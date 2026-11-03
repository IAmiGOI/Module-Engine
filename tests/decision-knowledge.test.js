import test from 'node:test';
import assert from 'node:assert/strict';
import { applyKnowledge, renderKnowledge } from '../libraries/core/decision-knowledge.js';
import { createKnowledge } from '../cores/decision/knowledge.js';
import { createCycleContext } from '../cores/decision/cycle-context.js';
import { buildDeciderContext, buildWriterContext } from '../libraries/core/decision-context.js';

let counter = 0;
const rid = () => ((counter += 1) / 1000);

test('knowledge is only appended: a revised fact keeps the old belief, a forgotten one leaves the section', () => {
    let state = {};
    const added = applyKnowledge(state, { op: 'add', character: 'Felt', fact: 'Emilia is a half-elf.', source: 'saw' }, { rid });
    state = added.state;
    const revised = applyKnowledge(state, { op: 'revise', character: 'felt', id: added.item.id, fact: 'Emilia is a royal candidate.', source: 'told', from: 'Rom' }, { rid });
    state = revised.state;
    const text = renderKnowledge(state);
    assert.match(text, /WHAT CHARACTERS KNOW/);
    assert.match(text, /Emilia is a royal candidate\. — told from Rom \(used to believe: Emilia is a half-elf\.\)/);
    assert.equal(text.match(/\[k_/g).length, 1, 'only the current belief is listed');
    const forgotten = applyKnowledge(state, { op: 'forget', character: 'Felt', id: revised.item.id }, { rid });
    assert.equal(renderKnowledge(forgotten.state), '');
    assert.equal(applyKnowledge(state, { op: 'revise', character: 'Felt', id: 'k_nope', fact: 'x' }).ok, false);
});

test('the writer gets the knowledge of active characters only', () => {
    let state = applyKnowledge({}, { op: 'add', character: 'Felt', fact: 'The insignia is in the loothouse.' }, { rid }).state;
    state = applyKnowledge(state, { op: 'add', character: 'Reinhard', fact: 'Felt has the blood of the royal family.' }, { rid }).state;
    const active = renderKnowledge(state, { names: ['Felt'] });
    assert.match(active, /loothouse/);
    assert.doesNotMatch(active, /royal family/);
});

test('the user character has no knowledge record; the tool refuses it with the reason', async () => {
    const memory = new Map();
    const call = async (contract, params) => {
        if (contract === 'storage.chatMemory.get') return memory.get(params.key) ?? params.fallback;
        if (contract === 'storage.chatMemory.set') { memory.set(params.key, params.value); return true; }
        throw new Error(contract);
    };
    const banks = { records: () => [{ sourceKind: 'persona', name: 'Sasha' }] };
    const knowledge = createKnowledge({ call, banks, rid });
    const refused = await knowledge.handlers.character_knowledge({ op: 'add', character: 'sasha', fact: 'Anything.', comment: 'Trying the user.' });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /items and physical state/);
    const ok = await knowledge.handlers.character_knowledge({ op: 'add', character: 'Puck', fact: 'Sasha knows the future.', source: 'heard', comment: 'Puck overheard it.' });
    assert.equal(ok.ok, true);
    assert.match(await knowledge.textFor(['Puck']), /knows the future/);
});

test('knowledge sits in the mutable part: after the turns for the director, after the history for the writer', () => {
    const director = buildDeciderContext({
        banksText: 'BANKS', knowledgeText: 'WHAT CHARACTERS KNOW x',
        turns: [{ cycles: [{ event: 'turn', turn: 2, messages: [{ role: 'user', content: 'Go.' }] }] }],
        chat: [{ mes: 'Go.', is_user: true }],
    }).messages;
    const at = (list, needle) => list.findIndex(message => String(message.content).includes(needle));
    assert.ok(at(director, 'BANKS') < at(director, 'TURN 2 (full)'));
    assert.ok(at(director, 'WHAT CHARACTERS KNOW') > at(director, 'TURN 2 (full)'), 'the banks stay frozen; knowledge changes, so it is after the turns');
    const writer = buildWriterContext({ chat: [{ mes: 'Go.', is_user: true }], decision: 'Felt runs.', banksText: 'BANKS', knowledgeText: 'WHAT CHARACTERS KNOW y' }).messages;
    const firstHistory = writer.findIndex(message => message.role === 'user');
    assert.ok(at(writer, 'BANKS') < firstHistory);
    assert.ok(at(writer, 'WHAT CHARACTERS KNOW') > firstHistory);
});

test('the director gets the knowledge tool and never the Secrets tool', async () => {
    const call = async contract => (contract === 'generation.tools' ? [{ name: 'Secrets', parameters: {} }, { name: 'Notebook', parameters: {} }] : []);
    const context = createCycleContext({ call, store: {} });
    const names = (await context.toolsFor({ turnDraft: false })).map(tool => tool.name);
    assert.ok(names.includes('character_knowledge'));
    assert.ok(names.includes('Notebook'));
    assert.equal(names.includes('Secrets'), false);
});

test('update extends an existing knowledge entry with a new detail, keeps its id and does not mark it outdated', () => {
    const added = applyKnowledge({}, { op: 'add', character: 'Rom', fact: 'Elsa is dangerous.', source: 'heard' }, { rid });
    const updated = applyKnowledge(added.state, { op: 'update', character: 'Rom', id: added.item.id, fact: 'she fights with a kukri', source: 'saw' }, { rid });
    assert.equal(updated.ok, true);
    assert.equal(updated.item.id, added.item.id);
    assert.equal(updated.item.status, 'known');
    const text = renderKnowledge(updated.state);
    assert.match(text, /Elsa is dangerous; she fights with a kukri/);
    assert.doesNotMatch(text, /used to believe/);
    assert.equal(text.match(/\[k_/g).length, 1, 'no duplicate entry');
    assert.equal(applyKnowledge(updated.state, { op: 'update', character: 'Rom', id: 'k_none', fact: 'x' }).ok, false);
});
