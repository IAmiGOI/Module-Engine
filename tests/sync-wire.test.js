import test from 'node:test';
import assert from 'node:assert/strict';
import { createLinkedEndpoints, createRpcEndpoint } from '../libraries/core/sync-wire.js';

const bytesOf = (length, seed = 1) => Uint8Array.from({ length }, (_, index) => (index * 31 + seed) % 251);

test('a call without a body gets the handler result back', async () => {
    const { a, b } = createLinkedEndpoints({}, { handlers: { hello: params => ({ greeting: `hi ${params.name}` }) } });
    const { result, body } = await a.call('hello', { name: 'phone' });
    assert.deepEqual(result, { greeting: 'hi phone' });
    assert.equal(body, undefined);
    void b;
});

test('a big request body arrives intact in small frames', async () => {
    const seen = [];
    const { a } = createLinkedEndpoints(
        { chunkBytes: 1000 },
        { handlers: { put: async (params, { body }) => { seen.push(new Uint8Array(await body.arrayBuffer())); return { received: body.size, path: params.path }; } } },
    );
    const payload = bytesOf(50_321);
    const { result } = await a.call('put', { path: 'backgrounds/a.png' }, { body: new Blob([payload]) });
    assert.deepEqual(result, { received: 50_321, path: 'backgrounds/a.png' });
    assert.deepEqual(seen[0], payload);
});

test('a big response body arrives intact, also when it is a plain Uint8Array', async () => {
    const payload = bytesOf(70_000, 7);
    const { a } = createLinkedEndpoints({}, { chunkBytes: 4096, handlers: { get: () => ({ result: { name: 'x' }, body: payload }) } });
    const { result, body } = await a.call('get', {});
    assert.deepEqual(result, { name: 'x' });
    assert.deepEqual(new Uint8Array(await body.arrayBuffer()), payload);
});

test('both sides can call each other at the same time, even when their call numbers collide', async () => {
    const { a, b } = createLinkedEndpoints(
        { handlers: { whoAmI: () => 'A', echo: async (_, { body }) => ({ result: 'a-echo', body }) } },
        { handlers: { whoAmI: () => 'B', echo: async (_, { body }) => ({ result: 'b-echo', body }) } },
    );
    const [fromA, fromB, echoA, echoB] = await Promise.all([
        a.call('whoAmI', {}),
        b.call('whoAmI', {}),
        a.call('echo', {}, { body: new Blob([bytesOf(3000, 1)]) }),
        b.call('echo', {}, { body: new Blob([bytesOf(3000, 2)]) }),
    ]);
    assert.equal(fromA.result, 'B');
    assert.equal(fromB.result, 'A');
    assert.equal(echoA.result, 'b-echo');
    assert.equal(echoB.result, 'a-echo');
    assert.deepEqual(new Uint8Array(await echoA.body.arrayBuffer()), bytesOf(3000, 1));
    assert.deepEqual(new Uint8Array(await echoB.body.arrayBuffer()), bytesOf(3000, 2));
});

test('a handler error turns into a rejected call, an unknown method too', async () => {
    const { a } = createLinkedEndpoints({}, { handlers: { boom: () => { throw new Error('disk on fire'); } } });
    await assert.rejects(a.call('boom', {}), /disk on fire/);
    await assert.rejects(a.call('nothing', {}), /unknown sync method/);
});

test('a call times out only after the channel goes quiet, not while data keeps flowing', async () => {
    const timers = new Map();
    let handle = 0;
    const fakeTimers = { setTimer: (fn) => { handle += 1; timers.set(handle, fn); return handle; }, clearTimer: id => timers.delete(id) };
    const lonely = createRpcEndpoint({ send: () => {}, ...fakeTimers });
    const call = lonely.call('anything', {});
    await new Promise(resolve => setImmediate(resolve));
    for (const fn of [...timers.values()]) fn();
    await assert.rejects(call, /timed out/);
});

test('closing the endpoint rejects every call still waiting', async () => {
    const lonely = createRpcEndpoint({ send: () => {} });
    const call = lonely.call('x', {});
    lonely.close(new Error('peer left'));
    await assert.rejects(call, /peer left/);
    await assert.rejects(lonely.call('y', {}), /closed/);
});

test('the sender waits for the channel to drain between frames', async () => {
    let buffered = 0;
    let peak = 0;
    const sent = [];
    const endpoint = createRpcEndpoint({
        chunkBytes: 100,
        send: frame => { if (typeof frame !== 'string') { buffered += 1; peak = Math.max(peak, buffered); sent.push(frame.byteLength); } },
        drain: async () => { buffered = 0; },
    });
    endpoint.call('put', {}, { body: new Uint8Array(1000) }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(sent.length, 10);
    assert.equal(peak, 1, 'never more than one undrained frame');
    endpoint.close();
});
