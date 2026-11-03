import test from 'node:test';
import assert from 'node:assert/strict';
import { createCycleContext } from '../cores/decision/cycle-context.js';

const memory = new Map();
const call = async (contract, params = {}) => {
    if (contract === 'storage.chatMemory.get') return memory.has(params.key) ? structuredClone(memory.get(params.key)) : params.fallback;
    if (contract === 'storage.chatMemory.set') { memory.set(params.key, structuredClone(params.value)); return true; }
    if (contract === 'lorebook.books') return [{ name: 'World' }];
    if (contract === 'lorebook.entries') return entries;
    throw new Error(`unexpected ${contract}`);
};

let entries = [
    { uid: 1, book: 'World', comment: 'Old Mill', content: 'The mill stands by the river.', constant: true },
];

function makeStore() {
    let boundary = null;
    let roster = ['Aria'];
    let library = { aria: { name: 'Aria', level: 1 } };
    return {
        roster: () => ({ active: [...roster] }),
        library: () => structuredClone(library),
        plans: () => [], clock: () => ({ minutes: 0 }),
        plan: () => null, arcs: () => [], notes: () => ({}),
        cycles: () => [], digests: () => [],
        boundary: () => boundary,
        saveBoundary: async value => { boundary = value; return value; },
        setRoster: value => { roster = value; },
        setLibrary: value => { library = value; },
    };
}

async function build(store) {
    const context = createCycleContext({ call, store, banks: null });
    return context.runContext({ settings: { promptSections: {} }, chat: [], worker: { id: 'director' } });
}

test('the window boundary is a snapshot: a roster change inside the window does not move blocks 4, 7 and 8', async () => {
    memory.clear();
    const store = makeStore();
    const first = await build(store);
    assert.match(first.messages.map(message => message.content).join('\n'), /Aria/);

    store.setRoster(['Aria', 'Rem']);
    store.setLibrary({ aria: { name: 'Aria', level: 1 }, rem: { name: 'Rem', level: 3 } });
    const second = await build(store);
    const text = second.messages.map(message => message.content).join('\n');
    assert.match(text, /- Aria \(level 1\)/);
    assert.doesNotMatch(text, /Rem \(level 3\)/, 'the library snapshot waits for the window switch');
    assert.doesNotMatch(text, /- Rem/, 'the active roster snapshot waits for the window switch');
});

test('the lorebook snapshot is frozen: new entries wait for the window switch', async () => {
    memory.clear();
    entries = [{ uid: 1, book: 'World', comment: 'Old Mill', content: 'The mill stands by the river.', constant: true }];
    const store = makeStore();
    const first = await build(store);
    assert.match(first.messages.map(message => message.content).join('\n'), /Old Mill/);

    entries = [...entries, { uid: 2, book: 'World', comment: 'New Alley', content: 'The graph wrote this.', constant: true }];
    const second = await build(store);
    const text = second.messages.map(message => message.content).join('\n');
    assert.match(text, /Old Mill/);
    assert.doesNotMatch(text, /New Alley/, 'the snapshot is not refreshed inside the window');
    assert.doesNotMatch(text, /LOREBOOK CHANGES/);
});
