import test from 'node:test';
import assert from 'node:assert/strict';
import { registerChatMetadataService } from '../services/chat-metadata.js';
import { createContractBus } from '../libraries/shared/contract-bus.js';

function fakeContext(initialChatMetadata = {}) {
    let saveCalls = 0;
    return {
        context: {
            chatMetadata: initialChatMetadata,
            saveMetadataDebounced: () => { saveCalls += 1; },
        },
        saveCalls: () => saveCalls,
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

test('registerChatMetadataService()\'s returned unregister function retires both contracts', async () => {
    const { context } = fakeContext({});
    const bus = createContractBus();
    const unregister = registerChatMetadataService(bus, { getContext: () => context });

    unregister();
    const result = await new Promise(resolve => bus.subscribe('chatMetadata.read', {}, resolve));

    assert.equal(result.ok, false);
});
