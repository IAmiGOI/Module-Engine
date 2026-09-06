import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerStChatService } from '../services/st-chat.js';
import { registerChatMetadataService } from '../services/chat-metadata.js';
import { createChatMemoryCore } from '../cores/memory/index.js';
import { createChatHistoryCore } from '../cores/chat-history/index.js';

/**
 * Scenario level (TESTING.md "Уровень 2") — real engine, real Гейты, real
 * dispatch through the Шина ядер; only `getContext()` is faked. Proves
 * "Модуль -> Гейт -> Ядро истории чата -> {Сервис stChat, Ядро памяти чата}"
 * end to end — the whole reason this Ядро exists is to give Модулям (who
 * cannot reach Сервисы directly) a `mesid` and a place to attach info to it.
 */

function buildEngine(chat = []) {
    const engine = createEngine();
    const context = { chat, chatMetadata: {}, saveMetadataDebounced: () => {} };
    registerStChatService(engine.buses.services, { getContext: () => context });
    registerChatMetadataService(engine.buses.services, { getContext: () => context });
    createChatMemoryCore(engine.registerCaller('core.memory.chat', 'cores', { tier: 'official' }));
    createChatHistoryCore(engine.registerCaller('core.chatHistory', 'cores', { tier: 'official' }));
    const module = engine.registerCaller('module.time', 'modules', {
        tier: 'community',
        allowedContracts: ['chatHistory.messages', 'chatHistory.annotate', 'chatHistory.annotations', 'chatHistory.clearAnnotations'],
    });
    return { engine, context, module };
}

function call(module, contract, params) {
    return new Promise(resolve => module.cores.subscribe(contract, { params }, resolve));
}

test('chatHistory.messages proxies real chat text WITH mesid — a Модуль cannot reach stChat.messages on its own', async () => {
    const { module } = buildEngine([
        { is_user: true, is_system: false, mes: 'I open the door.' },
        { is_user: false, is_system: false, mes: 'It creaks loudly.' },
    ]);

    const result = await call(module, 'chatHistory.messages', { limit: 10 });

    assert.equal(result.ok, true);
    assert.deepEqual(result.value.map(item => item.mesid), ['0', '1']);
    assert.equal(result.value[1].text, 'It creaks loudly.');
});

test('annotate() then annotations() round-trips a per-message value', async () => {
    const { module } = buildEngine();

    await call(module, 'chatHistory.annotate', { namespace: 'module.time', mesid: '3', value: 'Day 1, 08:03' });
    const result = await call(module, 'chatHistory.annotations', { namespace: 'module.time' });

    assert.deepEqual(result.value, { 3: 'Day 1, 08:03' });
});

test('annotate() with value: null clears a previously-set mesid, not writes a literal null', async () => {
    const { module } = buildEngine();

    await call(module, 'chatHistory.annotate', { namespace: 'module.time', mesid: '3', value: 'Day 1, 08:03' });
    await call(module, 'chatHistory.annotate', { namespace: 'module.time', mesid: '3', value: null });
    const result = await call(module, 'chatHistory.annotations', { namespace: 'module.time' });

    assert.deepEqual(result.value, {});
});

test('two different namespaces stay isolated — a Tracker\'s annotations do not leak into RP Time\'s', async () => {
    const { module } = buildEngine();

    await call(module, 'chatHistory.annotate', { namespace: 'module.time', mesid: '1', value: 'Day 1, 08:00' });
    await call(module, 'chatHistory.annotate', { namespace: 'tracker.health', mesid: '1', value: 87 });

    const time = await call(module, 'chatHistory.annotations', { namespace: 'module.time' });
    const tracker = await call(module, 'chatHistory.annotations', { namespace: 'tracker.health' });

    assert.deepEqual(time.value, { 1: 'Day 1, 08:00' });
    assert.deepEqual(tracker.value, { 1: 87 });
});

test('the annotation map is per-chat — a fresh chatMetadata (a different chat) starts with no annotations', async () => {
    const { module, context } = buildEngine();
    await call(module, 'chatHistory.annotate', { namespace: 'module.time', mesid: '1', value: 'Day 1, 08:00' });

    context.chatMetadata = {}; // ST switched to a different chat — its own, empty metadata
    const result = await call(module, 'chatHistory.annotations', { namespace: 'module.time' });

    assert.deepEqual(result.value, {});
});

test('two concurrent FIRST annotate() calls to the same namespace (different mesid each) both survive', async () => {
    const { module } = buildEngine();

    const first = call(module, 'chatHistory.annotate', { namespace: 'module.time', mesid: '1', value: 'a' });
    const second = call(module, 'chatHistory.annotate', { namespace: 'module.time', mesid: '2', value: 'b' });
    await Promise.all([first, second]);

    const result = await call(module, 'chatHistory.annotations', { namespace: 'module.time' });
    assert.deepEqual(result.value, { 1: 'a', 2: 'b' }, 'neither concurrent first write may clobber the other');
});

test('clearAnnotations() wipes the whole map at once — "Reset" does not have to name every mesid', async () => {
    const { module } = buildEngine();
    await call(module, 'chatHistory.annotate', { namespace: 'module.time', mesid: '1', value: 'a' });
    await call(module, 'chatHistory.annotate', { namespace: 'module.time', mesid: '2', value: 'b' });

    const result = await call(module, 'chatHistory.clearAnnotations', { namespace: 'module.time' });
    const after = await call(module, 'chatHistory.annotations', { namespace: 'module.time' });

    assert.deepEqual(result, { ok: true, value: true });
    assert.deepEqual(after.value, {});
});

test('annotate()/annotations() without a namespace fail with a clear error, never hang', async () => {
    const { module } = buildEngine();

    const result = await call(module, 'chatHistory.annotate', { mesid: '1', value: 'x' });

    assert.equal(result.ok, false);
    assert.match(result.error.message, /namespace/);
});

test('annotate() without a mesid fails with a clear error', async () => {
    const { module } = buildEngine();

    const result = await call(module, 'chatHistory.annotate', { namespace: 'module.time', value: 'x' });

    assert.equal(result.ok, false);
    assert.match(result.error.message, /mesid/);
});

test('a Модуль without the right to chatHistory.annotate is refused before the Ядро is ever reached', async () => {
    const { engine } = buildEngine();
    const untrusted = engine.registerCaller('module.untrusted', 'modules', { tier: 'community', allowedContracts: [] });

    const result = await call(untrusted, 'chatHistory.annotate', { namespace: 'x', mesid: '1', value: 'y' });

    assert.equal(result.ok, false);
});
