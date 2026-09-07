import test from 'node:test';
import assert from 'node:assert/strict';
import { registerChatMetadataService } from '../services/chat-metadata.js';
import { createContractBus } from '../libraries/shared/contract-bus.js';

function fakeContext(initialChatMetadata = {}) {
    let saveCalls = 0;
    let flushCalls = 0;
    return {
        context: {
            chatMetadata: initialChatMetadata,
            saveMetadataDebounced: () => { saveCalls += 1; },
            saveMetadata: async () => { flushCalls += 1; },
        },
        saveCalls: () => saveCalls,
        flushCalls: () => flushCalls,
    };
}

test('chatMetadata.read returns {} when nothing has ever been stored for this chat', async () => {
    const { context } = fakeContext({});
    const bus = createContractBus();
    registerChatMetadataService(bus, { getContext: () => context });

    const result = await new Promise(resolve => bus.subscribe('chatMetadata.read', {}, resolve));

    assert.deepEqual(result, { ok: true, value: {} });
});

test('chatMetadata.write stores the raw object under its own key and calls saveMetadataDebounced exactly once', async () => {
    const { context, saveCalls } = fakeContext({});
    const bus = createContractBus();
    registerChatMetadataService(bus, { getContext: () => context });

    await new Promise(resolve => bus.subscribe('chatMetadata.write', { params: { raw: { 'core.tracking': { value: 1 } } } }, resolve));

    assert.deepEqual(context.chatMetadata.stme_memory, { 'core.tracking': { value: 1 } });
    assert.equal(saveCalls(), 1);
});

test('chatMetadata.read reflects a value written by a previous chatMetadata.write on the same context', async () => {
    const { context } = fakeContext({});
    const bus = createContractBus();
    registerChatMetadataService(bus, { getContext: () => context });

    await new Promise(resolve => bus.subscribe('chatMetadata.write', { params: { raw: { ns: { key: 'value' } } } }, resolve));
    const result = await new Promise(resolve => bus.subscribe('chatMetadata.read', {}, resolve));

    assert.deepEqual(result.value, { ns: { key: 'value' } });
});

test('a custom storageKey keeps this Сервис\'s data out of chatMetadata\'s default slot, e.g. for a second isolated instance', async () => {
    const { context } = fakeContext({});
    const bus = createContractBus();
    registerChatMetadataService(bus, { getContext: () => context, storageKey: 'custom_slot' });

    await new Promise(resolve => bus.subscribe('chatMetadata.write', { params: { raw: { ns: { key: 'v' } } } }, resolve));

    assert.deepEqual(context.chatMetadata.custom_slot, { ns: { key: 'v' } });
    assert.equal('stme_memory' in context.chatMetadata, false);
});

test('registerChatMetadataService()\'s returned unregister function retires every contract, including flush', async () => {
    const { context } = fakeContext({});
    const bus = createContractBus();
    const unregister = registerChatMetadataService(bus, { getContext: () => context });

    unregister();
    const readResult = await new Promise(resolve => bus.subscribe('chatMetadata.read', {}, resolve));
    const flushResult = await new Promise(resolve => bus.subscribe('chatMetadata.flush', {}, resolve));

    assert.equal(readResult.ok, false);
    assert.equal(flushResult.ok, false);
});

// --- chatMetadata.flush — bypasses saveMetadataDebounced()'s 1000ms window ---
// Реальный баг, найден по жалобе пользователя: перезагрузка страницы сразу
// после бутстрапа теряла только что построенный граф целиком, потому что
// настоящий ST (см. `public/scripts/extensions.js`'s `saveMetadataDebounced()`)
// откладывает реальное сохранение на debounce_timeout.relaxed (1000ms) —
// достаточно, чтобы пользователь успел перезагрузить страницу раньше.

test('chatMetadata.flush calls the REAL context.saveMetadata() directly — not the debounced wrapper', async () => {
    const { context, saveCalls, flushCalls } = fakeContext({});
    const bus = createContractBus();
    registerChatMetadataService(bus, { getContext: () => context });

    const result = await new Promise(resolve => bus.subscribe('chatMetadata.flush', {}, resolve));

    assert.equal(result.ok, true);
    assert.equal(flushCalls(), 1, 'context.saveMetadata() must have been called for real, not just debounced');
    assert.equal(saveCalls(), 0, 'flush must not ALSO trigger the debounced path — that would just re-arm the very timer it exists to bypass');
});

test('chatMetadata.flush is awaited — a caller relying on it must see the real save actually complete first', async () => {
    let resolveSave;
    const context = {
        chatMetadata: {},
        saveMetadataDebounced: () => {},
        saveMetadata: () => new Promise(resolve => { resolveSave = resolve; }),
    };
    const bus = createContractBus();
    registerChatMetadataService(bus, { getContext: () => context });

    let settled = false;
    const flushPromise = new Promise(resolve => bus.subscribe('chatMetadata.flush', {}, resolve)).then(result => { settled = true; return result; });
    await Promise.resolve(); // let the microtask queue drain once, so a synchronous (buggy) flush would already show settled=true here
    assert.equal(settled, false, 'flush resolved before the underlying saveMetadata() promise did — it is not actually being awaited');

    resolveSave();
    const result = await flushPromise;
    assert.equal(settled, true);
    assert.equal(result.ok, true);
});
