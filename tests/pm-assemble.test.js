import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stToPreset } from '../libraries/core/pm-st-import.js';
import { assemblePrompt } from '../libraries/core/pm-assemble.js';

const amigo = () => stToPreset(JSON.parse(readFileSync(new URL('./fixtures/pm-amigo-polished.st.json', import.meta.url), 'utf8')));
const short = messages => messages.map(m => `${m.role}:${(m.content ?? '').slice(0, 24).replace(/\n/g, ' ')}`);

const history = [
    { role: 'assistant', content: 'memory graph' }, { role: 'assistant', content: 'notebook' }, { role: 'assistant', content: 'greeting' },
    { role: 'user', content: 'Hi, who are you?' },
    { role: 'assistant', content: undefined, tool_calls: [{ id: 'c1' }] }, { role: 'tool', content: 'Saved', tool_call_id: 'c1' },
];
const context = { markers: { charDescription: 'DESC', charPersonality: 'PERS', personaDescription: '18 yo Male', worldInfoBefore: 'LORE' }, history };

test('the real preset assembles in the same order as the real ST 1.18 request from the owner\'s log', () => {
    const { messages } = assemblePrompt(amigo(), context);
    const s = short(messages);
    const at = text => s.findIndex(line => line.includes(text));
    const order = ['<settings>', '</settings>', '<chat examples>', '</chat examples>', '<info>', 'DESC', 'PERS', '18 yo Male', '</info>', 'LORE',
        '[Start a new Chat]', 'assistant:memory graph', 'assistant:greeting', 'Hi, who are you?', 'Saved',
        '<need guidelines>', '<goal guidelines>', '<logic>', '<narration>', '<CoT>', '</CoT>'];
    const positions = order.map(at);
    assert.ok(positions.every(p => p >= 0), `missing: ${order.filter((_, i) => positions[i] < 0)}`);
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, `wrong order: ${s.join(' | ')}`);
    assert.equal(at('<char instructions>'), -1, 'the depth-8 <char instructions> group is empty in this preset, so it sends nothing (ST sent the bare tag pair)');
});

test('empty prompts and empty groups send no messages at all', () => {
    const preset = amigo();
    const { messages, report } = assemblePrompt(preset, { markers: {}, history: [{ role: 'user', content: 'hi' }] });
    assert.equal(messages.some(m => m.content === ''), false);
    assert.equal(messages.some(m => m.content === '<info>'), false);
    assert.ok(report.some(r => r.name === 'info' && r.reason === 'empty group'));
});

test('an injection at depth zero lands after the last message and depth two before the last two', () => {
    const preset = stToPreset({
        prompts: [
            { identifier: 'h', marker: true }, { identifier: 'z', role: 'system', content: 'ZERO', injection_position: 1, injection_depth: 0, injection_order: 100 },
            { identifier: 'w', role: 'system', content: 'TWO', injection_position: 1, injection_depth: 2, injection_order: 100 },
        ],
        prompt_order: [{ character_id: 1, order: ['h', 'z', 'w'].map(identifier => ({ identifier, enabled: true })) }],
    });
    const { messages } = assemblePrompt(preset, { history: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] });
    assert.deepEqual(messages.map(m => m.content), ['a', 'TWO', 'b', 'c', 'ZERO']);
});

test('injections of the same depth keep ascending order and a depth beyond the history goes to its very start', () => {
    const p = (identifier, content, order, depth) => ({ identifier, role: 'system', content, injection_position: 1, injection_depth: depth, injection_order: order });
    const preset = stToPreset({
        prompts: [{ identifier: 'h', marker: true }, p('b', 'B', 106, 1), p('a', 'A', 101, 1), p('far', 'FAR', 5, 9)],
        prompt_order: [{ character_id: 1, order: ['h', 'b', 'a', 'far'].map(identifier => ({ identifier, enabled: true })) }],
    });
    const { messages } = assemblePrompt(preset, { history: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }] });
    assert.deepEqual(messages.map(m => m.content), ['FAR', 'x', 'A', 'B', 'y']);
});

test('injections of the same depth and order go assistant, then user, then system — the role order SillyTavern 1.18 uses (system lands closest to the end)', () => {
    const p = (identifier, role, order) => ({ identifier, role, content: identifier.toUpperCase(), injection_position: 1, injection_depth: 0, injection_order: order });
    const preset = stToPreset({
        prompts: [{ identifier: 'h', marker: true }, p('sys', 'system', 100), p('usr', 'user', 100), p('ast', 'assistant', 100), p('early', 'system', 50)],
        prompt_order: [{ character_id: 1, order: ['h', 'sys', 'usr', 'ast', 'early'].map(identifier => ({ identifier, enabled: true })) }],
    });
    const { messages } = assemblePrompt(preset, { history: [{ role: 'user', content: 'x' }] });
    assert.deepEqual(messages.map(m => m.content), ['x', 'EARLY', 'AST', 'USR', 'SYS']);
});

test('a disabled block is skipped and reported and macros are substituted by the given function', () => {
    const preset = stToPreset({
        prompts: [{ identifier: 'a', role: 'system', content: 'Hello {{user}}' }, { identifier: 'b', role: 'system', content: 'gone' }],
        prompt_order: [{ character_id: 1, order: [{ identifier: 'a', enabled: true }, { identifier: 'b', enabled: false }] }],
    });
    const { messages, report } = assemblePrompt(preset, { substitute: text => text.replace('{{user}}', 'Sasha'), history: [] });
    assert.deepEqual(messages.map(m => m.content), ['Hello Sasha']);
    assert.equal(report.find(r => r.blockId === 'b').reason, 'disabled');
});

test('world info and personality go through their templates and the new chat line is dropped for an empty history', () => {
    const preset = stToPreset({
        prompts: [{ identifier: 'worldInfoBefore', marker: true }, { identifier: 'charPersonality', marker: true }, { identifier: 'chatHistory', marker: true }],
        prompt_order: [{ character_id: 1, order: ['worldInfoBefore', 'charPersonality', 'chatHistory'].map(identifier => ({ identifier, enabled: true })) }],
        wi_format: '[WI]\n{0}', personality_format: "{{char}}'s personality: {{personality}}", new_chat_prompt: '[Start]',
    });
    const { messages } = assemblePrompt(preset, { markers: { worldInfoBefore: 'lore', charPersonality: 'kind' }, history: [] });
    assert.deepEqual(messages.map(m => m.content), ['[WI]\nlore', "{{char}}'s personality: kind"]);
});

test('a module contribution is placed where the user put its node, in order or at a depth', () => {
    const preset = stToPreset({ prompts: [{ identifier: 'h', marker: true }], prompt_order: [{ character_id: 1, order: [{ identifier: 'h', enabled: true }] }] });
    preset.tree.unshift({ type: 'inject', contribution: 'graph', enabled: true });
    preset.tree.push({ type: 'inject', contribution: 'notes', enabled: true, placement: { mode: 'depth', depth: 1 } });
    const contributions = { graph: { role: 'assistant', content: 'MEMORY' }, notes: { role: 'system', content: 'NOTES' } };
    const { messages } = assemblePrompt(preset, { history: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], contributions });
    assert.deepEqual(messages.map(m => m.content), ['MEMORY', 'a', 'NOTES', 'b']);
});

test('a contribution that is empty or missing sends nothing and a disabled node is skipped', () => {
    const preset = stToPreset({ prompts: [], prompt_order: [] });
    preset.tree.push({ type: 'inject', contribution: 'a', enabled: true }, { type: 'inject', contribution: 'b', enabled: false });
    const { messages, report } = assemblePrompt(preset, { contributions: { a: { content: '  ' }, b: { content: 'x' } } });
    assert.equal(messages.length, 0);
    assert.deepEqual(report.map(r => r.reason), ['empty', 'disabled']);
});

test('a node whose condition is false is skipped and reported', () => {
    const preset = stToPreset({ prompts: [{ identifier: 'a', role: 'system', content: 'ONLY WHEN DRAGON' }], prompt_order: [{ character_id: 1, order: [{ identifier: 'a', enabled: true }] }] });
    preset.tree[0].condition = { type: 'keyword', words: ['dragon'], scan: 2 };
    const off = assemblePrompt(preset, { facts: { messages: [{ role: 'user', text: 'hello' }] } });
    const on = assemblePrompt(preset, { facts: { messages: [{ role: 'user', text: 'a Dragon!' }] } });
    assert.equal(off.messages.length, 0);
    assert.equal(off.report[0].reason, 'condition');
    assert.equal(on.messages.length, 1);
});

test('a choice group sends only the selected option and exposes it as a variable', () => {
    const preset = stToPreset({ prompts: [{ identifier: 'p', role: 'system', content: 'PAST' }, { identifier: 'n', role: 'system', content: 'NOW' }], prompt_order: [] });
    preset.tree = [{
        type: 'choice', id: 'tense', name: 'Tense', enabled: true, variable: 'tense', selected: 'now',
        options: [{ id: 'past', value: 'past tense', children: [{ type: 'item', block: 'p', enabled: true }] }, { id: 'now', value: 'present tense', children: [{ type: 'item', block: 'n', enabled: true }] }],
    }];
    const vars = {};
    const { messages } = assemblePrompt(preset, { setVariable: (name, value) => { vars[name] = value; } });
    assert.deepEqual(messages.map(m => m.content), ['NOW']);
    assert.deepEqual(vars, { tense: 'present tense' });
});
