import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnWindow } from '../cores/decision/window.js';
import { normalizeWindow, windowTurnCount } from '../libraries/core/decision-window.js';

const clone = value => JSON.parse(JSON.stringify(value));

function makeStore({ cycles = [], arcs = [], runs = {} } = {}) {
    let win = { entries: [], createdAt: 1000, lastSwitchAt: 1000 };
    let frozen = [];
    let boundary = null;
    let arcList = arcs;
    const library = { aria: { name: 'Aria', level: 1 }, rem: { name: 'Rem', level: 3 } };
    return {
        window: () => clone(win),
        saveWindow: async value => { win = clone(value); return win; },
        frozen: () => clone(frozen),
        saveFrozen: async value => { frozen = clone(value); return frozen; },
        boundary: () => (boundary ? clone(boundary) : null),
        saveBoundary: async value => { boundary = clone(value); return boundary; },
        roster: () => ({ active: ['Aria', 'Rem'] }),
        library: () => clone(library),
        plans: () => [],
        clock: () => ({ minutes: 0 }),
        arcs: () => clone(arcList),
        setArcs: value => { arcList = value; },
        cycles: () => clone(cycles),
        runs: () => clone(runs),
    };
}

function cycle(number) {
    return {
        id: `cyc_${number}`, runId: `run_${number}`, event: 'turn', turn: number, at: number,
        clockMinutes: number, toolCalls: [], messages: [],
        push: `This turn took 5 minutes.\nResolution: resolution ${number}.`,
    };
}

function makeWindow(store, { summary = 'THE SUMMARY', fail = false } = {}) {
    const calls = [];
    const events = [];
    const memory = [];
    const call = async (contract, params = {}) => {
        if (contract === 'model.generate') {
            calls.push(params);
            if (fail) throw new Error('model down');
            return summary;
        }
        if (contract === 'storage.chatMemory.set') { memory.push(params); return true; }
        throw new Error(`unexpected ${contract}`);
    };
    const turnWindow = createTurnWindow({
        store, call, banks: null, now: () => 1000,
        getSettings: () => ({ windowLimit: 50, windowDropShare: 0.6, windowSummaryMaxTokens: 1200 }),
        deciderWorker: () => ({ id: 'director' }),
        publishEvent: (event, payload) => events.push([event, payload]),
    });
    return { turnWindow, calls, events, memory };
}

test('a new cycle only appends: earlier window text stays byte for byte', async () => {
    const cycles = [];
    const store = makeStore({ cycles });
    const { turnWindow } = makeWindow(store);
    cycles.push(cycle(1));
    await turnWindow.recordTurn({ pending: { chat: [{ mes: 'hello', is_user: true }] }, stored: { id: 'run_1', writerText: 'prose one' } });
    const first = turnWindow.entries();
    assert.equal(first.length, 1);
    assert.match(first[0].text, /User: hello/);
    assert.match(first[0].text, /Writer: prose one/);
    cycles.push(cycle(2));
    await turnWindow.recordTurn({ pending: { chat: [{ mes: 'again', is_user: true }] }, stored: { id: 'run_2', writerText: 'prose two' } });
    assert.equal(turnWindow.entries()[0].text, first[0].text, 'the older entry is untouched');
    assert.equal(turnWindow.entries().length, 2);
});

test('the 50th cycle switches the window: 30 leave, 20 stay, and the summary goes into the frozen history', async () => {
    const cycles = [];
    const store = makeStore({ cycles });
    const { turnWindow, calls, events } = makeWindow(store, { summary: 'The first thirty turns are over.' });
    for (let number = 1; number <= 50; number += 1) {
        cycles.push(cycle(number));
        await turnWindow.recordTurn({ pending: { chat: [{ mes: `user ${number}`, is_user: true }] }, stored: { id: `run_${number}`, writerText: `writer ${number}` } });
    }
    assert.equal(windowTurnCount(turnWindow.entries()), 20, 'exactly 60% were dropped');
    assert.equal(turnWindow.frozen().length, 1);
    assert.match(turnWindow.frozen()[0].text, /The first thirty turns/);
    assert.equal(turnWindow.frozen()[0].reason, '50 cycles');
    assert.ok(calls.some(params => /50 cycles/.test(params.prompt)), 'the summary prompt names the reason');
    assert.ok(calls.some(params => /TURN 1 \(compressed\)/.test(params.prompt)), 'the dropped cycles are in the prompt');
    assert.ok(events.some(([event]) => event === 'decision.window.switched'));
});

test('the end of an arc switches the window too, and the summary is marked with the arc', async () => {
    const cycles = [];
    const store = makeStore({ cycles, arcs: [{ id: 'arc_1', title: 'The Escape', status: 'open' }] });
    const { turnWindow, calls } = makeWindow(store, { summary: 'The escape is over.' });
    for (let number = 1; number <= 25; number += 1) {
        cycles.push(cycle(number));
        await turnWindow.recordTurn({ pending: { chat: [{ mes: `user ${number}`, is_user: true }] }, stored: { id: `run_${number}`, writerText: `writer ${number}` } });
    }
    store.setArcs([{ id: 'arc_1', title: 'The Escape', status: 'closed', closedAt: 2000 }]);
    assert.equal(await turnWindow.maybeSwitch(), true);
    assert.equal(turnWindow.frozen()[0].reason, 'the arc ended');
    assert.equal(turnWindow.frozen()[0].arc, 'The Escape');
    assert.ok(calls.some(params => /The Escape/.test(params.prompt)));
    assert.equal(windowTurnCount(turnWindow.entries()), 10, '60% of 25 cycles leave');
});

test('plan and roster facts live in the window and reach the summary; the boundary is refreshed on the switch', async () => {
    const cycles = [];
    const store = makeStore({ cycles, arcs: [{ id: 'arc_1', title: 'Done', status: 'open' }] });
    const { turnWindow, calls } = makeWindow(store, { summary: 'A new plan was made.' });
    for (let number = 1; number <= 5; number += 1) {
        cycles.push(cycle(number));
        await turnWindow.recordTurn({ pending: { chat: [{ mes: `user ${number}`, is_user: true }] }, stored: { id: `run_${number}`, writerText: `writer ${number}` } });
    }
    await turnWindow.addFact('set_character_plan Aria: "find the key"', { turn: 1 });
    await turnWindow.addFact('roster: + Rem', { turn: 5 });
    assert.match(turnWindow.entries().at(-1).text, /roster: \+ Rem/);
    store.setArcs([{ id: 'arc_1', title: 'Done', status: 'closed', closedAt: 2000 }]);
    await turnWindow.maybeSwitch();
    assert.ok(calls.some(params => /find the key/.test(params.prompt)), 'the fact leaves with the dropped cycles and is summarized');
    assert.ok(turnWindow.entries().some(entry => /roster: \+ Rem/.test(entry.text)), 'a fact in the kept cycles stays in the window');
    assert.match(store.boundary().libraryText, /Aria \(level 1\)/);
    assert.equal(typeof store.boundary().plansText, 'string');
});

test('a failed summary still switches the window and keeps the dropped cycles as they are', async () => {
    const cycles = [];
    const store = makeStore({ cycles, arcs: [{ id: 'arc_1', title: 'Done', status: 'open' }] });
    const { turnWindow, events } = makeWindow(store, { fail: true });
    for (let number = 1; number <= 5; number += 1) {
        cycles.push(cycle(number));
        await turnWindow.recordTurn({ pending: { chat: [{ mes: `user ${number}`, is_user: true }] }, stored: { id: `run_${number}`, writerText: `writer ${number}` } });
    }
    store.setArcs([{ id: 'arc_1', title: 'Done', status: 'closed', closedAt: 2000 }]);
    await turnWindow.maybeSwitch();
    assert.equal(turnWindow.frozen()[0].fallback, true);
    assert.match(turnWindow.frozen()[0].text, /TURN 1 \(compressed\)/);
    assert.ok(events.some(([event]) => event === 'decision.window.warning'));
    assert.equal(windowTurnCount(turnWindow.entries()), 2);
});

test('a swipe removes only the last window turn, together with its facts', async () => {
    const cycles = [];
    const store = makeStore({ cycles });
    const { turnWindow } = makeWindow(store);
    for (let number = 1; number <= 3; number += 1) {
        cycles.push(cycle(number));
        await turnWindow.recordTurn({ pending: { chat: [{ mes: `user ${number}`, is_user: true }] }, stored: { id: `run_${number}`, writerText: `writer ${number}` } });
    }
    await turnWindow.addFact('roster: + Rem', { turn: 3 });
    assert.equal(turnWindow.entries().length, 4);
    await turnWindow.removeLastTurn();
    assert.equal(turnWindow.entries().length, 2);
    assert.equal(turnWindow.entries().every(entry => entry.turn <= 2), true);
});

test('a regenerated turn replaces the last cycle instead of appending a duplicate', async () => {
    const cycles = [];
    const store = makeStore({ cycles });
    const { turnWindow } = makeWindow(store);
    for (let number = 1; number <= 2; number += 1) {
        cycles.push(cycle(number));
        await turnWindow.recordTurn({ pending: { chat: [{ mes: `user ${number}`, is_user: true }] }, stored: { id: `run_${number}`, writerText: `first writer ${number}` } });
    }
    await turnWindow.addFact('roster: + Rem', { turn: 2 });
    assert.equal(turnWindow.entries().length, 3);

    await turnWindow.recordTurn({ pending: { chat: [{ mes: 'user 2', is_user: true }] }, stored: { id: 'run_2b', writerText: 'second writer 2', sourceRunId: 'run_2' } });

    const turns = turnWindow.entries().filter(entry => entry.kind === 'turn');
    assert.equal(turns.length, 2, 'the regenerated turn does not add a third cycle');
    assert.match(turns[1].text, /second writer 2/);
    assert.doesNotMatch(turns[1].text, /first writer 2/);
    assert.equal(turnWindow.entries().some(entry => /roster: \+ Rem/.test(entry.text)), false, 'facts after the replaced cycle are gone');
});

test('passive cycles and messages to the director go into the window between turn cycles', async () => {
    const cycles = [];
    const store = makeStore({ cycles });
    const { turnWindow } = makeWindow(store);
    cycles.push(cycle(1));
    await turnWindow.recordTurn({ pending: { chat: [{ mes: 'user 1', is_user: true }] }, stored: { id: 'run_1', writerText: 'writer 1' } });
    await turnWindow.recordBackground({
        id: 'passive_1', runId: 'passive_run', event: 'time', turn: 1, clockMinutes: 10, toolCalls: [],
        wake: { type: 'time', detail: 'Rem waited by the gate.' }, messages: [],
    });
    await turnWindow.recordBackground({
        id: 'msg_1', runId: 'message_run', event: 'message', turn: 1, clockMinutes: 11, toolCalls: [],
        wake: { type: 'message', detail: 'Go east instead.', text: 'Go east instead.' },
        messages: [{ role: 'assistant', content: 'As you wish.' }],
    });
    const entries = turnWindow.entries();
    assert.deepEqual(entries.map(entry => entry.kind), ['turn', 'passive', 'message']);
    assert.match(entries[1].text, /Rem waited by the gate/);
    assert.match(entries[2].text, /User: Go east instead\./);
    assert.match(entries[2].text, /Director: As you wish\./);
});

test('deleting an old message appends a correction instead of rewriting the window', async () => {
    const cycles = [];
    const store = makeStore({ cycles, runs: { 7: { id: 'run_2' } } });
    const { turnWindow } = makeWindow(store);
    for (let number = 1; number <= 2; number += 1) {
        cycles.push(cycle(number));
        await turnWindow.recordTurn({ pending: { chat: [{ mes: `user ${number}`, is_user: true }] }, stored: { id: `run_${number}`, writerText: `writer ${number}` } });
    }
    const before = turnWindow.entries()[0].text;
    await turnWindow.noteCorrection({ mesid: '7', action: 'deleted' });
    assert.equal(turnWindow.entries()[0].text, before);
    assert.match(turnWindow.entries().at(-1).text, /turn 2: message deleted by the user/);
});

test('a window wiped by the old turn-count bug is rebuilt from the runs and the chat text', async () => {
    let saved = { entries: [{ kind: 'fact', turn: 0, text: 'FACT\nupdate_roster: + Emilia' }, { kind: 'turn', turn: 1, text: 'TURN 1 (compressed)\nUser: last' }] };
    const runs = {
        2: { push: 'Resolution: Emilia greets Sasha.', form: { scene: { place: 'fountain' } } },
        4: { push: 'Resolution: Felt runs.', form: {} },
        6: { push: 'Resolution: the guard leaves.', form: {} },
    };
    const messages = [
        { mesid: '0', isUser: false, text: 'Greeting.' }, { mesid: '1', isUser: true, text: 'Walk to the fountain.' }, { mesid: '2', isUser: false, text: 'Emilia turns.' },
        { mesid: '3', isUser: true, text: 'Warn her.' }, { mesid: '4', isUser: false, text: 'Felt bolts.' },
        { mesid: '5', isUser: true, text: 'Whisper.' }, { mesid: '6', isUser: false, text: 'He walks off.' },
    ];
    const store = {
        window: () => saved, saveWindow: async value => { saved = value; return value; }, runs: () => runs, frozen: () => [],
        cycles: () => [], boundary: () => null, saveBoundary: async () => {}, roster: () => ({ active: [] }), library: () => ({}), plans: () => [],
    };
    const win = createTurnWindow({ store, call: async contract => (contract === 'chatHistory.messages' ? messages : null), getSettings: () => ({}), deciderWorker: () => null, publishEvent: () => {} });
    assert.equal(await win.rebuildFromRuns(), true);
    const turns = saved.entries.filter(entry => entry.kind === 'turn');
    assert.deepEqual(turns.map(entry => entry.turn), [1, 2, 3]);
    assert.match(turns[0].text, /User: Walk to the fountain\.[\s\S]*Writer: Emilia turns\./);
    assert.doesNotMatch(turns[0].text, /Emilia greets Sasha/, 'the push stays out when the writer reply is there');
    assert.match(turns[2].text, /User: Whisper\.[\s\S]*Writer: He walks off\./);
    assert.equal(saved.entries[0].kind, 'fact', 'the bootstrap facts before the turns are kept');
    assert.equal(await win.rebuildFromRuns(), false, 'a whole window is left alone');
});

test('a saved turn entry loses its old push when the writer reply is there', () => {
    const body = 'TURN 3 (compressed)\nUser: hi\nPUSH:\nBEATS — in this order:\n1. Emilia — ACTION: Stands still.\nEND: she waits.\nsubmit_turn: (no comment)\nWriter: Emilia waits.';
    const win = normalizeWindow({ entries: [{ kind: 'turn', turn: 3, text: body }, { kind: 'turn', turn: 4, text: 'TURN 4 (compressed)\nPUSH:\nOnly push.' }] });
    assert.equal(win.entries[0].text, 'TURN 3 (compressed)\nUser: hi\nsubmit_turn: (no comment)\nWriter: Emilia waits.');
    assert.match(win.entries[1].text, /Only push/, 'without a writer reply the push stays');
});
