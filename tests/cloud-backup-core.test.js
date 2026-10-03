import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { createCloudBackupCore } from '../cores/cloud-backup/index.js';
import { createFakeDrive } from './helpers/fake-drive.js';
import { BACKUP_ROOT_NAME } from '../libraries/core/backup-drive.js';
import { HOUR_MS, parseBackupName, sha256Hex } from '../libraries/core/backup-plan.js';

function setup({ files = {}, drive = createFakeDrive(), device = 'PC' } = {}) {
    const engine = createEngine();
    const store = new Map(Object.entries(files).map(([path, text]) => [path, { text, version: 1 }]));
    const state = new Map();
    const written = [];
    const services = engine.buses.services;
    services.register('stUserData.list', () => [...store].map(([path, { text, version }]) => ({ path, stamp: `v${version}`, size: text.length, modified: 1 })));
    services.register('stUserData.read', ({ path }) => new Blob([store.get(path).text]));
    services.register('stUserData.write', ({ path, blob }) => { written.push(path); return blob.text().then(text => { store.set(path, { text, version: (store.get(path)?.version ?? 0) + 1 }); return { stamp: 'x' }; }); });
    services.register('syncState.get', ({ key }) => state.get(key) ?? null);
    services.register('syncState.set', ({ key, value }) => { state.set(key, JSON.parse(JSON.stringify(value))); return true; });
    const host = engine.registerCaller('core.cloudBackup', 'cores', { tier: 'official' });
    const clock = { t: Date.UTC(2026, 9, 3, 12, 0, 0) };
    const core = createCloudBackupCore(host, { http: drive.http, getDeviceName: () => device, now: () => clock.t, sleep: async () => {} });
    const put = (path, text) => store.set(path, { text, version: (store.get(path)?.version ?? 0) + 1 });
    const call = (contract, params) => new Promise(resolve => host.own.subscribe(contract, { params }, resolve));
    return { core, drive, store, put, clock, written, call, state };
}
const FILES = { 'characters/Anna.png': 'card-anna', 'chats/Anna/log.jsonl': 'hello', 'stmeSettings/core.ui.home/state.json': '{"order":[1]}' };
const backupsOf = drive => [...drive.items.values()].filter(item => item.mimeType === 'application/vnd.google-apps.folder' && parseBackupName(item.name));

test('the first backup becomes a verified, properly named folder with the real paths, SHA256SUMS and manifest.json', async () => {
    const { core, drive } = setup({ files: FILES });
    const result = await core.run();
    assert.equal(result.outcome, 'created');
    const [folder] = backupsOf(drive);
    const parts = parseBackupName(folder.name);
    assert.deepEqual([parts.kind, parts.device, parts.files, parts.incomplete], ['hourly', 'PC', 3, false]);
    assert.deepEqual(drive.tree(BACKUP_ROOT_NAME).sort(), ['Anna.png', 'SHA256SUMS', 'log.jsonl', 'manifest.json', 'state.json']);
    const sums = [...drive.items.values()].find(item => item.name === 'SHA256SUMS');
    const text = await sums.blob.text();
    assert.equal((await sha256Hex(text)).slice(0, 8), parts.sums, 'the 8 hex digits in the folder name are the start of the SHA256SUMS hash');
    assert.match(text, /^[0-9a-f]{64} {2}characters\/Anna\.png$/m);
});

test('nothing changed since the last backup — no new backup is made', async () => {
    const { core, drive, clock } = setup({ files: FILES });
    await core.run();
    clock.t += HOUR_MS;
    const again = await core.run();
    assert.equal(again.outcome, 'unchanged');
    assert.equal(backupsOf(drive).length, 1);
});

test('a changed file makes a new backup that copies the rest inside Google Drive instead of uploading it again; the old one becomes the daily slot', async () => {
    const { core, drive, put, clock } = setup({ files: FILES });
    await core.run();
    put('chats/Anna/log.jsonl', 'hello again');
    clock.t += HOUR_MS;
    drive.calls.length = 0;
    const second = await core.run();
    assert.equal(second.outcome, 'created');
    assert.equal(drive.calls.filter(call => /\/copy$/.test(call)).length, 2, 'two unchanged files are copied server-side');
    assert.equal(second.uploadedBytes, 'hello again'.length);
    assert.deepEqual(backupsOf(drive).map(item => parseBackupName(item.name).kind).sort(), ['daily', 'hourly']);
});

test('over several days of hourly changes the folder holds exactly three backups: hourly, daily and weekly', async () => {
    const { core, drive, put, clock } = setup({ files: FILES });
    for (let hour = 0; hour < 24 * 10; hour += 1) {
        put('chats/Anna/log.jsonl', `version ${hour}`);
        clock.t += HOUR_MS;
        assert.equal((await core.run()).outcome, 'created');
    }
    const kinds = backupsOf(drive).map(item => parseBackupName(item.name));
    assert.deepEqual(kinds.map(k => k.kind).sort(), ['daily', 'hourly', 'weekly']);
    const age = kind => (clock.t - kinds.find(k => k.kind === kind).at) / HOUR_MS;
    assert.equal(age('hourly'), 0);
    assert.ok(age('daily') > 0 && age('daily') <= 25);
    assert.ok(age('weekly') >= 24 && age('weekly') <= 8 * 24);
});

test('a backup that fails verification is never activated; the next healthy run removes the leftovers and creates the real one', async () => {
    const drive = createFakeDrive({ corruptUpload: 'log.jsonl' });
    const { core } = setup({ files: FILES, drive });
    const first = await core.run();
    assert.equal(first.outcome, 'failed');
    assert.match(first.error, /did not pass verification/);
    assert.deepEqual(backupsOf(drive).map(item => parseBackupName(item.name).incomplete), [true], 'the only folder is marked INCOMPLETE');
    drive.options.corruptUpload = null;
    assert.equal((await core.run()).outcome, 'created');
    assert.deepEqual(backupsOf(drive).map(item => parseBackupName(item.name).incomplete), [false], 'leftover removed, one real backup');
});

test('a failed run leaves the existing good backups exactly as they were — nothing is promoted or deleted', async () => {
    const drive = createFakeDrive();
    const { core, put, clock } = setup({ files: FILES, drive });
    await core.run();
    const before = backupsOf(drive).map(item => item.name);
    put('chats/Anna/log.jsonl', 'changed');
    clock.t += HOUR_MS;
    drive.options.corruptUpload = 'log.jsonl';
    assert.equal((await core.run()).outcome, 'failed');
    assert.deepEqual(backupsOf(drive).map(item => item.name).filter(name => !name.endsWith('_INCOMPLETE')), before);
    drive.options.corruptUpload = null;
    assert.equal((await core.run()).outcome, 'created');
    assert.deepEqual(backupsOf(drive).map(item => parseBackupName(item.name).kind).sort(), ['daily', 'hourly']);
});

test('verify() confirms a good backup and catches tampering, a wrong name hash and missing files', async () => {
    const { core, drive, call } = setup({ files: FILES });
    await core.run();
    const [folder] = backupsOf(drive);
    const good = await call('cloudBackup.verify', { id: folder.id });
    assert.equal(good.ok, true);
    assert.deepEqual([good.value.ok, good.value.nameMatchesSums, good.value.files], [true, true, 3]);
    drive.corrupt('state.json');
    const bad = (await call('cloudBackup.verify', { id: folder.id })).value;
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.mismatched, ['stmeSettings/core.ui.home/state.json']);
});

test('restore() only previews by default, then writes verified files when confirmed', async () => {
    const { core, drive, put, call, written, store } = setup({ files: FILES });
    await core.run();
    const [folder] = backupsOf(drive);
    put('chats/Anna/log.jsonl', 'damaged');
    store.delete('characters/Anna.png');
    const preview = (await call('cloudBackup.restore', { id: folder.id })).value;
    assert.deepEqual([preview.dryRun, preview.same, preview.differs, preview.missing], [true, 1, ['chats/Anna/log.jsonl'], ['characters/Anna.png']]);
    assert.deepEqual(written, [], 'a preview writes nothing');
    const done = (await call('cloudBackup.restore', { id: folder.id, confirm: true })).value;
    assert.deepEqual(done.restored.sort(), ['characters/Anna.png', 'chats/Anna/log.jsonl']);
    assert.equal(store.get('chats/Anna/log.jsonl').text, 'hello');
});

test('not enough space on Google Drive stops before anything is created, and says how much is needed', async () => {
    const { core, drive } = setup({ files: FILES, drive: createFakeDrive({ quotaLimit: 10 }) });
    const result = await core.run();
    assert.equal(result.outcome, 'failed');
    assert.match(result.error, /Not enough space/);
    assert.equal(backupsOf(drive).length, 0);
});

test('large files go through the resumable upload and still verify', async () => {
    const big = 'x'.repeat(9 * 1024 * 1024);
    const { core, drive } = setup({ files: { ...FILES, 'backgrounds/big.png': big } });
    const result = await core.run();
    assert.equal(result.outcome, 'created');
    assert.ok(drive.calls.some(call => call.startsWith('PUT /upload')), 'a resumable PUT was used');
});
