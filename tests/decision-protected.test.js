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

test('a reroll hides the discarded version of the turn, marks the turn as REROLL and adds the reroll rule', async () => {
    memory.clear();
    const store = makeStore();
    const entries = [
        { kind: 'turn', turn: 1, text: 'TURN 1 (compressed)\nUser: Hello there.\nPush: Emilia waves.' },
        { kind: 'turn', turn: 2, text: 'TURN 2 (compressed)\nUser: I whisper to Puck.\nassess Sasha: 0.15 → botched\nWriter: Emilia hears everything.' },
        { kind: 'fact', turn: 2, text: 'character_knowledge Puck: learned the secret' },
    ];
    store.window = () => ({ entries });
    const context = createCycleContext({ call, store, banks: null });
    const chat = [{ mes: 'I whisper to Puck.', is_user: true }];
    const { DIRECTOR_REROLL } = await import('../libraries/core/decision-prompts.js');
    const reroll = await context.runContext({ settings: { promptSections: {} }, chat, worker: { id: 'director' }, reroll: true, task: `Play the turn.\n\n${DIRECTOR_REROLL}` });
    const text = reroll.messages.map(message => message.content).join('\n');
    assert.doesNotMatch(text, /Emilia hears everything|learned the secret|0\.15 → botched/, 'nothing of the discarded version is shown');
    assert.match(text, /TURN 2 — REROLL: your earlier version of this turn was discarded, none of it happened\nUser: I whisper to Puck\./);
    assert.match(text, /Emilia waves/, 'the turns before it stay');
    assert.match(reroll.messages.at(-1).content, /REROLL: the user discarded your previous version/);

    const failedFirst = await context.runContext({ settings: { promptSections: {} }, chat: [{ mes: 'A brand new message.', is_user: true }], worker: { id: 'director' }, reroll: true });
    assert.match(failedFirst.messages.map(message => message.content).join('\n'), /Emilia hears everything/, 'a turn with another message is a real past turn and stays');
});

test('a reroll keeps the message to the director written after the discarded turn', async () => {
    memory.clear();
    const store = makeStore();
    store.window = () => ({ entries: [
        { kind: 'turn', turn: 1, text: 'TURN 1 (compressed)\nUser: Hello there.' },
        { kind: 'turn', turn: 2, text: 'TURN 2 (compressed)\nUser: I ask for help.\nWriter: no gate.' },
        { kind: 'fact', turn: 2, text: 'update_roster: + Kadomon' },
        { kind: 'message', turn: 2, text: 'MESSAGE TO THE DIRECTOR (compressed)\nUser: My gate works — write it, I will reroll.' },
        { kind: 'fact', turn: 2, text: 'write_chat_brief — the chat brief now reads:\nSasha has a large gate.' },
    ] });
    const context = createCycleContext({ call, store, banks: null });
    const built = await context.runContext({ settings: { promptSections: {} }, chat: [{ mes: 'I ask for help.', is_user: true }], worker: { id: 'director' }, reroll: true });
    const text = built.messages.map(message => message.content).join('\n');
    assert.doesNotMatch(text, /Writer: no gate|\+ Kadomon/, 'the discarded turn and its own facts are gone');
    assert.match(text, /My gate works — write it/, 'the retcon message stays');
    assert.match(text, /Sasha has a large gate/, 'and so does the new brief');
});
