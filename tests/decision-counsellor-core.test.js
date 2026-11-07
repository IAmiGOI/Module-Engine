import test from 'node:test';
import assert from 'node:assert/strict';
import { createCounsellor, CounsellorConfigError } from '../cores/decision/counsellor.js';
import { clampDecisionSettings, counsellorWorkerId, DEFAULT_COUNSELLOR } from '../libraries/core/decision-settings.js';
import {
    COUNSELLOR_SYSTEM, COUNSELLOR_REVIEW, COUNSELLOR_DAY, COUNSELLOR_MESSAGE,
    LEDGER_HEADER, COUNSELLOR_CHAT_HEADER, fillPrompt,
} from '../libraries/core/decision-prompts.js';

const decreeState = {
    lena: { name: 'Lena', decree: { 1: ['Freedom above all.'], 3: ['Get out of the keep.'] } },
    ram: { name: 'Ram', decree: { 1: ['The family comes first.'] } },
};

function harness({ answers = [], settings = {}, workers = [{ id: 'resolver', format: 'openai', model: 'flash' }], ledger = [], messages = [], clockMinutes = 6 * 1440 + 600 } = {}) {
    let minutes = clockMinutes;
    const state = {
        ledger: ledger.map(row => ({ ...row })),
        petitions: [],
        prayers: [],
        conversation: messages.map(item => ({ ...item })),
        counsellor: { messages: [], lastReviewTurn: 0, lastReviewAt: 0, day: null },
        cycles: [],
    };
    const requests = [];
    const events = [];
    const queue = [...answers];
    const call = async (contract, params) => {
        if (contract !== 'model.generate') throw new Error(`unexpected contract ${contract}`);
        requests.push({ ...params });
        const next = queue.shift();
        if (!next) throw new Error('the fake model ran out of answers');
        return next;
    };
    const store = {
        window: () => ({ entries: [{ kind: 'turn', turn: 6, text: 'TURN 6' }] }),
        cycles: () => [],
        clock: () => ({ minutes }),
        library: () => ({ lena: { name: 'Lena', level: 2 }, ram: { name: 'Ram', level: 3 } }),
        unreviewedLedger: () => state.ledger.filter(row => !row.reviewedAt),
        ledger: () => state.ledger,
        markLedgerReviewed: async at => {
            state.ledger = state.ledger.map(row => (row.reviewedAt ? row : { ...row, reviewedAt: at }));
            return { count: state.ledger.length };
        },
        petitions: () => state.petitions.map(item => ({ ...item })),
        addPetition: async item => { state.petitions.push({ ...item }); return state.petitions; },
        prayers: () => state.prayers.map(item => ({ ...item })),
        addPrayer: async item => { state.prayers.push({ ...item }); return state.prayers; },
        conversation: () => state.conversation.map(item => ({ ...item })),
        addConversation: async item => { state.conversation.push({ ...item }); return state.conversation; },
        counsellor: () => ({ ...state.counsellor, messages: state.conversation.map(item => ({ ...item })) }),
        saveCounsellor: async patch => { state.counsellor = { ...state.counsellor, ...patch }; return state.counsellor; },
        appendCycle: async cycle => { state.cycles.push(cycle); return cycle; },
    };
    const full = clampDecisionSettings({ ...settings, decider: { workerId: 'resolver', ...(settings.decider ?? {}) }, counsellor: { ...(settings.counsellor ?? {}) } });
    const banks = {
        great: { load: async () => decreeState },
        decreeFor: async names => `DECREES: ${names.join(', ')}`,
    };
    const counsellor = createCounsellor({
        call, callTool: async () => ({ ok: true }), store, banks,
        getSettings: () => full, getWorkers: () => workers,
        publishEvent: (event, payload) => events.push([event, payload ?? {}]),
        enqueue: job => job(),
        now: (() => { let value = 1000; return () => (value += 10); })(),
    });
    return { counsellor, state, requests, events, settings: full, setClock: value => { minutes = value; } };
}

const call = (name, args) => ({ id: `${name}_${Math.random().toString(36).slice(2, 6)}`, name, arguments: { ...args } });

test('a review petitions the Director, then the read rows leave the Ledger for good', async () => {
    const world = harness({
        ledger: [{ turn: 5, character: 'Lena', wanted: 'get out', conflict: { level: 'strong' }, result: 'she stays' }],
        answers: [
            { text: '', toolCalls: [call('petition', { character: 'Lena', problem: 'The Decree cannot get her out.', excerpt: '- T5 Lena: get out', comment: 'The evidence deserves the Director.' })] },
            { text: '', toolCalls: [call('await', { reason: 'Done.', comment: 'The petition is written.' })] },
        ],
    });
    const result = await world.counsellor.run({ runId: 'r1', mode: 'review' });
    assert.equal(result.ok, true);
    assert.equal(world.state.petitions.length, 1);
    assert.equal(world.state.petitions[0].character, 'Lena');
    assert.equal(world.state.petitions[0].status, 'queued');
    assert.equal(world.state.ledger[0].reviewedAt > 0, true, 'the reviewed row is marked');
    const cycle = world.state.cycles.at(-1);
    assert.equal(cycle.event, 'counsellor');
    assert.equal(cycle.turn, 6);
    assert.equal(cycle.wake.label, 'The Counsellor read the Ledger');
    assert.deepEqual(cycle.wake.queues.petitions.map(item => item.character), ['Lena']);
    assert.match(cycle.wake.detail, /1 petition\(s\).*Queued: 1 petition/);
});

test('nothing_yet ends the review in one call and is written down with its reason', async () => {
    const world = harness({
        ledger: [{ turn: 5, character: 'Lena', wanted: 'get out', conflict: { level: 'minor' }, result: 'she stays' }],
        answers: [{ text: '', toolCalls: [call('nothing_yet', { reason: 'A minor hesitation is what the Decree covers.', comment: 'Nothing here needs the Director.' })] }],
    });
    const result = await world.counsellor.run({ runId: 'r2', mode: 'review' });
    assert.equal(result.type, 'await');
    assert.equal(world.state.petitions.length, 0);
    assert.match(world.state.cycles.at(-1).wake.detail, /nothing_yet: A minor hesitation/);
    assert.equal(world.state.ledger[0].reviewedAt > 0, true);
});

test('the review context is the unread Ledger, levels, Decrees, queues and RP time — never the chat', async () => {
    const world = harness({
        ledger: [{ turn: 5, character: 'Lena', wanted: 'get out' }],
        answers: [{ text: '', toolCalls: [call('nothing_yet', { reason: 'Fine.', comment: 'The Decree holds.' })] }],
    });
    await world.counsellor.run({ runId: 'r3', mode: 'review' });
    const sent = world.requests[0].messages.map(message => message.content).join('\n\n');
    assert.match(sent, /^You are the Counsellor/);
    assert.match(sent, new RegExp(LEDGER_HEADER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(sent, /T5 Lena: get out/);
    assert.match(sent, /CHARACTER LIBRARY \(levels 1–5\)/);
    assert.match(sent, /DECREES: Lena, Ram/);
    assert.equal(sent.includes('PETITIONS (to the Director)'), false, 'a review does not read the queues');
    assert.match(sent, /CURRENT RP TIME: Day 7, 10:00/);
    assert.match(sent, /A review has come due after 6 turns/);
    assert.equal(sent.includes('Writer:'), false);
});

test('the end of the day petitions every character with a Decree — the engine writes the missing ones', async () => {
    const world = harness({
        ledger: [{ turn: 9, character: 'Lena', wanted: 'get out', conflict: { level: 'strong', why: 'the gate' }, result: 'she stays' }],
        answers: [
            { text: '', toolCalls: [call('petition', { character: 'Lena', problem: 'The day left her nowhere.', excerpt: '- T9 Lena', promote: { level: 'main', reason: 'The user keeps asking for her.' }, comment: 'Her standing changed today.' })] },
            { text: '', toolCalls: [call('await', { reason: 'The day is closed.', comment: 'All petitions are written.' })] },
        ],
    });
    const result = await world.counsellor.run({ runId: 'r4', mode: 'day' });
    assert.equal(result.petitions.length, 2, 'Lena by the model, Ram by the engine');
    assert.deepEqual(world.state.petitions.map(item => item.character).sort(), ['Lena', 'Ram']);
    assert.equal(world.state.petitions.every(item => item.prepareNewDay), true);
    assert.equal(world.state.petitions.find(item => item.character === 'Lena').promote.level, 'main');
    assert.match(world.state.cycles.at(-1).wake.detail, /for the new day/);
});

test('the user talks to the Counsellor: the reply is kept and the talk is its whole context', async () => {
    const world = harness({
        messages: [{ role: 'user', text: 'More of the river, please.', at: 1 }, { role: 'counsellor', text: 'I will weigh it.', at: 2 }],
        answers: [
            {
                text: '', toolCalls: [
                    call('reply', { text: 'I will pass the wish about the river to the Director.', comment: 'The user must hear back.' }),
                    call('prayer', { text: 'The river should answer the wish without breaking its rule.', comment: 'This touches the world.' }),
                ],
            },
            { text: '', toolCalls: [call('await', { reason: 'Said.', comment: 'The answer is sent.' })] },
        ],
    });
    await world.counsellor.run({ runId: 'r5', mode: 'message', text: 'More of the river, please.' });
    assert.deepEqual(world.state.conversation.map(item => item.role), ['user', 'counsellor', 'counsellor']);
    assert.match(world.state.conversation.at(-1).text, /pass the wish/);
    assert.equal(world.state.prayers[0].source, 'counsellor');
    assert.equal(world.state.prayers[0].status, 'queued');
    const sent = world.requests[0].messages.map(message => message.content).join('\n\n');
    assert.match(sent, new RegExp(COUNSELLOR_CHAT_HEADER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(sent, /More of the river, please\./);
    assert.match(sent, /PETITIONS \(to the Director\)/, 'the talk sees the queues');
    assert.equal(sent.includes(LEDGER_HEADER), false, 'a talk does not drag the Ledger in');
    assert.equal(world.state.ledger.length, 0);
});

test('the Counsellor runs on its own connection, and the resolver connection otherwise', async () => {
    const own = harness({
        settings: { counsellor: { workerId: 'counsel' } },
        workers: [{ id: 'resolver', format: 'openai', model: 'flash' }, { id: 'counsel', format: 'openai', model: 'flash' }],
        answers: [{ text: '', toolCalls: [call('nothing_yet', { reason: 'Fine.', comment: 'Nothing to report.' })] }],
    });
    await own.counsellor.run({ runId: 'r6', mode: 'review' });
    assert.equal(own.requests[0].workerId, 'counsel');
    assert.equal(counsellorWorkerId(own.settings), 'counsel');

    const fallback = harness({
        answers: [{ text: '', toolCalls: [call('nothing_yet', { reason: 'Fine.', comment: 'Nothing to report.' })] }],
    });
    await fallback.counsellor.run({ runId: 'r7', mode: 'review' });
    assert.equal(fallback.requests[0].workerId, 'resolver');
    assert.equal(counsellorWorkerId(fallback.settings), 'resolver');
});

test('without a connection the Counsellor refuses with a configuration error, not a crash', async () => {
    const world = harness({ workers: [] });
    await assert.rejects(
        () => world.counsellor.run({ runId: 'r8', mode: 'review' }),
        error => error instanceof CounsellorConfigError && error.code === 'decision-config',
    );
});

test('a failed review leaves the rows unread and does not eat the N-turn slot', async () => {
    const world = harness({
        ledger: [{ turn: 5, character: 'Lena', wanted: 'get out' }],
        settings: { counsellor: { everyTurns: 1 } },
        answers: [],
    });
    const failed = await world.counsellor.run({ runId: 'e1', mode: 'review' });
    assert.equal(failed.ok, false);
    assert.equal(failed.type, 'error');
    assert.equal(world.state.counsellor.lastReviewTurn, 0);
    assert.equal(world.state.ledger[0].reviewedAt, undefined);
    assert.match(world.state.cycles.at(-1).warnings.join(' '), /the model request failed/);
});

test('the wake schedule: every N turns, at midnight, and never twice for the same turn', async () => {
    const answers = () => Array.from({ length: 6 }, () => ({ text: '', toolCalls: [call('nothing_yet', { reason: 'Fine.', comment: 'Nothing to report.' })] }));
    const world = harness({ settings: { counsellor: { everyTurns: 3 } }, answers: answers() });
    const early = await world.counsellor.maybeRun({ turn: 2 });
    assert.equal(early.skipped, true);
    const due = await world.counsellor.maybeRun({ turn: 6 });
    assert.equal(due.mode, 'review');
    const again = await world.counsellor.maybeRun({ turn: 6 });
    assert.equal(again.skipped, true, 'the same turn does not review twice');

    // Конец RP-дня: часы перешли через полночь — Советник будится даже при большом интервале.
    const midnight = harness({ settings: { counsellor: { everyTurns: 50 } }, answers: answers(), clockMinutes: 5 * 1440 + 100 });
    const first = await midnight.counsellor.maybeRun({ turn: 6 });
    assert.equal(first.skipped, true, 'the first sight of the clock is not a day end');
    midnight.setClock(6 * 1440 + 100);
    const day = await midnight.counsellor.maybeRun({ turn: 6 });
    assert.equal(day.mode, 'day');
    const after = await midnight.counsellor.maybeRun({ turn: 6 });
    assert.equal(after.skipped, true, 'one day end, one review');
});

test('counsellor settings are clamped and carry the defaults', () => {
    const values = clampDecisionSettings({ counsellor: { everyTurns: 999, maxSteps: 0, workerId: '  flash  ' } });
    assert.equal(values.counsellor.everyTurns, 50);
    assert.equal(values.counsellor.maxSteps, 1);
    assert.equal(values.counsellor.workerId, 'flash');
    assert.deepEqual(clampDecisionSettings({}).counsellor, { ...DEFAULT_COUNSELLOR });
});

test('the prompts are filled without leaving a placeholder behind', () => {
    assert.match(fillPrompt(COUNSELLOR_REVIEW, { turns: 3 }), /after 3 turns/);
    assert.match(fillPrompt(COUNSELLOR_MESSAGE, { message: 'Hello.' }), /Hello\./);
    assert.equal(COUNSELLOR_DAY.includes('{{'), false);
    assert.match(COUNSELLOR_SYSTEM, /## How You Judge The Ledger/);
});
