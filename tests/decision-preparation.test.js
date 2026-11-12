import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreparation } from '../cores/decision/preparation.js';
import { PREPARATION_STEPS, normalizePreparation, stepFromFacts } from '../libraries/core/decision-preparation.js';

const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function world(overrides = {}) {
    let facts = {
        startable: true, played: false, sorted: false, studied: false,
        openQuestions: false, declarationReady: false, creationStarted: false,
        creationComplete: false, mainWithoutDecree: 0, ...overrides,
    };
    const memory = new Map();
    const calls = { cold: 0, god: 0, director: 0 };
    const events = [];
    const call = async (contract, params = {}) => {
        if (contract === 'storage.chatMemory.get') return memory.has(params.key) ? clone(memory.get(params.key)) : params.fallback ?? null;
        if (contract === 'storage.chatMemory.set') { memory.set(params.key, clone(params.value)); return true; }
        if (contract === 'stCharacter.chatCharacters') return facts.startable ? [{ name: 'Aria' }] : [];
        return null;
    };
    let godResult = { ok: true };
    const preparation = createPreparation({
        call,
        store: { papers: () => ({ god: {} }), cycles: () => [], runs: () => ({}) },
        banks: {
            progress: () => ({ status: facts.sorted ? 'ready' : 'idle' }),
            records: () => [],
            ensureColdStart: async () => { calls.cold += 1; facts = { ...facts, sorted: true }; },
            great: null,
        },
        creation: {
            load: async () => {},
            complete: () => facts.creationComplete,
            started: () => facts.creationStarted,
        },
        cycle: {
            maybeRunGod: async () => { calls.god += 1; return godResult; },
            maybeRunDirector: async () => { calls.director += 1; return { ok: true }; },
        },
        facts: () => ({ ...facts }),
        publishEvent: (event, payload) => events.push([event, payload]),
        now: (() => { let value = 1000; return () => (value += 10); })(),
    });
    return {
        preparation, memory, calls, events,
        set: patch => { facts = { ...facts, ...patch }; },
        facts: () => ({ ...facts }),
        setGodResult: value => { godResult = value; },
    };
}

test('the steps go in the owner\'s order: sort, study, answers, build, cast, ready', () => {
    assert.deepEqual(PREPARATION_STEPS, ['sort', 'study', 'answers', 'build', 'cast', 'ready']);
    assert.equal(normalizePreparation({ step: 'nonsense' }).step, 'sort', 'an unknown step starts from the first');
});

test('every fact finds its step; a played chat is always ready', () => {
    assert.equal(stepFromFacts({ played: true }), 'ready');
    assert.equal(stepFromFacts({ sorted: false }), 'sort');
    assert.equal(stepFromFacts({ sorted: true, studied: false }), 'study');
    assert.equal(stepFromFacts({ sorted: true, studied: true, openQuestions: true }), 'answers');
    assert.equal(stepFromFacts({ sorted: true, studied: true, declarationReady: true }), 'build');
    assert.equal(stepFromFacts({ sorted: true, studied: true }), 'build');
    assert.equal(stepFromFacts({ sorted: true, studied: false, creationStarted: true }), 'build', 'a started world is finished, not studied again');
    assert.equal(stepFromFacts({ sorted: true, creationComplete: true, mainWithoutDecree: 2 }), 'cast');
    assert.equal(stepFromFacts({ sorted: true, creationComplete: true, mainWithoutDecree: 0 }), 'ready');
    assert.equal(stepFromFacts({ sorted: true, creationComplete: true }), 'ready', 'no Main Cast without a Decree is ready');
    assert.equal(stepFromFacts({ sorted: true, creationComplete: true, openQuestions: true }), 'answers', 'an open question holds the game even with a world');
    assert.equal(stepFromFacts({ sorted: true, creationComplete: true, declarationReady: true }), 'build', 'a Declaration is written into the world before the cast');
});

test('the sort step runs the cold start and moves on to study, which wakes God exactly once', async () => {
    const { preparation, calls } = world();
    const state = await preparation.advance();
    assert.equal(calls.cold, 1, 'the cold start ran once');
    assert.equal(calls.god, 1, 'God was woken on the study step');
    assert.equal(calls.director, 0);
    assert.equal(state.step, 'study', 'the fake facts do not change, so the step stays where it is');
});

test('the answers step calls no model at all: the Counsellor waits for the user', async () => {
    const { preparation, calls } = world({ sorted: true, studied: true, openQuestions: true });
    const state = await preparation.advance();
    assert.equal(state.step, 'answers');
    assert.deepEqual(calls, { cold: 0, god: 0, director: 0 });
});

test('the build step wakes God and the cast step wakes the Director — and nobody else', async () => {
    const build = world({ sorted: true, studied: true, creationStarted: true });
    assert.equal((await build.preparation.advance()).step, 'build');
    assert.equal(build.calls.god, 1);
    assert.equal(build.calls.director, 0);

    const cast = world({ sorted: true, studied: true, creationComplete: true, mainWithoutDecree: 2 });
    assert.equal((await cast.preparation.advance()).step, 'cast');
    assert.equal(cast.calls.director, 1);
    assert.equal(cast.calls.god, 0);
});

test('a lost event is nothing: a state left at sort continues from the facts at load', async () => {
    const { preparation, memory, calls } = world({ sorted: true, studied: true, creationComplete: true, mainWithoutDecree: 0 });
    memory.set('preparation', { step: 'sort', startedAt: 1, updatedAt: 1, error: '' });
    const state = await preparation.advance();
    assert.equal(state.step, 'ready', 'facts say the preparation is finished');
    assert.deepEqual(calls, { cold: 0, god: 0, director: 0 }, 'no model was called to recover');
    assert.equal(memory.get('preparation').step, 'ready');
});

test('an old chat that has already played is ready at once and calls nothing', async () => {
    const { preparation, memory, calls } = world({ played: true, sorted: false });
    const state = await preparation.advance();
    assert.equal(state.step, 'ready');
    assert.deepEqual(calls, { cold: 0, god: 0, director: 0 });
    assert.equal(memory.has('preparation'), false, 'nothing is written into a chat that needs no preparation');
    assert.equal((await preparation.assess()).step, 'ready', 'the turn gate sees a ready chat too');
});

test('a new chat without a single card has nothing to prepare and calls nothing', async () => {
    const { preparation, calls } = world({ startable: false });
    assert.equal((await preparation.advance()).step, 'ready');
    assert.deepEqual(calls, { cold: 0, god: 0, director: 0 });
});

test('a failed step is kept with its error, is not retried by itself, and the Retry button repeats it', async () => {
    const { preparation, setGodResult, calls } = world({ sorted: true });
    setGodResult({ ok: false, type: 'error' });
    const failed = await preparation.advance();
    assert.equal(failed.step, 'study');
    assert.match(failed.error, /God/);
    assert.equal(calls.god, 1);

    await preparation.advance();
    assert.equal(calls.god, 1, 'without a reason the failed step is not called again');

    await preparation.retry();
    assert.equal(calls.god, 2, 'Retry repeats the failed step');
});

test('the game turn sees the current step without running a role: assess is facts only', async () => {
    const { preparation, calls } = world({ sorted: true, studied: true, openQuestions: true });
    const state = await preparation.assess();
    assert.equal(state.step, 'answers');
    assert.deepEqual(calls, { cold: 0, god: 0, director: 0 });
});

test('a role without a connection does not hold the game: its step is skipped', async () => {
    const { stepFromFacts } = await import('../libraries/core/decision-preparation.js');
    assert.equal(stepFromFacts({ sorted: true, godConfigured: false, directorConfigured: true, mainWithoutDecree: 2 }), 'cast');
    assert.equal(stepFromFacts({ sorted: true, godConfigured: false, directorConfigured: false, mainWithoutDecree: 2 }), 'ready');
    assert.equal(stepFromFacts({ sorted: true, creationComplete: true, directorConfigured: false, mainWithoutDecree: 2 }), 'ready');
    assert.equal(stepFromFacts({ sorted: true }), 'study', 'with connections nothing changes');
});

test('a rewritten first message, or a Counsellor\'s prayer before the world exists, sends God back to study it', async () => {
    const { openingHash } = await import('../cores/decision/opening.js');
    let papers = { god: { studiedAt: 5, openingHash: openingHash('Old opening.'), questions: [{ id: 'q1', question: 'Old?', answer: '' }] }, prayers: [] };
    let opening = 'New opening.';
    const saved = [];
    const preparation = createPreparation({
        call: async contract => (contract === 'storage.chatMemory.get' ? null : true),
        callService: async contract => (contract === 'stChat.messages' ? [{ mesid: '0', isUser: false, text: opening }] : contract === 'stCharacter.chatCharacters' ? [{ name: 'Lena' }] : []),
        store: {
            papers: () => papers, cycles: () => [], runs: () => ({}),
            saveGod: async patch => { saved.push(patch); papers = { ...papers, god: { ...papers.god, ...patch } }; },
            markPrayersRead: async () => { papers = { ...papers, prayers: papers.prayers.map(item => ({ ...item, status: 'read' })) }; },
        },
        banks: { progress: () => ({ status: 'ready' }), records: () => [], great: null },
        creation: { load: async () => {}, complete: () => false, started: () => false },
        cycle: { maybeRunGod: async () => ({ ok: true }) },
        getSettings: () => ({ god: { workerId: 'god' }, director: { workerId: 'director' } }),
    });
    const state = await preparation.assess();
    assert.equal(saved.length, 1, 'the old questions are withdrawn');
    assert.deepEqual(papers.god.questions, []);
    assert.equal(state.step, 'study');
    papers = { god: { studiedAt: 5, questions: [{ id: 'q2', question: 'x', answer: '' }] }, prayers: [{ id: 'p', source: 'counsellor', status: 'queued', text: 'Read the new opening.' }] };
    opening = 'Same.';
    await preparation.assess();
    assert.equal(saved.length, 2, 'a prayer before the world exists is a request to study again');
    assert.equal(papers.prayers[0].status, 'read');
});
