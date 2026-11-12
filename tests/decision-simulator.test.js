import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSimulator, renderAccounts, personBlock } from '../cores/decision/simulator.js';
import { createGreatBank } from '../cores/decision/bank-great.js';
import { buildInscription } from '../libraries/core/decision-push.js';
import { clampDecisionSettings } from '../libraries/core/decision-settings.js';
import { SIMULATOR_SYSTEM, SIMULATOR_TASK, RESOLVER_ACCOUNTS } from '../libraries/core/decision-prompts.js';

const mara = { name: 'Mara', importance: 'main', psyche: ['She counts hours instead of sleeping.'], decree: { 1: ['Her brother is a hostage.'], 3: ['Today: get through the night.'] }, deadlines: [{ at: 360, what: 'Daniel dead, or Tomas dies' }] };

function world(answers) {
    const memory = new Map([['greatBank', { mara, daniel: { name: 'Daniel', sourceKey: 'persona:me' } }]]);
    const requests = [];
    const call = async (contract, params = {}) => {
        if (contract === 'storage.chatMemory.get') return memory.has(params.key) ? structuredClone(memory.get(params.key)) : params.fallback;
        if (contract === 'storage.chatMemory.set') { memory.set(params.key, structuredClone(params.value)); return true; }
        if (contract === 'chatHistory.annotations') return {};
        if (contract === 'model.generate') { requests.push(params); return answers.shift(); }
        return undefined;
    };
    const store = { clock: () => ({ minutes: 280 }), roster: () => ({ active: ['Mara'] }) };
    const great = createGreatBank({ call, store, banks: { records: () => [] } });
    const simulator = createSimulator({ call, banks: { great }, store, getSettings: () => ({ simulator: { enabled: true }, decider: { workerId: 'resolver' } }) });
    return { simulator, great, requests };
}

const account = args => ({ text: '', toolCalls: [{ id: 'a', name: 'account', arguments: args }] });

test('the simulator models each person here apart, from the inside, with no word of scene, turn or player', async () => {
    const { simulator, great, requests } = world([account({ took: 'He asked about the phone.', inner: 'Cold.', wants: 'For him not to ask.', does: 'Puts the phone away.', says: '"My brother."' })]);
    const chat = [{ is_user: false, mes: 'The kitchen is dark.' }, { is_user: true, mes: 'What does the phone say?' }];
    const accounts = await simulator.accountsFor({ chat });
    assert.equal(accounts.length, 1);
    assert.equal(requests[0].workerId, 'resolver');
    const system = requests[0].messages[0].content;
    assert.doesNotMatch(system, /\b(scene|player|character|roleplay|story's turn)\b/i);
    const block = requests[0].messages[1].content;
    assert.match(block, /She counts hours instead of sleeping/);
    assert.match(block, /What Hangs Over Them\*\*\n- Mara: Daniel dead, or Tomas dies — about an hour left\./);
    assert.match(requests[0].messages[2].content, /The kitchen is dark\.\n\nThen Daniel: What does the phone say\?/);
    assert.equal((await great.load()).mara.moments.at(-1).does, 'Puts the phone away.');
});

test('when the account has them speak but leaves the words out, the simulator asks once for the words', async () => {
    const { simulator } = world([account({ took: 'x', inner: 'y', does: 'Answers him flatly.', says: '' }), { text: '', toolCalls: [{ id: 'w', name: 'words', arguments: { says: '"Nothing."' } }] }]);
    const [{ account: got }] = await simulator.accountsFor({ chat: [{ is_user: true, mes: 'Hi.' }] });
    assert.equal(got.says, '"Nothing."');
});

test('a failed person carries on and the turn goes ahead', async () => {
    const { simulator } = world([]);
    const [{ account: got, error }] = await simulator.accountsFor({ chat: [{ is_user: true, mes: 'Hi.' }] });
    assert.equal(got.does, 'Carries on.');
    assert.ok(error);
});

test('the Resolver gets the accounts, and the Writer gets their words as their own', () => {
    const block = renderAccounts([{ name: 'Mara', account: { took: 'x', inner: 'cold', wants: 'quiet', does: 'Pours coffee.', says: '"Sit."' } }]);
    assert.match(block, /THE PEOPLE ARE NOT YOURS THIS TURN/);
    assert.match(block, /- says: "Sit\."/);
    const form = { scene: { minutes: 2 }, userResult: 'He sits.', beats: [{ who: 'Mara', kind: 'line', text: '"Sit."' }], stop: 'Mara pours.', characters: [] };
    assert.match(buildInscription({ form, ownWords: true }), /Mara — LINE \(their own words\): "Sit\."/);
    assert.match(buildInscription({ form }), /LINE \(meaning\)/);
});

test('the simulator is on by default, can be turned off, and its prompts are PROMPTS.md section 48', () => {
    assert.equal(clampDecisionSettings({}).simulator.enabled, true);
    assert.equal(clampDecisionSettings({ simulator: { enabled: false } }).simulator.enabled, false);
    const doc = readFileSync(new URL('../docs/research-decision/PROMPTS.md', import.meta.url), 'utf8');
    for (const prompt of [SIMULATOR_SYSTEM, SIMULATOR_TASK, RESOLVER_ACCOUNTS]) assert.ok(doc.includes(prompt));
    assert.ok(personBlock(mara, { now: 0 }).includes('True Of Them'));
});

test('with the simulator the Writer gets a person\'s words from the account itself, not the Resolver\'s retelling of them', () => {
    const form = {
        userResult: 'Sasha laid out the plan.',
        characters: [{ name: 'Lena', feels: 'Tired.' }],
        beats: [
            { who: 'Lena', kind: 'action', text: 'Looks at the window.' },
            { who: 'Lena', kind: 'line', text: 'Second: he did not answer her, and she noticed.' },
            { who: 'Lena', kind: 'action', text: 'Her hands tighten.' },
            { who: 'Lena', kind: 'line', text: 'Fourth: he has still not told her the numbers.' },
        ],
        stop: 'She waits for the numbers.',
    };
    const push = buildInscription({ form, ownWords: true, words: { Lena: '"You did not answer me. And you still have not told me the numbers."' } });
    assert.match(push, /2\. Lena — LINE \(their own words\): "You did not answer me\. And you still have not told me the numbers\."/);
    assert.match(push, /3\. Lena — ACTION: Her hands tighten\./);
    assert.doesNotMatch(push, /he did not answer her|4\. Lena/);
    const plain = buildInscription({ form });
    assert.match(plain, /LINE \(meaning\): Second: he did not answer her/);
});
