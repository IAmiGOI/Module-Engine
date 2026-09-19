import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { backgroundNameFor, encodeRepoPath, isBackgroundPath, planBackgroundSync } from '../libraries/core/background-sync.js';
import { createBackgroundsCore } from '../cores/backgrounds/index.js';

const blob = path => ({ path, type: 'blob', sha: `sha-${path}`, size: 1000 });

test('only images and videos count as backgrounds — README, hidden files and hidden folders are silently ignored', () => {
    assert.equal(isBackgroundPath('room.jpg'), true);
    assert.equal(isBackgroundPath('Interiors/Kitchen.PNG'), true);
    assert.equal(isBackgroundPath('loop.webm'), true);
    assert.equal(isBackgroundPath('README.md'), false);
    assert.equal(isBackgroundPath('.gitkeep'), false);
    assert.equal(isBackgroundPath('.github/logo.png'), false);
});

test('the ST file name carries the prefix and the folder, and is safe as a file name', () => {
    assert.equal(backgroundNameFor('room.jpg'), 'stme-room.jpg');
    assert.equal(backgroundNameFor('Interiors/Kitchen 1.png'), 'stme-Interiors-Kitchen 1.png');
    assert.equal(backgroundNameFor('a/b:c?.png'), 'stme-a-b_c_.png');
    assert.equal(encodeRepoPath('Интерьеры/Кухня #1.jpg'), '%D0%98%D0%BD%D1%82%D0%B5%D1%80%D1%8C%D0%B5%D1%80%D1%8B/%D0%9A%D1%83%D1%85%D0%BD%D1%8F%20%231.jpg');
});

test('a plan installs new and changed files, skips oversized ones, and removes only what WE installed and the repo dropped', () => {
    const plan = planBackgroundSync({
        tree: [blob('new.jpg'), blob('same.jpg'), { ...blob('changed.jpg'), sha: 'sha-v2' }, { ...blob('huge.mp4'), size: 999999999 }, blob('README.md')],
        installed: {
            'same.jpg': { sha: 'sha-same.jpg', name: 'stme-same.jpg' },
            'changed.jpg': { sha: 'sha-v1', name: 'stme-changed.jpg' },
            'gone.jpg': { sha: 'x', name: 'stme-gone.jpg' },
        },
        existing: ['stme-same.jpg', 'stme-changed.jpg', 'stme-gone.jpg', 'my-own-background.jpg'],
    });
    assert.deepEqual(plan.install.map(item => [item.path, item.reason]), [['new.jpg', 'new'], ['changed.jpg', 'changed']]);
    assert.deepEqual(plan.remove.map(item => item.name), ['stme-gone.jpg']);
    assert.deepEqual(plan.skipped.map(item => item.path), ['huge.mp4']);
    assert.equal(plan.remove.some(item => item.name === 'my-own-background.jpg'), false, 'a user\'s own background is never touched');
});

test('a background the user deleted by hand is not brought back until it changes in the repository', () => {
    const args = { tree: [blob('a.jpg')], installed: { 'a.jpg': { sha: 'sha-a.jpg', name: 'stme-a.jpg' } }, existing: [] };
    const first = planBackgroundSync(args);
    assert.equal(first.install.length, 0);
    assert.deepEqual(first.markUserRemoved, ['a.jpg']);
    const second = planBackgroundSync({ ...args, installed: { 'a.jpg': { sha: 'sha-a.jpg', name: 'stme-a.jpg', userRemoved: true } } });
    assert.equal(second.install.length, 0);
    const changed = planBackgroundSync({ ...args, tree: [{ ...blob('a.jpg'), sha: 'sha-new' }], installed: { 'a.jpg': { sha: 'sha-a.jpg', name: 'stme-a.jpg', userRemoved: true } } });
    assert.equal(changed.install.length, 1, 'a changed file is offered again');
});

test('removeDeleted: false leaves everything we installed in place', () => {
    const plan = planBackgroundSync({ tree: [], installed: { 'gone.jpg': { sha: 'x', name: 'stme-gone.jpg' } }, existing: ['stme-gone.jpg'], removeDeleted: false });
    assert.equal(plan.remove.length, 0);
});

// ── Ядро: весь ход на фейковых сетях ──────────────────────────────────────────

function buildCore({ treeResponse, existing = [], failUpload = false }) {
    const engine = createEngine();
    const stored = new Map();
    engine.buses.cores.register('storage.settings.get', ({ namespace, key, fallback }) => stored.get(`${namespace}/${key}`) ?? fallback);
    engine.buses.cores.register('storage.settings.set', ({ namespace, key, value }) => { stored.set(`${namespace}/${key}`, JSON.parse(JSON.stringify(value))); return true; });
    const uploads = [];
    const deletes = [];
    let refreshes = 0;
    engine.buses.services.register('stBackgrounds.list', () => existing);
    engine.buses.services.register('stBackgrounds.upload', ({ name }) => { if (failUpload) throw new Error('upload refused'); uploads.push(name); return 'ok'; });
    engine.buses.services.register('stBackgrounds.delete', ({ name }) => { deletes.push(name); return true; });
    engine.buses.services.register('stBackgrounds.refresh', () => { refreshes += 1; return true; });
    const requested = [];
    engine.buses.network.register('http.request', ({ url, headers }) => {
        requested.push({ url, headers });
        if (url.includes('/git/trees/')) return treeResponse(headers);
        return { status: 200, ok: true, blob: { size: 10 } };
    });
    const events = [];
    const core = createBackgroundsCore(engine.registerCaller('core.backgrounds', 'cores', { tier: 'official', networkAccess: true }), {
        owner: 'o', repo: 'r', log: { info() {}, warn() {} }, publish: (event, payload) => events.push([event, payload]),
    });
    return { core, uploads, deletes, requested, events, stored, refreshes: () => refreshes };
}

const okTree = tree => () => ({ status: 200, ok: true, text: JSON.stringify({ tree }), headers: { etag: 'W/"1"' } });

test('the core installs new files from the repository through the ST upload, refreshes the list once, and remembers them', async () => {
    const ctx = buildCore({ treeResponse: okTree([blob('Rooms/a.jpg'), blob('b.png'), blob('README.md')]) });
    const result = await ctx.core.sync();
    assert.equal(result.outcome, 'synced');
    assert.deepEqual(ctx.uploads.sort(), ['stme-Rooms-a.jpg', 'stme-b.png']);
    assert.equal(ctx.refreshes(), 1);
    assert.ok(ctx.requested.some(r => r.url === 'https://raw.githubusercontent.com/o/r/HEAD/Rooms/a.jpg'));
    assert.equal(ctx.events.at(-1)[0], 'backgrounds.synced');
    const status = await ctx.core.status();
    assert.equal(status.installedCount, 2);

    // Повторный ход: ничего нового — ничего не скачивается и не грузится.
    ctx.uploads.length = 0;
    const again = await ctx.core.sync({ force: true });
    assert.equal(again.installed, 0);
    assert.equal(ctx.uploads.length, 0);
});

test('an unchanged repository (HTTP 304 on the stored ETag) costs one request and nothing else', async () => {
    let call = 0;
    const ctx = buildCore({ treeResponse: headers => (call++ === 0 ? okTree([blob('a.jpg')])() : (assert.equal(headers['If-None-Match'], 'W/"1"'), { status: 304, ok: false, text: '', headers: {} })) });
    await ctx.core.sync();
    const second = await ctx.core.sync();
    assert.equal(second.outcome, 'unchanged');
});

test('an empty repository, a network failure and a refused upload are all quiet — the run ends without throwing', async () => {
    const empty = await buildCore({ treeResponse: () => ({ status: 409, ok: false, text: '', headers: {} }) }).core.sync();
    assert.equal(empty.outcome, 'empty');
    const down = await buildCore({ treeResponse: () => ({ status: 500, ok: false, text: '', headers: {} }) }).core.sync();
    assert.equal(down.outcome, 'unavailable');
    const refused = buildCore({ treeResponse: okTree([blob('a.jpg')]), failUpload: true });
    const result = await refused.core.sync();
    assert.equal(result.failed, 1);
    assert.equal((await refused.core.status()).installedCount, 0, 'a failed file is not recorded, so it is retried next time');
});

test('a file removed from the repository disappears from ST, but only if it was installed by us', async () => {
    const ctx = buildCore({ treeResponse: okTree([blob('keep.jpg')]), existing: ['stme-old.jpg', 'my-own.jpg'] });
    ctx.stored.set('core.backgrounds/state', { enabled: true, removeDeleted: true, etag: null, installed: { 'old.jpg': { sha: 'x', name: 'stme-old.jpg' } } });
    await ctx.core.sync();
    assert.deepEqual(ctx.deletes, ['stme-old.jpg']);
});

test('turning auto-install off stops the startup sync but not an explicit "Sync now"', async () => {
    const ctx = buildCore({ treeResponse: okTree([blob('a.jpg')]) });
    await ctx.core.setSettings({ enabled: false });
    assert.equal((await ctx.core.sync()).outcome, 'disabled');
    assert.equal((await ctx.core.sync({ force: true })).outcome, 'synced');
});
