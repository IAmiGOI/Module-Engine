import test from 'node:test';
import assert from 'node:assert/strict';
import { createBootstrap } from '../cores/decision/bootstrap.js';

function build({ messages = [], cycles = [], briefWritten = true, timeoutMs = 180000, run = null } = {}) {
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
