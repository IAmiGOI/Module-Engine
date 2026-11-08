import test from 'node:test';
import assert from 'node:assert/strict';
import { createCharacterBanks } from '../cores/decision/banks.js';
import { BANK_BUILDER_VERSION } from '../libraries/core/decision-banks.js';

const CARD = { avatar: 'Aria.png', name: 'Aria', description: 'A courier.' };

const SECTIONED = `***Aria***
Material 1 — Appearance
- Grey coat, one long scar over the brow.
Material 3 — Life facts
- **Timeline lock** — she has not yet reached the capital.
Material 6 — Abilities
- Runs for hours; her knee gives out after two.
Spiritual 4 — Needs and goals
- To find her brother before winter.
Spiritual 6 — Resolving
- Keeps a promise even when it costs her the job.
IMPORTANCE: key`;

function build({ bankText = SECTIONED, builderVersion = BANK_BUILDER_VERSION } = {}) {
    const memory = new Map();
    const events = [];
    const key = (namespace, name) => `${namespace}:${name}`;
    let times = { 1: '2026-03-07 04:15' };
    const call = async (contract, params = {}) => {
        if (contract === 'storage.chatMemory.get') return memory.has(key(params.namespace, params.key)) ? structuredClone(memory.get(key(params.namespace, params.key))) : params.fallback;
        if (contract === 'storage.chatMemory.set') { memory.set(key(params.namespace, params.key), structuredClone(params.value)); return true; }
        if (contract === 'storage.settings.get') return params.fallback;
        if (contract === 'storage.settings.set') return true;
        if (contract === 'chatHistory.annotations') return times;
        if (contract === 'lorebook.entries') return [];
        return undefined;
    };
    const callService = async contract => (contract === 'stCharacter.chatCharacters' ? [CARD] : contract === 'stCharacter.persona' ? null : []);
    const researcher = {
        start({ system }) {
            const name = /CHARACTER: (.+)/.exec(system)?.[1] ?? 'Unknown';
            return { ok: true, taskId: 't', done: Promise.resolve({ error: null, report: bankText.replace('***Aria***', `***${name}***`), status: 'done' }) };
        },
    };
    const store = { library: () => ({}), clock: () => ({ minutes: 7 * 1440 + 4 * 60 + 15, updatedAt: 1 }) };
    const banks = createCharacterBanks({
        call, callService, researcher, store,
        getSettings: () => ({ bankColdStart: 'build', researcher: { workerId: 'subagent', maxSteps: 8 }, bankColdStartTimeoutMs: 500 }),
        getWorkers: () => [],
        publishEvent: (event, payload) => events.push([event, payload]),
    });
    return { banks, memory, events, setTime: next => { times = next; } };
}

async function ready(options) {
    const world = build(options);
    await world.banks.ensureColdStart();
    // Сборщик-фейк ставит свою версию: иначе банк считается старым и не переводится по разделам.
    const chatKey = [...world.memory.keys()].find(name => name.endsWith(':characterBanks') && [...world.memory.get(name).values?.() ?? []].length);
    const stored = world.memory.get(chatKey);
    if (stored) world.memory.set(chatKey, Object.fromEntries(Object.entries(stored).map(([key, record]) => [key, { ...record, builderVersion: options?.builderVersion ?? BANK_BUILDER_VERSION }])));
    await world.banks.reload();
    return world;
}

test('a bank built by the current builder is split into the Great Bank sections on sync', async () => {
    const world = await ready();
    const near = await world.banks.nearContext(['Aria']);
    assert.match(near, /Material 1 · Appearance/);
    assert.match(near, /Grey coat, one long scar/);
    assert.match(near, /Spiritual 6 · Resolving/);
    assert.match(near, /Keeps a promise/);
});

test('a legacy free-text bank is not translated: it shows as its own text', async () => {
    const world = await ready({ bankText: '***Aria***\n**Core goal** — Find her brother.', builderVersion: 4 });
    const near = await world.banks.nearContext(['Aria']);
    assert.match(near, /Find her brother/);
    assert.doesNotMatch(near, /Material 1 · Appearance/, 'nothing was invented for the old bank');
});

test('bank_edit changes several characters in one call and answers with the changed lines', async () => {
    const world = await ready();
    const result = await world.banks.edit({
        comment: 'The fight cost them something.',
        edits: [
            { character: 'Aria', section: 'abilities', old: 'her knee gives out after two', new: 'Her knee gives out after one hour.' },
            { character: 'Aria', section: 'carried', old: '', new: 'A cracked lantern.', until: 'dawn' },
            { character: 'Lena', section: 'clothing', old: '', new: 'A patched sailor coat.' },
        ],
    });
    assert.equal(result.ok, true);
    assert.equal(result.changes.length, 3);
    assert.deepEqual(result.created, ['Lena']);
    const abilities = result.changes[0];
    assert.match(abilities.line, /^\[2026-03-07 04:15\] Her knee gives out after one hour\.$/, 'the line carries the turn\'s RP time');
    assert.match(result.changes[1].line, /\[until 2026-03-07 06:00\]$/, 'dawn is turned into an absolute deadline');
    const near = await world.banks.nearContext(['Aria', 'Lena']);
    assert.match(near, /Her knee gives out after one hour\./);
    assert.doesNotMatch(near, /her knee gives out after two/, 'the old line is gone');
    assert.match(near, /A patched sailor coat/);
});

test('the resolver writes material straight away and keeps a spiritual edit as a proposal', async () => {
    const world = await ready();
    const result = await world.banks.edit({ comment: 'What the turn showed.', edits: [
        { character: 'Aria', section: 'carried', old: '', new: 'A stolen key.' },
        { character: 'Aria', section: 'values', old: '', new: 'Hates being owned.' },
    ] }, { by: 'resolver' });
    assert.equal(result.changes.find(change => change.part === 'material').pending, false);
    assert.equal(result.changes.find(change => change.part === 'spiritual').pending, true);
    const pending = await world.banks.great.pending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].character, 'Aria');
    assert.equal(pending[0].items[0].new, 'Hates being owned.');
    const near = await world.banks.nearContext(['Aria']);
    assert.match(near, /A stolen key/);
    assert.doesNotMatch(near, /Hates being owned/, 'a proposal is not in the bank until the director accepts it');
});

test('the director accepts a proposal and it then appears in the bank, with the resolver named as its author', async () => {
    const world = await ready();
    await world.banks.edit({ comment: 'The turn showed it.', edits: [{ character: 'Aria', section: 'values', old: '', new: 'Hates being owned.' }] }, { by: 'resolver' });
    const accepted = await world.banks.great.resolvePending({ character: 'Aria', accept: true, index: 0 });
    assert.equal(accepted.ok, true);
    const near = await world.banks.nearContext(['Aria']);
    assert.match(near, /Hates being owned\./);
    assert.deepEqual(await world.banks.great.pending(), []);
    const history = await world.banks.great.historyFor('Aria');
    assert.equal(history.at(-1).by, 'director');
});

test('a rebuilt bank moves its changes into the edit history instead of losing them', async () => {
    const world = await ready();
    await world.banks.edit({ comment: 'The turn showed it.', edits: [{ character: 'Aria', section: 'appearance', old: '', new: 'A new cut over the eye.' }] });
    const chatKey = [...world.memory.keys()].find(name => name.endsWith(':characterBanks'));
    const stored = world.memory.get(chatKey);
    const aria = Object.entries(stored).find(([, record]) => record?.name === 'Aria');
    world.memory.set(chatKey, { ...stored, [aria[0]]: { ...aria[1], text: `${aria[1].text}\nMaterial 1 — Appearance\n- A new cut over the eye, healed to a thin line.`, builderVersion: BANK_BUILDER_VERSION } });
    await world.banks.reload();
    const near = await world.banks.nearContext(['Aria']);
    assert.match(near, /healed to a thin line/);
    const history = await world.banks.great.historyFor('Aria');
    assert.ok(history.some(item => item.by === 'builder' && /healed to a thin line/.test(item.new)));
});

test('importance levels are set on a character, and an unknown one is created at "temporary"', async () => {
    const world = await ready();
    const set = await world.banks.great.setImportance({ character: 'Aria', importance: 'main' });
    assert.equal(set.importance, 'main');
    const created = await world.banks.edit({ comment: 'He spoke up.', edits: [{ character: 'Kadomon', section: 'appearance', old: '', new: 'A round green face.' }] });
    assert.deepEqual(created.created, ['Kadomon']);
    const state = await world.banks.great.load();
    assert.equal(state.kadomon.importance, 'temporary');
    assert.equal(state.aria.importance, 'main');
});

test('the far projection carries only Material 1, 3, 6 and Spiritual 4, 6 of every character', async () => {
    const world = await ready();
    await world.banks.edit({ comment: 'A detail about property.', edits: [{ character: 'Aria', section: 'property', old: '', new: 'A rented room above a chandlery.' }] });
    const far = await world.banks.farContext();
    assert.match(far, /Grey coat/);
    assert.match(far, /Keeps a promise/);
    assert.doesNotMatch(far, /A rented room above a chandlery/, 'Property stays out of the compact projection');
    const near = await world.banks.nearContext(['Aria']);
    assert.match(near, /A rented room above a chandlery/);
});

test('the writer gets the active banks and no Decrees until the Decree phase exists', async () => {
    const world = await ready();
    const writer = await world.banks.writerContext(['Aria']);
    assert.match(writer.banks, /Grey coat/);
    assert.equal(writer.decrees, '');
});

test('the writer still gets the scene card: it describes the world, not a character, and stays out of the Great Bank', async () => {
    const world = await ready();
    const writer = await world.banks.writerContext(['Aria']);
    assert.match(writer.banks, /Grey coat/);
    assert.equal(writer.banks.includes('World / Scene'), false, 'no scene source in this fixture');
    const records = world.banks.records();
    assert.ok(records.some(record => record.sourceKind === 'card'));
});

test('knowledge hangs on the character record in the Great Bank, not in a separate map', async () => {
    const { createKnowledge } = await import('../cores/decision/knowledge.js');
    const world = await ready();
    // Ядро знаний ходит в память чата тем же контрактом, что и банки.
    const call = async (contract, params = {}) => {
        const key = `${params.namespace}:${params.key}`;
        if (contract === 'storage.chatMemory.get') return world.memory.has(key) ? structuredClone(world.memory.get(key)) : params.fallback;
        if (contract === 'storage.chatMemory.set') { world.memory.set(key, structuredClone(params.value)); return true; }
        throw new Error(contract);
    };
    const bound = createKnowledge({ call, store: { clock: () => ({ minutes: 0 }) }, banks: world.banks });
    const added = await bound.handlers.character_knowledge({ op: 'add', character: 'aria', fact: 'The gate is open.', source: 'saw', comment: 'Aria saw it.' });
    assert.equal(added.ok, true);
    const state = await world.banks.great.load();
    assert.equal(state.aria.knowledge.items.length, 1, 'the fact lives on the character record');
    assert.match(await bound.textFor(['Aria']), /The gate is open/);
    assert.equal(world.memory.has('core.decision:knowledge'), false, 'nothing was written to the old separate store');
});
