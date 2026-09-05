import test from 'node:test';
import assert from 'node:assert/strict';
import { registerStEventsService } from '../services/st-events.js';
import { createContractBus } from '../libraries/shared/contract-bus.js';

/** A fake SillyTavern context: `eventTypes` maps KEYS to the real event names, exactly as the real ST does. */
function fakeContext({ withOff = true } = {}) {
    const listeners = [];
    const eventSource = {
        on: (name, handler) => listeners.push({ name, handler }),
    };
    if (withOff) eventSource.off = (name, handler) => remove(name, handler);
    else eventSource.removeListener = (name, handler) => remove(name, handler);

    function remove(name, handler) {
        const index = listeners.findIndex(entry => entry.name === name && entry.handler === handler);
        if (index >= 0) listeners.splice(index, 1);
    }

    return {
        context: { eventSource, eventTypes: { CHAT_CHANGED: 'chat_id_changed', MESSAGE_RECEIVED: 'message_received' } },
        listeners,
    };
}

test('stEvents.subscribe attaches to the REAL ST event name resolved through eventTypes, not the key itself', async () => {
    const { context, listeners } = fakeContext();
    const bus = createContractBus();
    registerStEventsService(bus, { getContext: () => context });
    const handler = () => {};

    const result = await new Promise(resolve => bus.subscribe('stEvents.subscribe', { params: { event: 'CHAT_CHANGED', handler } }, resolve));

    assert.deepEqual(result, { ok: true, value: true });
    assert.deepEqual(listeners, [{ name: 'chat_id_changed', handler }]);
});

test('stEvents.subscribe accepts a raw event name too, for a build where the key is not in eventTypes', async () => {
    const { context, listeners } = fakeContext();
    const bus = createContractBus();
    registerStEventsService(bus, { getContext: () => context });

    await new Promise(resolve => bus.subscribe('stEvents.subscribe', { params: { event: 'some_raw_name', handler: () => {} } }, resolve));

    assert.equal(listeners[0].name, 'some_raw_name');
});

test('stEvents.unsubscribe detaches the SAME handler reference via off()', async () => {
    const { context, listeners } = fakeContext();
    const bus = createContractBus();
    registerStEventsService(bus, { getContext: () => context });
    const handler = () => {};
    await new Promise(resolve => bus.subscribe('stEvents.subscribe', { params: { event: 'CHAT_CHANGED', handler } }, resolve));

    await new Promise(resolve => bus.subscribe('stEvents.unsubscribe', { params: { event: 'CHAT_CHANGED', handler } }, resolve));

    assert.deepEqual(listeners, []);
});

test('stEvents.unsubscribe falls back to removeListener() on a build that has no off()', async () => {
    const { context, listeners } = fakeContext({ withOff: false });
    const bus = createContractBus();
    registerStEventsService(bus, { getContext: () => context });
    const handler = () => {};
    await new Promise(resolve => bus.subscribe('stEvents.subscribe', { params: { event: 'CHAT_CHANGED', handler } }, resolve));

    await new Promise(resolve => bus.subscribe('stEvents.unsubscribe', { params: { event: 'CHAT_CHANGED', handler } }, resolve));

    assert.deepEqual(listeners, []);
});

test('stEvents.types lists every event key this ST build advertises — real discovery, not a list hardcoded by us', async () => {
    const { context } = fakeContext();
    const bus = createContractBus();
    registerStEventsService(bus, { getContext: () => context });

    const result = await new Promise(resolve => bus.subscribe('stEvents.types', {}, resolve));

    assert.deepEqual(result.value.sort(), ['CHAT_CHANGED', 'MESSAGE_RECEIVED']);
});

test('a build with no event API at all fails clearly through the normal envelope', async () => {
    const bus = createContractBus();
    registerStEventsService(bus, { getContext: () => ({}) });

    const result = await new Promise(resolve => bus.subscribe('stEvents.subscribe', { params: { event: 'CHAT_CHANGED', handler: () => {} } }, resolve));

    assert.equal(result.ok, false);
    assert.match(result.error.message, /eventSource/);
});
