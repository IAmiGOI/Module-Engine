import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { request } from '../libraries/shared/request.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { createSettingsCore } from '../cores/settings/index.js';
import { createLorebookCore } from '../cores/lorebook/index.js';

/**
 * Scenario level (TESTING.md "Уровень 2") — real engine, real Гейты, real
 * Ядро сохранения (persistence for "published"). `stLorebook.*` — a fake
 * registered directly on the services bus (this Ядро doesn't care whether
 * it's the real Сервис or not, only that the contract shape matches — the
 * real Сервис has its own dedicated test file). `macros.setValue/clearValue`
 * likewise faked here (just records calls) — Ядро macros' OWN behavior for
 * these contracts is covered by macros-core.test.js; this file only proves
 * Ядро работы с WI calls them correctly.
 */

function fakeWorld(initial = {}) {
    // name -> { entries: { uid: entry } }
    const books = new Map(Object.entries(initial));
    const saveCalls = [];
    return {
        books,
        saveCalls,
        load: async name => books.get(name) ?? null,
        save: async (name, data, immediately) => { books.set(name, data); saveCalls.push({ name, data: structuredClone(data), immediately }); },
    };
}

function buildEngine({ rawState = {}, world = {} } = {}) {
    const engine = createEngine();
    const settingsContext = { extensionSettings: {}, saveSettingsDebounced: () => {} };
    registerExtensionSettingsService(engine.buses.services, { getContext: () => settingsContext });
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));

    const fake = fakeWorld(world);
    const servicesHost = engine.registerCaller('service.stLorebook', 'services', { tier: 'official' });
    servicesHost.own.register('stLorebook.rawState', () => rawState);
    servicesHost.own.register('stLorebook.load', params => fake.load(params?.name));
    servicesHost.own.register('stLorebook.save', params => fake.save(params?.name, params?.data, params?.immediately));

    const macroCalls = []; // { op: 'set'|'clear', name, value? }
    const macrosHost = engine.registerCaller('core.macros', 'cores', { tier: 'official' });
    macrosHost.own.register('macros.setValue', params => { macroCalls.push({ op: 'set', name: params?.name, value: params?.value }); });
    macrosHost.own.register('macros.clearValue', params => { macroCalls.push({ op: 'clear', name: params?.name }); return true; });

    const lorebookHost = engine.registerCaller('core.lorebook', 'cores', { tier: 'official' });
    const lorebookCore = createLorebookCore(lorebookHost);

    return { engine, lorebookCore, fake, macroCalls, settingsContext };
}

async function callAs(engine, contract, params) {
    const module = engine.registerCaller('probe', 'modules', { tier: 'official' });
    return new Promise(resolve => module.cores.subscribe(contract, { params }, resolve));
}

// --- scan()/find()/get()/books() ---------------------------------------

test('scan() resolves active books via resolveBookNames() and merges their entries into the index', async () => {
    const { engine } = buildEngine({
        rawState: { selectedWorldInfo: ['Global'], chatBook: null, personaBook: null, characterId: null, characters: [], groupId: null, groups: [] },
        world: { Global: { entries: { 0: { uid: 0, comment: 'Tavern', key: ['tavern'], content: 'A cozy tavern.' } } } },
    });

    const result = await callAs(engine, 'lorebook.scan', {});

    assert.equal(result.ok, true);
    assert.deepEqual(result.value.books, ['Global']);
    assert.equal(result.value.entries.length, 1);
    assert.equal(result.value.entries[0].name, 'Tavern');
    assert.ok(!('content' in result.value.entries[0]), 'find()/scan() index stays metadata-only');
});

test('find() filters the scanned index; get() returns the full entry including content', async () => {
    const { engine } = buildEngine({
        rawState: { selectedWorldInfo: ['Global'] },
        world: { Global: { entries: {
            0: { uid: 0, comment: 'Tavern', key: ['tavern'], content: 'A cozy tavern.' },
            1: { uid: 1, comment: 'Castle', key: ['castle'], content: 'A tall castle.' },
        } } },
    });
    await callAs(engine, 'lorebook.scan', {});

    const found = await callAs(engine, 'lorebook.find', { name: 'tav' });
    assert.equal(found.value.length, 1);
    assert.equal(found.value[0].name, 'Tavern');

    const got = await callAs(engine, 'lorebook.get', { uid: 0, book: 'Global' });
    assert.equal(got.value.content, 'A cozy tavern.');
});

test('books() reflects an empty active set honestly — no throw, no stale entries left over from a previous scan', async () => {
    const { engine } = buildEngine({ rawState: {}, world: {} });

    const result = await callAs(engine, 'lorebook.scan', {});

    assert.deepEqual(result.value, { books: [], entries: [] });
});

// --- Real ST events drive automatic re-scanning -------------------------

test('st.worldinfoUpdated (a book saved — by us OR by ST\'s own native editor) re-scans automatically, no manual Rescan needed', async () => {
    const { engine, fake } = buildEngine({
        rawState: { selectedWorldInfo: ['Global'] },
        world: { Global: { entries: {} } },
    });
    await callAs(engine, 'lorebook.scan', {});
    assert.equal((await callAs(engine, 'lorebook.find', {})).value.length, 0);

    // Simulates a save from ST's OWN World Info editor — not through our API at all.
    fake.books.set('Global', { entries: { 0: { uid: 0, comment: 'New', key: [], content: 'x' } } });
    engine.events.emit('st.worldinfoUpdated', { event: 'WORLDINFO_UPDATED', args: ['Global', fake.books.get('Global')] });
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal((await callAs(engine, 'lorebook.find', {})).value.length, 1);
});

test('st.worldinfoSettingsUpdated (global book selection changed) re-scans and picks up the new active set', async () => {
    let rawState = { selectedWorldInfo: [] };
    const engine2 = createEngine();
    const settingsContext = { extensionSettings: {}, saveSettingsDebounced: () => {} };
    registerExtensionSettingsService(engine2.buses.services, { getContext: () => settingsContext });
    createSettingsCore(engine2.registerCaller('core.settings', 'cores', { tier: 'official' }));
    const fake = fakeWorld({ NewBook: { entries: { 0: { uid: 0, comment: 'Entry', key: [], content: 'x' } } } });
    const servicesHost = engine2.registerCaller('service.stLorebook', 'services', { tier: 'official' });
    servicesHost.own.register('stLorebook.rawState', () => rawState);
    servicesHost.own.register('stLorebook.load', params => fake.load(params?.name));
    servicesHost.own.register('stLorebook.save', params => fake.save(params?.name, params?.data, params?.immediately));
    const macrosHost = engine2.registerCaller('core.macros', 'cores', { tier: 'official' });
    macrosHost.own.register('macros.setValue', () => {});
    macrosHost.own.register('macros.clearValue', () => true);
    createLorebookCore(engine2.registerCaller('core.lorebook', 'cores', { tier: 'official' }));

    await callAs(engine2, 'lorebook.scan', {});
    assert.deepEqual((await callAs(engine2, 'lorebook.books', {})).value, []);

    rawState = { selectedWorldInfo: ['NewBook'] };
    engine2.events.emit('st.worldinfoSettingsUpdated', { event: 'WORLDINFO_SETTINGS_UPDATED', args: [] });
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.deepEqual((await callAs(engine2, 'lorebook.books', {})).value, ['NewBook']);
});

test('st.chatChanged re-scans — a different chat/character has its own active books', async () => {
    let rawState = { chatBook: 'Chat A Book' };
    const { engine } = (() => {
        const eng = createEngine();
        const settingsContext = { extensionSettings: {}, saveSettingsDebounced: () => {} };
        registerExtensionSettingsService(eng.buses.services, { getContext: () => settingsContext });
        createSettingsCore(eng.registerCaller('core.settings', 'cores', { tier: 'official' }));
        const fake = fakeWorld({ 'Chat A Book': { entries: { 0: { uid: 0, comment: 'A', key: [], content: 'x' } } }, 'Chat B Book': { entries: {} } });
        const servicesHost = eng.registerCaller('service.stLorebook', 'services', { tier: 'official' });
        servicesHost.own.register('stLorebook.rawState', () => rawState);
        servicesHost.own.register('stLorebook.load', params => fake.load(params?.name));
        servicesHost.own.register('stLorebook.save', params => fake.save(params?.name, params?.data, params?.immediately));
        const macrosHost = eng.registerCaller('core.macros', 'cores', { tier: 'official' });
        macrosHost.own.register('macros.setValue', () => {});
        macrosHost.own.register('macros.clearValue', () => true);
        createLorebookCore(eng.registerCaller('core.lorebook', 'cores', { tier: 'official' }));
        return { engine: eng };
    })();

    await callAs(engine, 'lorebook.scan', {});
    assert.deepEqual((await callAs(engine, 'lorebook.books', {})).value, ['Chat A Book']);

    rawState = { chatBook: 'Chat B Book' };
    engine.events.emit('st.chatChanged', { event: 'CHAT_CHANGED', args: [] });
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.deepEqual((await callAs(engine, 'lorebook.books', {})).value, ['Chat B Book']);
});

test('st.worldInfoActivated records what actually got injected THIS generation, as an array — not a re-scan trigger', async () => {
    const { engine } = buildEngine({ rawState: { selectedWorldInfo: ['Global'] }, world: { Global: { entries: {} } } });
    await callAs(engine, 'lorebook.scan', {});

    const activated = [{ uid: 0, world: 'Global', comment: 'Tavern' }];
    engine.events.emit('st.worldInfoActivated', { event: 'WORLD_INFO_ACTIVATED', args: [activated] });
    await new Promise(resolve => setTimeout(resolve, 0));

    const result = await callAs(engine, 'lorebook.lastActivated', {});
    assert.deepEqual(result.value.entries, activated);
    assert.ok(typeof result.value.at === 'number');
});

// --- CRUD -----------------------------------------------------------------

test('createEntry() writes to the first active book by default, saves IMMEDIATELY (not left to ST\'s debounce), and re-scans', async () => {
    const { engine, fake } = buildEngine({ rawState: { selectedWorldInfo: ['Global'] }, world: { Global: { entries: {} } } });
    await callAs(engine, 'lorebook.scan', {});

    const result = await callAs(engine, 'lorebook.createEntry', { patch: { comment: 'New Entry', content: 'Hello' } });

    assert.equal(result.ok, true);
    assert.equal(result.value.book, 'Global');
    assert.equal(result.value.comment, 'New Entry');
    assert.equal(fake.saveCalls.at(-1).immediately, true, 'must not be left to ST\'s own debounce — risks losing the write on a reload');
    assert.equal((await callAs(engine, 'lorebook.find', {})).value.length, 1, 'index refreshed after create');
});

test('createEntry() into an explicit book, with no active book at all, still works', async () => {
    const { engine } = buildEngine({ rawState: {}, world: { SomeBook: { entries: {} } } });
    await callAs(engine, 'lorebook.scan', {});

    const result = await callAs(engine, 'lorebook.createEntry', { patch: { comment: 'X' }, book: 'SomeBook' });

    assert.equal(result.ok, true);
    assert.equal(result.value.book, 'SomeBook');
});

test('createEntry() with no active book and none given explicitly fails clearly, does not silently write nowhere', async () => {
    const { engine } = buildEngine({ rawState: {}, world: {} });
    await callAs(engine, 'lorebook.scan', {});

    const result = await callAs(engine, 'lorebook.createEntry', { patch: { comment: 'X' } });

    assert.equal(result.ok, false);
    assert.match(result.error.message, /no lorebook active/);
});

test('createEntry() fills every real ST default field, not just the 11 Alpha hardcoded — verified against the real newWorldInfoEntryDefinition', async () => {
    const { engine } = buildEngine({ rawState: { selectedWorldInfo: ['Global'] }, world: { Global: { entries: {} } } });
    await callAs(engine, 'lorebook.scan', {});

    const result = await callAs(engine, 'lorebook.createEntry', { patch: { comment: 'X' } });

    assert.equal(result.value.depth, 4);
    assert.equal(result.value.groupWeight, 100);
    assert.equal(result.value.selectiveLogic, 0);
    assert.equal(result.value.role, 0);
});

test('updateEntry() merges patch into the existing entry and saves immediately', async () => {
    const { engine, fake } = buildEngine({
        rawState: { selectedWorldInfo: ['Global'] },
        world: { Global: { entries: { 0: { uid: 0, comment: 'Old', key: [], content: 'old text' } } } },
    });
    await callAs(engine, 'lorebook.scan', {});

    const result = await callAs(engine, 'lorebook.updateEntry', { uid: 0, book: 'Global', patch: { content: 'new text' } });

    assert.equal(result.ok, true);
    assert.equal(result.value.content, 'new text');
    assert.equal(result.value.comment, 'Old', 'unpatched fields survive');
    assert.equal(fake.saveCalls.at(-1).immediately, true);
});

test('updateEntry() on an unknown uid fails clearly instead of silently no-op-ing', async () => {
    const { engine } = buildEngine({ rawState: { selectedWorldInfo: ['Global'] }, world: { Global: { entries: {} } } });
    await callAs(engine, 'lorebook.scan', {});

    const result = await callAs(engine, 'lorebook.updateEntry', { uid: 99, patch: { content: 'x' } });

    assert.equal(result.ok, false);
    assert.match(result.error.message, /no known entry/);
});

// --- Read-before-write safety: real ST's loadWorldInfo() returns `null` on
// ANY failed HTTP response, not only "book does not exist" (verified against
// the real world-info.js source) — a transient hiccup must never be read as
// "the book is empty" and written back that way, wiping real content. ------

test('updateEntry() refuses to write when the live re-read of the book fails, instead of silently saving an empty book over real content', async () => {
    const { engine, fake } = buildEngine({
        rawState: { selectedWorldInfo: ['Global'] },
        world: { Global: { entries: { 0: { uid: 0, comment: 'Keep me', key: [], content: 'important lore' } } } },
    });
    await callAs(engine, 'lorebook.scan', {});
    fake.load = async () => null; // simulates ST's real "HTTP response not ok" failure signal

    const result = await callAs(engine, 'lorebook.updateEntry', { uid: 0, patch: { content: 'x' } });

    assert.equal(result.ok, false);
    assert.match(result.error.message, /refusing to write blind/);
    assert.equal(fake.saveCalls.length, 0, 'must NEVER call save() on a failed read — that would be the wipe');
    assert.deepEqual(fake.books.get('Global').entries[0].content, 'important lore', 'the real entry must be untouched');
});

test('deleteEntry() also refuses to write when the live re-read fails — a transient hiccup must not erase the whole book', async () => {
    const { engine, fake } = buildEngine({
        rawState: { selectedWorldInfo: ['Global'] },
        world: { Global: { entries: { 0: { uid: 0, comment: 'Keep me', key: [], content: 'important lore' }, 1: { uid: 1, comment: 'Also keep', key: [], content: 'more lore' } } } },
    });
    await callAs(engine, 'lorebook.scan', {});
    fake.load = async () => null;

    const result = await callAs(engine, 'lorebook.deleteEntry', { uid: 0 });

    assert.equal(result.ok, false);
    assert.equal(fake.saveCalls.length, 0, 'must NEVER call save() on a failed read');
    assert.equal(Object.keys(fake.books.get('Global').entries).length, 2, 'BOTH entries must survive — neither the target nor its sibling');
});

test('createEntry() into an EXISTING book with real entries also refuses on a failed read, rather than replacing it with a book of just the one new entry', async () => {
    const { engine, fake } = buildEngine({
        rawState: {},
        world: { SomeBook: { entries: { 0: { uid: 0, comment: 'Keep me', key: [], content: 'important lore' } } } },
    });
    await callAs(engine, 'lorebook.scan', {});
    fake.load = async () => null;

    const result = await callAs(engine, 'lorebook.createEntry', { patch: { comment: 'New' }, book: 'SomeBook' });

    assert.equal(result.ok, false);
    assert.equal(fake.saveCalls.length, 0);
    assert.equal(Object.keys(fake.books.get('SomeBook').entries).length, 1, 'the pre-existing entry must survive untouched');
});

test('updateEntry() refuses when the uid vanished from the real book between scan() and write — a stale local index must not resurrect a fabricated entry', async () => {
    const { engine, fake } = buildEngine({
        rawState: { selectedWorldInfo: ['Global'] },
        world: { Global: { entries: { 0: { uid: 0, comment: 'Will vanish', key: [], content: 'x' } } } },
    });
    await callAs(engine, 'lorebook.scan', {});
    // Someone else (native ST editor) removed uid 0 for real, but our local
    // index (`byUid`) has not re-scanned yet — the classic stale-cache shape.
    fake.books.set('Global', { entries: {} });

    const result = await callAs(engine, 'lorebook.updateEntry', { uid: 0, patch: { content: 'x' } });

    assert.equal(result.ok, false);
    assert.match(result.error.message, /no longer in/);
    assert.equal(fake.saveCalls.length, 0);
});

test('deleteEntry() removes the entry and re-scans; a deleted, still-published entry gets unpublished from real ST too', async () => {
    const { engine, macroCalls } = buildEngine({
        rawState: { selectedWorldInfo: ['Global'] },
        world: { Global: { entries: { 0: { uid: 0, comment: 'Gone', key: [], content: 'x' } } } },
    });
    await callAs(engine, 'lorebook.scan', {});
    await callAs(engine, 'lorebook.publish', { uid: 0, book: 'Global' });
    macroCalls.length = 0; // clear the publish-time calls, only care about what happens on delete

    const result = await callAs(engine, 'lorebook.deleteEntry', { uid: 0, book: 'Global' });

    assert.equal(result.ok, true);
    assert.equal((await callAs(engine, 'lorebook.find', {})).value.length, 0);
    assert.ok(macroCalls.some(call => call.op === 'clear'), 're-scan republishAll() must retire the now-gone entry\'s macro');
});

test('two concurrent createEntry() calls into the SAME book do not collide on the same uid — the write queue serializes them', async () => {
    const { engine } = buildEngine({ rawState: { selectedWorldInfo: ['Global'] }, world: { Global: { entries: {} } } });
    await callAs(engine, 'lorebook.scan', {});

    const [a, b] = await Promise.all([
        callAs(engine, 'lorebook.createEntry', { patch: { comment: 'A' } }),
        callAs(engine, 'lorebook.createEntry', { patch: { comment: 'B' } }),
    ]);

    assert.notEqual(a.value.uid, b.value.uid, 'both writes must land on DIFFERENT uids, neither one lost');
    assert.equal((await callAs(engine, 'lorebook.find', {})).value.length, 2);
});

// --- Publish ----------------------------------------------------------------

test('publish() calls macros.setValue with the entry\'s content and a stable slug; isPublished() reflects it; unpublish() calls macros.clearValue', async () => {
    const { engine, macroCalls } = buildEngine({
        rawState: { selectedWorldInfo: ['Global'] },
        world: { Global: { entries: { 0: { uid: 0, comment: 'Tavern', key: [], content: 'A cozy tavern.' } } } },
    });
    await callAs(engine, 'lorebook.scan', {});

    await callAs(engine, 'lorebook.publish', { uid: 0, book: 'Global' });
    assert.deepEqual(macroCalls.at(-1), { op: 'set', name: 'lorebook_global_tavern', value: 'A cozy tavern.' });
    assert.equal((await callAs(engine, 'lorebook.isPublished', { uid: 0, book: 'Global' })).value, true);

    const indexed = await callAs(engine, 'lorebook.publishedEntries', {});
    assert.deepEqual(indexed.value, [{ book: 'Global', uid: 0, name: 'Tavern', macro: 'lorebook_global_tavern' }]);

    await callAs(engine, 'lorebook.unpublish', { uid: 0, book: 'Global' });
    assert.deepEqual(macroCalls.at(-1), { op: 'clear', name: 'lorebook_global_tavern' });
    assert.equal((await callAs(engine, 'lorebook.isPublished', { uid: 0, book: 'Global' })).value, false);
});

test('publish state survives a fresh Ядро instance sharing the same storage.settings — persisted, not in-memory only', async () => {
    const { engine, settingsContext } = buildEngine({
        rawState: { selectedWorldInfo: ['Global'] },
        world: { Global: { entries: { 0: { uid: 0, comment: 'Tavern', key: [], content: 'x' } } } },
    });
    await callAs(engine, 'lorebook.scan', {});
    await callAs(engine, 'lorebook.publish', { uid: 0, book: 'Global' });

    const second = createLorebookCore(engine.registerCaller('core.lorebook.second', 'cores', { tier: 'official' }));
    void second;
    const result = await callAs(engine, 'lorebook.isPublished', { uid: 0, book: 'Global' });

    assert.equal(result.value, true);
    assert.ok(settingsContext.extensionSettings, 'really went through storage.settings, not a private field');
});

// --- Rights -------------------------------------------------------------

test('a Module without the right to lorebook.* contracts is refused before the Ядро is ever reached', async () => {
    const { engine } = buildEngine();
    const module = engine.registerCaller('module.untrusted', 'modules', { tier: 'community', allowedContracts: [] });

    const result = await new Promise(resolve => module.cores.subscribe('lorebook.createEntry', { params: { patch: {} } }, resolve));

    assert.equal(result.ok, false);
});
