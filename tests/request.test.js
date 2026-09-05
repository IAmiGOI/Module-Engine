import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { request } from '../libraries/shared/request.js';

/** A minimal stub bus — just enough of `subscribe()`'s real shape to drive request() in isolation, no real contract-bus needed for these tests. */
function makeStubBus() {
    let capturedCallback = null;
    let capturedArgs = null;
    let unsubscribed = false;
    return {
        subscribe: (contract, options, callback) => {
            capturedArgs = { contract, options };
            capturedCallback = callback;
            return () => { unsubscribed = true; };
        },
        deliver: result => capturedCallback(result),
        get capturedArgs() { return capturedArgs; },
        get unsubscribed() { return unsubscribed; },
    };
}

test('resolves with the first delivered result, and unsubscribes right after', async () => {
    const bus = makeStubBus();
    const pending = request(bus, 'demo.contract', { params: { x: 1 } });

    bus.deliver({ ok: true, value: 'hi' });
    const result = await pending;

    assert.deepEqual(result, { ok: true, value: 'hi' });
    assert.equal(bus.unsubscribed, true);
});

test('passes params/when straight through to bus.subscribe()', () => {
    const bus = makeStubBus();
    request(bus, 'demo.contract', { params: { x: 1 }, when: { event: 'y' } });

    assert.equal(bus.capturedArgs.contract, 'demo.contract');
    assert.deepEqual(bus.capturedArgs.options, { params: { x: 1 }, when: { event: 'y' } });
});

test('a second delivery after the first is ignored — request() settles exactly once', async () => {
    const bus = makeStubBus();
    const pending = request(bus, 'demo.contract', {});
    bus.deliver({ ok: true, value: 'first' });
    bus.deliver({ ok: true, value: 'second' }); // must be ignored — already resolved

    assert.deepEqual(await pending, { ok: true, value: 'first' });
});

test('with no timeoutMs, it simply never resolves on its own — no default timeout exists', async () => {
    const bus = makeStubBus();
    let settled = false;
    request(bus, 'demo.contract', {}).then(() => { settled = true; });

    await new Promise(resolve => setTimeout(resolve, 20));

    assert.equal(settled, false);
});

test('on timeout with no delivery, resolves (never rejects) with the standard failure envelope', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
        const bus = makeStubBus();
        const pending = request(bus, 'demo.contract', { timeoutMs: 5000 });

        mock.timers.tick(5000);
        const result = await pending;

        assert.equal(result.ok, false);
        assert.match(result.error.message, /demo\.contract.*timed out/);
        assert.equal(bus.unsubscribed, true);
    } finally {
        mock.timers.reset();
    }
});

test('a delivery that arrives before the timeout wins — the timeout never fires afterward', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
        const bus = makeStubBus();
        const pending = request(bus, 'demo.contract', { timeoutMs: 5000 });

        bus.deliver({ ok: true, value: 'real result' });
        const result = await pending;
        mock.timers.tick(5000); // must be a no-op now — already settled

        assert.deepEqual(result, { ok: true, value: 'real result' });
    } finally {
        mock.timers.reset();
    }
});
