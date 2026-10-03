import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModuleLink, rawModuleUrl, parseThirdPartyList, buildVerifiedEntries } from '../libraries/core/module-catalog.js';
import { analyzeExternalModule, MAX_MODULE_SOURCE_BYTES } from '../libraries/core/module-analyze.js';
import { createRightsCore } from '../cores/rights/index.js';
import { createModuleInstaller } from '../cores/runner/installer.js';
import { createModuleRuntime, createModuleRegistry } from '../harness/engine-wiring.js';
import { createEngine } from '../libraries/shared/engine.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { createSettingsCore } from '../cores/settings/index.js';

// Node не импортирует blob:, но data: — тот же "исполняется ровно проверенный текст".
const importBlob = source => import(`data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`);

const MODULE = (id, body = 'export default () => ({ load: async () => {}, tree: () => ({ tag: "div", props: {}, children: [] }), stop() {} });', extra = '') =>
    `/*@module\nid: ${id}\ntitle: ${id}\nversion: 1.0.0\n${extra}\n*/\n${body}`;

test('parseModuleLink() understands owner/repo, repo URLs, tree and blob links, and refuses the rest', () => {
    assert.deepEqual(parseModuleLink('me/dice'), { owner: 'me', repo: 'dice', ref: 'HEAD', path: 'index.js' });
    assert.deepEqual(parseModuleLink('https://github.com/me/dice.git/'), { owner: 'me', repo: 'dice', ref: 'HEAD', path: 'index.js' });
    assert.deepEqual(parseModuleLink('https://github.com/me/mods/tree/main/dice'), { owner: 'me', repo: 'mods', ref: 'main', path: 'dice/index.js' });
    assert.deepEqual(parseModuleLink('https://github.com/me/mods/blob/v2/x/dice.js'), { owner: 'me', repo: 'mods', ref: 'v2', path: 'x/dice.js' });
    for (const bad of ['', 'nope', 'https://evil.example/me/dice', 'me/dice/tree/main/../../etc', 'me/dice/wiki/x', 'me/dice/blob/main/readme.md']) assert.equal(parseModuleLink(bad), null, bad);
    assert.equal(rawModuleUrl({ owner: 'me', repo: 'mods', ref: 'main', path: 'a b/index.js' }), 'https://raw.githubusercontent.com/me/mods/main/a%20b/index.js');
});

test('parseThirdPartyList() skips comments, collapses duplicates and reports bad lines with their number', () => {
    const { entries, errors } = parseThirdPartyList('# list\nme/dice\n\nhttps://github.com/me/dice   # same\nhttps://github.com/me/mods/tree/main/cards\nrubbish line\n');
    assert.deepEqual(entries.map(e => e.url), ['https://raw.githubusercontent.com/me/dice/HEAD/index.js', 'https://raw.githubusercontent.com/me/mods/main/cards/index.js']);
    assert.equal(entries[0].kind, 'thirdParty');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /line 6/);
});

test('buildVerifiedEntries() takes only folders, sorted, with raw URLs to their index.js', () => {
    const listing = [{ name: 'zeta', type: 'dir' }, { name: 'README.md', type: 'file' }, { name: 'alpha', type: 'dir' }, { name: '.github', type: 'dir' }];
    const entries = buildVerifiedEntries(listing, { owner: 'cat', repo: 'mods', ref: 'main' });
    assert.deepEqual(entries.map(e => e.name), ['alpha', 'zeta']);
    assert.equal(entries[0].url, 'https://raw.githubusercontent.com/cat/mods/main/modules/alpha/index.js');
    assert.deepEqual(buildVerifiedEntries({ message: 'rate limited' }, { owner: 'a', repo: 'b' }), []);
});

test('analyzeExternalModule() demands the community. namespace, refuses built-in ids, oversize sources and bad code', async () => {
    assert.equal((await analyzeExternalModule(MODULE('community.ok'))).ok, true);
    const impostor = await analyzeExternalModule(MODULE('module.tracker'));
    assert.equal(impostor.ok, false);
    assert.match(impostor.errors.join(), /community\./);
    const taken = await analyzeExternalModule(MODULE('community.map'), { reservedIds: ['community.map'] });
    assert.match(taken.errors.join(), /built-in/);
    const huge = await analyzeExternalModule(MODULE('community.big', 'x'.repeat(MAX_MODULE_SOURCE_BYTES)));
    assert.equal(huge.ok, false);
    const evil = await analyzeExternalModule(MODULE('community.evil', 'eval("1")'));
    assert.equal(evil.ok, false);
    assert.equal(evil.tier, 'rejected');
});

test('quarantineOnViolation: only flagged callers are quarantined, on a denied contract or an unasked-for network call, once', () => {
    const rights = createRightsCore();
    const seen = [];
    rights.onViolation(v => seen.push(v));
    rights.register('module.builtin', { tier: 'community', allowedContracts: [] });
    rights.register('community.ext', { tier: 'community', allowedContracts: ['ui.notify'], quarantineOnViolation: true });
    rights.register('community.scanned', { tier: 'scanned-unsafe', deniedContracts: ['http.request'], quarantineOnViolation: true });

    assert.equal(rights.checkAccess('community.ext', 'ui.notify').allowed, true);
    assert.equal(rights.isQuarantined('community.ext'), false, 'an allowed call is not a violation');
    assert.equal(rights.checkAccess('module.builtin', 'anything').allowed, false);
    assert.equal(rights.isQuarantined('module.builtin'), false, 'built-ins keep their old silent denial');

    assert.equal(rights.checkAccess('community.ext', 'storage.settings.get').allowed, false);
    assert.equal(rights.isQuarantined('community.ext'), true);
    assert.equal(rights.checkAccess('community.ext', 'ui.notify').allowed, false, 'once quarantined, even allowed contracts are refused');

    assert.equal(rights.hasNetworkAccess('community.scanned'), false);
    assert.equal(rights.isQuarantined('community.scanned'), true, 'reaching for the network without the grant is a violation');
    assert.deepEqual(seen.map(v => v.callerId), ['community.ext', 'community.scanned']);

    rights.unquarantine('community.ext');
    assert.equal(rights.checkAccess('community.ext', 'ui.notify').allowed, true, 'an explicit release lifts it');
});

function memoryStore() {
    const data = new Map();
    return { data, read: async (key, fallback) => (data.has(key) ? structuredClone(data.get(key)) : fallback), write: async (key, value) => { data.set(key, structuredClone(value)); } };
}

function fakeGithub(files) {
    return async url => (url in files ? { ok: true, status: 200, text: typeof files[url] === 'string' ? files[url] : JSON.stringify(files[url]) } : { ok: false, status: 404, text: '' });
}

const CATALOG = {
    'https://api.github.com/repos/cat/mods/contents/modules?ref=HEAD': [{ name: 'dice', type: 'dir' }],
    'https://raw.githubusercontent.com/cat/mods/HEAD/modules/dice/index.js': MODULE('community.dice'),
    'https://raw.githubusercontent.com/cat/mods/HEAD/third-party.txt': '# x\nfan/cards\n',
    'https://raw.githubusercontent.com/fan/cards/HEAD/index.js': MODULE('community.cards'),
};

test('the installer lists both halves of a catalog and survives one half being down', async () => {
    const installer = createModuleInstaller({ fetchText: fakeGithub(CATALOG), store: memoryStore() });
    const catalog = await installer.fetchCatalog('cat/mods');
    assert.deepEqual(catalog.verified.map(e => e.name), ['dice']);
    assert.deepEqual(catalog.thirdParty.map(e => e.name), ['fan/cards']);
    assert.deepEqual(catalog.errors, []);

    const partial = createModuleInstaller({ fetchText: fakeGithub({ [Object.keys(CATALOG)[0]]: CATALOG[Object.keys(CATALOG)[0]] }), store: memoryStore() });
    const half = await partial.fetchCatalog('cat/mods');
    assert.equal(half.verified.length, 1);
    assert.equal(half.thirdParty.length, 0);
    assert.match(half.errors[0], /third-party list/);
    assert.equal((await installer.fetchCatalog('not a link')).errors.length, 1);
});

test('preview() installs nothing; install() stores the exact source and survives a reload', async () => {
    const store = memoryStore();
    const installer = createModuleInstaller({ fetchText: fakeGithub(CATALOG), store });
    const catalog = await installer.fetchCatalog('cat/mods');
    const preview = await installer.preview(catalog.verified[0]);
    assert.equal(preview.ok, true);
    assert.equal(preview.tier, 'scanned-safe');
    assert.deepEqual(installer.list(), [], 'a preview changes nothing');

    const record = await installer.install(preview);
    assert.equal(record.id, 'community.dice');
    assert.equal(record.source, undefined, 'list/return values never carry the source around');
    assert.equal(installer.sources()[0].source, CATALOG['https://raw.githubusercontent.com/cat/mods/HEAD/modules/dice/index.js']);

    const reloaded = createModuleInstaller({ fetchText: async () => { throw new Error('no network at startup'); }, store });
    await reloaded.load();
    assert.deepEqual(reloaded.list().map(i => i.id), ['community.dice'], 'installed Modules start without the network');
    assert.equal(await reloaded.uninstall('community.dice'), true);
    assert.equal(await reloaded.uninstall('community.dice'), false);
});

test('preview() takes a bare GitHub link, reports 404s, and refuses a rejected module', async () => {
    const installer = createModuleInstaller({ fetchText: fakeGithub({ ...CATALOG, 'https://raw.githubusercontent.com/bad/evil/HEAD/index.js': MODULE('community.evil', 'eval("x")') }), store: memoryStore() });
    assert.equal((await installer.preview('fan/cards')).ok, true);
    const missing = await installer.preview('nobody/nothing');
    assert.equal(missing.ok, false);
    assert.match(missing.errors[0], /404/);
    const evil = await installer.preview('bad/evil');
    assert.equal(evil.ok, false);
    await assert.rejects(() => installer.install(evil), /cannot install/);
    assert.equal((await installer.preview('lol')).ok, false);
});

test('a requested network grant is shown but never given; the preview says what is asked and what gets replaced', async () => {
    const source = MODULE('community.net', 'export default () => 1;', 'network: true\nrights: ui.notify, tracking.poll');
    const installer = createModuleInstaller({ fetchText: fakeGithub({ 'https://raw.githubusercontent.com/a/b/HEAD/index.js': source }), store: memoryStore() });
    const first = await installer.preview('a/b');
    assert.equal(first.requestsNetwork, true);
    assert.deepEqual(first.requestedRights, ['ui.notify', 'tracking.poll']);
    assert.equal(first.replaces, null);
    await installer.install(first);
    assert.equal((await installer.preview('a/b')).replaces, '1.0.0');
});

test('quarantine is recorded by id with the installed hash, blocks a reinstall, and lifts only on explicit release', async () => {
    const store = memoryStore();
    const installer = createModuleInstaller({ fetchText: fakeGithub(CATALOG), store, now: () => 42 });
    await installer.install(await installer.preview('fan/cards'));
    await installer.recordQuarantine({ callerId: 'community.cards', contract: 'storage.settings.get' });
    await installer.recordQuarantine({ callerId: 'community.cards', contract: 'again' });
    assert.equal(installer.quarantineList().length, 1, 'recorded once');
    assert.equal(installer.quarantineList()[0].at, 42);
    assert.match(installer.quarantineList()[0].hash, /^[0-9a-f]{64}$/);

    const fresh = createModuleInstaller({ fetchText: fakeGithub(CATALOG), store });
    await fresh.load();
    assert.equal(fresh.isQuarantined('community.cards'), true, 'survives a restart');
    const again = await fresh.preview('fan/cards');
    assert.equal(again.ok, false, 'a reinstall of the same module is refused');
    await assert.rejects(() => fresh.install(again), /cannot install|quarantined/);
    assert.equal(await fresh.releaseQuarantine('community.cards'), true);
    assert.equal((await fresh.preview('fan/cards')).ok, true);
});

async function runtimeFixture(files) {
    const engine = createEngine();
    const settings = {};
    // Хранилище и сеть — настоящие контракты движка, фейкаются только Сервисы под ними (TESTING.md).
    engine.buses.cores.register('storage.settings.get', async ({ namespace, key, fallback }) => (settings[`${namespace}/${key}`] ?? fallback));
    engine.buses.cores.register('storage.settings.set', async ({ namespace, key, value }) => { settings[`${namespace}/${key}`] = structuredClone(value); return true; });
    engine.buses.network.register('http.request', async ({ url }) => (url in files ? { ok: true, status: 200, text: files[url] } : { ok: false, status: 404, text: '' }));
    const storageHost = engine.registerCaller('core.runner', 'cores', { tier: 'official' });
    return { engine, settings, storageHost };
}

test('end to end: install through the real registry, enable, violate, get quarantined, restart, still refused', async () => {
    const SOURCE = 'https://raw.githubusercontent.com/fan/cards/HEAD/index.js';
    const files = { [SOURCE]: MODULE('community.cards', 'export default host => ({ host, load: async () => {}, tree: () => ({ tag: "div", props: {}, children: [] }), stop() {} });', 'rights: ui.notify') };
    const { engine, settings, storageHost } = await runtimeFixture(files);

    const build = () => {
        const runtime = createModuleRuntime({ engine, storageHost, entries: [], importBlob });
        const registry = createModuleRegistry({
            engine, storageHost,
            uiModules: { enable: () => ({ getRoot: () => ({}), settled: async () => {} }), disable: () => {} },
            panelSettled: async () => {}, panelRoot: () => ({ querySelector: () => null }),
            definitions: runtime.runner.definitions, ready: runtime.ready, problems: runtime.runner.problems,
            installer: runtime.installer, rediscover: runtime.rediscover,
        });
        return { runtime, registry };
    };

    const first = build();
    await first.runtime.ready;
    assert.deepEqual(first.registry.list(), []);

    const preview = await first.registry.installer.preview('fan/cards');
    assert.equal(preview.ok, true, preview.errors.join());
    await first.registry.installModule(preview);
    assert.deepEqual(first.registry.list().map(m => [m.id, m.origin, m.tier]), [['community.cards', 'installed', 'scanned-safe']]);

    await first.registry.enable('community.cards');
    assert.deepEqual(first.registry.enabled(), ['community.cards']);

    // Модуль лезет за контрактом, которого у него нет, — в scanned-safe это default-allow, поэтому нарушение — только сеть без права.
    const host = first.registry.instance('community.cards').host;
    const denied = await new Promise(resolve => host.network.subscribe('http.request', { params: { url: 'https://x.example' } }, resolve));
    assert.equal(denied.ok, false);
    assert.equal(engine.rights.isQuarantined('community.cards'), true);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(settings['core.runner/quarantinedModules'][0].id, 'community.cards', 'persisted');

    // «Перезапуск»: новый движок, то же хранилище — Модуль на месте, но не поднимается.
    const second = await (async () => {
        const next = createEngine();
        next.buses.cores.register('storage.settings.get', async ({ namespace, key, fallback }) => (settings[`${namespace}/${key}`] ?? fallback));
        next.buses.cores.register('storage.settings.set', async ({ namespace, key, value }) => { settings[`${namespace}/${key}`] = structuredClone(value); return true; });
        next.buses.network.register('http.request', async () => ({ ok: false, status: 0, text: '' }));
        const runtime = createModuleRuntime({ engine: next, storageHost: next.registerCaller('core.runner', 'cores', { tier: 'official' }), entries: [], importBlob });
        await runtime.ready;
        return runtime;
    })();
    assert.deepEqual(second.runner.definitions, []);
    assert.equal(second.runner.problems()[0].state, 'quarantined');
    assert.equal(second.installer.list().length, 1, 'still installed, just not runnable');

    // Явное решение пользователя возвращает его.
    await first.registry.releaseQuarantine('community.cards');
    assert.equal(engine.rights.isQuarantined('community.cards'), false);
    assert.deepEqual(first.registry.list().map(m => m.id), ['community.cards']);

    assert.equal(await first.registry.uninstallModule('community.cards'), true);
    assert.deepEqual(first.registry.list(), []);
});

test('a preview that says OK means the module will load: an unknown stme: import is refused already at preview time', async () => {
    const resolveStme = path => (path === 'ui/tree' ? 'http://x/tree.js' : null);
    const ok = await analyzeExternalModule(MODULE('community.fine', "import { h } from 'stme:ui/tree';"), { resolveStme });
    assert.equal(ok.ok, true, ok.errors.join());
    const bad = await analyzeExternalModule(MODULE('community.lost', "import { x } from 'stme:nope';"), { resolveStme });
    assert.equal(bad.ok, false);
    assert.match(bad.errors.join(), /unknown "stme:nope"/);
    const commentOnly = await analyzeExternalModule(MODULE('community.doc', "// only `stme:<path>` imports are allowed\nexport default () => 1;"), { resolveStme });
    assert.equal(commentOnly.ok, true, 'a mention in a comment is not an import');
});
