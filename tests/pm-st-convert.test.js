import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stToPreset } from '../libraries/core/pm-st-import.js';
import { presetToSt, stripSecrets } from '../libraries/core/pm-st-export.js';
import { flattenTree } from '../libraries/core/pm-wrapper-groups.js';
import { walkTree } from '../libraries/core/pm-preset-format.js';

const amigo = () => JSON.parse(readFileSync(new URL('./fixtures/pm-amigo-polished.st.json', import.meta.url), 'utf8'));

test('the owner\'s real preset survives import and export without losing or inventing any field', () => {
    const original = amigo();
    assert.deepEqual(presetToSt(stToPreset(original)), original);
});

test('a preset is re-imported to the same internal form after a full export round trip', () => {
    const once = stToPreset(amigo());
    assert.deepEqual(stToPreset(presetToSt(once)), once);
});

test('the effective enabled flag is read from the prompt order, not from the prompt itself', () => {
    const preset = stToPreset({
        prompts: [{ identifier: 'a', name: 'A', role: 'system', content: 'x', enabled: false }],
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: true }] }],
    });
    assert.equal(preset.tree[0].enabled, true);
    assert.equal(preset.blocks[0].stEnabled, false);
});

test('the longest prompt order becomes the tree and the shorter one is kept for export', () => {
    const preset = stToPreset(amigo());
    assert.equal(preset.primaryOrder, 100001);
    assert.equal(preset.orders.find(list => list.characterId === 100000).raw.length, 11);
});

test('the global 100001 prompt order becomes the tree even when a character-specific list is longer, because SillyTavern 1.18 reads only 100001 for Chat Completion', () => {
    const block = id => ({ identifier: id, name: id, role: 'system', content: id });
    const preset = stToPreset({
        prompts: ['a', 'b', 'c'].map(block),
        prompt_order: [
            { character_id: 100001, order: [{ identifier: 'a', enabled: true }] },
            { character_id: 58, order: ['a', 'b', 'c'].map(identifier => ({ identifier, enabled: true })) },
        ],
    });
    assert.equal(preset.primaryOrder, 100001);
    assert.deepEqual(flattenTree(preset.tree).map(entry => entry.identifier), ['a']);
});

test('without a 100001 list the longest prompt order becomes the tree', () => {
    const block = id => ({ identifier: id, name: id, role: 'system', content: id });
    const preset = stToPreset({
        prompts: ['a', 'b'].map(block),
        prompt_order: [
            { character_id: 100000, order: [{ identifier: 'a', enabled: true }] },
            { character_id: 7, order: ['a', 'b'].map(identifier => ({ identifier, enabled: true })) },
        ],
    });
    assert.equal(preset.primaryOrder, 7);
});

test('paired wrapper prompts of the real preset are glued into groups and expand back to the same order', () => {
    const preset = stToPreset(amigo());
    const groups = [...walkTree(preset.tree)].filter(node => node.type === 'group');
    assert.ok(groups.length >= 5, `expected several wrapper groups, got ${groups.length}`);
    const settings = groups.find(group => group.name === 'settings');
    assert.equal(preset.blocks.find(block => block.id === settings.wrap.open).content, '<settings>');
    assert.equal(flattenTree(preset.tree).length, amigo().prompt_order.find(list => list.character_id === 100001).order.length);
});

test('wrapper prompts with different enabled states are not glued', () => {
    const preset = stToPreset({
        prompts: [
            { identifier: 'o', role: 'system', content: '<x>' }, { identifier: 'b', role: 'system', content: 'body' },
            { identifier: 'c', role: 'system', content: '</x>' },
        ],
        prompt_order: [{ character_id: 1, order: [{ identifier: 'o', enabled: true }, { identifier: 'b', enabled: true }, { identifier: 'c', enabled: false }] }],
    });
    assert.equal(preset.tree.every(node => node.type === 'item'), true);
});

test('nested wrappers of the same tag pair up by depth', () => {
    const p = (id, content) => ({ identifier: id, role: 'system', content });
    const preset = stToPreset({
        prompts: [p('o1', '<a>'), p('o2', '<a>'), p('c2', '</a>'), p('c1', '</a>')],
        prompt_order: [{ character_id: 1, order: ['o1', 'o2', 'c2', 'c1'].map(identifier => ({ identifier, enabled: true })) }],
    });
    assert.equal(preset.tree.length, 1);
    assert.equal(preset.tree[0].wrap.close, 'c1');
    assert.equal(preset.tree[0].children[0].wrap.close, 'c2');
});

test('a wrapper pair injected at one depth, with everything between it at that depth and inside its order range, becomes a group placed at that depth — like <char instructions> 8/101 … 8/102-105 … 8/106 in the owner\'s presets', () => {
    const d = (identifier, content, order, depth = 8) => ({ identifier, role: 'system', content, injection_position: 1, injection_depth: depth, injection_order: order });
    const st = {
        prompts: [d('o', '<char instructions>', 101), d('m', 'Be brief.', 102), d('c', '</char instructions>', 106)],
        prompt_order: [{ character_id: 100001, order: ['o', 'm', 'c'].map(identifier => ({ identifier, enabled: true })) }],
    };
    const preset = stToPreset(st);
    assert.equal(preset.tree.length, 1);
    assert.deepEqual(preset.tree[0].placement, { mode: 'depth', depth: 8, order: 101 });
    const out = presetToSt(preset);
    assert.deepEqual({ prompts: out.prompts, prompt_order: out.prompt_order }, st, 'export unfolds the group back into the same three prompts');
});

test('a wrapper pair spanning different depths or holding a block outside its depth stays plain prompts — that is last-message wrapping, not a group', () => {
    const d = (identifier, content, order, depth) => ({ identifier, role: 'system', content, injection_position: 1, injection_depth: depth, injection_order: order });
    const across = stToPreset({
        prompts: [d('o', '<last_message>', 101, 1), d('c', '</last_message>', 99, 0)],
        prompt_order: [{ character_id: 100001, order: ['o', 'c'].map(identifier => ({ identifier, enabled: true })) }],
    });
    assert.equal(across.tree.length, 2);
    const mixed = stToPreset({
        prompts: [d('o', '<x>', 101, 8), d('m', 'Elsewhere.', 102, 2), d('c', '</x>', 106, 8)],
        prompt_order: [{ character_id: 100001, order: ['o', 'm', 'c'].map(identifier => ({ identifier, enabled: true })) }],
    });
    assert.equal(mixed.tree.length, 3);
});

test('secrets and connection passwords are removed on export while other connection fields are kept', () => {
    const preset = stToPreset({ prompts: [], chat_completion_source: 'nanogpt', proxy_password: 'sk-live', openai_api_key: 'k', custom_url: 'http://x' });
    const out = presetToSt(preset);
    assert.equal(out.proxy_password, undefined);
    assert.equal(out.openai_api_key, undefined);
    assert.equal(out.chat_completion_source, 'nanogpt');
    assert.equal(out.custom_url, 'http://x');
    assert.deepEqual(stripSecrets({ a: 1, secret_token: 2 }), { a: 1 });
});

test('a file without a prompts list is rejected with a clear message', () => {
    assert.throws(() => stToPreset({ temperature: 1 }), /not a Chat Completion preset/);
    assert.throws(() => stToPreset('{"prompts":'), SyntaxError);
});

test('a block created inside the manager exports its effective enabled state', () => {
    const preset = stToPreset({ prompts: [], prompt_order: [] });
    preset.blocks.push({ id: 'n1', name: 'New', role: 'system', content: 'hi' });
    preset.tree.push({ type: 'item', block: 'n1', enabled: true });
    assert.equal(presetToSt(preset).prompts[0].enabled, true);
});
