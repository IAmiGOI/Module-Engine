import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerChatMetadataService } from '../services/chat-metadata.js';
import { createChatMemoryCore } from '../cores/memory/index.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { createSettingsCore } from '../cores/settings/index.js';
import { createBackupCore, createChatMetadataBackupSource, createExtensionSettingsBackupSource } from '../cores/backup/index.js';

/**
 * Scenario level (TESTING.md "Уровень 2") — real engine, real Гейты; only
 * `getContext()` (the true ST boundary, via chat-metadata.js) is faked.
 * Proves "Модуль -> Гейт -> Ядро бэкапа -> [зарегистрированный источник] ->
 * Гейт -> Сервис chatMetadata" end to end, including a REAL round-trip
 * through Ядро внутренней памяти чата: data written via storage.chatMemory
 * survives an export -> wipe -> import cycle.
 */

function fakeContext(initialChatMetadata = {}) {
    return { chatMetadata: initialChatMetadata, saveMetadataDebounced: () => {} };
}

function buildEngineWithBackupCore() {
    const engine = createEngine();
    const context = fakeContext({});
    registerChatMetadataService(engine.buses.services, { getContext: () => context });
    const memoryHost = engine.registerCaller('core.memory.chat', 'cores', { tier: 'official' });
    createChatMemoryCore(memoryHost);
    const backupHost = engine.registerCaller('core.backup', 'cores', { tier: 'official' });
    const backupCore = createBackupCore(backupHost);
    backupCore.registerSource('chatMemory', createChatMetadataBackupSource(backupHost));
    return { engine, context };
}

test('export({ sourceIds }) keeps only the named sources — preset export skips chat-scoped data', async () => {
    // СВОЙ движок: контракт backup.export в этом файле уже зарегистрирован
    // buildEngineWithBackupCore() — второй экземпляр Ядра на той же шине
    // контракт не перехватит, и проверка гоняла бы не тот экземпляр.
    const engine = createEngine();
    const context = fakeContext({});
    registerChatMetadataService(engine.buses.services, { getContext: () => context });
    registerExtensionSettingsService(engine.buses.services, { getContext: () => context });
    createChatMemoryCore(engine.registerCaller('core.memory.chat', 'cores', { tier: 'official' }));
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));
    const backupHost = engine.registerCaller('core.backup.filter', 'cores', { tier: 'official' });
    const backupCore2 = createBackupCore(backupHost);
    backupCore2.registerSource('chatMemory', createChatMetadataBackupSource(backupHost));
    backupCore2.registerSource('settings', createExtensionSettingsBackupSource(backupHost));

    const runner = engine.registerCaller('core.runner.filter', 'cores', { tier: 'official' });
    await new Promise(resolve => runner.own.subscribe('storage.settings.set', { params: { namespace: 'core.runner', key: 'enabledModules', value: ['module.music'] } }, resolve));
    const mod = engine.registerCaller('module.filter', 'modules', { tier: 'official' });
    await new Promise(resolve => mod.cores.subscribe('storage.chatMemory.set', { params: { namespace: 'module.notebook', key: 'notes', value: ['a'] } }, resolve));

    // Полный экспорт — оба источника.
    const full = await new Promise(resolve => backupHost.own.subscribe('backup.export', {}, resolve));
    assert.ok(full.ok);
    assert.deepEqual(Object.keys(full.value.sources).sort(), ['chatMemory', 'settings']);
    // Пресет-экспорт — только settings, chatMemory не попадает.
    const preset = await new Promise(resolve => backupHost.own.subscribe('backup.export', { params: { sourceIds: ['settings'] } }, resolve));
    assert.ok(preset.ok);
    assert.deepEqual(Object.keys(preset.value.sources), ['settings']);
    assert.deepEqual(preset.value.sources.settings['core.runner'].enabledModules, ['module.music']);
})

test('export -> import round-trips real data written through Ядро внутренней памяти чата', async () => {
    const { engine, context } = buildEngineWithBackupCore();
    const module = engine.registerCaller('module.notebook', 'modules', { tier: 'official' });
    await new Promise(resolve => module.cores.subscribe('storage.chatMemory.set', { params: { namespace: 'module.notebook', key: 'notes', value: ['a', 'b'] } }, resolve));

    const exportResult = await new Promise(resolve => module.cores.subscribe('backup.export', {}, resolve));
    assert.equal(exportResult.ok, true);
    assert.deepEqual(exportResult.value.sources.chatMemory, { 'module.notebook': { notes: ['a', 'b'] } });

    // Simulate a fresh install / wiped chat: the underlying store is now empty.
    context.chatMetadata = {};
    const wiped = await new Promise(resolve => module.cores.subscribe('storage.chatMemory.get', { params: { namespace: 'module.notebook', key: 'notes', fallback: 'gone' } }, resolve));
    assert.equal(wiped.value, 'gone');

    const importResult = await new Promise(resolve => module.cores.subscribe('backup.import', { params: { snapshot: exportResult.value } }, resolve));
    assert.deepEqual(importResult, { ok: true, value: ['chatMemory'] });

    const restored = await new Promise(resolve => module.cores.subscribe('storage.chatMemory.get', { params: { namespace: 'module.notebook', key: 'notes' } }, resolve));
    assert.deepEqual(restored.value, ['a', 'b']);
});

test('exporting with no data written yet still produces a valid, empty-ish snapshot rather than failing', async () => {
    const { engine } = buildEngineWithBackupCore();
    const module = engine.registerCaller('module.notebook', 'modules', { tier: 'official' });

    const result = await new Promise(resolve => module.cores.subscribe('backup.export', {}, resolve));

    assert.equal(result.ok, true);
    assert.deepEqual(result.value.sources.chatMemory, {});
});

test('two independently registered sources (chatMemory + settings) both export and both restore together, in one snapshot', async () => {
    const engine = createEngine();
    const chatContext = { chatMetadata: {}, saveMetadataDebounced: () => {} };
    const settingsContext = { extensionSettings: {}, saveSettingsDebounced: () => {} };
    registerChatMetadataService(engine.buses.services, { getContext: () => chatContext });
    registerExtensionSettingsService(engine.buses.services, { getContext: () => settingsContext });
    createChatMemoryCore(engine.registerCaller('core.memory.chat', 'cores', { tier: 'official' }));
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));
    const backupHost = engine.registerCaller('core.backup', 'cores', { tier: 'official' });
    const backupCore = createBackupCore(backupHost);
    backupCore.registerSource('chatMemory', createChatMetadataBackupSource(backupHost));
    backupCore.registerSource('settings', createExtensionSettingsBackupSource(backupHost));
    const module = engine.registerCaller('module.x', 'modules', { tier: 'official' });
    await new Promise(resolve => module.cores.subscribe('storage.chatMemory.set', { params: { namespace: 'module.x', key: 'chatKey', value: 'chat-value' } }, resolve));
    await new Promise(resolve => module.cores.subscribe('storage.settings.set', { params: { namespace: 'module.x', key: 'settingKey', value: 'setting-value' } }, resolve));

    const exportResult = await new Promise(resolve => module.cores.subscribe('backup.export', {}, resolve));
    assert.deepEqual(Object.keys(exportResult.value.sources).sort(), ['chatMemory', 'settings']);

    chatContext.chatMetadata = {};
    settingsContext.extensionSettings = {};
    const importResult = await new Promise(resolve => module.cores.subscribe('backup.import', { params: { snapshot: exportResult.value } }, resolve));
    assert.deepEqual(importResult.value.sort(), ['chatMemory', 'settings']);

    const restoredChat = await new Promise(resolve => module.cores.subscribe('storage.chatMemory.get', { params: { namespace: 'module.x', key: 'chatKey' } }, resolve));
    const restoredSetting = await new Promise(resolve => module.cores.subscribe('storage.settings.get', { params: { namespace: 'module.x', key: 'settingKey' } }, resolve));
    assert.equal(restoredChat.value, 'chat-value');
    assert.equal(restoredSetting.value, 'setting-value');
});

test('importing a snapshot with an unrecognized source id skips it (returns it as NOT restored) instead of failing the whole import', async () => {
    const { engine } = buildEngineWithBackupCore();
    const module = engine.registerCaller('module.notebook', 'modules', { tier: 'official' });
    const snapshot = { version: 1, createdAt: Date.now(), sources: { chatMemory: {}, settingsFromAFutureEngine: { x: 1 } } };

    const result = await new Promise(resolve => module.cores.subscribe('backup.import', { params: { snapshot } }, resolve));

    assert.deepEqual(result, { ok: true, value: ['chatMemory'] });
});

test('importing a garbage/malformed snapshot fails clearly through the normal error envelope, never silently no-ops', async () => {
    const { engine } = buildEngineWithBackupCore();
    const module = engine.registerCaller('module.notebook', 'modules', { tier: 'official' });

    const result = await new Promise(resolve => module.cores.subscribe('backup.import', { params: { snapshot: 'not a snapshot at all' } }, resolve));

    assert.equal(result.ok, false);
    assert.match(result.error.message, /not a recognizable backup snapshot/);
});

test('a Module without the right to backup.export is refused before the Ядро — and any source read — is ever reached', async () => {
    const { engine } = buildEngineWithBackupCore();
    const module = engine.registerCaller('module.untrusted', 'modules', { tier: 'community', allowedContracts: [] });

    const result = await new Promise(resolve => module.cores.subscribe('backup.export', {}, resolve));

    assert.equal(result.ok, false);
});
