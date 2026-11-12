import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSceneCast } from '../cores/decision/scene-cast.js';
import { createSimulator } from '../cores/decision/simulator.js';
import { CAST_SYSTEM, CAST_TASK } from '../libraries/core/decision-prompts.js';

const bank = {
    lena: { name: 'Vladilena Milizé', aliases: ['Lena'], importance: 'main', decree: { 1: ['At HQ in the First Sector.'] }, psyche: ['Holds herself to the record.'] },
    shin: { name: 'Shinei Nouzen', aliases: ['Shin'], importance: 'main', decree: { 1: ['At the Spearhead base in Sector 86.'] }, psyche: ['Flat.'] },
    sasha: { name: 'Sasha', sourceKey: 'persona:user' },
};
const chat = [{ is_user: false, mes: 'Vladilena Milizé slumps against the wall of the HQ corridor.' }, { is_user: true, mes: 'Has something happened?' }];

function setup(answer) {
    let roster = { active: [] };
    const requests = [];
    const call = async (contract, params) => { if (contract === 'model.generate') { requests.push(params); return answer; } };
    const store = { roster: () => roster, saveRoster: async next => { roster = next; return roster; } };
    const banks = { great: { load: async () => structuredClone(bank) }, noteRosterAdded: async () => {} };
    return { cast: createSceneCast({ call, banks, store }), store, requests, banks, call };
}

test('the first turn casts the scene in its own short call to the resolver model, and the roster takes only names from the list', async () => {
    const { cast, store, requests } = setup({ toolCalls: [{ name: 'cast', arguments: JSON.stringify({ present: ['Vladilena Milizé', 'Kurena'] }) }] });
    assert.deepEqual(await cast.castIfEmpty({ chat, workerId: 'resolver' }), ['Vladilena Milizé']);
    assert.deepEqual(store.roster().active, ['Vladilena Milizé']);
    assert.equal(requests[0].workerId, 'resolver');
    assert.equal(requests[0].messages.length, 2);
    assert.equal(requests[0].messages[0].content, CAST_SYSTEM);
    const task = requests[0].messages[1].content;
    assert.match(task, /Shinei Nouzen \(also Shin\) — their day: At the Spearhead base in Sector 86\./);
    assert.match(task, /THEN Sasha: Has something happened\?/);
    assert.doesNotMatch(task, /- Sasha/);
});

test('a roster already set means no cast call', async () => {
    const { cast, store, requests } = setup({});
    await store.saveRoster({ active: ['Shinei Nouzen'] });
    assert.deepEqual(await cast.castIfEmpty({ chat, workerId: 'resolver' }), []);
    assert.equal(requests.length, 0);
});

test('without a roster the simulator models only the main cast the page names, not everyone important', async () => {
    const { store, banks } = setup({});
    const requests = [];
    const call = async (contract, params) => { if (contract === 'model.generate') { requests.push(params); return { toolCalls: [{ name: 'account', arguments: { took: 'A question.', inner: 'Raw.', does: 'Looks away.' } }] }; } };
    const simulator = createSimulator({ call, banks, store, getSettings: () => ({ simulator: { enabled: true } }) });
    const accounts = await simulator.accountsFor({ chat });
    assert.deepEqual(accounts.map(item => item.name), ['Vladilena Milizé']);
});

test('the cast prompts are mirrored in PROMPTS.md', () => {
    const doc = readFileSync(new URL('../docs/research-decision/PROMPTS.md', import.meta.url), 'utf8');
    for (const prompt of [CAST_SYSTEM, CAST_TASK]) assert.ok(doc.includes(prompt));
});
