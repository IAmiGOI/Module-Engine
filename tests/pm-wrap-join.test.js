import test from 'node:test';
import assert from 'node:assert/strict';
import { joinWrappers, mergeWrapped } from '../libraries/core/pm-wrap-join.js';
import { finalizeMessages } from '../libraries/core/pm-finalize.js';
import { assemblePrompt } from '../libraries/core/pm-assemble.js';
import { stToPreset } from '../libraries/core/pm-st-import.js';
import { regroupTree } from '../libraries/core/pm-wrapper-groups.js';

const sys = (content, extra = {}) => ({ role: 'system', content, ...extra });

test('a wrapper group goes to the model as ONE message <tag>\\n…\\n</tag>, nested groups included', () => {
    const messages = [
        sys('<a>', { _open: 'ga', _block: 'o1' }), sys('one', { _block: 'b1' }),
        sys('<b>', { _open: 'gb', _block: 'o2' }), sys('two', { _block: 'b2' }), sys('</b>', { _close: 'gb', _block: 'c2' }),
        sys('</a>', { _close: 'ga', _block: 'c1' }), { role: 'user', content: 'hi', _hid: 0 },
    ];
    assert.deepEqual(joinWrappers(messages), [
        { role: 'system', content: '<a>\none\n<b>\ntwo\n</b>\n</a>', _block: 'ga' },
        { role: 'user', content: 'hi', _hid: 0 },
    ]);
});

test('a group whose content was all trimmed away sends nothing — not even its tags', () => {
    assert.deepEqual(joinWrappers([sys('<a>', { _open: 'g' }), sys('</a>', { _close: 'g' })]), []);
});

test('content with another role, history or tool calls keeps the old separate form so nothing changes meaning', () => {
    const mixed = mergeWrapped(sys('<a>'), [{ role: 'user', content: 'u' }], sys('</a>'), 'g');
    assert.deepEqual(mixed.map(m => m.content), ['<a>', 'u', '</a>']);
    const history = mergeWrapped(sys('<a>'), [{ role: 'system', content: 'x', _hid: 3 }], sys('</a>'), 'g');
    assert.equal(history.length, 3);
});

test('a group placed at a depth is one injection at that depth, and an empty one is not sent', () => {
    const d = (identifier, content, order) => ({ identifier, role: 'system', content, injection_position: 1, injection_depth: 1, injection_order: order });
    const make = inner => stToPreset({
        prompts: [{ identifier: 'h', marker: true }, d('o', '<char instructions>', 101), d('m', inner, 102), d('c', '</char instructions>', 106)],
        prompt_order: [{ character_id: 100001, order: ['h', 'o', 'm', 'c'].map(identifier => ({ identifier, enabled: true })) }],
    });
    const history = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
    assert.deepEqual(assemblePrompt(make('Be brief.'), { history }).messages.map(m => m.content), ['a', '<char instructions>\nBe brief.\n</char instructions>', 'b']);
    assert.deepEqual(assemblePrompt(make(''), { history }).messages.map(m => m.content), ['a', 'b']);
});

test('a tree prepared before 5.140 (depth tags left as plain prompts) is regrouped once, and regrouping again changes nothing', () => {
    const d = (identifier, content, order) => ({ identifier, role: 'system', content, injection_position: 1, injection_depth: 8, injection_order: order });
    const preset = stToPreset({
        prompts: [{ identifier: 'h', marker: true }, d('o', '<ci>', 101), d('m', 'Be brief.', 102), d('c', '</ci>', 106)],
        prompt_order: [{ character_id: 100001, order: ['h', 'o', 'm', 'c'].map(identifier => ({ identifier, enabled: true })) }],
    });
    const old = [{ type: 'item', block: 'h', enabled: true }, ...['o', 'm', 'c'].map(block => ({ type: 'item', block, enabled: true }))];
    const blocks = new Map(preset.blocks.map(block => [block.id, block]));
    const first = regroupTree(old, blocks);
    assert.equal(first.changed, true);
    assert.deepEqual(first.tree.map(node => node.type), ['item', 'group']);
    assert.equal(regroupTree(first.tree, blocks).changed, false);
});

test('no service field (anything starting with "_") reaches the provider — _priority used to leak into the request', () => {
    const out = finalizeMessages([{ role: 'system', content: 'x', _block: 'b', _hid: 1, _priority: 40, _open: 'g' }]);
    assert.deepEqual(out, [{ role: 'system', content: 'x' }]);
});
