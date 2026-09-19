import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeBuses } from '../libraries/shared/fake-buses.js';
import { registerSyncSignalService } from '../services/sync-signal.js';
import { request } from '../libraries/shared/request.js';

const ndjson = events => events.map(event => JSON.stringify(event)).join('\n') + '\n';

function setup(fetchImpl, options = {}) {
    const buses = createFakeBuses();
    const timers = [];
    registerSyncSignalService(buses.network, { fetch: fetchImpl, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {}, ...options });
    const call = (contract, params) => request(buses.network, contract, { params }).then(result => { if (!result.ok) throw new Error(result.error.message); return result.value; });
    return { call, timers };
}

test('published lines go to the topic one request each', async () => {
    const posted = [];
    const { call } = setup(async (url, options) => { posted.push([url, options.method, options.body]); return { ok: true, status: 200 }; });
    await call('syncSignal.publish', { server: 'https://ntfy.example', topic: 'stmeabc', lines: ['part-1', 'part-2'] });
    assert.deepEqual(posted, [['https://ntfy.example/stmeabc', 'POST', 'part-1'], ['https://ntfy.example/stmeabc', 'POST', 'part-2']]);
});

test('a refused publish is an error the Core can show', async () => {
    const { call } = setup(async () => ({ ok: false, status: 429 }));
    await assert.rejects(call('syncSignal.publish', { server: 'https://x', topic: 't', lines: ['a'] }), /HTTP 429/);
});

test('subscribing streams only real messages to the handler — opens and keepalives are ignored', async () => {
    const seen = [];
    let requestedUrl = '';
    const { call } = setup(async url => {
        requestedUrl = url;
        return { ok: true, status: 200, text: async () => ndjson([{ event: 'open' }, { event: 'message', message: 'hello', time: 1700 }, { event: 'keepalive' }, { event: 'message', message: 'again', time: 1701 }]) };
    });
    await call('syncSignal.subscribe', { server: 'https://ntfy.example', topic: 'stmeabc', since: '10m', handler: message => seen.push(message) });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(seen, ['hello', 'again']);
    assert.equal(requestedUrl, 'https://ntfy.example/stmeabc/json?since=10m');
});

test('a dropped stream reconnects after a growing pause and resumes from the last message it saw', async () => {
    const urls = [];
    let round = 0;
    const { call, timers } = setup(async url => {
        urls.push(url);
        round += 1;
        if (round === 1) return { ok: true, status: 200, text: async () => ndjson([{ event: 'message', message: 'one', time: 500 }]) };
        throw new Error('network down');
    });
    const states = [];
    await call('syncSignal.subscribe', { server: 'https://s', topic: 't', handler: () => {}, onState: state => states.push(state) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 1000);
    timers[0].fn();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(urls[1].endsWith('since=500'), true, 'resumes after the last seen message');
    assert.equal(timers[1].ms, 2000, 'the pause grows');
    assert.ok(states.includes('reconnecting'));
});

test('unsubscribing stops the loop and no reconnect timer fires afterwards', async () => {
    let calls = 0;
    const { call, timers } = setup(async () => { calls += 1; return { ok: true, status: 200, text: async () => '' }; });
    const { id } = await call('syncSignal.subscribe', { server: 'https://s', topic: 't', handler: () => {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await call('syncSignal.unsubscribe', { id }), true);
    timers[0]?.fn();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(await call('syncSignal.unsubscribe', { id }), false);
});
