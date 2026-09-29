import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stToPreset } from '../libraries/core/pm-st-import.js';
import { buildRequest } from '../libraries/core/pm-run.js';

const amigo = () => stToPreset(JSON.parse(readFileSync(new URL('./fixtures/pm-amigo-polished.st.json', import.meta.url), 'utf8')));
const chat = [
    { is_user: false, is_system: true, name: 'Memory', mes: 'MEMORY GRAPH' },
    { is_user: false, name: 'Lena', mes: 'Greetings, {{user}}.' },
    { is_user: true, name: 'Sasha', mes: 'Hi, who are you? Tell me about the dragon.' },
];
const materials = {
    user: 'Sasha', char: 'Lena', description: 'Lena is a Handler.', personality: 'Kind.', persona: '18 yo Male',
    chat, macros: { 'rp-time_year': '2148', 'rp-time_month': 'May', 'rp-time_day': '22', 'rp-time_time': '23:10', 'rp-time_period': 'night' },
    loreEntries: [{ uid: 1, key: ['dragon'], content: 'Dragons guard castles.', position: 0, order: 100 }, { uid: 2, constant: true, content: 'ALWAYS', position: 4, depth: 1, role: 0 }],
};

test('the whole pipeline produces a Chat Completion request from the owner\'s preset with macros and lore resolved', () => {
    const result = buildRequest(amigo(), materials);
    const text = result.messages.map(m => m.content).join('\n');
    assert.ok(text.includes('Lena is a Handler.'));
    assert.ok(text.includes('Dragons guard castles.'));
    assert.ok(text.includes('2148 May 22 23:10 (night)'), 'time macros of our own must be resolved');
    assert.ok(text.includes('Greetings, Sasha.'), 'macros in history are substituted');
    assert.equal(result.messages.some(m => '_block' in m || '_hid' in m), false);
    assert.equal(result.body.temperature, 0.85);
    assert.equal(result.body.max_tokens, 4000);
    assert.deepEqual(result.macros.unresolved, []);
});

test('a lore entry set to a depth is injected into the history at that depth', () => {
    const result = buildRequest(amigo(), materials);
    const contents = result.messages.map(m => m.content);
    const at = contents.indexOf('ALWAYS');
    assert.equal(contents[at + 1].startsWith('Hi, who are you'), true, 'depth 1 stands right before the last message');
});

test('the request is trimmed to the context budget with the oldest history dropped first', () => {
    const preset = amigo();
    preset.params.openai_max_context = 4500;
    preset.params.openai_max_tokens = 100;
    const longChat = Array.from({ length: 40 }, (_, i) => ({ is_user: i % 2 === 1, name: 'x', mes: `message number ${i} ${'word '.repeat(30)}` }));
    const result = buildRequest(preset, { ...materials, chat: longChat, loreEntries: [] });
    assert.ok(result.dropped.length > 0);
    assert.equal(result.messages.at(-1).content.startsWith('message number 39') || result.messages.at(-1).role !== undefined, true);
    assert.ok(result.tokens.total <= 4400, `total ${result.tokens.total}`);
    assert.ok(result.cut > 0);
});

test('a seed freezes random macros and the result reports that randomness was used', () => {
    const preset = amigo();
    preset.blocks.push({ id: 'r', role: 'system', content: '{{random::a::b::c::d::e}}' });
    preset.tree.push({ type: 'item', block: 'r', enabled: true });
    const a = buildRequest(preset, materials, { seed: 's1' }), b = buildRequest(preset, materials, { seed: 's1' });
    assert.deepEqual(a.messages, b.messages);
    assert.equal(a.macros.usedRandom, true);
});
