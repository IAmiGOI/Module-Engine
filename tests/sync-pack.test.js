import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPack, COLD_AGE_MS, gunzip, gzip, isCompressible, isPackable, maybeCompress, packGroupOf, parsePack, sliceFromPack } from '../libraries/core/sync-pack.js';
import { blobNameFor, compressedNameFor, createAuthedHttp, createCloudRemote, createDriveStore, createDropboxStore, INDEX_NAME } from '../libraries/core/sync-cloud.js';
import { runSync } from '../libraries/core/sync-runner.js';
import { computeGitBlobSha } from '../libraries/core/content-hash.js';
import { createFakeDrive, createFakeDropbox } from './helpers/fake-cloud.js';

const enc = text => new TextEncoder().encode(text);
const chatText = (seed, lines = 60) => Array.from({ length: lines }, (_, index) => JSON.stringify({ name: index % 2 ? 'Alex' : 'You', is_user: index % 2 === 0, mes: `message ${seed} number ${index}: the quick brown fox jumps over the lazy dog, again and again`, send_date: '2026-01-01' })).join('\n');

test('only text is compressed: chats, lorebooks, presets yes; cards, images, tiny files no', () => {
    assert.equal(isCompressible('chats/Alex/a.jsonl', 5000), true);
    assert.equal(isCompressible('worlds/book.json', 5000), true);
    assert.equal(isCompressible('stmeSettings/x.json', 5000), true);
    assert.equal(isCompressible('characters/Alex.png', 5000000), false, 'a card is a PNG: 84% of it is the already-compressed picture');
    assert.equal(isCompressible('backgrounds/sky.png', 5000), false);
    assert.equal(isCompressible('chats/Alex/a.jsonl', 100), false, 'a gzip header would eat the gain');
});

test('gzip round-trips bytes exactly, and compressed text is several times smaller', async () => {
    const original = enc(chatText('a', 400));
    const packed = await gzip(original);
    assert.ok(packed.length < original.length / 3, `ratio ${(packed.length / original.length).toFixed(2)}`);
    assert.deepEqual([...await gunzip(packed)], [...original]);
});

test('maybeCompress keeps the original when compression does not pay (random data) and for non-text paths', async () => {
    const random = crypto.getRandomValues(new Uint8Array(4000));
    assert.equal((await maybeCompress('chats/Alex/noise.jsonl', random)).compressed, false);
    assert.equal((await maybeCompress('characters/Alex.png', enc(chatText('p', 400)))).compressed, false);
    const text = await maybeCompress('chats/Alex/a.jsonl', enc(chatText('c', 400)));
    assert.equal(text.compressed, true);
});

test('only OLD chats of a character are pack candidates', () => {
    const now = 1_800_000_000_000;
    assert.equal(isPackable('chats/Alex/a.jsonl', { modified: now - COLD_AGE_MS - 1, size: 5000, now }), true);
    assert.equal(isPackable('chats/Alex/a.jsonl', { modified: now - 1000, size: 5000, now }), false, 'a recent chat stays an individual file');
    assert.equal(isPackable('groupChats/g.jsonl', { modified: 1, size: 5000, now }), false);
    assert.equal(isPackable('characters/Alex.png', { modified: 1, size: 5000, now }), false, 'cards are never packed: the bytes do not shrink and one card would cost a whole block');
    assert.equal(isPackable('chats/Alex/a.jsonl', { modified: 0, size: 5000, now }), false, 'unknown age is not old');
    assert.equal(packGroupOf('chats/Alex/a.jsonl'), 'chats/Alex');
});

test('a pack is self-describing: every member comes back byte for byte, and damage is reported', async () => {
    const members = [{ path: 'chats/Alex/a.jsonl', bytes: enc(chatText('a')) }, { path: 'chats/Alex/b.jsonl', bytes: enc(chatText('b')) }, { path: 'chats/Alex/empty.jsonl', bytes: new Uint8Array(0) }];
    const built = await buildPack(members);
    const parsed = await parsePack(built.bytes);
    for (const member of members) assert.deepEqual([...sliceFromPack(parsed, member.path)], [...member.bytes]);
    assert.throws(() => sliceFromPack(parsed, 'chats/Alex/none.jsonl'), /not inside/);
    await assert.rejects(() => parsePack(built.bytes.subarray(0, 20)));
});

// ── Облачная сторона ─────────────────────────────────────────────────────────────────────────────────────────────

const passthrough = { accessToken: async () => 'T', forceRefresh: async () => 'T' };
const NOW = 1_800_000_000_000;
const OLD = NOW - COLD_AGE_MS - 86_400_000;

function side(initial = {}) {
    const files = new Map(Object.entries(initial).map(([path, value]) => [path, typeof value === 'string' ? { text: value, modified: OLD } : value]));
    return {
        files,
        async manifest() { const out = {}; for (const [path, { text, modified }] of files) out[path] = { hash: await computeGitBlobSha(enc(text)), size: text.length, modified }; return out; },
        async read(path) { return new Blob([files.get(path).text]); },
        async write(path, blob, meta) { files.set(path, { text: await blob.text(), modified: meta?.modified ?? OLD }); },
        async remove(path) { files.delete(path); },
    };
}

for (const [name, createFake, createStore] of [['dropbox', createFakeDropbox, createDropboxStore], ['google', createFakeDrive, createDriveStore]]) {
    const build = (packOptions) => {
        const fake = createFake();
        const reads = [];
        const makeStore = () => {
            const store = createStore({ http: createAuthedHttp({ http: fake.http, tokens: passthrough }) });
            const readBlob = store.readBlob;
            store.readBlob = async blobName => { reads.push(blobName); return readBlob(blobName); };
            return store;
        };
        return { fake, reads, remote: () => createCloudRemote({ store: makeStore(), now: () => NOW, pack: packOptions }) };
    };
    const kinds = fake => ({ b: fake.names().filter(item => /\/?b-/.test(item) && !item.includes(INDEX_NAME)), z: fake.names().filter(item => /\/?z-/.test(item)), k: fake.names().filter(item => /\/?k-/.test(item)) });

    test(`[${name}] a recent text chat is stored compressed under a NEW name, and another device reads exactly the same bytes`, async () => {
        const { fake, remote } = build();
        const text = chatText('hot', 300);
        const one = side({ 'chats/Alex/new.jsonl': { text, modified: NOW - 1000 } });
        const first = await runSync({ local: one, remote: remote(), base: {} });
        assert.equal(first.ok, true, JSON.stringify(first.errors));
        const found = kinds(fake);
        assert.equal(found.z.length, 1);
        assert.equal(found.k.length, 0, 'a recent chat is not packed');
        assert.equal(found.b.length, 0, 'nothing under the old name: a device without this version cannot mistake compressed bytes for the chat');
        const stored = fake.names().length;
        assert.ok(stored > 0);
        const two = side({});
        const second = await runSync({ local: two, remote: remote(), base: {} });
        assert.equal(second.counts.pulled, 1);
        assert.equal(two.files.get('chats/Alex/new.jsonl').text, text);
    });

    test(`[${name}] a card (PNG) is never compressed or packed: it stays under the old name, byte for byte`, async () => {
        const { fake, remote } = build();
        const card = 'PNGDATA'.repeat(2000);
        const one = side({ 'characters/Alex.png': { text: card, modified: OLD } });
        await runSync({ local: one, remote: remote(), base: {} });
        const found = kinds(fake);
        assert.deepEqual([found.b.length, found.z.length, found.k.length], [1, 0, 0]);
        const two = side({});
        await runSync({ local: two, remote: remote(), base: {} });
        assert.equal(two.files.get('characters/Alex.png').text, card);
    });

    test(`[${name}] old chats of one character travel as ONE pack, and a new device downloads that pack once for all of them`, async () => {
        const { fake, reads, remote } = build();
        const chats = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`chats/Alex/old${index}.jsonl`, { text: chatText(`old${index}`, 80), modified: OLD }]));
        chats['chats/Bea/solo.jsonl'] = { text: chatText('solo', 80), modified: OLD };
        const one = side(chats);
        const first = await runSync({ local: one, remote: remote(), base: {} });
        assert.equal(first.ok, true, JSON.stringify(first.errors));
        const found = kinds(fake);
        assert.equal(found.k.length, 1, 'twelve old chats of Alex are a single block');
        assert.equal(found.z.length, 1, 'one lone old chat of Bea is just a compressed file');
        const two = side({});
        reads.length = 0;
        const second = await runSync({ local: two, remote: remote(), base: {}, concurrency: 6 });
        assert.equal(second.ok, true, JSON.stringify(second.errors));
        assert.equal(second.counts.pulled, 13);
        assert.equal(reads.filter(blobName => blobName.startsWith('k-')).length, 1, 'the block is downloaded once, however many chats are taken from it');
        for (const [path, { text }] of Object.entries(chats)) assert.equal(two.files.get(path).text, text);
    });

    test(`[${name}] a packed chat that is edited later becomes its own file, and a block nobody uses any more is deleted`, async () => {
        const { fake, remote } = build();
        const paths = Array.from({ length: 4 }, (_, index) => `chats/Alex/c${index}.jsonl`);
        const one = side(Object.fromEntries(paths.map(path => [path, { text: chatText(path), modified: OLD }])));
        const first = await runSync({ local: one, remote: remote(), base: {} });
        assert.equal(kinds(fake).k.length, 1);
        // One chat is continued today: it must not drag the whole block into a re-upload.
        one.files.set(paths[0], { text: `${chatText(paths[0])}\n${JSON.stringify({ mes: 'new today' })}`, modified: NOW - 5000 });
        const second = await runSync({ local: one, remote: remote(), base: first.base });
        assert.equal(second.counts.pushed, 1);
        assert.equal(kinds(fake).k.length, 1, 'the block is still needed by the other three');
        assert.equal(kinds(fake).z.length, 1, 'the edited chat is an individual compressed file');
        // The others are edited as well: nothing refers to the block, so it is cleaned up.
        let state = second.base;
        for (const path of paths.slice(1)) {
            one.files.set(path, { text: `${chatText(path)}\nedited`, modified: NOW - 4000 });
            const step = await runSync({ local: one, remote: remote(), base: state });
            state = step.base;
        }
        assert.equal(kinds(fake).k.length, 0, 'the unused block is deleted');
        const reader = side({});
        const read = await runSync({ local: reader, remote: remote(), base: {} });
        assert.equal(read.ok, true, JSON.stringify(read.errors));
        for (const path of paths) assert.equal(reader.files.get(path).text, one.files.get(path).text);
    });

    test(`[${name}] a deletion removes a compressed file's data too`, async () => {
        const { fake, remote } = build();
        const one = side({ 'chats/Alex/new.jsonl': { text: chatText('x', 200), modified: NOW - 1000 } });
        const first = await runSync({ local: one, remote: remote(), base: {} });
        assert.equal(kinds(fake).z.length, 1);
        one.files.clear();
        const second = await runSync({ local: one, remote: remote(), base: first.base, categoryOf: () => null });
        assert.equal(second.counts.deletedRemote, 1);
        assert.equal(kinds(fake).z.length, 0);
    });

    test(`[${name}] with a tiny memory budget the packs are built early and everything still arrives intact`, async () => {
        const { remote } = build({ maxBytes: 4000 });
        const chats = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`chats/Alex/m${index}.jsonl`, { text: chatText(`m${index}`, 60), modified: OLD }]));
        const one = side(chats);
        const first = await runSync({ local: one, remote: remote(), base: {} });
        assert.equal(first.ok, true, JSON.stringify(first.errors));
        const two = side({});
        const second = await runSync({ local: two, remote: remote(), base: {} });
        assert.equal(second.ok, true, JSON.stringify(second.errors));
        for (const [path, { text }] of Object.entries(chats)) assert.equal(two.files.get(path).text, text);
    });

    test(`[${name}] files uploaded by a version without compression are still read as before (a mixed cloud works)`, async () => {
        const { fake, remote } = build();
        const store = createStore({ http: createAuthedHttp({ http: fake.http, tokens: passthrough }) });
        // What an older version leaves: raw bytes under b-<sha(path)> and a plain index entry.
        const text = chatText('legacy', 100);
        await store.writeBlob(await blobNameFor('chats/Alex/legacy.jsonl'), new Blob([text]));
        await store.writeText(INDEX_NAME, JSON.stringify({ v: 1, files: { 'chats/Alex/legacy.jsonl': { h: await computeGitBlobSha(enc(text)), s: text.length, m: OLD } } }), { mustNotExist: true });
        const two = side({});
        const result = await runSync({ local: two, remote: remote(), base: {} });
        assert.equal(result.counts.pulled, 1);
        assert.equal(two.files.get('chats/Alex/legacy.jsonl').text, text);
    });

    test(`[${name}] an old version that finds nothing under the old name fails that one file instead of writing compressed bytes as a chat`, async () => {
        const { fake, remote } = build();
        const one = side({ 'chats/Alex/new.jsonl': { text: chatText('z', 200), modified: NOW - 1000 } });
        await runSync({ local: one, remote: remote(), base: {} });
        const store = createStore({ http: createAuthedHttp({ http: fake.http, tokens: passthrough }) });
        assert.equal(await store.readBlob(await blobNameFor('chats/Alex/new.jsonl')), null, 'nothing is stored under b-<path>');
        assert.notEqual(await store.readBlob(await compressedNameFor('chats/Alex/new.jsonl')), null);
    });
}
