import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, isValidSnapshot, resolveSnapshotSources } from '../libraries/core/backup-snapshot.js';

test('buildSnapshot() combines several source entries into one object keyed by source id, with a version and a timestamp', () => {
    const before = Date.now();
    const snapshot = buildSnapshot([{ id: 'chatMemory', raw: { a: 1 } }, { id: 'settings', raw: { b: 2 } }]);

    assert.equal(snapshot.version, 1);
    assert.ok(snapshot.createdAt >= before);
    assert.deepEqual(snapshot.sources, { chatMemory: { a: 1 }, settings: { b: 2 } });
});

test('buildSnapshot() with no sources still produces a valid, empty snapshot — not an error', () => {
    const snapshot = buildSnapshot([]);

    assert.deepEqual(snapshot.sources, {});
    assert.equal(isValidSnapshot(snapshot), true);
});

test('isValidSnapshot() rejects anything that isn\'t an object with a "sources" object, regardless of "version"', () => {
    assert.equal(isValidSnapshot(null), false);
    assert.equal(isValidSnapshot(undefined), false);
    assert.equal(isValidSnapshot('not an object'), false);
    assert.equal(isValidSnapshot({}), false, 'missing "sources" entirely');
    assert.equal(isValidSnapshot({ sources: 'not an object' }), false);
    assert.equal(isValidSnapshot({ version: 999, sources: {} }), true, 'an unknown version is still shape-valid — version handling is a future concern, not this predicate\'s job');
});

test('resolveSnapshotSources() returns the real sources object for a valid snapshot', () => {
    const snapshot = buildSnapshot([{ id: 'chatMemory', raw: { a: 1 } }]);

    assert.deepEqual(resolveSnapshotSources(snapshot), { chatMemory: { a: 1 } });
});

test('resolveSnapshotSources() returns {} for a malformed/garbage snapshot rather than throwing', () => {
    assert.deepEqual(resolveSnapshotSources(null), {});
    assert.deepEqual(resolveSnapshotSources('garbage'), {});
    assert.deepEqual(resolveSnapshotSources({}), {});
});
