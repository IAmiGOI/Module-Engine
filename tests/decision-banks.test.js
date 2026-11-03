import test from 'node:test';
import assert from 'node:assert/strict';
import { createCharacterBanks } from '../cores/decision/banks.js';
import { characterLorebookEntries, bankSourcesForChat, hashText, planLorebookMarking, lorebookHash, bankIsReady, createBankRecord, BANK_BUILDER_VERSION } from '../libraries/core/decision-banks.js';

const CARD = { avatar: 'Aria.png', name: 'Aria', description: 'A courier.', personality: 'Quiet.', scenario: 'A rain-soaked port.', mes_example: '<START>\n{{char}}: "Rain."' };
const PERSONA = { avatar: 'me.png', name: 'Me', description: 'A traveller in a grey coat.' };
const LOREBOOK = [
    { book: 'World', uid: 1, comment: '-- CHARACTERS --', content: '' },
    { book: 'World', uid: 2, comment: 'Lena', content: 'Lena keeps the lighthouse.' },
    { book: 'World', uid: 3, comment: 'Bram', content: 'Bram sells rope.' },
    { book: 'World', uid: 4, comment: '-- PLACES --', content: '' },
    { book: 'World', uid: 5, comment: 'The Port', content: 'A wet harbour.' },
];

function fakeWorld({ cards = [CARD], persona = PERSONA, entries = LOREBOOK, settings = {}, failName = 'Bram', markReply = null, importances = {} } = {}) {
    const settingsStore = new Map();
    const chatMemory = new Map();
    const base = {};
    const calls = [];
    const markCalls = [];
    let active = 0;
    let maxActive = 0;
    const key = (namespace, name) => `${namespace}:${name}`;
    const call = async (contract, params = {}) => {
        if (contract === 'storage.settings.get') return settingsStore.has(key(params.namespace, params.key)) ? settingsStore.get(key(params.namespace, params.key)) : params.fallback;
        if (contract === 'storage.settings.set') { settingsStore.set(key(params.namespace, params.key), params.value); return true; }
        if (contract === 'storage.chatMemory.get') return chatMemory.has(key(params.namespace, params.key)) ? chatMemory.get(key(params.namespace, params.key)) : params.fallback;
        if (contract === 'storage.chatMemory.set') { chatMemory.set(key(params.namespace, params.key), params.value); return true; }
        if (contract === 'lorebook.entries') return entries;
        if (contract === 'model.generate') {
            markCalls.push(params);
            return { text: '', toolCalls: [{ id: 'mark', name: 'mark_lorebook_characters', arguments: { comment: 'These entries describe single characters.', characters: markReply ?? [] } }] };
        }
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
                resolve(failed ? { error: 'canon lookup failed', report: '', status: 'done' } : { error: null, report: `***${name}***\nBuilt bank.${importances[name] ? `\nIMPORTANCE: ${importances[name]}` : ''}`, status: 'done' });
            }, 5));
            return { ok: true, taskId: `task_${calls.length}`, done };
        },
    };
    const banks = createCharacterBanks({
        call, callService, researcher,
        getSettings: () => ({ researcher: { workerId: 'subagent', maxSteps: 8 }, bankColdStartTimeoutMs: 500, ...(markReply ? { decider: { workerId: 'director' } } : {}), ...settings }),
        getWorkers: () => [{ id: 'director', format: 'openai', model: 'director/model' }],
        store: { library: () => ({}) },
        publishEvent: () => {},
    });
    return { banks, calls, markCalls, call, callService, settingsStore, chatMemory, maxActive: () => maxActive, base };
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

test('cold start builds a bank for every source, at most four bank builders at once, and the first turn waits for it', async () => {
    const world = fakeWorld();
    const result = await world.banks.ensureColdStart();
    assert.equal(result.status, 'ready');
    const keys = world.banks.records().map(record => record.sourceKey).sort();
    assert.deepEqual(keys, ['card:Aria.png', 'lorebook:World:2', 'lorebook:World:3', 'persona:me.png', 'scene:Aria.png']);
    assert.ok(world.calls.length >= 4, 'one task per character source');
    assert.ok(world.maxActive() <= 4, 'no more than four bank builders at once');
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


test('the director marks a villain outside the characters section; the marked entry becomes a bank with a clean name and aliases; the builder decides the key size', async () => {
    const entries = [
        { book: 'Story', uid: 1, comment: '-- VILLAINS AND SIN ARCHBISHOPS --', content: '' },
        { book: 'Story', uid: 2, comment: 'Rem (Still comatose lmao)', keys: ['Rem-tan'], content: 'A demon maid.' },
        { book: 'Story', uid: 3, comment: 'The family', content: 'A whole family entry.' },
    ];
    const world = fakeWorld({ entries, markReply: [{ uid: 2, name: 'Rem', aliases: ['Rem-tan'], franchise: '' }], failName: null, importances: { Rem: 'key' } });
    await world.banks.ensureColdStart();
    const rem = world.banks.records().find(record => record.sourceKey === 'lorebook:Story:2');
    assert.equal(rem.name, 'Rem');
    assert.equal(rem.sizeBand, 'key');
    assert.equal(rem.text, '***Rem***\nBuilt bank.', 'the IMPORTANCE line is cut from the bank');
    assert.deepEqual(rem.aliases, ['Rem-tan']);
    assert.equal(world.banks.records().some(record => record.sourceKey === 'lorebook:Story:3'), false, 'an unmarked group entry is not a character');
});

test('marking is cached per entry: an unchanged book is not marked again, a changed entry is', async () => {
    const entries = [{ book: 'Story', uid: 1, comment: 'Rem', content: 'A demon maid.' }];
    const world = fakeWorld({ entries, markReply: [{ uid: 1, name: 'Rem', importance: 'minor' }], failName: null });
    await world.banks.ensureColdStart();
    assert.equal(world.markCalls.length, 1);
    await newChat(world);
    await world.banks.ensureColdStart();
    assert.equal(world.markCalls.length, 1, 'the same book list needs no new marking');
    entries[0].content = 'A demon maid with a new scar.';
    await newChat(world);
    await world.banks.ensureColdStart();
    assert.equal(world.markCalls.length, 2, 'a changed entry is marked again');
});

test('when marking fails, the section fallback is used and the cold start carries a warning', async () => {
    const world = fakeWorld();
    const result = await world.banks.ensureColdStart();
    assert.ok(result.warnings.some(warning => /was not marked/.test(warning)));
    assert.equal(world.banks.records().some(record => record.name === 'Lena'), true, 'the section fallback still found Lena');
});

test('a clean marked name and its aliases match the roster, so no empty short bank is created', async () => {
    const entries = [
        { book: 'Story', uid: 1, comment: '-- VILLAINS --', content: '' },
        { book: 'Story', uid: 2, comment: 'Rem (Still comatose lmao)', key: ['Rem-tan'], content: 'A demon maid.' },
    ];
    const world = fakeWorld({ entries, markReply: [{ uid: 2, name: 'Rem', aliases: ['Rem-tan'], importance: 'key', franchise: '' }], failName: null });
    await world.banks.ensureColdStart();
    const before = world.banks.records().length;
    const rem = await world.banks.ensureName('Rem');
    const alias = await world.banks.ensureName('Rem-tan');
    assert.equal(rem.status, 'ready');
    assert.equal(alias.sourceKey, rem.sourceKey);
    assert.equal(world.banks.records().length, before, 'no extra short bank was created');
    assert.equal(world.calls.at(-1).system.includes('ALSO KNOWN AS: Rem-tan'), true);
});

test('the franchise from the marking reaches the subagent prompt, and an empty franchise stays empty', async () => {
    const entries = [{ book: 'Story', uid: 1, comment: 'Rem', content: 'A demon maid.' }];
    const withFranchise = fakeWorld({ entries, markReply: [{ uid: 1, name: 'Rem', aliases: ['Rem-tan'], importance: 'key', franchise: 'Re:Zero' }], failName: null });
    await withFranchise.banks.ensureColdStart();
    assert.match(withFranchise.calls.at(-1).system, /FRANCHISE: Re:Zero/);
    assert.match(withFranchise.calls.at(-1).system, /ALSO KNOWN AS: Rem-tan/);

    const original = fakeWorld({ entries, markReply: [{ uid: 1, name: 'Rem', importance: 'minor', franchise: '' }], failName: null });
    await original.banks.ensureColdStart();
    assert.match(original.calls.at(-1).system, /FRANCHISE: \n/);
});

test('a new lorebook entry is the only one sent for marking; the marks of the old entries are kept', async () => {
    const entries = [
        { book: 'Story', uid: 1, comment: 'Rem (Still comatose lmao)', content: 'A demon maid.' },
        { book: 'Story', uid: 2, comment: 'The Mansion', content: 'A big house.' },
    ];
    const world = fakeWorld({ entries, markReply: [{ uid: 1, name: 'Rem', importance: 'key' }], failName: null });
    await world.banks.ensureColdStart();
    assert.equal(world.markCalls.length, 1);

    entries.push({ book: 'Story', uid: 3, comment: 'Alley ambush fight', content: 'The memory graph wrote this event.' });
    await newChat(world);
    await world.banks.ensureColdStart();
    assert.equal(world.markCalls.length, 2);
    const sent = JSON.stringify(world.markCalls[1].messages);
    assert.match(sent, /Alley ambush fight/);
    assert.doesNotMatch(sent, /1 \| Rem \(Still comatose/, 'old entries are not sent again');
    assert.doesNotMatch(sent, /The Mansion/, 'old entries are not sent again');
    const rem = world.banks.records().find(record => record.sourceKey === 'lorebook:Story:1');
    assert.equal(rem.name, 'Rem', 'the old mark survives the new marking');
});

test('the marking plan drops marks of removed and changed entries and treats a matching legacy record as fully reviewed', () => {
    const list = [
        { uid: 1, comment: 'Rem', content: 'A demon maid.' },
        { uid: 2, comment: 'Ram', content: 'Her sister, edited.' },
    ];
    const legacy = { sourceHash: lorebookHash(list), marks: [{ uid: 1, name: 'Rem' }, { uid: 2, name: 'Ram' }] };
    assert.equal(planLorebookMarking(legacy, list).toMark.length, 0, 'a legacy record that matches the whole book needs no request');

    const first = planLorebookMarking(null, [{ uid: 1, comment: 'Rem', content: 'A demon maid.' }, { uid: 2, comment: 'Ram', content: 'Her sister.' }, { uid: 9, comment: 'Gone', content: 'Removed later.' }]);
    const stored = { ...first, marks: [{ uid: 1, name: 'Rem' }, { uid: 2, name: 'Ram' }, { uid: 9, name: 'Gone' }] };
    const plan = planLorebookMarking(stored, list);
    assert.deepEqual(plan.toMark.map(entry => entry.uid), [2], 'only the changed entry is marked again');
    assert.deepEqual(plan.kept.map(mark => mark.uid), [1], 'the changed and the removed entries lose their old marks');
});

test('a bank built before the current builder version is not ready, so the broken banks are rebuilt; a manual bank stays', () => {
    const old = createBankRecord({ sourceKey: 'card:A', sourceKind: 'card', name: 'A', text: 'The researcher returned no report.', status: 'ready' });
    assert.equal(bankIsReady(old), false);
    assert.equal(bankIsReady({ ...old, builderVersion: BANK_BUILDER_VERSION, text: '***A***' }), true);
    assert.equal(bankIsReady(createBankRecord({ sourceKey: 'manual:a', sourceKind: 'manual', name: 'A', text: 'by hand', status: 'ready' })), true);
});

test('the persona and the scene are always key; without an IMPORTANCE line an ordinary character stays minor', async () => {
    const world = fakeWorld({ failName: null });
    await world.banks.ensureColdStart();
    const records = world.banks.records();
    assert.equal(records.find(record => record.sourceKind === 'persona').sizeBand, 'key');
    const scene = records.find(record => record.sourceKind === 'scene');
    if (scene) assert.equal(scene.sizeBand, 'key');
    assert.ok(records.filter(record => record.sourceKind === 'lorebook entry').every(record => record.sizeBand === 'minor'));
});

test('a cold start finished by an older bank builder runs again once, and a current one does not', async () => {
    const world = fakeWorld({ failName: null });
    await world.banks.ensureColdStart();
    const built = world.calls.length;
    await world.banks.ensureColdStart();
    assert.equal(world.calls.length, built, 'a current cold start is not repeated');
    for (const [name, value] of world.chatMemory) {
        if (value && typeof value === 'object' && 'builderVersion' in value && 'status' in value && !('sourceKey' in value)) world.chatMemory.set(name, { ...value, builderVersion: 2 });
    }
    const chatBanks = [...world.chatMemory].find(([, value]) => value && typeof value === 'object' && Object.values(value).some(record => record?.sourceKey));
    world.chatMemory.set(chatBanks[0], Object.fromEntries(Object.entries(chatBanks[1]).map(([sourceKey, record]) => [sourceKey, { ...record, builderVersion: 2 }])));
    world.settingsStore.clear();
    await world.banks.reload();
    await world.banks.ensureColdStart();
    assert.ok(world.calls.length > built, 'banks of the old builder are rebuilt');
});
