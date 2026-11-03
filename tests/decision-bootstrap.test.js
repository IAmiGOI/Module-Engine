import test from 'node:test';
import assert from 'node:assert/strict';
import { createBootstrap } from '../cores/decision/bootstrap.js';

function build({ messages = [{ mes: 'The greeting.', is_user: false }], cycles = [], briefWritten = true, timeoutMs = 180000, run = null } = {}) {
    const memory = new Map();
    const events = [];
    let starts = 0;
    let briefResult = null;
    const call = async (contract, params = {}) => {
        if (contract === 'storage.chatMemory.get') return memory.has(params.key) ? memory.get(params.key) : params.fallback;
        if (contract === 'storage.chatMemory.set') { memory.set(params.key, params.value); return true; }
        if (contract === 'chatHistory.messages') return messages;
        return undefined;
    };
    const store = { cycles: () => cycles };
    const cycle = {
        runBootstrap: async () => {
            starts += 1;
            if (run) return run();
            return { briefWritten };
        },
    };
    const bootstrap = createBootstrap({
        call, store, cycle, now: () => 100,
        getSettings: () => ({ bootstrap: { maxQuestions: 5, maxSteps: 30, timeoutMs } }),
        publishEvent: (event, payload) => events.push([event, payload]),
    });
    return { bootstrap, events, starts: () => starts, memory, setBriefResult: value => { briefResult = value; } };
}

test('a new chat runs bootstrap once and stores done', async () => {
    const world = build();
    await world.bootstrap.load();
    await world.bootstrap.maybeStart();
    assert.equal(world.starts(), 1);
    assert.equal(world.bootstrap.state().status, 'done');
    await world.bootstrap.maybeStart();
    assert.equal(world.starts(), 1, 'bootstrap does not run twice');
    assert.ok(world.events.some(([event]) => event === 'decision.bootstrap.started'));
    assert.ok(world.events.some(([event]) => event === 'decision.bootstrap.finished'));
});

test('an old chat with messages or a director log is not bootstrapped', async () => {
    const withMessages = build({ messages: [{ mes: 'one' }, { mes: 'two' }] });
    await withMessages.bootstrap.maybeStart();
    assert.equal(withMessages.starts(), 0);
    const withCycles = build({ cycles: [{ id: 'c1' }] });
    await withCycles.bootstrap.maybeStart();
    assert.equal(withCycles.starts(), 0);
});

test('a bootstrap without a brief is failed and warns, but does not throw', async () => {
    const world = build({ briefWritten: false });
    await world.bootstrap.maybeStart();
    assert.equal(world.bootstrap.state().status, 'failed');
    assert.match(world.bootstrap.state().error, /without a chat brief/);
    assert.ok(world.events.some(([event, payload]) => event === 'decision.bootstrap.warning' && /without a chat brief/.test(payload.message)));
});

test('the first turn waits for bootstrap, and a timeout lets the turn go on', async () => {
    let release = null;
    const world = build({ timeoutMs: 20, run: () => new Promise(resolve => { release = () => resolve({ briefWritten: true }); }) });
    const result = await world.bootstrap.waitFirstTurn();
    assert.equal(result.timedOut, true);
    assert.ok(world.events.some(([event]) => event === 'decision.bootstrap.warning'));
    release();
});

test('a failed bootstrap is retried only by the user, and the retry can succeed', async () => {
    let brief = false;
    const world = build({ run: () => ({ briefWritten: brief }) });
    await world.bootstrap.load();
    await world.bootstrap.maybeStart();
    assert.equal(world.bootstrap.state().status, 'failed');
    await world.bootstrap.maybeStart();
    assert.equal(world.starts(), 1, 'a failed bootstrap does not restart by itself');
    brief = true;
    const retried = await world.bootstrap.retry();
    assert.equal(retried.ok, true);
    assert.equal(retried.started, true, 'the retry returns at once — the button must not stay busy while bootstrap asks questions');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(world.bootstrap.state().status, 'done');
    assert.equal((await world.bootstrap.retry()).ok, false, 'nothing to retry after success');
});

test('a page reload before the chat is loaded (no messages yet) is not a new chat — bootstrap does not start on empty data', async () => {
    const world = build({ messages: [] });
    await world.bootstrap.load();
    await world.bootstrap.maybeStart();
    assert.equal(world.starts(), 0);
    const userFirst = build({ messages: [{ mes: 'Hi', is_user: true }] });
    await userFirst.bootstrap.load();
    await userFirst.bootstrap.maybeStart();
    assert.equal(userFirst.starts(), 0, 'a chat that already has a user message is not new');
});

test('a chat switch forgets the running bootstrap: the new chat does not wait for it, and the old run writes nothing', async () => {
    let release = null;
    const world = build({ run: () => new Promise(resolve => { release = resolve; }) });
    await world.bootstrap.load();
    world.bootstrap.maybeStart();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(world.bootstrap.state().status, 'running');
    world.bootstrap.chatChanged();
    world.memory.clear();
    assert.equal(world.bootstrap.state().status, 'idle');
    release({ briefWritten: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(world.memory.has('bootstrap'), false, 'the old run did not save its state into the new chat');
    assert.ok(!world.events.some(([event, payload]) => event === 'decision.bootstrap.finished' && payload.status === 'done'));
});
