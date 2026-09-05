import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerChatMetadataService } from '../services/chat-metadata.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { registerStMacrosService } from '../services/st-macros.js';
import { createChatMemoryCore } from '../cores/memory/index.js';
import { createSettingsCore } from '../cores/settings/index.js';
import { createTrackingCore } from '../cores/tracking/index.js';
import { createMacrosCore } from '../cores/macros/index.js';

/**
 * Scenario level (TESTING.md "Уровень 2") — real engine, real Гейты; only
 * `getContext()` (chatMetadata + the fake ST macro registry) is faked.
 * Proves the whole loop the user's own tracking spec asked for: a User
 * Tracker field update reaches a real `{{macro}}` registration, end to end.
 */

function fakeStMacros() {
    const registered = new Map(); // name -> handler
    return {
        context: { macros: { register: (name, { handler }) => registered.set(name, handler), registry: { unregisterMacro: name => registered.delete(name) } } },
        registered,
        resolve: name => registered.get(name)?.(),
    };
}

function buildEngine() {
    const engine = createEngine();
    const chatContext = { chatMetadata: {}, saveMetadataDebounced: () => {} };
    registerChatMetadataService(engine.buses.services, { getContext: () => chatContext });
    const { context: stContext, resolve } = fakeStMacros();
    registerStMacrosService(engine.buses.services, { getContext: () => stContext });
    // configureTrackers()/configurePrograms() now really persist via
    // storage.settings — a Settings Core must be wired for them to have
    // anywhere to write to, same as a real engine (harness/engine-wiring.js).
    const settingsContext = { extensionSettings: {}, saveSettingsDebounced: () => {} };
    registerExtensionSettingsService(engine.buses.services, { getContext: () => settingsContext });
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));

    createChatMemoryCore(engine.registerCaller('core.memory.chat', 'cores', { tier: 'official' }));
    const trackingCore = createTrackingCore(engine.registerCaller('core.tracking', 'cores', { tier: 'official' }));
    const macrosHost = engine.registerCaller('core.macros', 'cores', { tier: 'official' });
    const macrosCore = createMacrosCore(macrosHost);

    return { engine, trackingCore, macrosCore, resolveStMacro: resolve };
}

async function flushMicrotasks(rounds = 20) {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
}

test('a "text" program registers its literal source as a real {{macro}}', async () => {
    const { engine, macrosCore, resolveStMacro } = buildEngine();
    macrosCore.configurePrograms([{ id: 'p1', macroName: 'greeting', kind: 'text', source: 'hello there' }]);
    await flushMicrotasks();

    assert.equal(resolveStMacro('greeting'), 'hello there');
});

test('a "code" program runs, caches its result, and registers a real {{macro}} whose handler reads the cache', async () => {
    const { engine, macrosCore, resolveStMacro } = buildEngine();
    const module = engine.registerCaller('module.ui', 'modules', { tier: 'official' });
    macrosCore.configurePrograms([{ id: 'p1', macroName: 'sum', kind: 'code', source: 'return 2 + 3' }]);

    const result = await new Promise(resolve => module.cores.subscribe('macros.run', { params: { programId: 'p1' } }, resolve));

    assert.deepEqual(result, { ok: true, value: '5' });
    assert.equal(resolveStMacro('sum'), '5', 'the real ST-facing handler must read the same cached value');
});

test('a "code" program reads a tracker field via get "trackerId:fieldName"', async () => {
    const { engine, trackingCore, macrosCore } = buildEngine();
    trackingCore.configureTrackers([{ id: 'char', kind: 'user', workerId: 'none', fields: [{ name: 'health', prompt: '', default: 80 }] }]);
    macrosCore.configurePrograms([{ id: 'p1', macroName: 'healthReport', kind: 'code', source: 'set h to get "char:health"\nreturn "HP: " + h' }]);
    const module = engine.registerCaller('module.ui', 'modules', { tier: 'official' });

    const result = await new Promise(resolve => module.cores.subscribe('macros.run', { params: { programId: 'p1' } }, resolve));

    assert.deepEqual(result, { ok: true, value: 'HP: 80' });
});

test('a "code" program\'s save/get (bareword key) persists across separate runs via storage.chatMemory', async () => {
    const { engine, macrosCore } = buildEngine();
    macrosCore.configurePrograms([{ id: 'counter', macroName: 'counter', kind: 'code', source: 'set n to get "count"\nif n is "" then\nset n to 0\nend\nset n to n + 1\nsave n as "count"\nreturn n' }]);
    const module = engine.registerCaller('module.ui', 'modules', { tier: 'official' });
    const runOnce = () => new Promise(resolve => module.cores.subscribe('macros.run', { params: { programId: 'counter' } }, resolve));

    // configurePrograms() already ran it once (initial cache warm-up); run explicitly twice more.
    await runOnce();
    const second = await runOnce();
    const third = await runOnce();

    assert.equal(Number(second.value) + 1, Number(third.value), 'each run must see the PREVIOUS run\'s saved count, not start over');
});

test('a syntax error in a code program caches a "[macro error: ...]" placeholder but macros.run still fails through the normal envelope', async () => {
    const { engine, macrosCore, resolveStMacro } = buildEngine();
    macrosCore.configurePrograms([{ id: 'p1', macroName: 'broken', kind: 'code', source: 'if true then\nreturn 1' }]); // missing "end"
    const module = engine.registerCaller('module.ui', 'modules', { tier: 'official' });

    const result = await new Promise(resolve => module.cores.subscribe('macros.run', { params: { programId: 'p1' } }, resolve));

    assert.equal(result.ok, false);
    await flushMicrotasks();
    assert.equal(resolveStMacro('broken'), '[macro error: broken]', 'the real {{macro}} must still resolve to a visible placeholder, never vanish');
});

test('setValueMacro() registers a real {{macro}} directly from a value, with no program/language involved', async () => {
    const { macrosCore, resolveStMacro } = buildEngine();

    await macrosCore.setValueMacro('char_health', 90);

    assert.equal(resolveStMacro('char_health'), '90');
});

test('clearValueMacro() unregisters the real {{macro}} — it no longer resolves to anything', async () => {
    const { macrosCore, resolveStMacro } = buildEngine();
    await macrosCore.setValueMacro('char_health', 90);

    macrosCore.clearValueMacro('char_health');
    await flushMicrotasks();

    assert.equal(resolveStMacro('char_health'), undefined);
});

test('Ядро трекинга\'s onUserFieldRegistered hook, wired to macrosCore.setValueMacro, closes the real loop end to end', async () => {
    const engine = createEngine();
    const chatContext = { chatMetadata: {}, saveMetadataDebounced: () => {} };
    registerChatMetadataService(engine.buses.services, { getContext: () => chatContext });
    const { context: stContext, resolve: resolveStMacro } = fakeStMacros();
    registerStMacrosService(engine.buses.services, { getContext: () => stContext });
    const settingsContext = { extensionSettings: {}, saveSettingsDebounced: () => {} };
    registerExtensionSettingsService(engine.buses.services, { getContext: () => settingsContext });
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));
    createChatMemoryCore(engine.registerCaller('core.memory.chat', 'cores', { tier: 'official' }));
    // macrosCore must exist before the tracking hook below can reference it.
    const macrosCore = createMacrosCore(engine.registerCaller('core.macros', 'cores', { tier: 'official' }));
    const trackingCore = createTrackingCore(engine.registerCaller('core.tracking', 'cores', { tier: 'official' }), {
        onUserFieldRegistered: ({ trackerId, fieldName, value }) => macrosCore.setValueMacro(`${trackerId}_${fieldName}`, value),
    });
    trackingCore.configureTrackers([{ id: 'char', kind: 'user', workerId: 'none', fields: [{ name: 'health', prompt: '', default: 100 }] }]);
    const module = engine.registerCaller('module.ui', 'modules', { tier: 'official' });

    await new Promise(resolve => module.cores.subscribe('tracking.set', { params: { trackerId: 'char', fieldName: 'health', value: 42 } }, resolve));
    await flushMicrotasks();

    assert.equal(resolveStMacro('char_health'), '42', 'a Tracker field update must reach a real, resolvable {{macro}} with no manual wiring beyond the hook');
});

test('a program\'s configured trigger re-runs it automatically, refreshing the cached macro value', async () => {
    const { engine, macrosCore } = buildEngine();
    let counter = 0;
    // A "system"-ish tracker-free program: uses its own save/get counter, driven purely by the trigger.
    macrosCore.configurePrograms([{ id: 'ticker', macroName: 'ticker', kind: 'code', source: 'set n to get "n"\nif n is "" then\nset n to 0\nend\nset n to n + 1\nsave n as "n"\nreturn n', triggers: ['generation.completed'] }]);
    await flushMicrotasks();
    const module = engine.registerCaller('module.ui', 'modules', { tier: 'official' });
    const before = await new Promise(resolve => module.cores.subscribe('macros.value', { params: { name: 'ticker' } }, resolve));

    engine.events.emit('generation.completed');
    await flushMicrotasks();
    const after = await new Promise(resolve => module.cores.subscribe('macros.value', { params: { name: 'ticker' } }, resolve));

    assert.equal(Number(after.value), Number(before.value) + 1);
});

test('re-configurePrograms() unregisters a removed program\'s real {{macro}} and tears down its trigger', async () => {
    const { engine, macrosCore, resolveStMacro } = buildEngine();
    macrosCore.configurePrograms([{ id: 'p1', macroName: 'gone', kind: 'text', source: 'x', triggers: ['generation.completed'] }]);
    await flushMicrotasks();
    assert.equal(resolveStMacro('gone'), 'x');

    macrosCore.configurePrograms([]);
    await flushMicrotasks();

    assert.equal(resolveStMacro('gone'), undefined);
});

test('a Module without the right to macros.run is refused before the Ядро is ever reached', async () => {
    const { engine, macrosCore } = buildEngine();
    macrosCore.configurePrograms([{ id: 'p1', macroName: 'x', kind: 'text', source: 'hi' }]);
    const module = engine.registerCaller('module.untrusted', 'modules', { tier: 'community', allowedContracts: [] });

    const result = await new Promise(resolve => module.cores.subscribe('macros.run', { params: { programId: 'p1' } }, resolve));

    assert.equal(result.ok, false);
});

test('program config really persists via storage.settings — restorePrograms() on a FRESH Ядро instance recovers what a previous one configured, simulating a reload', async () => {
    const { engine } = buildEngine();
    const firstInstance = createMacrosCore(engine.registerCaller('core.macros.first', 'cores', { tier: 'official' }));
    const programConfig = [{ id: 'p1', macroName: 'greeting', kind: 'text', source: 'hello there' }];
    await firstInstance.configurePrograms(programConfig);

    // A brand new Ядро instance — nothing hands it the config directly; it
    // only shares the SAME underlying storage.settings.
    const secondInstance = createMacrosCore(engine.registerCaller('core.macros.second', 'cores', { tier: 'official' }));
    const restored = await secondInstance.restorePrograms();

    assert.deepEqual(restored, programConfig);
});
