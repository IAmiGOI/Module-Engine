import test from 'node:test';
import assert from 'node:assert/strict';
import { createCharacterBanks } from '../cores/decision/banks.js';
import { hashText, bankFrameHash } from '../libraries/core/decision-banks.js';

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
        getSettings: () => ({ bankColdStart: 'build', researcher: { workerId: 'subagent', maxSteps: 8 }, decider: { workerId: 'director' }, bankColdStartTimeoutMs: 500 }),
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
    assert.ok(result.adjusted >= 1);
    const aria = world.adjustCalls.find(params => /CHARACTER: Aria/.test(params.prompt));
    assert.match(aria.prompt, /You adjust one character's data bank/);
    assert.match(aria.prompt, /She has not met Subaru yet\./);
    assert.equal(world.researcherCalls.length, before, 'the adjust does not start a search');
    assert.equal(world.banks.records().find(record => record.name === 'Aria').timelineHash, bankFrameHash('The story starts before the war.'));
    assert.match(world.banks.records().find(record => record.name === 'Aria').text, /Timeline adjusted/);
});

test('a bank not named in timelineBanks is adjusted too, once: built before the brief, it was never checked against it', async () => {
    const world = build();
    await world.banks.ensureColdStart();
    world.setBrief({ text: 'TIMELINE:\nThe story starts before the war.', timeline: 'The story starts before the war.', bankGuide: 'Cover abilities.' });
    await world.banks.applyTimeline({ timelineBanks: [{ name: 'Me', note: 'x' }] });
    const aria = world.banks.records().find(record => record.name === 'Aria');
    assert.match(aria.text, /Timeline adjusted/);
    assert.match(world.adjustCalls.find(params => /CHARACTER: Aria/.test(params.prompt)).prompt, /GUIDE FROM THE DIRECTOR: Cover abilities\./);
    const calls = world.adjustCalls.length;
    await world.banks.applyTimeline({ timelineBanks: [] });
    assert.equal(world.adjustCalls.length, calls, 'a bank already adjusted to this frame is not adjusted again');
});

test('a failed adjust leaves the bank as it was and warns', async () => {
    const world = build({ adjust: () => '' });
    await world.banks.ensureColdStart();
    const before = world.banks.records().find(record => record.name === 'Aria').text;
    world.setBrief({ text: 'TIMELINE:\nThe story starts before the war.', timeline: 'The story starts before the war.' });
    const result = await world.banks.applyTimeline({ timeline: 'The story starts before the war.', timelineBanks: [{ name: 'Aria', note: 'x' }] });
    assert.equal(result.adjusted, 0);
    assert.equal(world.banks.records().find(record => record.name === 'Aria').text, before);
    assert.ok(world.events.some(([event, payload]) => event === 'decision.bank.warning' && /Timeline adjust failed/.test(payload.message)));
});

test('a bank still being built is adjusted when it becomes ready', async () => {
    const world = build();
    await world.banks.ensureColdStart();
    world.setBrief({ text: 'TIMELINE:\nThe story starts before the war.', timeline: 'The story starts before the war.' });
    await world.banks.applyTimeline({ timelineBanks: [{ name: 'Nobody', note: 'x' }] });
    assert.ok(!world.adjustCalls.some(params => /CHARACTER: Nobody/.test(params.prompt)), 'nothing to adjust for Nobody yet');
    await world.banks.ensureName('Nobody');
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(world.adjustCalls.some(params => /Nobody/.test(params.prompt)), 'the queued name is adjusted when its bank is ready');
});

test('timeline adjustments run a few at a time instead of strictly one by one', async () => {
    const { createTimelineAdjust } = await import('../cores/decision/bank-timeline.js');
    let active = 0;
    let peak = 0;
    const list = ['A', 'B', 'C', 'D', 'E'].map(name => ({ sourceKey: `k:${name}`, name, status: 'ready', text: `***${name}***`, sourceKind: 'lorebook entry' }));
    const adjust = createTimelineAdjust({
        call: async () => { active += 1; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 5)); active -= 1; return '***X***\nAdjusted.'; },
        getSettings: () => ({ decider: { workerId: 'director' } }),
        publishEvent: () => {},
        bankStore: { putBase: async () => {}, putChat: async () => {} },
        records: () => list,
        matchesName: (record, name) => record.name === name,
        currentTimeline: () => 'Arc 1',
        queue: { add: () => {} },
    });
    const result = await adjust.applyTimeline({ timeline: 'Arc 1', timelineBanks: list.map(record => ({ name: record.name, note: '' })) });
    assert.equal(result.adjusted, 5);
    assert.equal(peak, 3);
});

test('a failed adjust is not repeated on every chat load until the frame changes; reasoning is off', async () => {
    const world = build({ adjust: () => '' });
    await world.banks.ensureColdStart();
    world.setBrief({ text: 'TIMELINE:\nBefore the war.', timeline: 'Before the war.' });
    await world.banks.applyTimeline({});
    const first = world.adjustCalls.length;
    assert.ok(first >= 1);
    assert.ok(world.adjustCalls.every(params => params.reasoningMode === 'disabled'));
    await world.banks.applyTimeline({});
    assert.equal(world.adjustCalls.length, first, 'the same frame is not retried');
    world.setBrief({ text: 'TIMELINE:\nAfter the war.', timeline: 'After the war.' });
    await world.banks.applyTimeline({});
    assert.ok(world.adjustCalls.length > first, 'a new frame is tried again');
});
