import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { registerStUserDataService } from '../services/st-user-data.js';
import { createSettingsCore } from '../cores/settings/index.js';
import { computeSyncPlan } from '../libraries/core/sync-plan.js';
import { runSync } from '../libraries/core/sync-runner.js';
import { noCopyFor } from '../libraries/core/sync-config.js';
import { applySetting, canonicalJson, collectSettings, isSecretName, parseSettingFileName, restoreSecrets, settingFileName, stripSecrets, touchSetting } from '../libraries/core/sync-settings.js';

// ── чистая библиотека ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('only API keys of AI-model connections are secret — every other field, even one with "token" in its name, travels', () => {
    for (const name of ['apiKey', 'api_key', 'workerApiKey', 'x-api-key', 'apiToken', 'authorization', 'bearer']) assert.equal(isSecretName(name), true, name);
    for (const name of ['maxTokens', 'tokens', 'secrets', 'endpoint', 'model', 'title', 'password', 'clientId']) assert.equal(isSecretName(name), false, name);
});

test('stripSecrets() removes keys at any depth, in objects and inside lists of connections', () => {
    const value = { enabled: true, connections: [{ id: 'a', endpoint: 'http://x', apiKey: 'SECRET-A' }, { id: 'b', apiKey: 'SECRET-B', headers: { authorization: 'Bearer Z', accept: '*/*' } }] };
    assert.deepEqual(stripSecrets(value), { enabled: true, connections: [{ id: 'a', endpoint: 'http://x' }, { id: 'b', headers: { accept: '*/*' } }] });
    assert.equal(JSON.stringify(stripSecrets(value)).includes('SECRET'), false);
});

test('restoreSecrets() keeps OUR keys when a stripped value arrives — matching list items by id, else by position', () => {
    const local = { connections: [{ id: 'b', apiKey: 'KEY-B' }, { id: 'a', apiKey: 'KEY-A' }], worker: { apiKey: 'W' } };
    const incoming = { connections: [{ id: 'a', endpoint: 'new-a' }, { id: 'b', endpoint: 'new-b' }, { id: 'c', endpoint: 'new-c' }], worker: { url: 'u' } };
    assert.deepEqual(restoreSecrets(incoming, local), {
        connections: [{ id: 'a', endpoint: 'new-a', apiKey: 'KEY-A' }, { id: 'b', endpoint: 'new-b', apiKey: 'KEY-B' }, { id: 'c', endpoint: 'new-c' }],
        worker: { url: 'u', apiKey: 'W' },
    });
});

test('canonicalJson() is independent of key order, so two devices produce the same file and the same hash', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: 3 } }), canonicalJson({ a: { c: 3, d: [1, { y: 2, z: 1 }] }, b: 1 }));
});

test('setting file names round-trip, and copies/foreign names are not settings', () => {
    assert.equal(settingFileName('core.ui.home', 'state'), 'core.ui.home/state.json');
    assert.deepEqual(parseSettingFileName('core.ui.home/state.json'), { namespace: 'core.ui.home', key: 'state' });
    assert.equal(parseSettingFileName('core.ui.home/state (conflict Phone 2026-10-03 10-00-00).json'), null);
    assert.equal(parseSettingFileName('core.sync/config.json'), null);
    assert.equal(parseSettingFileName('plain.json'), null);
});

test('touchSetting() moves the edit time only when the value really changed', () => {
    const raw = {};
    assert.equal(touchSetting(raw, 'core.x', 'k', undefined, { a: 1 }, 100), true);
    assert.equal(touchSetting(raw, 'core.x', 'k', { a: 1 }, { a: 1 }, 200), false, 'saving the same value again is not an edit');
    assert.equal(raw._syncMeta.updated['core.x::k'], 100);
    assert.equal(touchSetting(raw, 'core.x', 'k', { a: 1 }, { a: 2 }, 300), true);
    assert.equal(raw._syncMeta.updated['core.x::k'], 300);
});

test('collectSettings() skips the identity section, the metadata section, excluded keys and sections declared device-only', () => {
    const raw = { 'core.sync': { config: { token: 'T' } }, 'core.ui.home': { state: { order: [1] } }, 'module.music': { tracks: [1], player: { volume: 1 } }, 'core.local': { a: 1 } };
    raw._syncMeta = { policy: { 'module.music': { exclude: ['player'] }, 'core.local': { sync: false } } };
    const names = collectSettings(raw).map(entry => `${entry.namespace}/${entry.key}`).sort();
    assert.deepEqual(names, ['core.ui.home/state', 'module.music/tracks']);
});

test('applySetting() writes the value with the sender\'s time, keeps our API key, and refuses device-only sections', () => {
    const raw = { 'core.classifier': { settings: { connections: [{ id: 'a', apiKey: 'MINE' }] } }, _syncMeta: { policy: { 'core.local': { sync: false } } } };
    assert.equal(applySetting(raw, { namespace: 'core.classifier', key: 'settings', updatedAt: 777, value: { connections: [{ id: 'a', endpoint: 'E' }] } }), true);
    assert.deepEqual(raw['core.classifier'].settings, { connections: [{ id: 'a', endpoint: 'E', apiKey: 'MINE' }] });
    assert.equal(raw._syncMeta.updated['core.classifier::settings'], 777);
    assert.equal(applySetting(raw, { namespace: 'core.local', key: 'x', updatedAt: 1, value: 1 }), false);
    assert.equal(raw['core.local'], undefined);
});

// ── общее Ядро настроек: контракты и права ────────────────────────────────────────────────────────────────────────────────────

function settingsEngine() {
    const engine = createEngine();
    const context = { extensionSettings: {}, saveSettingsDebounced() {} };
    registerExtensionSettingsService(engine.buses.services, { getContext: () => context });
    const host = engine.registerCaller('core.settings', 'cores', { tier: 'official' });
    let clock = 1000;
    createSettingsCore(host, { now: () => (clock += 10) });
    const events = [];
    for (const name of ['settings.changed', 'settings.namespaces.changed']) engine.events.subscribe?.(name, payload => events.push([name, payload]));
    const call = (callerHost, contract, params) => new Promise(resolve => callerHost.cores.subscribe(contract, { params }, resolve));
    return { engine, context, call, events };
}
const raw = context => context.extensionSettings.stme_settings;

test('settings.send writes a whole batch of the caller\'s own section at once, stamping only the keys that really changed', async () => {
    const { engine, context, call } = settingsEngine();
    const module = engine.registerCaller('module.music', 'modules', { tier: 'community', allowedContracts: ['settings.send', 'settings.namespaces'] });
    const first = await call(module, 'settings.send', { values: { tracks: [1, 2], player: { volume: 0.5 } } });
    assert.deepEqual(first, { ok: true, value: { namespace: 'module.music', written: ['tracks', 'player'], unchanged: [], removed: [] } });
    const second = await call(module, 'settings.send', { values: { tracks: [1, 2], player: { volume: 0.9 } } });
    assert.deepEqual(second.value.written, ['player']);
    assert.deepEqual(second.value.unchanged, ['tracks']);
    assert.equal(raw(context)['module.music'].player.volume, 0.9);
    const replaced = await call(module, 'settings.send', { values: { player: { volume: 0.9 } }, replace: true });
    assert.deepEqual(replaced.value.removed, ['tracks']);
    assert.equal('tracks' in raw(context)['module.music'], false);
});

test('a Module cannot send into someone else\'s section — the error comes back in the envelope, nothing is written', async () => {
    const { engine, context, call } = settingsEngine();
    const module = engine.registerCaller('module.music', 'modules', { tier: 'community', allowedContracts: ['settings.send'] });
    const result = await call(module, 'settings.send', { namespace: 'core.guide', values: { x: 1 } });
    assert.equal(result.ok, false);
    assert.match(result.error.message, /own namespace/);
    assert.equal(raw(context)?.['core.guide'], undefined);
});

test('settings.declare sets the sync policy of the caller\'s section and settings.namespaces lists everything', async () => {
    const { engine, call } = settingsEngine();
    const module = engine.registerCaller('module.music', 'modules', { tier: 'community', allowedContracts: ['settings.send', 'settings.declare', 'settings.namespaces'] });
    await call(module, 'settings.send', { values: { tracks: [1], player: { volume: 1 } } });
    const policy = await call(module, 'settings.declare', { exclude: ['player'] });
    assert.deepEqual(policy.value, { sync: true, exclude: ['player'] });
    const list = await call(module, 'settings.namespaces', {});
    const music = list.value.find(item => item.namespace === 'module.music');
    assert.deepEqual([music.keys, music.synced, music.policy.exclude], [['tracks', 'player'], true, ['player']]);
    assert.equal(list.value.some(item => item.namespace === '_syncMeta'), false, 'the metadata section is not a settings section');
});

test('storage.settings.set stamps the edit time and emits settings.changed; setting the same value again changes nothing', async () => {
    const { engine, context, call } = settingsEngine();
    const module = engine.registerCaller('module.tracker', 'modules', { tier: 'community', allowedContracts: ['storage.settings.set'] });
    await call(module, 'storage.settings.set', { namespace: 'module.tracker', key: 'poll', value: 5 });
    const stamp = raw(context)._syncMeta.updated['module.tracker::poll'];
    assert.ok(stamp > 0);
    await call(module, 'storage.settings.set', { namespace: 'module.tracker', key: 'poll', value: 5 });
    assert.equal(raw(context)._syncMeta.updated['module.tracker::poll'], stamp);
});

// ── Сервис: настройки как файлы синхронизации ────────────────────────────────────────────────────────────────────────────────

function userDataService(settings) {
    const engine = createEngine();
    const context = { extensionSettings: { stme_settings: settings }, saveSettingsDebounced() {} };
    registerStUserDataService(engine.buses.services, { getContext: () => context, fetch: async () => ({ ok: true, json: async () => [] }), graphStore: null, pmStore: null });
    const call = (contract, params) => new Promise(resolve => engine.buses.services.subscribe(contract, { params }, resolve));
    return { context, call };
}

test('the engine settings appear as sync files, without API keys and without the identity section', async () => {
    const { call } = userDataService({ 'core.sync': { config: { deviceId: 'x', github: { token: 'T' } } }, 'core.classifier': { settings: { connections: [{ id: 'a', endpoint: 'E', apiKey: 'SECRET' }] } }, 'core.ui.home': { state: { order: ['a'] } } });
    const listed = await call('stUserData.list', { categories: ['engineSettings'] });
    assert.deepEqual(listed.value.map(item => item.path).sort(), ['stmeSettings/core.classifier/settings.json', 'stmeSettings/core.ui.home/state.json']);
    const blob = (await call('stUserData.read', { path: 'stmeSettings/core.classifier/settings.json' })).value;
    const text = await blob.text();
    assert.equal(text.includes('SECRET'), false);
    assert.equal(text.includes('"endpoint":"E"'), true);
});

test('a setting written by sync lands in the store with the sender\'s time, keeps our API key, and a conflict-copy name never becomes a setting', async () => {
    const { context, call } = userDataService({ 'core.classifier': { settings: { connections: [{ id: 'a', apiKey: 'MINE' }] } } });
    const file = JSON.stringify({ format: 'stme-setting', namespace: 'core.classifier', key: 'settings', updatedAt: 555, value: { connections: [{ id: 'a', endpoint: 'NEW' }] } });
    const written = await call('stUserData.write', { path: 'stmeSettings/core.classifier/settings.json', blob: new Blob([file]) });
    assert.equal(written.ok, true);
    const stored = context.extensionSettings.stme_settings;
    assert.deepEqual(stored['core.classifier'].settings, { connections: [{ id: 'a', endpoint: 'NEW', apiKey: 'MINE' }] });
    assert.equal(stored._syncMeta.updated['core.classifier::settings'], 555);
    const copy = await call('stUserData.write', { path: 'stmeSettings/core.classifier/settings (conflict Phone 2026-10-03 10-00-00).json', blob: new Blob([file]) });
    assert.equal(copy.ok, true);
    assert.deepEqual(Object.keys(stored['core.classifier']), ['settings']);
});

test('removing a setting file removes the setting and its edit time', async () => {
    const { context, call } = userDataService({ 'core.x': { a: 1, b: 2 }, _syncMeta: { updated: { 'core.x::a': 5 } } });
    await call('stUserData.remove', { path: 'stmeSettings/core.x/a.json' });
    const stored = context.extensionSettings.stme_settings;
    assert.deepEqual(stored['core.x'], { b: 2 });
    assert.equal('core.x::a' in stored._syncMeta.updated, false);
});

// ── конфликт настройки: без копии, побеждает свежая ───────────────────────────────────────────────────────────────────────────

test('engine settings are a no-copy category', () => {
    assert.equal(noCopyFor('stmeSettings/core.ui.home/state.json'), true);
    assert.equal(noCopyFor('characters/Anna.png'), false);
});

test('a conflict on a setting keeps the newer version and makes no copy file', async () => {
    const path = 'stmeSettings/core.ui.home/state.json';
    const plan = computeSyncPlan({ local: { [path]: { hash: 'L', modified: 9 } }, remote: { [path]: { hash: 'R', modified: 5 } }, base: { [path]: 'B' }, noCopy: noCopyFor });
    assert.equal(plan.actions[0].noCopy, true);
    assert.equal(plan.actions[0].winner, 'local');
    assert.equal('conflictPath' in plan.actions[0], false);
    const mk = (hash, modified) => ({ files: new Map([[path, { text: hash, modified }]]), async manifest() { return { [path]: { hash, modified, size: 1 } }; }, async read() { return new Blob([hash]); }, async write(_p, blob, meta) { this.files.set(path, { text: await blob.text(), modified: meta?.modified }); }, async remove() {} });
    const local = mk('L', 9), remote = mk('R', 5);
    const result = await runSync({ local, remote, base: { [path]: 'B' }, noCopy: noCopyFor, cleanupCopies: false });
    assert.equal(remote.files.get(path).text, 'L');
    assert.deepEqual([...remote.files.keys()], [path]);
    assert.equal(result.counts.conflicts, 1);
});
