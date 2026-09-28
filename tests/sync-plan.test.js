import test from 'node:test';
import assert from 'node:assert/strict';
import { computeConflictPath, computeSyncPlan, detectMassDeletion, isConflictCopy, resolveBaseHashes } from '../libraries/core/sync-plan.js';
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

test('a conflict is flagged firstMeet when the base never had this path, and NOT flagged when a real shared history exists (ROADMAP 5.106б)', () => {
    const firstMeet = computeSyncPlan({ local: { 'characters/Alice.png': file('x', 1) }, remote: { 'characters/Alice.png': file('y', 2) }, base: {} });
    assert.equal(firstMeet.actions[0].firstMeet, true);
    const realEdit = computeSyncPlan({ local: { 'characters/Alice.png': file('x2', 3) }, remote: { 'characters/Alice.png': file('y2', 4) }, base: { 'characters/Alice.png': 'original' } });
    assert.equal(realEdit.actions[0].firstMeet, false);
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

// --- Сравнение по семантическому `key` (card-fingerprint.js), не только по байтовому `hash` ---

const withKey = (hash, key, modified = 0, size = 10) => ({ hash, key, modified, size });

test('computeSyncPlan(): a path with the same key on both sides settles with zero transfers, even though the raw hash differs (the whole point of key-comparison)', () => {
    const plan = computeSyncPlan({
        local: { 'characters/Alice.png': withKey('bytes-a', 'card1:same') },
        remote: { 'characters/Alice.png': withKey('bytes-b', 'card1:same') },
        base: {},
    });
    assert.deepEqual(opsOf(plan), ['settle:characters/Alice.png']);
    assert.equal(plan.actions[0].hash, 'card1:same', 'the base records the KEY, not either side\'s raw byte hash');
});

test('computeSyncPlan(): key present on only one side falls back to hash comparison for that path', () => {
    const plan = computeSyncPlan({
        local: { 'characters/Alice.png': withKey('bytes-a', 'card1:same') },
        remote: { 'characters/Alice.png': { hash: 'bytes-b', modified: 0, size: 10 } },   // no key — e.g. GitHub side
        base: {},
    });
    assert.equal(plan.actions[0].op, 'conflict', 'without a key on both sides, differing raw bytes still conflict as before');
});

test('computeSyncPlan(): a real edit (different key) still pushes/pulls, and the transferred `hash` stays the real byte hash while `baseValue` is the key', () => {
    const plan = computeSyncPlan({
        local: { 'characters/Alice.png': withKey('new-bytes', 'card1:v2') },
        remote: { 'characters/Alice.png': withKey('old-bytes', 'card1:v1') },
        base: { 'characters/Alice.png': 'card1:v1' },
    });
    assert.equal(plan.actions[0].op, 'push');
    assert.equal(plan.actions[0].hash, 'new-bytes', 'meta.hash for the write is the real byte hash, not the key');
    assert.equal(plan.actions[0].baseValue, 'card1:v2', 'what gets recorded into base is the key');
});

test('computeSyncPlan(): an old byte-hash base naturally stops matching once both sides carry a key — next pass just re-settles on the key instead of a hardcoded special case', () => {
    // Base was recorded as a plain byte hash before this pair started reporting `key` for this path (pre-fingerprint history).
    const plan = computeSyncPlan({
        local: { 'characters/Alice.png': withKey('bytes-a', 'card1:same') },
        remote: { 'characters/Alice.png': withKey('bytes-b', 'card1:same') },
        base: { 'characters/Alice.png': 'bytes-a' },   // old-format base — never equals a `card1:` key by construction
    });
    assert.deepEqual(opsOf(plan), ['settle:characters/Alice.png']);
    assert.equal(plan.actions[0].hash, 'card1:same');
});

// --- Защита от массового удаления (ROADMAP 5.106в, Этап 4.4) ---

const categoryOf = path => (path.startsWith('characters/') ? 'characters' : path.startsWith('chats/') ? 'chats' : null);
/** `count` файлов `prefix0..N` — `entries` для local/remote (`{hash,...}`), `bases` — тот же набор как плоские хеши для `base`. */
const filesOf = (prefix, count) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`${prefix}${index}.png`, file(`h${index}`)]));
const basesOf = (prefix, count) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`${prefix}${index}.png`, `h${index}`]));
const deletionPlan = (local, remote, base) => computeSyncPlan({ local, remote, base }).actions;

test('detectMassDeletion(): a single stray deletion in a small category is never blocked', () => {
    const base = { 'characters/0.png': 'h0', 'characters/1.png': 'h1' };
    const local = { 'characters/1.png': file('h1') };   // 0.png genuinely removed locally
    const remote = { 'characters/0.png': file('h0'), 'characters/1.png': file('h1') };
    const actions = deletionPlan(local, remote, base);
    assert.deepEqual(detectMassDeletion({ actions, local, remote, base, categoryOf }), new Set());
});

test('detectMassDeletion(): more than 20 files AND more than 30% of the category trips the guard', () => {
    const base = basesOf('characters/', 30);   // 30 files existed
    const remote = filesOf('characters/', 30); // remote still has all 30 — local lost 25 of them
    const local = filesOf('characters/', 5);   // only 5 left locally -> 25 deleteRemote actions planned
    const actions = deletionPlan(local, remote, base);
    assert.equal(actions.filter(a => a.op === 'deleteRemote').length, 25);
    assert.deepEqual(detectMassDeletion({ actions, local, remote, base, categoryOf }), new Set(['characters']));
});

test('detectMassDeletion(): more than 20 deletions but under 30% of a LARGE category is not blocked — ratio matters, not just the raw count', () => {
    const base = basesOf('characters/', 200);
    const remote = filesOf('characters/', 200);
    const local = filesOf('characters/', 175);   // 25 deletions out of 200 (12.5%) — over the count floor, under the ratio
    const actions = deletionPlan(local, remote, base);
    assert.equal(actions.filter(a => a.op === 'deleteRemote').length, 25);
    assert.deepEqual(detectMassDeletion({ actions, local, remote, base, categoryOf }), new Set());
});

test('detectMassDeletion(): a category emptied to zero on one side trips the guard even with few files — the classic "listing came back empty" symptom', () => {
    const base = { 'characters/0.png': 'h0', 'characters/1.png': 'h1', 'characters/2.png': 'h2' };
    const remote = { 'characters/0.png': file('h0'), 'characters/1.png': file('h1'), 'characters/2.png': file('h2') };
    const local = {};   // the local listing came back completely empty
    const actions = deletionPlan(local, remote, base);
    assert.deepEqual(detectMassDeletion({ actions, local, remote, base, categoryOf }), new Set(['characters']));
});

test('detectMassDeletion(): a category that legitimately has zero files AND zero base history is not flagged — nothing to protect', () => {
    const actions = deletionPlan({}, {}, {});
    assert.deepEqual(detectMassDeletion({ actions, local: {}, remote: {}, base: {}, categoryOf }), new Set());
});

test('detectMassDeletion(): only the tripped category is reported — an untouched category never blocks another', () => {
    // chats loses one of two files: neither over the 20/30% ratio nor emptied to zero — must not join the block.
    const base = { ...basesOf('characters/', 30), 'chats/x.jsonl': 'hc1', 'chats/y.jsonl': 'hc2' };
    const remote = { ...filesOf('characters/', 30), 'chats/x.jsonl': file('hc1'), 'chats/y.jsonl': file('hc2') };
    const local = { ...filesOf('characters/', 5), 'chats/y.jsonl': file('hc2') };
    const actions = deletionPlan(local, remote, base);
    assert.deepEqual(detectMassDeletion({ actions, local, remote, base, categoryOf }), new Set(['characters']));
});
