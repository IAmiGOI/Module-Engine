import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { createSettingsCore } from '../cores/settings/index.js';
import { registerChatMetadataService } from '../services/chat-metadata.js';
import { createChatMemoryCore } from '../cores/memory/index.js';

/**
 * Scenario level (TESTING.md "Уровень 2") — mirrors tests/chat-memory-core.test.js
 * exactly, but for storage.settings/extensionSettings. Proves "Модуль -> Гейт
 * -> Ядро сохранения -> Гейт -> Сервис extensionSettings" end to end, AND
 * that a Module reaches this Ядро through a real cross-domain Гейт (not a
 * same-bus registration) — see this Ядро's own doc-comment for why that
 * matters.
 */

function fakeContext(initialExtensionSettings = {}) {
    return { extensionSettings: initialExtensionSettings, saveSettingsDebounced: () => {} };
}

function buildEngineWithSettingsCore() {
    const engine = createEngine();
    const context = fakeContext({});
    registerExtensionSettingsService(engine.buses.services, { getContext: () => context });
    const settingsHost = engine.registerCaller('core.settings', 'cores', { tier: 'official' });
    createSettingsCore(settingsHost);
    return { engine, context };
}

test('a Module writes then reads back a setting through the real Director -> Гейт -> Ядро -> Гейт -> Сервис chain', async () => {
    const { engine } = buildEngineWithSettingsCore();
    const module = engine.registerCaller('module.tracker', 'modules', { tier: 'community', allowedContracts: ['storage.settings.get', 'storage.settings.set'] });

    await new Promise(resolve => module.cores.subscribe('storage.settings.set', { params: { namespace: 'module.tracker', key: 'pollIntervalMs', value: 5000 } }, resolve));
    const result = await new Promise(resolve => module.cores.subscribe('storage.settings.get', { params: { namespace: 'module.tracker', key: 'pollIntervalMs' } }, resolve));

    assert.deepEqual(result, { ok: true, value: 5000 });
});

test('a Core reaches storage.settings on its OWN bus directly — no Гейт needed for a same-domain Core -> Core call', async () => {
    const { engine } = buildEngineWithSettingsCore();
    const otherCore = engine.registerCaller('core.tracking', 'cores', { tier: 'community', allowedContracts: [] });

    // Even with an empty allowedContracts grant (which would deny a CROSS-domain
    // call), the same-bus path must still work — same invariant already proven
    // for Core -> Core in tests/engine.test.js.
    const result = await new Promise(resolve => otherCore.own.subscribe('storage.settings.set', { params: { namespace: 'core.tracking', key: 'lastRun', value: 1 } }, resolve));

    assert.equal(result.ok, true);
});

test('storage.settings and storage.chatMemory are independent — writing one does not affect the other, even under the same namespace', async () => {
    const engine = createEngine();
    const chatContext = { chatMetadata: {}, saveMetadataDebounced: () => {} };
    const settingsContext = { extensionSettings: {}, saveSettingsDebounced: () => {} };
    registerChatMetadataService(engine.buses.services, { getContext: () => chatContext });
    registerExtensionSettingsService(engine.buses.services, { getContext: () => settingsContext });
    createChatMemoryCore(engine.registerCaller('core.memory.chat', 'cores', { tier: 'official' }));
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));
    const module = engine.registerCaller('module.x', 'modules', { tier: 'official' });

    await new Promise(resolve => module.cores.subscribe('storage.settings.set', { params: { namespace: 'module.x', key: 'shared', value: 'settings-value' } }, resolve));

    const fromChatMemory = await new Promise(resolve => module.cores.subscribe('storage.chatMemory.get', { params: { namespace: 'module.x', key: 'shared', fallback: 'untouched' } }, resolve));
    assert.equal(fromChatMemory.value, 'untouched', 'writing storage.settings must never leak into storage.chatMemory');
});

test('set()/get() without a namespace or key fails with a clear error through the normal envelope', async () => {
    const { engine } = buildEngineWithSettingsCore();
    const module = engine.registerCaller('module.tracker', 'modules', { tier: 'official' });

    const result = await new Promise(resolve => module.cores.subscribe('storage.settings.set', { params: { key: 'a', value: 1 } }, resolve));

    assert.equal(result.ok, false);
    assert.match(result.error.message, /namespace/);
});

test('a Module without the right to storage.settings.set is refused before the Ядро — and the Сервис save — are ever reached', async () => {
    let saveCalls = 0;
    const engine = createEngine();
    registerExtensionSettingsService(engine.buses.services, { getContext: () => ({ extensionSettings: {}, saveSettingsDebounced: () => { saveCalls += 1; } }) });
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));
    const module = engine.registerCaller('module.untrusted', 'modules', { tier: 'community', allowedContracts: [] });

    const result = await new Promise(resolve => module.cores.subscribe('storage.settings.set', { params: { namespace: 'module.untrusted', key: 'a', value: 1 } }, resolve));

    assert.equal(result.ok, false);
    assert.equal(saveCalls, 0);
});
