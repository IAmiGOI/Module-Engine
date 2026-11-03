import test from 'node:test';
import assert from 'node:assert/strict';
import { createCharacterBanks } from '../cores/decision/banks.js';
import { hashText } from '../libraries/core/decision-banks.js';

const CARD = { avatar: 'Aria.png', name: 'Aria', description: 'A courier.' };
const PERSONA = { avatar: 'me.png', name: 'Me', description: 'A traveller.' };

function build({ timeline = '', adjust = null } = {}) {
    const settingsStore = new Map();
    const chatMemory = new Map();
    const events = [];
    const adjustCalls = [];
    const researcherCalls = [];
    const key = (namespace, name) => `${namespace}:${name}`;
    let brief = timeline ? { text: `TIMELINE:\n${timeline}`, timeline } : null;
    const call = async (contract, params = {}) => {
        if (contract === 'storage.settings.get') return settingsStore.has(key(params.namespace, params.key)) ? settingsStore.get(key(params.namespace, params.key)) : params.fallback;
        if (contract === 'storage.settings.set') { settingsStore.set(key(params.namespace, params.key), params.value); return true; }
        if (contract === 'storage.chatMemory.get') return chatMemory.has(key(params.namespace, params.key)) ? chatMemory.get(key(params.namespace, params.key)) : params.fallback;
        if (contract === 'storage.chatMemory.set') { chatMemory.set(key(params.namespace, params.key), params.value); return true; }
        if (contract === 'lorebook.entries') return [];
        if (contract === 'model.generate') {
            adjustCalls.push(params);
            if (adjust) return adjust(params);
            return `***Lena***\nTimeline adjusted.`;
        }
        return undefined;
    };
    const callService = async contract => (contract === 'stCharacter.chatCharacters' ? [CARD] : contract === 'stCharacter.persona' ? PERSONA : []);
    const researcher = {
        start({ system, kind }) {
            researcherCalls.push({ system, kind });
            const name = /CHARACTER: (.+)/.exec(system)?.[1] ?? 'Unknown';
            return { ok: true, taskId: `t${researcherCalls.length}`, done: Promise.resolve({ error: null, report: `***${name}***\nBuilt bank.`, status: 'done' }) };
        },
    };
    const store = { library: () => ({}), chatBrief: () => brief, window: () => ({ entries: [] }), boundary: () => null };
    const banks = createCharacterBanks({
        call, callService, researcher, store,
        getSettings: () => ({ researcher: { workerId: 'subagent', maxSteps: 8 }, decider: { workerId: 'director' }, bankColdStartTimeoutMs: 500 }),
        getWorkers: () => [{ id: 'director', format: 'openai', model: 'director/model' }],
        publishEvent: (event, payload) => events.push([event, payload]),
    });
    return { banks, events, adjustCalls, researcherCalls, setBrief: value => { brief = value; } };
}

test('a ready brief puts the TIMELINE into the bank builder prompt', async () => {
    const world = build({ timeline: 'The story starts before the war.' });
    await world.banks.ensureColdStart();
    assert.ok(world.researcherCalls.length > 0);
    assert.match(world.researcherCalls[0].system, /TIMELINE OF THIS STORY: The story starts before the war\./);
    assert.match(world.researcherCalls[0].system, /\*\*Timeline lock\*\*/);
});

test('a ready bank in timelineBanks gets one timeline adjust with no search', async () => {
    const world = build();
    await world.banks.ensureColdStart();
    const before = world.researcherCalls.length;
    world.setBrief({ text: 'TIMELINE:\nThe story starts before the war.', timeline: 'The story starts before the war.' });
    const result = await world.banks.applyTimeline({ timeline: 'The story starts before the war.', timelineBanks: [{ name: 'Aria', note: 'She has not met Subaru yet.' }] });
    assert.equal(result.adjusted, 1);
    assert.equal(world.adjustCalls.length, 1);
    assert.match(world.adjustCalls[0].prompt, /You adjust one character's data bank/);
    assert.match(world.adjustCalls[0].prompt, /She has not met Subaru yet\./);
    assert.equal(world.researcherCalls.length, before, 'the adjust does not start a search');
    assert.equal(world.banks.records().find(record => record.name === 'Aria').timelineHash, hashText('The story starts before the war.'));
    assert.match(world.banks.records().find(record => record.name === 'Aria').text, /Timeline adjusted/);
});

test('a bank not named in timelineBanks is not touched', async () => {
    const world = build();
    await world.banks.ensureColdStart();
    const before = world.banks.records().find(record => record.name === 'Aria').text;
    world.setBrief({ text: 'TIMELINE:\nThe story starts before the war.', timeline: 'The story starts before the war.' });
    await world.banks.applyTimeline({ timeline: 'The story starts before the war.', timelineBanks: [{ name: 'Me', note: 'x' }] });
    assert.equal(world.banks.records().find(record => record.name === 'Aria').text, before);
});

test('a failed adjust leaves the bank as it was and warns', async () => {
    const world = build({ adjust: () => '' });
    await world.banks.ensureColdStart();
    const before = world.banks.records().find(record => record.name === 'Aria').text;
    const result = await world.banks.applyTimeline({ timeline: 'The story starts before the war.', timelineBanks: [{ name: 'Aria', note: 'x' }] });
    assert.equal(result.adjusted, 0);
    assert.equal(world.banks.records().find(record => record.name === 'Aria').text, before);
    assert.ok(world.events.some(([event, payload]) => event === 'decision.bank.warning' && /Timeline adjust failed/.test(payload.message)));
});

test('a bank still being built is adjusted when it becomes ready', async () => {
    const world = build();
    await world.banks.ensureColdStart();
    world.setBrief({ text: 'TIMELINE:\nThe story starts before the war.', timeline: 'The story starts before the war.' });
    await world.banks.applyTimeline({ timeline: 'The story starts before the war.', timelineBanks: [{ name: 'Nobody', note: 'x' }] });
    assert.equal(world.adjustCalls.length, 0, 'nothing to adjust yet');
    await world.banks.ensureName('Nobody');
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(world.adjustCalls.some(params => /Nobody/.test(params.prompt)), 'the queued name is adjusted when its bank is ready');
});
