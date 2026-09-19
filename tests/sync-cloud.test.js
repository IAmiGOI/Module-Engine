import test from 'node:test';
import assert from 'node:assert/strict';
import { blobNameFor, CloudConflictError, createAuthedHttp, createCloudRemote, createDriveStore, createDropboxStore, describeCloudFailure, INDEX_NAME } from '../libraries/core/sync-cloud.js';
import { runSync } from '../libraries/core/sync-runner.js';
import { computeGitBlobSha } from '../libraries/core/content-hash.js';
import { createFakeDrive, createFakeDropbox } from './helpers/fake-cloud.js';

const providers = [
    ['dropbox', createFakeDropbox, createDropboxStore],
    ['google', createFakeDrive, createDriveStore],
];

const passthrough = { accessToken: async () => 'T', forceRefresh: async () => 'T' };

function localSide(initial = {}) {
    const files = new Map(Object.entries(initial));
    return {
        files,
        async manifest() { const out = {}; for (const [path, text] of files) out[path] = { hash: await computeGitBlobSha(new TextEncoder().encode(text)), size: text.length, modified: 1 }; return out; },
        async read(path) { return new Blob([files.get(path)]); },
        async write(path, blob) { files.set(path, await blob.text()); },
        async remove(path) { files.delete(path); },
    };
}

for (const [name, createFake, createStore] of providers) {
    const build = () => {
        const fake = createFake();
        const store = createStore({ http: createAuthedHttp({ http: fake.http, tokens: passthrough }) });
        return { fake, store, remote: () => createCloudRemote({ store: createStore({ http: createAuthedHttp({ http: fake.http, tokens: passthrough }) }) }) };
    };

    test(`[${name}] a first sync uploads files and one index, and a second device downloads them`, async () => {
        const { fake, remote } = build();
        const one = localSide({ 'backgrounds/a.png': 'AAA', 'chats/Alice/one.jsonl': 'line1\nline2' });
        const first = await runSync({ local: one, remote: remote(), base: {} });
        assert.equal(first.ok, true, JSON.stringify(first.errors));
        assert.equal(first.counts.pushed, 2);
        assert.equal(fake.names().length, 3, 'two files plus the index');
        assert.ok(fake.names().some(item => item.includes(INDEX_NAME)));

        const two = localSide();
        const second = await runSync({ local: two, remote: remote(), base: {} });
        assert.equal(second.counts.pulled, 2);
        assert.equal(two.files.get('chats/Alice/one.jsonl'), 'line1\nline2');
    });

    test(`[${name}] a repeat pass uploads nothing, and only the changed file moves after an edit`, async () => {
        const { fake, remote } = build();
        const local = localSide({ 'a': '1', 'b': '2' });
        const first = await runSync({ local, remote: remote(), base: {} });
        fake.calls.length = 0;
        const second = await runSync({ local, remote: remote(), base: first.base });
        assert.equal(second.counts.pushed + second.counts.pulled, 0);
        assert.equal(fake.calls.some(call => /upload/.test(call) && !/^GET/.test(call)), false, 'no uploads');

        local.files.set('b', '2-edited');
        fake.calls.length = 0;
        const third = await runSync({ local, remote: remote(), base: second.base });
        assert.equal(third.counts.pushed, 1);
        assert.equal(fake.calls.filter(call => /upload/.test(call) && !call.startsWith('GET')).length, 2, 'one changed file + the index');
    });

    test(`[${name}] a deletion removes the file's data and its index entry`, async () => {
        const { fake, remote } = build();
        const local = localSide({ 'gone': 'x', 'stay': 'y' });
        const first = await runSync({ local, remote: remote(), base: {} });
        local.files.delete('gone');
        const second = await runSync({ local, remote: remote(), base: first.base });
        assert.equal(second.counts.deletedRemote, 1);
        assert.equal(fake.names().length, 2, 'the stay file and the index remain');
        const manifest = await remote().manifest();
        assert.deepEqual(Object.keys(manifest), ['stay']);
    });

    test(`[${name}] if another device changes the index during a commit, the commit re-reads, merges and retries`, async () => {
        const { fake, remote, store } = build();
        const local = localSide({ 'mine': 'M' });
        const cloud = remote();
        await cloud.manifest();
        // Другое устройство успевает записать свой файл и обновить индекс между нашим чтением и записью.
        const otherRemote = createCloudRemote({ store: createStore({ http: createAuthedHttp({ http: fake.http, tokens: passthrough }) }) });
        fake.beforeUpload.push(async () => {});   // первая загрузка нашего файла — без помех
        await cloud.write('mine', await local.read('mine'), { hash: await computeGitBlobSha(new TextEncoder().encode('M')), modified: 5 });
        await otherRemote.manifest();
        await otherRemote.write('theirs', new Blob(['T']), { hash: 'h-theirs', modified: 6 });
        await otherRemote.commit();
        await cloud.commit();   // наш индекс устарел: конфликт → повтор с слиянием
        const merged = await remote().manifest();
        assert.deepEqual(Object.keys(merged).sort(), ['mine', 'theirs'], 'nothing the other device wrote was lost');
        void store;
    });

    test(`[${name}] a file above the size cap is refused, and a missing data file is a clear error`, async () => {
        const { fake, store } = build();
        const capped = createCloudRemote({ store, maxFileBytes: 3 });
        await capped.manifest();
        await assert.rejects(capped.write('big', new Blob(['0123456789']), { hash: 'h' }), /larger than/);
        assert.equal(fake.names().length, 0);
        const remote = createCloudRemote({ store });
        await remote.manifest();
        await remote.write('x', new Blob(['1']), { hash: 'h' });
        await remote.commit();
        for (const key of [...fake.files.keys()]) { const label = name === 'dropbox' ? key : key; if (!String(label).includes('index')) fake.files.delete(key); }
        const reader = createCloudRemote({ store: createStore({ http: createAuthedHttp({ http: fake.http, tokens: passthrough }) }) });
        await reader.manifest();
        await assert.rejects(reader.read('x'), /data is missing|missing/);
    });
}

test('an expired token is refreshed once and the request is repeated', async () => {
    let good = 'NEW';
    const fake = createFakeDropbox({ validToken: token => token === good });
    let refreshed = 0;
    const tokens = { accessToken: async () => 'OLD', forceRefresh: async () => { refreshed += 1; return good; } };
    const store = createDropboxStore({ http: createAuthedHttp({ http: fake.http, tokens }) });
    await store.writeBlob('x', new Blob(['1']));
    assert.equal(refreshed, 1);
    assert.equal(fake.names().length, 1);
});

test('a refused sign-in after the refresh is reported, not retried forever', async () => {
    const fake = createFakeDropbox({ validToken: () => false });
    const store = createDropboxStore({ http: createAuthedHttp({ http: fake.http, tokens: { accessToken: async () => 'a', forceRefresh: async () => 'b' } }) });
    await assert.rejects(store.writeBlob('x', new Blob(['1'])), /connect the account again/);
});

test('names for files depend only on the path, so both devices find the same data', async () => {
    assert.equal(await blobNameFor('chats/Алиса/файл.jsonl'), await blobNameFor('chats/Алиса/файл.jsonl'));
    assert.notEqual(await blobNameFor('a'), await blobNameFor('b'));
    assert.match(await blobNameFor('a'), /^b-[0-9a-f]{40}$/);
});

test('failures are described in plain words for both providers', () => {
    assert.match(describeCloudFailure('dropbox', 401), /Dropbox rejected the sign-in/);
    assert.match(describeCloudFailure('google', 403, JSON.stringify({ error: { message: 'no scope' } })), /Google Drive refused access.*no scope/);
    assert.match(describeCloudFailure('google', 429), /rate-limiting/);
    assert.match(describeCloudFailure('dropbox', 409, JSON.stringify({ error_summary: 'insufficient_space/..' })), /Dropbox is full/);
    assert.equal(new CloudConflictError().code, 'conflict');
});

test('a full Google Drive stops the pass with ONE readable message (no doubled full stop) and keeps what was uploaded', async () => {
    const fake = createFakeDrive();
    let uploads = 0;
    const http = async request => {
        if (request.method === 'POST' && request.url.includes('/upload/drive/v3/files') && request.url.includes('multipart')) {
            uploads += 1;
            if (uploads >= 3) return { status: 403, ok: false, text: JSON.stringify({ error: { code: 403, message: "The user's Drive storage quota has been exceeded.", errors: [{ reason: 'storageQuotaExceeded' }] } }), headers: {} };
        }
        return fake.http(request);
    };
    const store = createDriveStore({ http: createAuthedHttp({ http, tokens: passthrough }) });
    const local = localSide(Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`f${index}`, `data ${index}`])));
    const result = await runSync({ local, remote: createCloudRemote({ store }), base: {} });
    assert.equal(result.ok, false);
    assert.ok(result.stopped, 'the pass was stopped');
    assert.match(result.errors[0].message, /Google Drive is full/);
    assert.doesNotMatch(result.errors[0].message, /\.\./);
    assert.equal(result.errors.length, 1);
    assert.ok(result.stopped.remaining >= 4, 'the remaining files were not tried');
    assert.ok(uploads <= 4, `only a few uploads were attempted, not one per file (got ${uploads})`);
});

test('quota and rate-limit refusals are fatal, ordinary and missing-file ones are not', async () => {
    const { isFatalError, isFatalHttpStatus } = await import('../libraries/core/sync-errors.js');
    for (const status of [401, 403, 429, 507]) assert.equal(isFatalHttpStatus(status), true, String(status));
    for (const status of [400, 404, 409, 500]) assert.equal(isFatalHttpStatus(status), false, String(status));
    const store = createDropboxStore({ http: async () => ({ status: 429, ok: false, text: '{}', headers: {} }) });
    await assert.rejects(store.writeBlob('x', new Blob(['1'])), error => isFatalError(error) && /rate-limiting/.test(error.message));
    assert.match(describeCloudFailure('dropbox', 409, JSON.stringify({ error_summary: 'insufficient_space/..' })), /is full/);
});

test('when the drive fills up mid-pass, the other device still sees everything up to the last checkpoint (not nothing)', async () => {
    const fake = createFakeDrive();
    let uploads = 0;
    const quota = { status: 403, ok: false, text: JSON.stringify({ error: { message: 'quota', errors: [{ reason: 'storageQuotaExceeded' }] } }), headers: {} };
    const http = async request => {
        if (request.method !== 'GET' && /upload\/drive/.test(request.url)) { uploads += 1; if (uploads > 60) return quota; }
        return fake.http(request);
    };
    const remoteOf = h => createCloudRemote({ store: createDriveStore({ http: createAuthedHttp({ http: h, tokens: passthrough }) }) });
    const local = localSide(Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`f${index}`, `data ${index}`])));
    const result = await runSync({ local, remote: remoteOf(http), base: {} });
    assert.ok(result.stopped, 'the pass stopped on the refusal');
    const seenByPhone = await remoteOf(fake.http).manifest();
    assert.equal(Object.keys(seenByPhone).length, 50, 'the two checkpoints (25 + 25) are visible to the other device');
    assert.equal(Object.keys(result.base).length, 50, 'and the first device remembers exactly those as synced');

    // Место освободили — следующий проход докладывает остальное, ничего не задваивая.
    const again = await runSync({ local, remote: remoteOf(fake.http), base: result.base });
    assert.equal(again.ok, true, JSON.stringify(again.errors));
    assert.equal(Object.keys(await remoteOf(fake.http).manifest()).length, 120);
    const phone = localSide();
    const phonePass = await runSync({ local: phone, remote: remoteOf(fake.http), base: {} });
    assert.equal(phonePass.counts.pulled, 120);
    assert.equal(phone.files.get('f119'), 'data 119');
});
