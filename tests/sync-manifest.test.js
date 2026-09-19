import test from 'node:test';
import assert from 'node:assert/strict';
import { buildManifest, rememberWrite } from '../libraries/core/sync-manifest.js';

const hasher = async blob => `h(${await blob.text()})`;

test('files with an unchanged stamp are never read again — their hash comes from the cache', async () => {
    const reads = [];
    const result = await buildManifest({
        listing: [{ path: 'a', stamp: 's1', size: 1, modified: 10 }, { path: 'b', stamp: 's2', size: 1, modified: 20 }],
        cache: { a: { stamp: 's1', hash: 'cached-a' }, b: { stamp: 'OLD', hash: 'cached-b' } },
        read: async path => { reads.push(path); return new Blob([`content-${path}`]); },
        hash: hasher,
    });
    assert.deepEqual(reads, ['b']);
    assert.equal(result.manifest.a.hash, 'cached-a');
    assert.equal(result.manifest.b.hash, 'h(content-b)');
    assert.deepEqual(result.cache, { a: { stamp: 's1', hash: 'cached-a' }, b: { stamp: 's2', hash: 'h(content-b)' } });
    assert.equal(result.hashed, 1);
});

test('a file that disappeared from the listing also disappears from the cache', async () => {
    const result = await buildManifest({ listing: [], cache: { gone: { stamp: 's', hash: 'h' } }, read: async () => new Blob(['']), hash: hasher });
    assert.deepEqual(result.cache, {});
    assert.deepEqual(result.manifest, {});
});

test('one unreadable file is reported and left out of the manifest, the rest carry on', async () => {
    const result = await buildManifest({
        listing: [{ path: 'bad', stamp: '1' }, { path: 'good', stamp: '2' }],
        read: async path => { if (path === 'bad') throw new Error('HTTP 500'); return new Blob(['x']); },
        hash: hasher,
    });
    assert.deepEqual(Object.keys(result.manifest), ['good']);
    assert.deepEqual(result.failed, [{ path: 'bad', message: 'HTTP 500' }]);
});

test('progress counts only the files that actually need hashing', async () => {
    const seen = [];
    await buildManifest({
        listing: [{ path: 'a', stamp: '1' }, { path: 'b', stamp: '2' }, { path: 'c', stamp: '3' }],
        cache: { a: { stamp: '1', hash: 'x' } },
        read: async () => new Blob(['z']), hash: hasher,
        onProgress: state => seen.push(`${state.done}/${state.total}`),
    });
    assert.deepEqual(seen, ['0/2', '1/2']);
});

test('a written file can be remembered under its new stamp', () => {
    assert.deepEqual(rememberWrite({ a: { stamp: '1', hash: 'x' } }, 'b', 's', 'h'), { a: { stamp: '1', hash: 'x' }, b: { stamp: 's', hash: 'h' } });
});

test('a null stamp means always re-read and is never cached', async () => {
    const reads = [];
    const args = { listing: [{ path: 'world', stamp: null }], cache: {}, read: async path => { reads.push(path); return new Blob(['v']); }, hash: hasher };
    const first = await buildManifest(args);
    assert.deepEqual(first.cache, {});
    await buildManifest({ ...args, cache: { world: { stamp: null, hash: 'stale' } } });
    assert.deepEqual(reads, ['world', 'world']);
});
