import test from 'node:test';
import assert from 'node:assert/strict';
import { runSync } from '../libraries/core/sync-runner.js';
import { computeGitBlobSha } from '../libraries/core/content-hash.js';

/** Сторона на памяти: путь → { text, modified }. */
function memorySide(initial = {}, { batched = false, failWrite = () => false } = {}) {
    const files = new Map(Object.entries(initial).map(([path, value]) => [path, typeof value === 'string' ? { text: value, modified: 1 } : value]));
    const log = [];
    const side = {
        files,
        log,
        batched,
        async manifest() {
            const out = {};
            for (const [path, { text, modified }] of files) out[path] = { hash: await computeGitBlobSha(new TextEncoder().encode(text)), size: text.length, modified };
            return out;
        },
        async read(path) { log.push(`read:${path}`); return new Blob([files.get(path).text]); },
        async write(path, blob, meta) {
            if (failWrite(path)) throw new Error(`disk full for ${path}`);
            log.push(`write:${path}`);
            files.set(path, { text: await blob.text(), modified: meta?.modified ?? 1 });
        },
        async remove(path) { log.push(`remove:${path}`); files.delete(path); },
    };
    if (batched) { side.commitCalls = 0; side.commit = async () => { side.commitCalls += 1; }; }
    return side;
}

const textOf = (side, path) => side.files.get(path)?.text;
const hashOf = text => computeGitBlobSha(new TextEncoder().encode(text));

test('a first sync copies new files both ways and remembers them as the base', async () => {
    const local = memorySide({ 'backgrounds/a.png': 'AAA' });
    const remote = memorySide({ 'backgrounds/b.png': 'BBB' });
    const result = await runSync({ local, remote, base: {} });
    assert.equal(result.ok, true);
    assert.equal(textOf(remote, 'backgrounds/a.png'), 'AAA');
    assert.equal(textOf(local, 'backgrounds/b.png'), 'BBB');
    assert.deepEqual(result.counts, { pushed: 1, pulled: 1, deletedLocal: 0, deletedRemote: 0, conflicts: 0, failed: 0, deferred: 0 });
    assert.equal(result.base['backgrounds/a.png'], await hashOf('AAA'));
    assert.equal(result.base['backgrounds/b.png'], await hashOf('BBB'));
});

test('running again right after does nothing — only changed files ever move', async () => {
    const local = memorySide({ 'a': 'one', 'b': 'two' });
    const remote = memorySide({});
    const first = await runSync({ local, remote, base: {} });
    local.log.length = 0; remote.log.length = 0;
    const second = await runSync({ local, remote, base: first.base });
    assert.deepEqual(second.counts, { pushed: 0, pulled: 0, deletedLocal: 0, deletedRemote: 0, conflicts: 0, failed: 0, deferred: 0 });
    assert.deepEqual([...local.log, ...remote.log], []);
    local.files.set('a', { text: 'one!', modified: 5 });
    const third = await runSync({ local, remote, base: second.base });
    assert.deepEqual(third.counts.pushed, 1);
    assert.equal(textOf(remote, 'a'), 'one!');
    assert.equal(remote.log.filter(line => line.startsWith('write:')).length, 1, 'only the changed file was sent');
});

test('a deletion travels to the other side after a settled sync', async () => {
    const local = memorySide({ 'x': 'data' });
    const remote = memorySide({});
    const first = await runSync({ local, remote, base: {} });
    local.files.delete('x');
    const second = await runSync({ local, remote, base: first.base });
    assert.equal(remote.files.has('x'), false);
    assert.equal(second.counts.deletedRemote, 1);
    assert.equal('x' in second.base, false);
});

test('a conflict keeps both versions on both sides: winner in place, loser as a copy', async () => {
    const local = memorySide({ 'chats/A/log.jsonl': { text: 'from phone', modified: 2000 } });
    const remote = memorySide({ 'chats/A/log.jsonl': { text: 'from pc', modified: 1000 } });
    const result = await runSync({ local, remote, base: {}, conflictLabel: 'Phone' });
    assert.equal(result.counts.conflicts, 1);
    for (const side of [local, remote]) {
        assert.equal(textOf(side, 'chats/A/log.jsonl'), 'from phone');
        assert.equal(textOf(side, 'chats/A/log (conflict Phone).jsonl'), 'from pc');
    }
    assert.equal(result.base['chats/A/log.jsonl'], await hashOf('from phone'));
    assert.equal(result.base['chats/A/log (conflict Phone).jsonl'], await hashOf('from pc'));
});

test('when the remote version wins, the local version is what survives as the copy', async () => {
    const local = memorySide({ 'w.json': { text: 'old local', modified: 100 } });
    const remote = memorySide({ 'w.json': { text: 'new remote', modified: 900 } });
    await runSync({ local, remote, base: {}, conflictLabel: 'PC' });
    assert.equal(textOf(local, 'w.json'), 'new remote');
    assert.equal(textOf(local, 'w (conflict PC).json'), 'old local');
    assert.equal(textOf(remote, 'w (conflict PC).json'), 'old local');
});

test('one failing file does not stop the rest and stays out of the base so it is retried next time', async () => {
    const local = memorySide({});
    const remote = memorySide({ 'good.png': 'ok', 'bad.png': 'nope' });
    const failing = memorySide({}, { failWrite: path => path === 'bad.png' });
    const result = await runSync({ local: failing, remote, base: {} });
    assert.equal(result.ok, false);
    assert.equal(result.counts.failed, 1);
    assert.equal(result.errors[0].path, 'bad.png');
    assert.equal(textOf(failing, 'good.png'), 'ok');
    assert.equal('bad.png' in result.base, false);
    assert.equal('good.png' in result.base, true);
    void local;
});

test('a batched side (GitHub) commits once for the whole pass and the base only advances after the commit succeeds', async () => {
    const local = memorySide({ 'a': '1', 'b': '2', 'c': '3' });
    const remote = memorySide({}, { batched: true });
    const result = await runSync({ local, remote, base: {} });
    assert.equal(remote.commitCalls, 1);
    assert.equal(result.counts.pushed, 3);
    assert.equal(Object.keys(result.base).length, 3);

    const broken = memorySide({}, { batched: true });
    broken.commit = async () => { throw new Error('GitHub rejected the commit'); };
    const failed = await runSync({ local, remote: broken, base: {} });
    assert.equal(failed.ok, false);
    assert.deepEqual(failed.base, {}, 'nothing is remembered as synced when the commit failed');
    assert.equal(failed.errors.at(-1).op, 'commit');
});

test('pulling from a batched side needs no commit', async () => {
    const remote = memorySide({ 'a': '1' }, { batched: true });
    const local = memorySide({});
    const result = await runSync({ local, remote, base: {} });
    assert.equal(remote.commitCalls, 0);
    assert.equal(textOf(local, 'a'), '1');
    assert.equal(Object.keys(result.base).length, 1);
});

test('include limits which paths take part and abort stops between files', async () => {
    const local = memorySide({ 'backgrounds/a': '1', 'chats/b': '2', 'chats/c': '3' });
    const remote = memorySide({});
    const only = await runSync({ local, remote, base: {}, include: path => path.startsWith('backgrounds/') });
    assert.deepEqual([...remote.files.keys()], ['backgrounds/a']);
    assert.equal(only.counts.pushed, 1);

    const remote2 = memorySide({});
    let seen = 0;
    const stopped = await runSync({ local, remote: remote2, base: {}, isAborted: () => (seen += 1) > 1 });
    assert.equal(stopped.aborted, true);
    assert.equal(remote2.files.size, 1);
});

test('progress is reported for every transferred file', async () => {
    const local = memorySide({ 'a': '1', 'b': '2' });
    const remote = memorySide({});
    const seen = [];
    await runSync({ local, remote, base: {}, onProgress: event => seen.push(`${event.done}/${event.total}:${event.path}`) });
    assert.deepEqual(seen, ['0/2:a', '1/2:b', '2/2:null']);
});

test('a deferred file (open chat) is not a failure: the pass stays ok and the file is retried next time', async () => {
    const local = memorySide({});
    local.write = async () => { throw Object.assign(new Error('chat is open'), { deferred: true }); };
    const remote = memorySide({ 'chats/A/open.jsonl': 'x', 'other': 'y' });
    const result = await runSync({ local, remote, base: {} });
    assert.equal(result.counts.deferred, 2);
    assert.equal(result.counts.failed, 0);
    assert.equal(result.ok, true);
    assert.deepEqual(result.base, {}, 'not remembered, so it is planned again next time');
});

test('a fatal refusal (no space, token rejected) stops the pass at once instead of trying every remaining file', async () => {
    const { FatalSyncError } = await import('../libraries/core/sync-errors.js');
    const local = memorySide({ 'a': '1', 'b': '2', 'c': '3', 'd': '4', 'e': '5' });
    const remote = memorySide({});
    let attempts = 0;
    remote.write = async (path, blob) => {
        attempts += 1;
        if (attempts === 2) throw new FatalSyncError('Google Drive is full');
        remote.files.set(path, { text: await blob.text(), modified: 1 });
    };
    const result = await runSync({ local, remote, base: {} });
    assert.equal(attempts, 2, 'the third, fourth and fifth files were never tried');
    assert.equal(result.ok, false);
    assert.deepEqual(result.stopped, { reason: 'Google Drive is full', remaining: 3 });
    assert.equal(result.counts.pushed, 1);
    assert.equal(result.counts.failed, 1);
    assert.equal(result.errors.length, 1, 'one clear message, not a wall of identical ones');
    assert.equal('a' in result.base, true, 'what was already sent is remembered');
    assert.equal('b' in result.base, false);
});

test('an ordinary per-file failure does not stop the pass, only a fatal one does', async () => {
    const local = memorySide({ 'a': '1', 'b': '2', 'c': '3' });
    const remote = memorySide({}, { failWrite: path => path === 'a' });
    const result = await runSync({ local, remote, base: {} });
    assert.equal(result.counts.pushed, 2);
    assert.equal(result.counts.failed, 1);
    assert.equal(result.stopped, null);
});

test('after a fatal stop on a batched side the already-uploaded files are still committed, and a failing commit is not reported a second time', async () => {
    const { FatalSyncError } = await import('../libraries/core/sync-errors.js');
    const local = memorySide({ 'a': '1', 'b': '2', 'c': '3' });
    const remote = memorySide({}, { batched: true });
    const originalWrite = remote.write;
    let count = 0;
    remote.write = async (...args) => { count += 1; if (count === 2) throw new FatalSyncError('quota'); return originalWrite(...args); };
    const good = await runSync({ local, remote, base: {} });
    assert.equal(remote.commitCalls, 1, 'the one file that made it is committed');
    assert.equal('a' in good.base, true);

    const broken = memorySide({}, { batched: true });
    const writeThenFail = broken.write;
    let n = 0;
    broken.write = async (...args) => { n += 1; if (n === 2) throw new FatalSyncError('quota'); return writeThenFail(...args); };
    broken.commit = async () => { throw new Error('index could not be written'); };
    const result = await runSync({ local, remote: broken, base: {} });
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].message, 'quota');
    assert.deepEqual(result.base, {}, 'nothing is remembered when the index could not be written');
});

test('a batched side that asks for checkpoints is committed every N changes, so an interrupted pass keeps what was already sent', async () => {
    const { FatalSyncError } = await import('../libraries/core/sync-errors.js');
    const local = memorySide({ a: '1', b: '2', c: '3', d: '4', e: '5', f: '6' });
    const remote = memorySide({}, { batched: true });
    remote.checkpointEvery = 2;
    const originalWrite = remote.write;
    let count = 0;
    remote.write = async (...args) => { count += 1; if (count === 6) throw new FatalSyncError('quota'); return originalWrite(...args); };
    const result = await runSync({ local, remote, base: {} });
    assert.equal(remote.commitCalls, 3, 'after 2, after 4, and the final commit for the fifth file');
    assert.deepEqual(Object.keys(result.base).sort(), ['a', 'b', 'c', 'd', 'e'], 'everything before the refusal is remembered as synced');
    assert.equal(result.stopped.remaining, 0);
});

test('without checkpoints a batched side commits once at the end, as before (GitHub keeps one commit per pass)', async () => {
    const local = memorySide({ a: '1', b: '2', c: '3', d: '4' });
    const remote = memorySide({}, { batched: true });
    await runSync({ local, remote, base: {} });
    assert.equal(remote.commitCalls, 1);
});

test('a failing checkpoint commit does not lose the changes: they stay pending and the final commit tries again', async () => {
    const local = memorySide({ a: '1', b: '2', c: '3' });
    const remote = memorySide({}, { batched: true });
    remote.checkpointEvery = 2;
    let attempts = 0;
    remote.commit = async () => { attempts += 1; remote.commitCalls += 1; if (attempts === 1) throw new Error('temporary failure'); };
    const result = await runSync({ local, remote, base: {} });
    assert.equal(result.counts.failed, 1, 'the failed checkpoint is reported once');
    assert.equal(Object.keys(result.base).length, 3, 'the final commit succeeded, so all three are remembered');
});
