import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createContractBus } from '../libraries/shared/contract-bus.js';
import { createEventBus } from '../libraries/shared/event-bus.js';

/**
 * `resolve()` inside contract-bus.js is always `async` — even a synchronous
 * supplier handler still goes through at least one microtask tick before its
 * result reaches a `when`-gated subscriber's callback. `emit()`/`tick()`
 * themselves are synchronous and don't wait for that, so a test asserting
 * immediately after either would race the delivery. A handful of queued
 * microtask turns flushes any such pending chain deterministically.
 */
async function flushMicrotasks(rounds = 10) {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
}

test('subscribe() with no "when" resolves once, immediately, against the registered supplier', async () => {
    const bus = createContractBus();
    bus.register('greet.name', ({ name }) => `Hello, ${name}`);

    const result = await new Promise(resolve => bus.subscribe('greet.name', { params: { name: 'Ada' } }, resolve));

    assert.deepEqual(result, { ok: true, value: 'Hello, Ada' });
});

test('subscribe() against a contract with no registered supplier resolves to a structured failure, never throws', async () => {
    const bus = createContractBus();

    const result = await new Promise(resolve => bus.subscribe('nothing.registered', {}, resolve));

    assert.equal(result.ok, false);
    assert.match(result.error.message, /No supplier registered/);
});

test('a supplier handler that throws resolves to { ok: false, error }, never rejects the caller', async () => {
    const bus = createContractBus();
    bus.register('broken.thing', () => { throw new Error('kaboom'); });

    const result = await new Promise(resolve => bus.subscribe('broken.thing', {}, resolve));

    assert.equal(result.ok, false);
    assert.equal(result.error.message, 'kaboom');
});

test('a supplier handler that returns a rejected promise is caught the same way as a thrown error', async () => {
    const bus = createContractBus();
    bus.register('async.broken', async () => { throw new Error('async kaboom'); });

    const result = await new Promise(resolve => bus.subscribe('async.broken', {}, resolve));

    assert.equal(result.ok, false);
    assert.equal(result.error.message, 'async kaboom');
});

test('when: { event } redelivers every time that Event Bus event fires, not immediately on subscribe', async () => {
    const events = createEventBus();
    const bus = createContractBus(events);
    let callCount = 0;
    bus.register('counter.value', () => ++callCount);

    const deliveries = [];
    bus.subscribe('counter.value', { when: { event: 'tick' } }, result => deliveries.push(result));

    assert.equal(deliveries.length, 0, 'must not deliver before the event fires at all');
    events.emit('tick');
    await flushMicrotasks();
    events.emit('tick');
    await flushMicrotasks();

    assert.deepEqual(deliveries, [{ ok: true, value: 1 }, { ok: true, value: 2 }]);
});

test('when: { every: { event, count } } only redelivers on every Nth occurrence, and resets the counter afterward', async () => {
    const events = createEventBus();
    const bus = createContractBus(events);
    let callCount = 0;
    bus.register('poll.result', () => ++callCount);

    const deliveries = [];
    bus.subscribe('poll.result', { when: { every: { event: 'turn', count: 3 } } }, result => deliveries.push(result));

    events.emit('turn'); events.emit('turn');
    await flushMicrotasks();
    assert.equal(deliveries.length, 0, 'turns 1 and 2 of 3 must not deliver yet');
    events.emit('turn');
    await flushMicrotasks();
    assert.deepEqual(deliveries, [{ ok: true, value: 1 }], 'turn 3 of 3 must deliver');

    events.emit('turn'); events.emit('turn');
    await flushMicrotasks();
    assert.equal(deliveries.length, 1, 'the counter must have reset — turns 1 and 2 of the next window must not deliver yet');
    events.emit('turn');
    await flushMicrotasks();
    assert.deepEqual(deliveries, [{ ok: true, value: 1 }, { ok: true, value: 2 }]);
});

test('when: { every: { ms } } redelivers on a real timer, and stops once unsubscribed', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
        const bus = createContractBus();
        let callCount = 0;
        bus.register('heartbeat', () => ++callCount);

        const deliveries = [];
        const unsubscribe = bus.subscribe('heartbeat', { when: { every: { ms: 1000 } } }, result => deliveries.push(result));

        mock.timers.tick(1000);
        await flushMicrotasks();
        mock.timers.tick(1000);
        await flushMicrotasks();
        assert.equal(deliveries.length, 2);

        unsubscribe();
        mock.timers.tick(5000);
        await flushMicrotasks();
        assert.equal(deliveries.length, 2, 'no further delivery after unsubscribe');
    } finally {
        mock.timers.reset();
    }
});

test('register() returns an unregister function; after calling it, the contract has no supplier', async () => {
    const bus = createContractBus();
    const unregister = bus.register('temp.thing', () => 'value');

    unregister();
    const result = await new Promise(resolve => bus.subscribe('temp.thing', {}, resolve));

    assert.equal(result.ok, false);
});

test('with two suppliers for the same contract, the one reporting LOWER load is picked', async () => {
    const bus = createContractBus();
    bus.register('worker.task', () => 'busy-worker', { loadMetric: () => 10 });
    bus.register('worker.task', () => 'idle-worker', { loadMetric: () => 0 });

    const result = await new Promise(resolve => bus.subscribe('worker.task', {}, resolve));

    assert.deepEqual(result, { ok: true, value: 'idle-worker' });
});

test('subscribe() throws synchronously for an unrecognized "when" shape — a real programmer error, not a runtime data failure', () => {
    const bus = createContractBus();
    bus.register('x', () => 'value');

    assert.throws(() => bus.subscribe('x', { when: { nonsense: true } }, () => {}));
});

// --- The Директор's delivery modifiers: every one of these exists so a
// Ядро/Модуль never hand-rolls counters, timers or dedupe bookkeeping. ---

test('when: { event, every: N } is the same rule as the longer { every: { event, count: N } } form', async () => {
    const events = createEventBus();
    const bus = createContractBus(events);
    let calls = 0;
    bus.register('poll.value', () => ++calls);
    const deliveries = [];
    bus.subscribe('poll.value', { when: { event: 'turn.done', every: 3 } }, result => deliveries.push(result.value));

    for (let i = 0; i < 6; i++) events.emit('turn.done');
    await flushMicrotasks();

    assert.deepEqual(deliveries, [1, 2], 'six turns at "every third" is exactly two deliveries');
});

test('when: { event, once: true } delivers once and then unsubscribes itself', async () => {
    const events = createEventBus();
    const bus = createContractBus(events);
    bus.register('poll.value', () => 'value');
    const deliveries = [];
    bus.subscribe('poll.value', { when: { event: 'turn.done', once: true } }, result => deliveries.push(result.value));

    events.emit('turn.done');
    await flushMicrotasks();
    events.emit('turn.done');
    await flushMicrotasks();

    assert.deepEqual(deliveries, ['value']);
});

test('when: { event, dedupe: true } skips an event whose payload repeats the previous one', async () => {
    const events = createEventBus();
    const bus = createContractBus(events);
    let calls = 0;
    bus.register('poll.value', () => ++calls);
    const deliveries = [];
    bus.subscribe('poll.value', { when: { event: 'chat.changed', dedupe: true } }, result => deliveries.push(result.value));

    events.emit('chat.changed', { chatId: 'a' });
    events.emit('chat.changed', { chatId: 'a' });
    events.emit('chat.changed', { chatId: 'b' });
    await flushMicrotasks();

    assert.deepEqual(deliveries, [1, 2], 'the repeated chatId never reached the supplier at all');
});

test('when: { event, debounceMs } collapses a burst into one delivery once it goes quiet', async () => {
    const events = createEventBus();
    const bus = createContractBus(events);
    let calls = 0;
    bus.register('poll.value', () => ++calls);
    const deliveries = [];
    bus.subscribe('poll.value', { when: { event: 'typing', debounceMs: 30 } }, result => deliveries.push(result.value));

    events.emit('typing'); events.emit('typing'); events.emit('typing');
    await flushMicrotasks();
    assert.deepEqual(deliveries, [], 'nothing resolves while the burst is still going');

    await new Promise(resolve => setTimeout(resolve, 60));
    await flushMicrotasks();
    assert.deepEqual(deliveries, [1]);
});

test('the unsubscribe function cancels a still-pending debounced delivery', async () => {
    const events = createEventBus();
    const bus = createContractBus(events);
    let calls = 0;
    bus.register('poll.value', () => ++calls);
    const unsubscribe = bus.subscribe('poll.value', { when: { event: 'typing', debounceMs: 30 } }, () => {});

    events.emit('typing');
    unsubscribe();
    await new Promise(resolve => setTimeout(resolve, 60));

    assert.equal(calls, 0, 'an unsubscribed subscription must never resolve its contract afterwards');
});
