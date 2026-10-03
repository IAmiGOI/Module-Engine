import test from 'node:test';
import assert from 'node:assert/strict';
import { healValue, secretLeaves, seedEntry, updateEntry } from '../libraries/core/secret-vault.js';
import { createEngine } from '../libraries/shared/engine.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { createSettingsCore } from '../cores/settings/index.js';
import { createPersistedList } from '../libraries/core/persisted-list.js';

const workers = () => [{ id: 'connection_2', endpoint: 'https://openrouter.ai', apiKey: 'sk-or-SECRET', model: 'm' }, { id: 'st-main', apiKey: '' }];

test('secrets are found on any depth by their names, list items are addressed by id (not by position)', () => {
    const found = [...secretLeaves({ workers: workers(), nested: { api_key: 'x', token: 'not-a-secret-name' } })];
    assert.equal(found.length, 3);
    assert.ok(found.some(([path, value]) => path.includes('i:connection_2') && value === 'sk-or-SECRET'));
    assert.ok(found.some(([path, value]) => path.includes('i:st-main') && value === ''));
});

test('the copy follows explicit writes: a key is stored, an empty string deletes it, an ABSENT field leaves it alone', () => {
    let entry = updateEntry({}, workers());
    assert.equal(Object.keys(entry).length, 1);
    entry = updateEntry(entry, [{ id: 'connection_2', model: 'm' }]);   // the field is absent: not a decision of the person
    assert.equal(Object.keys(entry).length, 1);
    entry = updateEntry(entry, [{ id: 'connection_2', apiKey: '' }]);   // the person cleared it
    assert.equal(Object.keys(entry).length, 0);
});

test('a lost key comes back into the same connection even if the list was reordered; nothing else is touched', () => {
    const entry = updateEntry({}, workers());
    const lost = [{ id: 'st-main' }, { id: 'connection_2', endpoint: 'https://openrouter.ai', model: 'other' }];
    assert.equal(healValue(lost, entry), 1);
    assert.equal(lost[1].apiKey, 'sk-or-SECRET');
    assert.equal(lost[1].model, 'other');
    assert.equal(lost[0].apiKey, undefined);
});

test('a key is restored only into a connection that still exists, and never over a key that is there', () => {
    const entry = updateEntry({}, workers());
    assert.equal(healValue([{ id: 'someone-else' }], entry), 0);
    const present = [{ id: 'connection_2', apiKey: 'typed-later' }];
    assert.equal(healValue(present, entry), 0);
    assert.equal(present[0].apiKey, 'typed-later');
    const emptied = [{ id: 'connection_2', apiKey: '' }];
    assert.equal(healValue(emptied, entry), 1, 'an empty value left by an overwrite is filled from the copy');
});

test('seeding stores what already lies in the settings, and never deletes', () => {
    assert.equal(Object.keys(seedEntry({}, workers())).length, 1);
    assert.equal(Object.keys(seedEntry({ keep: 'k' }, [])).length, 1);
});

// ── Ядро настроек + копия в «браузере» ───────────────────────────────────────────────────────────────────────────

function build(initial = {}) {
    const engine = createEngine();
    const context = { extensionSettings: { stme_settings: initial }, saveSettingsDebounced: () => {} };
    registerExtensionSettingsService(engine.buses.services, { getContext: () => context });
    const browser = new Map();   // IndexedDB этого браузера: переживает перезапись settings.json
    engine.buses.services.register('syncState.get', ({ key }) => browser.get(key) ?? null);
    engine.buses.services.register('syncState.set', ({ key, value }) => { browser.set(key, structuredClone(value)); return true; });
    const host = engine.registerCaller('core.settings', 'cores', { tier: 'official' });
    createSettingsCore(host);
    const call = (contract, params) => new Promise(resolve => host.own.subscribe(contract, { params }, resolve));
    const settle = () => new Promise(resolve => setTimeout(resolve, 20));
    return { engine, context, browser, host, call, settle };
}

test('a key typed by the person survives an overwrite of the whole settings file: the next start returns it from the copy', async () => {
    const { context, call, settle } = build();
    await call('storage.settings.set', { namespace: 'core.models.internal', key: 'workers', value: workers() });
    // A stale page saved settings.json from its old memory: the key is gone from the file…
    context.extensionSettings.stme_settings['core.models.internal'].workers = [{ id: 'connection_2', endpoint: 'https://openrouter.ai', model: 'm' }, { id: 'st-main' }];
    assert.equal((await call('storage.settings.get', { namespace: 'core.models.internal', key: 'workers' })).value[0].apiKey, undefined);
    // …and the start (or the sync having applied settings) heals it.
    const healed = await call('settings.secrets.heal', {});
    assert.equal(healed.value, 1);
    assert.equal((await call('storage.settings.get', { namespace: 'core.models.internal', key: 'workers' })).value[0].apiKey, 'sk-or-SECRET');
    await settle();
});

test('a key the person erased on purpose is NOT brought back', async () => {
    const { call } = build();
    await call('storage.settings.set', { namespace: 'core.models.internal', key: 'workers', value: workers() });
    await call('storage.settings.set', { namespace: 'core.models.internal', key: 'workers', value: [{ id: 'connection_2', apiKey: '', model: 'm' }] });
    const healed = await call('settings.secrets.heal', {});
    assert.equal(healed.value, 0);
    assert.equal((await call('storage.settings.get', { namespace: 'core.models.internal', key: 'workers' })).value[0].apiKey, '');
});

test('keys that already lie in the settings when the copy is first made are saved into it (first start after the update)', async () => {
    const { context, browser, call, settle } = build({ 'core.models.internal': { workers: workers() } });
    await settle();
    const vault = browser.get('secretVault');
    assert.equal(Object.keys(vault['core.models.internal::workers']).length, 1);
    context.extensionSettings.stme_settings['core.models.internal'].workers[0].apiKey = '';
    assert.equal((await call('settings.secrets.heal', {})).value, 1);
});

test('the Core that holds the list reloads it when sync applied settings, and a save never drops a key that is stored', async () => {
    const { engine, call, settle } = build();
    await call('storage.settings.set', { namespace: 'core.models.internal', key: 'workers', value: workers() });
    const host = engine.registerCaller('core.models', 'cores', { tier: 'official' });
    let memory = [];
    const list = createPersistedList(host, { namespace: 'core.models.internal', key: 'workers', apply: next => { memory = next; } });
    await list.restore();
    assert.equal(memory[0].apiKey, 'sk-or-SECRET');
    // Sync pulls a list with a new connection; the Core must see it.
    await call('storage.settings.set', { namespace: 'core.models.internal', key: 'workers', value: [...workers(), { id: 'new', apiKey: '' }] });
    host.events.emit('settings.applied', { namespaces: ['core.models.internal'] });
    await settle();
    assert.equal(memory.length, 3);
    // A stale in-memory list without the field is saved: the stored key is kept.
    await list.save([{ id: 'connection_2', endpoint: 'https://openrouter.ai', model: 'edited' }, { id: 'st-main' }]);
    const stored = (await call('storage.settings.get', { namespace: 'core.models.internal', key: 'workers' })).value;
    assert.equal(stored[0].apiKey, 'sk-or-SECRET');
    assert.equal(stored[0].model, 'edited');
    assert.equal(memory[0].apiKey, 'sk-or-SECRET', 'the Core itself now holds the key too');
});
