import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersistedList } from '../libraries/core/persisted-list.js';
import { createEngine } from '../libraries/shared/engine.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { createSettingsCore } from '../cores/settings/index.js';

function buildEngine() {
    const engine = createEngine();
    // Must be the SAME context object on every getContext() call — a fresh
    // `{}` per call would silently discard every write (the exact bug this
    // whole file exists to prove doesn't happen at the Ядро level).
    const settingsContext = { extensionSettings: {}, saveSettingsDebounced: () => {} };
    registerExtensionSettingsService(engine.buses.services, { getContext: () => settingsContext });
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));
    return engine;
}

test('restore() with nothing ever saved applies (and returns) an empty list', async () => {
    const engine = buildEngine();
    const host = engine.registerCaller('core.demo', 'cores', { tier: 'official' });
    let applied;
    const persisted = createPersistedList(host, { namespace: 'core.demo', key: 'items', apply: list => { applied = list; } });

    const result = await persisted.restore();

    assert.deepEqual(result, []);
    assert.deepEqual(applied, []);
});

test('save() applies the list in memory immediately AND writes it through to storage.settings', async () => {
    const engine = buildEngine();
    const host = engine.registerCaller('core.demo', 'cores', { tier: 'official' });
    const applyCalls = [];
    const persisted = createPersistedList(host, { namespace: 'core.demo', key: 'items', apply: list => applyCalls.push(list) });

    await persisted.save([{ id: 'a' }]);

    assert.deepEqual(applyCalls, [[{ id: 'a' }]]);
    const raw = await new Promise(resolve => host.own.subscribe('storage.settings.get', { params: { namespace: 'core.demo', key: 'items' } }, resolve));
    assert.deepEqual(raw.value, [{ id: 'a' }]);
});

test('a fresh createPersistedList() on the SAME namespace/key recovers what a previous one saved — the actual "survives a reload" guarantee', async () => {
    const engine = buildEngine();
    const firstHost = engine.registerCaller('core.demo.first', 'cores', { tier: 'official' });
    const first = createPersistedList(firstHost, { namespace: 'core.demo.shared', key: 'items', apply: () => {} });
    await first.save([{ id: 'persisted' }]);

    const secondHost = engine.registerCaller('core.demo.second', 'cores', { tier: 'official' });
    let appliedOnSecond;
    const second = createPersistedList(secondHost, { namespace: 'core.demo.shared', key: 'items', apply: list => { appliedOnSecond = list; } });
    const restored = await second.restore();

    assert.deepEqual(restored, [{ id: 'persisted' }]);
    assert.deepEqual(appliedOnSecond, [{ id: 'persisted' }]);
});

test('save()/restore() reject when storage.settings has no supplier at all (no Settings Core wired) — never silently no-op', async () => {
    const engine = createEngine(); // deliberately no Settings Core wired
    const host = engine.registerCaller('core.demo', 'cores', { tier: 'official' });
    const persisted = createPersistedList(host, { namespace: 'core.demo', key: 'items', apply: () => {} });

    await assert.rejects(persisted.save([{ id: 'x' }]), /No supplier registered/);
    await assert.rejects(persisted.restore(), /No supplier registered/);
});
