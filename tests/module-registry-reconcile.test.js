import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { createSettingsCore } from '../cores/settings/index.js';
import { createModuleRegistry } from '../harness/engine-wiring.js';

/**
 * Scenario level (TESTING.md "Уровень 2") — real engine, real Гейты, real
 * Ядро сохранения over a faked ST context. Only the registry's UI deps are
 * stubbed (панель/слоты — не участники этих сценариев). Proves the registry
 * side of preset import: reconcile() brings the live module set to the
 * target list written by a restored snapshot, and the WRITTEN
 * `core.runner.enabledModules` record ends up matching (enable/disable
 * remember() the true set themselves — same discipline as restore()).
 */

function fakeContext() {
    return { extensionSettings: {}, saveSettingsDebounced: () => {}, saveSettings: () => {} };
}

/** Лёгкий Модуль: интерфейс реестра (`create`/`load`/`tree`/`stop`), без начинки. */
function stubDefinition(id) {
    return {
        id,
        title: id,
        description: `stub ${id}`,
        rights: { tier: 'official' },
        create: () => ({
            load: async () => {},
            tree: () => ({ tag: 'div', props: {}, children: [] }),
            stop: () => {},
        }),
    };
}

async function buildRegistry(definitionIds) {
    const engine = createEngine();
    const context = fakeContext();
    registerExtensionSettingsService(engine.buses.services, { getContext: () => context });
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));
    const registry = createModuleRegistry({
        engine,
        uiModules: {
            enable: () => ({ getRoot: () => ({}), settled: async () => {} }),
            disable: () => {},
        },
        panelSettled: async () => {},
        // Фейковый корень, а не null: attach() при null уходит в настоящий
        // `document`, которого в тестовой среде нет. querySelector() → null —
        // слот не найден, дерево не приложено, для этих сценариев неважно.
        panelRoot: () => ({ querySelector: () => null }),
        storageHost: engine.registerCaller('core.runner', 'cores', { tier: 'official' }),
        definitions: definitionIds.map(stubDefinition),
    });
    return { engine, context, registry };
}

async function readEnabledRecord(engine) {
    const runner = engine.registerCaller('core.runner.read', 'cores', { tier: 'official' });
    const result = await new Promise(resolve => runner.own.subscribe(
        'storage.settings.get',
        { params: { namespace: 'core.runner', key: 'enabledModules', fallback: [] } },
        resolve,
    ));
    return result.ok ? result.value ?? [] : [];
}

test('reconcile() enables the wanted modules and remembers the true set', async () => {
    const { engine, registry } = await buildRegistry(['module.a', 'module.b']);
    const { enabled } = await registry.reconcile(['module.a', 'module.b', 'module.ghost']);
    assert.deepEqual(enabled.sort(), ['module.a', 'module.b']);
    // Незнакомый id не попал в состав — и не попал в сохранённую запись.
    assert.deepEqual((await readEnabledRecord(engine)).sort(), ['module.a', 'module.b']);
});

test('reconcile() disables modules missing from the target list', async () => {
    const { engine, registry } = await buildRegistry(['module.a', 'module.b']);
    await registry.enable('module.a');
    await registry.enable('module.b');
    const { enabled } = await registry.reconcile(['module.b']);
    assert.deepEqual(enabled, ['module.b']);
    assert.deepEqual(await readEnabledRecord(engine), ['module.b']);
});

test('reconcile([]) with an empty snapshot disables everything — a clean preset imports cleanly', async () => {
    const { engine, registry } = await buildRegistry(['module.a']);
    await registry.enable('module.a');
    const { enabled } = await registry.reconcile([]);
    assert.deepEqual(enabled, []);
    assert.deepEqual(await readEnabledRecord(engine), []);
});

test('reconcile() to the same set changes nothing and keeps the record intact', async () => {
    const { registry } = await buildRegistry(['module.a']);
    await registry.enable('module.a');
    const { enabled } = await registry.reconcile(['module.a']);
    assert.deepEqual(enabled, ['module.a']);
});
