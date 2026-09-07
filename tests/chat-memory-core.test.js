import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerChatMetadataService } from '../services/chat-metadata.js';
import { createChatMemoryCore } from '../cores/memory/index.js';

/**
 * Scenario level (TESTING.md "Уровень 2") — real engine, real Гейты, real
 * dispatch through the Шина ядер and the Шина сервисов; only `getContext()`
 * (the true ST boundary) is faked. Proves "Модуль -> Гейт -> Ядро
 * внутренней памяти чата -> Гейт -> Сервис chatMetadata" end to end.
 */

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

function buildEngineWithMemoryCore() {
    const engine = createEngine();
    const { context, saveCalls, flushCalls } = fakeContext({});
    registerChatMetadataService(engine.buses.services, { getContext: () => context });
    const memoryHost = engine.registerCaller('core.memory.chat', 'cores', { tier: 'official' });
    createChatMemoryCore(memoryHost);
    return { engine, context, saveCalls, flushCalls };
}

test('a Module writes then reads back a value through the real Director -> Гейт -> Ядро -> Гейт -> Сервис chain', async () => {
    const { engine, saveCalls } = buildEngineWithMemoryCore();
    const module = engine.registerCaller('module.notebook', 'modules', { tier: 'community', allowedContracts: ['storage.chatMemory.get', 'storage.chatMemory.set'] });

    const setResult = await new Promise(resolve => module.cores.subscribe('storage.chatMemory.set', { params: { namespace: 'module.notebook', key: 'notes', value: ['a', 'b'] } }, resolve));
    const getResult = await new Promise(resolve => module.cores.subscribe('storage.chatMemory.get', { params: { namespace: 'module.notebook', key: 'notes' } }, resolve));

    assert.deepEqual(setResult, { ok: true, value: true });
    assert.deepEqual(getResult, { ok: true, value: ['a', 'b'] });
    assert.equal(saveCalls(), 1, 'exactly one real chatMetadata save for the one set()');
});

test('two different namespaces stay isolated — one module cannot read what a different namespace wrote', async () => {
    const { engine } = buildEngineWithMemoryCore();
    const moduleA = engine.registerCaller('module.a', 'modules', { tier: 'official' });
    const moduleB = engine.registerCaller('module.b', 'modules', { tier: 'official' });

    await new Promise(resolve => moduleA.cores.subscribe('storage.chatMemory.set', { params: { namespace: 'module.a', key: 'shared-key-name', value: 'a-value' } }, resolve));
    await new Promise(resolve => moduleB.cores.subscribe('storage.chatMemory.set', { params: { namespace: 'module.b', key: 'shared-key-name', value: 'b-value' } }, resolve));

    const readA = await new Promise(resolve => moduleA.cores.subscribe('storage.chatMemory.get', { params: { namespace: 'module.a', key: 'shared-key-name' } }, resolve));
    const readB = await new Promise(resolve => moduleB.cores.subscribe('storage.chatMemory.get', { params: { namespace: 'module.b', key: 'shared-key-name' } }, resolve));

    assert.equal(readA.value, 'a-value');
    assert.equal(readB.value, 'b-value');
});

test('a missing key returns the caller-supplied fallback rather than undefined-through-the-envelope', async () => {
    const { engine } = buildEngineWithMemoryCore();
    const module = engine.registerCaller('module.notebook', 'modules', { tier: 'official' });

    const result = await new Promise(resolve => module.cores.subscribe('storage.chatMemory.get', { params: { namespace: 'module.notebook', key: 'never-set', fallback: 'default' } }, resolve));

    assert.deepEqual(result, { ok: true, value: 'default' });
});

test('remove() deletes a previously-set key; keys() reflects the current set for that namespace only', async () => {
    const { engine, saveCalls } = buildEngineWithMemoryCore();
    const module = engine.registerCaller('module.notebook', 'modules', { tier: 'official' });
    await new Promise(resolve => module.cores.subscribe('storage.chatMemory.set', { params: { namespace: 'module.notebook', key: 'a', value: 1 } }, resolve));
    await new Promise(resolve => module.cores.subscribe('storage.chatMemory.set', { params: { namespace: 'module.notebook', key: 'b', value: 2 } }, resolve));

    const keysBefore = await new Promise(resolve => module.cores.subscribe('storage.chatMemory.keys', { params: { namespace: 'module.notebook' } }, resolve));
    assert.deepEqual(keysBefore.value.sort(), ['a', 'b']);

    const removeResult = await new Promise(resolve => module.cores.subscribe('storage.chatMemory.remove', { params: { namespace: 'module.notebook', key: 'a' } }, resolve));
    const keysAfter = await new Promise(resolve => module.cores.subscribe('storage.chatMemory.keys', { params: { namespace: 'module.notebook' } }, resolve));

    assert.deepEqual(removeResult, { ok: true, value: true });
    assert.deepEqual(keysAfter.value, ['b']);
    assert.equal(saveCalls(), 3, 'two set()s + one actual remove() — a fourth save must not happen for the redundant removal below');

    const redundantRemove = await new Promise(resolve => module.cores.subscribe('storage.chatMemory.remove', { params: { namespace: 'module.notebook', key: 'a' } }, resolve));
    assert.deepEqual(redundantRemove, { ok: true, value: false });
    assert.equal(saveCalls(), 3, 'removing an already-gone key must not trigger another chatMetadata save');
});

test('set()/get() without a namespace or key fails with a clear error through the normal envelope, never hangs', async () => {
    const { engine } = buildEngineWithMemoryCore();
    const module = engine.registerCaller('module.notebook', 'modules', { tier: 'official' });

    const result = await new Promise(resolve => module.cores.subscribe('storage.chatMemory.set', { params: { key: 'a', value: 1 } }, resolve));

    assert.equal(result.ok, false);
    assert.match(result.error.message, /namespace/);
});

test('two concurrent FIRST writes to the same namespace both survive — neither set() reads a stale empty fallback and clobbers the other', async () => {
    const { engine } = buildEngineWithMemoryCore();
    const moduleA = engine.registerCaller('module.a', 'modules', { tier: 'official' });
    const moduleB = engine.registerCaller('module.b', 'modules', { tier: 'official' });

    // Same namespace, DIFFERENT keys — before the queue, both could read the
    // namespace's bucket as freshly-empty and write back only their own key.
    const setA = new Promise(resolve => moduleA.cores.subscribe('storage.chatMemory.set', { params: { namespace: 'shared', key: 'a', value: 1 } }, resolve));
    const setB = new Promise(resolve => moduleB.cores.subscribe('storage.chatMemory.set', { params: { namespace: 'shared', key: 'b', value: 2 } }, resolve));
    await Promise.all([setA, setB]);

    const keys = await new Promise(resolve => moduleA.cores.subscribe('storage.chatMemory.keys', { params: { namespace: 'shared' } }, resolve));
    assert.deepEqual(keys.value.sort(), ['a', 'b'], 'both concurrent first writes must land, not just whichever finished last');
});

test('a Module without the right to storage.chatMemory.set is refused before the Ядро — and the Сервис save — are ever reached', async () => {
    const { engine, saveCalls } = buildEngineWithMemoryCore();
    const module = engine.registerCaller('module.untrusted', 'modules', { tier: 'community', allowedContracts: [] });

    const result = await new Promise(resolve => module.cores.subscribe('storage.chatMemory.set', { params: { namespace: 'module.untrusted', key: 'a', value: 1 } }, resolve));

    assert.equal(result.ok, false);
    assert.equal(saveCalls(), 0);
});

// --- storage.chatMemory.flush — real save NOW, bypassing saveMetadataDebounced()'s 1s window ---
// Реальный баг, найден по жалобе пользователя: перезагрузка страницы вскоре
// после bootstrapFromLorebook() теряла только что построенный граф —
// saveMetadataDebounced() (настоящий ST, public/scripts/extensions.js)
// откладывает реальную запись на debounce_timeout.relaxed (1000ms).

test('storage.chatMemory.flush reaches the real Сервис save (saveMetadata()), through the full Director -> Гейт -> Ядро -> Гейт -> Сервис chain', async () => {
    const { engine, flushCalls } = buildEngineWithMemoryCore();
    const module = engine.registerCaller('module.notebook', 'modules', { tier: 'community', allowedContracts: ['storage.chatMemory.set', 'storage.chatMemory.flush'] });
    await new Promise(resolve => module.cores.subscribe('storage.chatMemory.set', { params: { namespace: 'module.notebook', key: 'notes', value: ['a'] } }, resolve));

    const result = await new Promise(resolve => module.cores.subscribe('storage.chatMemory.flush', {}, resolve));

    assert.deepEqual(result, { ok: true, value: true });
    assert.equal(flushCalls(), 1, 'the REAL context.saveMetadata() must have actually been called — a debounced-only save can still be lost on an immediate page reload');
});

test('storage.chatMemory.flush waits for already-queued set() calls to land first — flushing mid-write would save a stale, half-written blob', async () => {
    const { engine, context } = buildEngineWithMemoryCore();
    const module = engine.registerCaller('module.notebook', 'modules', { tier: 'community', allowedContracts: ['storage.chatMemory.set', 'storage.chatMemory.flush'] });

    // Fired WITHOUT awaiting the set() first — same shape as bootstrapFromLorebook()'s
    // Promise.all([...persist calls]) racing a flush right after.
    const setPromise = new Promise(resolve => module.cores.subscribe('storage.chatMemory.set', { params: { namespace: 'module.notebook', key: 'notes', value: ['a', 'b'] } }, resolve));
    const flushPromise = new Promise(resolve => module.cores.subscribe('storage.chatMemory.flush', {}, resolve));
    await Promise.all([setPromise, flushPromise]);

    assert.deepEqual(context.chatMetadata.stme_memory, { 'module.notebook': { notes: ['a', 'b'] } }, 'by the time flush() resolves, the queued set() must already be reflected in the raw blob it saved');
});

test('a Module without the right to storage.chatMemory.flush is refused before the real save is ever reached', async () => {
    const { engine, flushCalls } = buildEngineWithMemoryCore();
    const module = engine.registerCaller('module.untrusted', 'modules', { tier: 'community', allowedContracts: [] });

    const result = await new Promise(resolve => module.cores.subscribe('storage.chatMemory.flush', {}, resolve));

    assert.equal(result.ok, false);
    assert.equal(flushCalls(), 0);
});
