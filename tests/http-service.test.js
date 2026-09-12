import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHttpService } from '../services/http.js';
import { createContractBus } from '../libraries/shared/contract-bus.js';

function fakeFetch(responses) {
    const calls = [];
    return {
        calls,
        fetch: async (url, init) => {
            calls.push({ url, ...init });
            const response = responses[url] ?? { status: 200, body: '' };
            return {
                status: response.status,
                ok: response.status >= 200 && response.status < 300,
                headers: { entries: () => Object.entries(response.headers ?? {}) },
                text: async () => response.body,
            };
        },
    };
}

test('registerHttpService() registers http.request as a real contract, delegating to the injected fetch', async () => {
    const { fetch, calls } = fakeFetch({ 'https://example.com': { status: 200, body: 'hello' } });
    const bus = createContractBus();
    registerHttpService(bus, { fetch });

    const result = await new Promise(resolve =>
        bus.subscribe('http.request', { params: { url: 'https://example.com' } }, resolve));

    assert.equal(result.ok, true);
    assert.equal(result.value.status, 200);
    assert.equal(result.value.ok, true);
    assert.equal(result.value.text, 'hello');
    assert.equal(calls[0].url, 'https://example.com');
    assert.equal(calls[0].method, 'GET');
});

test('http.request forwards method/headers/body to fetch, and reports a non-2xx status without throwing', async () => {
    const { fetch, calls } = fakeFetch({ 'https://example.com/api': { status: 404, body: 'not found' } });
    const bus = createContractBus();
    registerHttpService(bus, { fetch });

    const result = await new Promise(resolve =>
        bus.subscribe('http.request', {
            params: { url: 'https://example.com/api', method: 'POST', headers: { 'X-Test': '1' }, body: '{"a":1}' },
        }, resolve));

    assert.equal(result.ok, true, 'a non-2xx HTTP response is still a successful bus call — see the universal error envelope');
    assert.equal(result.value.status, 404);
    assert.equal(result.value.ok, false);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].headers['X-Test'], '1');
    assert.equal(calls[0].body, '{"a":1}');
});

test('registerHttpService()\'s returned unregister function retires the contract', async () => {
    const { fetch } = fakeFetch({});
    const bus = createContractBus();
    const unregister = registerHttpService(bus, { fetch });

    unregister();
    const result = await new Promise(resolve =>
        bus.subscribe('http.request', { params: { url: 'https://example.com' } }, resolve));

    assert.equal(result.ok, false);
});

test('http.request with responseType:"blob" returns the body as a blob instead of text — text() would UTF-8-mangle image bytes (picture panel)', async () => {
    const fakeBlob = { size: 3, type: 'image/webp' };
    const { fetch, calls } = fakeFetch({
        'https://example.com/pic.webp': {
            status: 200,
            body: fakeBlob, // фейковый fetch возвращает объект и как body, и как blob
            headers: { 'content-type': 'image/webp' },
        },
    });
    const bus = createContractBus();
    registerHttpService(bus, { fetch: async (url, init) => ({ ...(await fetch(url, init)), blob: async () => fakeBlob }) });

    const result = await new Promise(resolve =>
        bus.subscribe('http.request', { params: { url: 'https://example.com/pic.webp', responseType: 'blob' } }, resolve));

    assert.equal(result.ok, true);
    assert.equal(result.value.blob, fakeBlob, 'the blob comes back live, not through the UTF-8 text decoder');
    assert.equal(result.value.text, undefined, 'no text field when a blob was requested — bytes must not round-trip through text');
    assert.equal(calls[0].url, 'https://example.com/pic.webp');
});

test('http.request WITHOUT responseType keeps the default text behavior (optional parameter, zero regression for other callers)', async () => {
    const { fetch } = fakeFetch({ 'https://example.com': { status: 200, body: 'hello' } });
    const bus = createContractBus();
    registerHttpService(bus, { fetch });

    const result = await new Promise(resolve =>
        bus.subscribe('http.request', { params: { url: 'https://example.com' } }, resolve));

    assert.equal(result.value.text, 'hello');
    assert.equal(result.value.blob, undefined);
});

// --- Стриминг: params.stream делит тело на SSE-фреймы, params.stallMs абортит зависший поток ---

/** Фейковый `Response` с `.body` как реальный `ReadableStream`, отдающий заданные строки чанк-за-чанком (с паузами между ними, если заданы delaysMs). */
function fakeStreamingFetch({ chunks, delaysMs = [], status = 200 }) {
    const calls = [];
    return {
        calls,
        fetch: async (url, init) => {
            calls.push({ url, ...init });
            let index = 0;
            const encoder = new TextEncoder();
            const body = new ReadableStream({
                async pull(controller) {
                    if (init.signal?.aborted) { controller.error(new DOMException('aborted', 'AbortError')); return; }
                    if (index >= chunks.length) { controller.close(); return; }
                    const delay = delaysMs[index] ?? 0;
                    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
                    if (init.signal?.aborted) { controller.error(new DOMException('aborted', 'AbortError')); return; }
                    controller.enqueue(encoder.encode(chunks[index]));
                    index += 1;
                },
            });
            return { status, ok: status >= 200 && status < 300, headers: { entries: () => [] }, body };
        },
    };
}

test('http.request with stream:true delivers one onChunk per complete SSE frame and still returns the full raw text', async () => {
    const { fetch } = fakeStreamingFetch({ chunks: ['data: one\n\n', 'data: two\n\n'] });
    const bus = createContractBus();
    registerHttpService(bus, { fetch });
    const frames = [];

    const result = await new Promise(resolve =>
        bus.subscribe('http.request', { params: { url: 'https://example.com', stream: true, onChunk: frame => frames.push(frame) } }, resolve));

    assert.equal(result.ok, true);
    assert.equal(result.value.ok, true);
    assert.deepEqual(frames.map(f => f.data), ['one', 'two']);
    assert.equal(result.value.text, 'data: one\n\ndata: two\n\n');
});

test('http.request with stream:true and a frame split across two underlying chunks still yields exactly one onChunk call', async () => {
    const { fetch } = fakeStreamingFetch({ chunks: ['data: par', 'tial\n\n'] });
    const bus = createContractBus();
    registerHttpService(bus, { fetch });
    const frames = [];

    await new Promise(resolve =>
        bus.subscribe('http.request', { params: { url: 'https://example.com', stream: true, onChunk: frame => frames.push(frame) } }, resolve));

    assert.deepEqual(frames.map(f => f.data), ['partial']);
});

test('http.request with stream:true and stallMs aborts and rejects when no chunk arrives in time — this is the whole point of the watchdog', async () => {
    const { fetch } = fakeStreamingFetch({ chunks: ['data: one\n\n', 'data: two\n\n'], delaysMs: [0, 50] });
    const bus = createContractBus();
    registerHttpService(bus, { fetch });

    const result = await new Promise(resolve =>
        bus.subscribe('http.request', { params: { url: 'https://example.com', stream: true, stallMs: 10 } }, resolve));

    assert.equal(result.ok, false);
    assert.match(result.error.message, /stalled/);
});

test('http.request with stream:true and stallMs does NOT abort as long as chunks keep arriving faster than the timeout — the timer resets on each chunk, not on the whole request. Total delay (120ms) deliberately EXCEEDS stallMs (60ms): only a per-chunk reset survives this, a single upfront timeout would not', async () => {
    const { fetch } = fakeStreamingFetch({ chunks: ['data: one\n\n', 'data: two\n\n', 'data: three\n\n'], delaysMs: [40, 40, 40] });
    const bus = createContractBus();
    registerHttpService(bus, { fetch });
    const frames = [];

    const result = await new Promise(resolve =>
        bus.subscribe('http.request', { params: { url: 'https://example.com', stream: true, stallMs: 60, onChunk: frame => frames.push(frame) } }, resolve));

    assert.equal(result.ok, true);
    assert.deepEqual(frames.map(f => f.data), ['one', 'two', 'three']);
});

test('http.request with stream:true but no stallMs never aborts, matching every other request without a timeout today', async () => {
    const { fetch } = fakeStreamingFetch({ chunks: ['data: one\n\n'], delaysMs: [30] });
    const bus = createContractBus();
    registerHttpService(bus, { fetch });

    const result = await new Promise(resolve =>
        bus.subscribe('http.request', { params: { url: 'https://example.com', stream: true } }, resolve));

    assert.equal(result.ok, true);
});
