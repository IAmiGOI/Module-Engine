import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventBus } from '../libraries/shared/event-bus.js';

test('subscribe() receives the payload passed to emit()', () => {
    const bus = createEventBus();
    let received = null;
    bus.subscribe('thing.happened', payload => { received = payload; });

    bus.emit('thing.happened', { value: 42 });

    assert.deepEqual(received, { value: 42 });
});

test('every subscriber to the same event receives the same emit', () => {
    const bus = createEventBus();
    const calls = [];
    bus.subscribe('x', () => calls.push('a'));
    bus.subscribe('x', () => calls.push('b'));

    bus.emit('x');

    assert.deepEqual(calls.sort(), ['a', 'b']);
});

test('unsubscribe() stops further delivery to that listener only', () => {
    const bus = createEventBus();
    const calls = [];
    const unsubA = bus.subscribe('x', () => calls.push('a'));
    bus.subscribe('x', () => calls.push('b'));

    unsubA();
    bus.emit('x');

    assert.deepEqual(calls, ['b']);
});

test('a listener that throws does not stop other listeners from being called', () => {
    const bus = createEventBus();
    const calls = [];
    bus.subscribe('x', () => { throw new Error('boom'); });
    bus.subscribe('x', () => calls.push('survived'));

    assert.doesNotThrow(() => bus.emit('x'));
    assert.deepEqual(calls, ['survived']);
});

test('emit() on an event with no subscribers is a silent no-op', () => {
    const bus = createEventBus();
    assert.doesNotThrow(() => bus.emit('nobody.listens', { any: 'payload' }));
});

test('emit() only reaches subscribers of that exact event name, not other names', () => {
    const bus = createEventBus();
    let calledWrong = false;
    bus.subscribe('a', () => { calledWrong = true; });

    bus.emit('b');

    assert.equal(calledWrong, false);
});
