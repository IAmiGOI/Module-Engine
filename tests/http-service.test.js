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
