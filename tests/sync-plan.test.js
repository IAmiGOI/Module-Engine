import test from 'node:test';
import assert from 'node:assert/strict';
import { computeConflictPath, computeSyncPlan, isConflictCopy, resolveBaseHashes } from '../libraries/core/sync-plan.js';
import { computeGitBlobSha } from '../libraries/core/content-hash.js';

const file = (hash, modified = 0, size = 10) => ({ hash, modified, size });
const opsOf = plan => plan.actions.map(action => `${action.op}:${action.path}`);

test('the git blob hash matches what git itself computes, so it equals the GitHub blob sha', async () => {
    assert.equal(await computeGitBlobSha(new TextEncoder().encode('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
    assert.equal(await computeGitBlobSha(new Uint8Array(0)), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
    assert.equal(await computeGitBlobSha(new Blob(['hello\n'])), 'ce013625030ba8dba906f756967f9e9ca394464a');
});

test('identical files on both sides need no transfer, only the base is remembered', () => {
    const plan = computeSyncPlan({ local: { 'a.png': file('h1') }, remote: { 'a.png': file('h1') }, base: {} });
    assert.deepEqual(opsOf(plan), ['settle:a.png']);
    const settled = computeSyncPlan({ local: { 'a.png': file('h1') }, remote: { 'a.png': file('h1') }, base: { 'a.png': 'h1' } });
    assert.equal(settled.actions.length, 0);
});

test('a file changed only here is pushed, a file changed only there is pulled', () => {
    const plan = computeSyncPlan({
        local: { 'mine.json': file('h2'), 'theirs.json': file('t1') },
        remote: { 'mine.json': file('h1'), 'theirs.json': file('t2') },
        base: { 'mine.json': 'h1', 'theirs.json': 't1' },
    });
    assert.deepEqual(opsOf(plan), ['push:mine.json', 'pull:theirs.json']);
});

test('a brand-new file on one side is copied to the other', () => {
    const plan = computeSyncPlan({ local: { 'new-here.png': file('a') }, remote: { 'new-there.png': file('b') }, base: {} });
    assert.deepEqual(opsOf(plan), ['push:new-here.png', 'pull:new-there.png']);
});

test('deleting a file on one side deletes it on the other only when the other side has not changed it since the last sync', () => {
    const plan = computeSyncPlan({
        local: {},
        remote: { 'old.png': file('h1') },
        base: { 'old.png': 'h1' },
    });
    assert.deepEqual(opsOf(plan), ['deleteRemote:old.png']);
    const reverse = computeSyncPlan({ local: { 'old.png': file('h1') }, remote: {}, base: { 'old.png': 'h1' } });
    assert.deepEqual(opsOf(reverse), ['deleteLocal:old.png']);
});

test('a deletion never beats an edit made on the other side — the edited file comes back instead of being lost', () => {
    const plan = computeSyncPlan({ local: {}, remote: { 'chat.jsonl': file('edited') }, base: { 'chat.jsonl': 'original' } });
    assert.deepEqual(opsOf(plan), ['pull:chat.jsonl']);
    assert.equal(plan.actions[0].restored, true);
    const reverse = computeSyncPlan({ local: { 'chat.jsonl': file('edited') }, remote: {}, base: { 'chat.jsonl': 'original' } });
    assert.deepEqual(opsOf(reverse), ['push:chat.jsonl']);
});

test('a file that vanished from both sides is simply forgotten', () => {
    const plan = computeSyncPlan({ local: {}, remote: {}, base: { 'gone.png': 'h' } });
    assert.deepEqual(plan.actions, [{ op: 'settle', path: 'gone.png', hash: null }]);
});

test('two different edits conflict: the newer one wins and the older one is kept as a copy next to it', () => {
    const plan = computeSyncPlan({
        local: { 'chats/Alice/log.jsonl': file('mine', 2000) },
        remote: { 'chats/Alice/log.jsonl': file('theirs', 1000) },
        base: { 'chats/Alice/log.jsonl': 'old' },
        conflictLabel: 'Phone 2026-09-19 14-05',
    });
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].op, 'conflict');
    assert.equal(plan.actions[0].winner, 'local');
    assert.equal(plan.actions[0].conflictPath, 'chats/Alice/log (conflict Phone 2026-09-19 14-05).jsonl');
    const flipped = computeSyncPlan({
        local: { 'x.json': file('mine', 1000) }, remote: { 'x.json': file('theirs', 2000) }, base: { 'x.json': 'old' },
    });
    assert.equal(flipped.actions[0].winner, 'remote');
});

test('equal timestamps are broken by hash, so both devices independently pick the same winner', () => {
    const fromA = computeSyncPlan({ local: { 'x': file('aaa', 5) }, remote: { 'x': file('bbb', 5) }, base: { 'x': 'old' } });
    const fromB = computeSyncPlan({ local: { 'x': file('bbb', 5) }, remote: { 'x': file('aaa', 5) }, base: { 'x': 'old' } });
    assert.equal(fromA.actions[0].winner, 'remote');
    assert.equal(fromB.actions[0].winner, 'local');
});

test('the same new path with different content on both sides (no base) is a conflict, not an overwrite', () => {
    const plan = computeSyncPlan({ local: { 'a.png': file('x', 1) }, remote: { 'a.png': file('y', 2) }, base: {} });
    assert.equal(plan.actions[0].op, 'conflict');
});

test('include narrows the plan to the chosen categories', () => {
    const plan = computeSyncPlan({
        local: { 'backgrounds/a.png': file('1'), 'chats/x.jsonl': file('2') }, remote: {}, base: {},
        include: path => path.startsWith('backgrounds/'),
    });
    assert.deepEqual(opsOf(plan), ['push:backgrounds/a.png']);
});

test('conflict copies are recognized so they never conflict again', () => {
    assert.equal(isConflictCopy('chats/A/log (conflict Phone 2026-09-19 14-05).jsonl'), true);
    assert.equal(isConflictCopy('chats/A/log.jsonl'), false);
    assert.equal(computeConflictPath('noext', 'X'), 'noext (conflict X)');
    assert.equal(computeConflictPath('.hidden', 'X'), '.hidden (conflict X)');
});

test('base entries can be stored as plain hashes or as objects with a hash', () => {
    assert.deepEqual(resolveBaseHashes({ a: 'h1', b: { hash: 'h2', stamp: 's' }, c: null }), { a: 'h1', b: 'h2' });
});
