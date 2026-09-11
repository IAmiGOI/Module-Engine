import test from 'node:test';
import assert from 'node:assert/strict';
import { createPicturePanelCore, isHttpUrl, classifyDrop } from '../cores/ui/picture-panel.js';
import { createContractBus } from '../libraries/shared/contract-bus.js';
import { createEventBus } from '../libraries/shared/event-bus.js';
import { signal } from '../cores/ui/reactive.js';

// --- Чистая классификация --------------------------------------------------

test('isHttpUrl() accepts http/https and rejects anything the HTTP service could not fetch', () => {
    assert.equal(isHttpUrl('https://example.com/pic.webp'), true);
    assert.equal(isHttpUrl('http://example.com/pic.png'), true);
    assert.equal(isHttpUrl('file:///C:/pic.png'), false, 'local file paths must never reach the HTTP service');
    assert.equal(isHttpUrl('data:image/png;base64,xxx'), false, 'data: URLs are not network resources');
    assert.equal(isHttpUrl('not a url'), false);
    assert.equal(isHttpUrl(''), false);
});

test('classifyDrop() prefers a FILE over text (a mixed drop carries both — the file is primary)', () => {
    const file = { name: 'cat.webp', type: 'image/webp' };
    const result = classifyDrop({ files: [file], text: 'https://example.com/other.png' });
    assert.equal(result.kind, 'file');
    assert.equal(result.file, file);
});

test('classifyDrop() reads a dragged LINK from text, taking the first token only', () => {
    const result = classifyDrop({ files: [], text: 'https://example.com/pic.webp\r\nhttps://extra.com' });
    assert.equal(result.kind, 'url');
    assert.equal(result.url, 'https://example.com/pic.webp', 'uri-list lines/trailing junk must not leak into the URL');
});

test('classifyDrop() honestly reports "none" for plain text that is not a URL — nothing shown, nothing guessed', () => {
    assert.deepEqual(classifyDrop({ files: [], text: 'just some words' }), { kind: 'none' });
    assert.deepEqual(classifyDrop({}), { kind: 'none' });
});

// --- Маршрут сети: полный путь Ядро → host.network (сетевой Гейт) → сервис --

// Фейковый host ровно той формы, которую Ядро использует: host.network.subscribe
// (через request-обёртку) — и НИЧЕГО другого для сети. Если ядро однажды
// попробует прямой fetch, этот тест это не увидит — но факт, что картинка по
// ссылке пришла ТОЛЬКО через подписку на 'http.request' на сетевой шине,
// тест доказывает: без запроса состояния 'ready' не бывает.
function fakeNetworkHost({ body = 'GIF89a', type = 'image/gif' } = {}) {
    const networkRequests = [];
    const network = {
        subscribe: (contract, options, callback) => {
            assert.equal(contract, 'http.request');
            networkRequests.push(options.params);
            // Отвечаем асинхронно, как настоящая шина.
            Promise.resolve().then(() => callback({
                ok: true,
                value: { status: 200, ok: true, headers: { 'content-type': type }, blob: { type, fake: true } },
            }));
            return () => {};
        },
    };
    const host = { network, own: { subscribe: () => () => {}, register: () => () => {} } };
    return { host, networkRequests };
}

test('a dropped URL is fetched ONLY through the full architecture route: host.network -> http.request (network gate), never any direct fetch', async () => {
    const { host, networkRequests } = fakeNetworkHost();
    const core = createPicturePanelCore(host, {
        mount: () => ({ settled: async () => {}, getRoot: () => ({}), unmount: () => {} }),
        blobToDataUrl: async () => 'data:image/gif;base64,xxx',
    });
    core.showSource({ kind: 'url', url: 'https://example.com/pic.webp' });
    // Промис показа резолвится через микротаски — даём ему дойти.
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(networkRequests.length, 1, 'exactly one request through the network bus');
    assert.equal(networkRequests[0].url, 'https://example.com/pic.webp');
    assert.equal(networkRequests[0].responseType, 'blob', 'binary body — default text() would mangle image bytes');
    assert.equal(core.showState.peek().kind, 'ready');
    core.stop();
});

test('a failed fetch (bus error envelope) lands in an honest error state, not a broken image', async () => {
    const network = {
        subscribe: (contract, options, callback) => {
            Promise.resolve().then(() => callback({ ok: false, error: { message: 'denied by the network gate' } }));
            return () => {};
        },
    };
    const host = { network, own: { subscribe: () => () => {}, register: () => () => {} } };
    const core = createPicturePanelCore(host, { mount: () => ({ settled: async () => {} }) });
    core.showSource({ kind: 'url', url: 'https://example.com/pic.webp' });
    await new Promise(resolve => setTimeout(resolve, 0));
    const state = core.showState.peek();
    assert.equal(state.kind, 'error');
    assert.match(state.message, /denied by the network gate/, 'the real refusal text reaches the user, not a generic failure');
});

test('a NON-image content-type from the service is rejected before rendering — the panel never pretends garbage is a picture', async () => {
    const network = {
        subscribe: (contract, options, callback) => {
            Promise.resolve().then(() => callback({
                ok: true,
                value: { status: 200, ok: true, headers: { 'content-type': 'text/html' }, blob: { type: 'text/html' } },
            }));
            return () => {};
        },
    };
    const host = { network, own: { subscribe: () => () => {}, register: () => () => {} } };
    const core = createPicturePanelCore(host, { mount: () => ({ settled: async () => {} }) });
    core.showSource({ kind: 'url', url: 'https://example.com/page.html' });
    await new Promise(resolve => setTimeout(resolve, 0));
    const state = core.showState.peek();
    assert.equal(state.kind, 'error');
    assert.match(state.message, /Not an image/);
});

test('a LOCAL image file needs no network at all: file drop goes straight to a blob URL (FileReader path, zero http.request calls)', async t => {
    const calls = [];
    const network = { subscribe: (contract, options, callback) => { calls.push(contract); return () => {}; } };
    const host = { network, own: { subscribe: () => () => {}, register: () => () => {} } };
    const core = createPicturePanelCore(host, { mount: () => ({ settled: async () => {} }) });
    // В node нет URL.createObjectURL — подменяем на счётчик, факт создания и
    // последующего отзыва в stop() проверяем по счётчику.
    const created = [];
    const originalCreate = globalThis.URL?.createObjectURL;
    const originalRevoke = globalThis.URL?.revokeObjectURL;
    t.mock.method(globalThis.URL, 'createObjectURL', () => { created.push('create'); return 'blob:fake'; });
    t.mock.method(globalThis.URL, 'revokeObjectURL', () => { created.push('revoke'); });
    try {
        core.showSource({ kind: 'file', file: { name: 'cat.webp', type: 'image/webp' } });
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(core.showState.peek().kind, 'ready');
        assert.deepEqual(calls, [], 'a local file must not touch the network route at all');
        assert.deepEqual(created, ['create']);
        core.stop();
        assert.deepEqual(created, ['create', 'revoke'], 'stop() revokes the blob URL — no leak per dropped file');
    } finally {
        // Вернуть исходные методы не нужно: t.mock восстанавливает сам.
        void originalCreate;
    }
});

test('a non-image FILE is refused honestly, without touching URL.createObjectURL', async t => {
    const network = { subscribe: (contract, options, callback) => { assert.fail('network must not be used for a file drop'); return () => {}; } };
    const host = { network, own: { subscribe: () => () => {}, register: () => () => {} } };
    const core = createPicturePanelCore(host, { mount: () => ({ settled: async () => {} }) });
    let createdCalled = false;
    t.mock.method(globalThis.URL, 'createObjectURL', () => { createdCalled = true; return 'blob:fake'; });
    core.showSource({ kind: 'file', file: { name: 'notes.txt', type: 'text/plain' } });
    await new Promise(resolve => setTimeout(resolve, 0));
    const state = core.showState.peek();
    assert.equal(state.kind, 'error');
    assert.match(state.message, /Not an image/);
    assert.equal(createdCalled, false, 'no object URL for a non-image file');
});

test('handleDrop() wires the raw DOM drop event through classifyDrop: file wins over text, junk drop is a silent no-op', async t => {
    const network = { subscribe: () => () => {} };
    const host = { network, own: { subscribe: () => () => {}, register: () => () => {} } };
    const core = createPicturePanelCore(host, { mount: () => ({ settled: async () => {} }) });
    const created = [];
    t.mock.method(globalThis.URL, 'createObjectURL', () => { created.push('create'); return 'blob:fake'; });

    core.handleDrop({ dataTransfer: { files: [{ name: 'a.png', type: 'image/png' }], getData: () => 'https://example.com/x' } });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(core.showState.peek().kind, 'ready', 'file wins over the dragged link');

    const before = core.showState.peek();
    core.handleDrop({ dataTransfer: { files: [], getData: () => 'hello there' } });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(core.showState.peek(), before, 'a junk drop changes nothing');
});