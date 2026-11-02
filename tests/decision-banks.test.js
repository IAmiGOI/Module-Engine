import test from 'node:test';
import assert from 'node:assert/strict';
import { createCharacterBanks } from '../cores/decision/banks.js';
import { characterLorebookEntries, bankSourcesForChat, hashText } from '../libraries/core/decision-banks.js';

const CARD = { avatar: 'Aria.png', name: 'Aria', description: 'A courier.', personality: 'Quiet.', scenario: 'A rain-soaked port.', mes_example: '<START>\n{{char}}: "Rain."' };
const PERSONA = { avatar: 'me.png', name: 'Me', description: 'A traveller in a grey coat.' };
const LOREBOOK = [
    { book: 'World', uid: 1, comment: '-- CHARACTERS --', content: '' },
    { book: 'World', uid: 2, comment: 'Lena', content: 'Lena keeps the lighthouse.' },
    { book: 'World', uid: 3, comment: 'Bram', content: 'Bram sells rope.' },
    { book: 'World', uid: 4, comment: '-- PLACES --', content: '' },
    { book: 'World', uid: 5, comment: 'The Port', content: 'A wet harbour.' },
];

function fakeWorld({ cards = [CARD], persona = PERSONA, entries = LOREBOOK, settings = {}, failName = 'Bram' } = {}) {
    const settingsStore = new Map();
    const chatMemory = new Map();
    const base = {};
    const calls = [];
    let active = 0;
    let maxActive = 0;
    const key = (namespace, name) => `${namespace}:${name}`;
    const call = async (contract, params = {}) => {
        if (contract === 'storage.settings.get') return settingsStore.has(key(params.namespace, params.key)) ? settingsStore.get(key(params.namespace, params.key)) : params.fallback;
        if (contract === 'storage.settings.set') { settingsStore.set(key(params.namespace, params.key), params.value); return true; }
        if (contract === 'storage.chatMemory.get') return chatMemory.has(key(params.namespace, params.key)) ? chatMemory.get(key(params.namespace, params.key)) : params.fallback;
        if (contract === 'storage.chatMemory.set') { chatMemory.set(key(params.namespace, params.key), params.value); return true; }
        if (contract === 'lorebook.entries') return entries;
        return undefined;
    };
    const callService = async contract => (contract === 'stCharacter.chatCharacters' ? cards : contract === 'stCharacter.persona' ? persona : []);
    const researcher = {
        start({ system, kind, notify }) {
            calls.push({ system, kind, notify });
            const name = /CHARACTER: (.+)/.exec(system)?.[1] ?? 'Unknown';
            active += 1;
            maxActive = Math.max(maxActive, active);
            const done = new Promise(resolve => setTimeout(() => {
                active -= 1;
                const failed = failName !== null && name === failName;
                resolve(failed ? { error: 'canon lookup failed', report: '', status: 'done' } : { error: null, report: `***${name}***\nBuilt bank.`, status: 'done' });
            }, 5));
            return { ok: true, taskId: `task_${calls.length}`, done };
        },
    };
    const banks = createCharacterBanks({
        call, callService, researcher,
        getSettings: () => ({ researcher: { workerId: 'subagent', maxSteps: 8 }, bankColdStartTimeoutMs: 500, ...settings }),
        store: { library: () => ({}) },
        publishEvent: () => {},
    });
    return { banks, calls, call, callService, settingsStore, chatMemory, maxActive: () => maxActive, base };
}

async function newChat(world) {
    world.chatMemory.clear();
    await world.banks.reload();
}

test('lorebook characters are separated by the -- CHARACTERS -- section, not taken from every entry', () => {
    const entries = characterLorebookEntries(LOREBOOK);
    assert.deepEqual(entries.map(entry => entry.comment), ['Lena', 'Bram']);
    assert.equal(entries.some(entry => entry.comment === 'The Port'), false);
});

test('cold start builds a bank for every source, at most two subagents at once, and the first turn waits for it', async () => {
    const world = fakeWorld();
    const result = await world.banks.ensureColdStart();
    assert.equal(result.status, 'ready');
    const keys = world.banks.records().map(record => record.sourceKey).sort();
    assert.deepEqual(keys, ['card:Aria.png', 'lorebook:World:2', 'lorebook:World:3', 'persona:me.png', 'scene:Aria.png']);
    assert.ok(world.calls.length >= 4, 'one task per character source');
    assert.ok(world.maxActive() <= 2, 'no more than two subagent tasks at once');
    const lena = world.banks.records().find(record => record.name === 'Lena');
    assert.equal(lena.status, 'ready');
    assert.match(lena.text, /Built bank/);
    assert.match(lena.rawSource, /lighthouse/);
});

test('a second chat with the same characters copies the base banks without a single model request', async () => {
    const world = fakeWorld({ failName: null });
    await world.banks.ensureColdStart();
    const first = world.calls.length;
    await newChat(world);
    const result = await world.banks.ensureColdStart();
    assert.equal(result.status, 'ready');
    assert.equal(world.calls.length, first, 'no subagent call on the second chat');
    assert.equal(world.banks.records().length, 5);
    assert.ok(world.banks.records().every(record => record.status === 'ready'));
});

test('a changed source is rebuilt, while the unchanged ones are reused', async () => {
    const world = fakeWorld({ failName: null });
    await world.banks.ensureColdStart();
    const first = world.calls.length;
    CARD.description = 'A courier with a new scar.';
    await newChat(world);
    await world.banks.ensureColdStart();
    assert.equal(world.calls.length, first + 1, 'only the changed card is rebuilt');
    assert.equal(world.calls.at(-1).system.includes('a new scar'), true);
});

test('one failed bank stays marked with its raw source; the others are ready', async () => {
    const world = fakeWorld();
    const result = await world.banks.ensureColdStart();
    assert.equal(result.status, 'ready');
    const bram = world.banks.records().find(record => record.name === 'Bram');
    assert.equal(bram.status, 'error');
    assert.match(bram.error, /canon lookup failed/);
    assert.match(bram.rawSource, /sells rope/);
    assert.equal(world.banks.records().filter(record => record.name === 'Lena')[0].status, 'ready');
});

test('a manual bank edit is stored in the chat copy and read back', async () => {
    const world = fakeWorld();
    const written = await world.banks.write({ name: 'Aria', text: '***Aria***\nA new bank.' });
    assert.equal(written.ok, true);
    const [bank] = await world.banks.read({ name: 'Aria' });
    assert.equal(bank.text, '***Aria***\nA new bank.');
    assert.equal(bank.status, 'ready');
});

test('a new roster name without a source gets a short bank immediately and a background rebuild', async () => {
    const world = fakeWorld();
    const short = await world.banks.ensureName('Bram');
    assert.equal(short.status, 'short');
    assert.match(short.text, /Bram/);
    await new Promise(done => setTimeout(done, 20));
    const full = world.banks.records().find(record => record.name === 'Bram');
    assert.ok(['ready', 'error'].includes(full.status));
});

test('the source keys from a card, persona and scene are stable and hashed by content', () => {
    const sources = bankSourcesForChat({ cards: [CARD], persona: PERSONA, lorebookEntries: LOREBOOK });
    assert.equal(sources.find(source => source.sourceKey === 'card:Aria.png').sizeBand, 'key');
    assert.equal(sources.find(source => source.sourceKey === 'scene:Aria.png').sourceKind, 'scene');
    assert.equal(sources.find(source => source.sourceKey === 'persona:me.png').sourceKind, 'persona');
    assert.notEqual(hashText('one'), hashText('two'));
});

test('the writer sees only active banks, the persona and the scene; the director can see all', async () => {
    const world = fakeWorld({ failName: null });
    await world.banks.ensureColdStart();
    const writer = world.banks.contextFor({ names: ['Aria'], all: false });
    assert.match(writer.text, /Aria/);
    assert.match(writer.text, /World \/ Scene/);
    assert.match(writer.text, /Me/);
    assert.doesNotMatch(writer.text, /Bram/);
    const director = world.banks.contextFor({ all: true });
    assert.match(director.text, /Bram/);
});

test('a card system prompt and mes_example never enter the bank source; examples travel separately', () => {
    const card = { avatar: 'A.png', name: 'A', description: 'Body.', personality: '', scenario: '', system_prompt: 'SYSTEM-CARD', mes_example: '<START>\n{{char}}: "Hi."' };
    const sources = bankSourcesForChat({ cards: [card] });
    const cardSource = sources.find(source => source.sourceKind === 'card');
    assert.equal(cardSource.source.includes('SYSTEM-CARD'), false);
    assert.equal(cardSource.source.includes('{{char}}'), false);
    assert.match(cardSource.examples, /\{\{char\}\}: "Hi\."/);
});
