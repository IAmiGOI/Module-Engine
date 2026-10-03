import test from 'node:test';
import assert from 'node:assert/strict';
import { conflictCopyOriginal, planCopyCleanup } from '../libraries/core/sync-plan.js';
import { runSync } from '../libraries/core/sync-runner.js';
import { computeGitBlobSha } from '../libraries/core/content-hash.js';

const entry = (hash, key) => ({ hash, size: 1, modified: 1, ...(key ? { key } : {}) });
const copy = (path, stamp = '2026-10-03 10-00-00') => path.replace(/(\.[^./]*)$/, ` (conflict Phone ${stamp})$1`);
const paths = plan => plan.map(item => item.path).sort();

test('conflictCopyOriginal(): finds the file a copy was made from, including numbered and extension-less copies', () => {
    assert.equal(conflictCopyOriginal('characters/Anna (conflict Phone 2026-10-03 10-00-00).png'), 'characters/Anna.png');
    assert.equal(conflictCopyOriginal('chats/A/log (conflict X) 2.jsonl'), 'chats/A/log.jsonl');
    assert.equal(conflictCopyOriginal('notes (conflict X)'), 'notes');
    assert.equal(conflictCopyOriginal('characters/Anna.png'), null);
});

test('a copy byte-identical to its original is redundant and goes (on both sides)', () => {
    const c = copy('chats/log.jsonl');
    const local = { 'chats/log.jsonl': entry('H1'), [c]: entry('H1') };
    const remote = { 'chats/log.jsonl': entry('H1'), [c]: entry('H1') };
    assert.deepEqual(planCopyCleanup({ local, remote }), [{ path: c, original: 'chats/log.jsonl', reason: 'same-as-original', remote: true }]);
});

test('a character copy with the same card fingerprint as the original is redundant even though ST rewrote its bytes', () => {
    const c = copy('characters/Anna.png');
    const local = { 'characters/Anna.png': entry('H1', 'card1:A'), [c]: entry('H2', 'card1:A') };
    const remote = { [c]: entry('H3') };   // у облака нет key; байты прежние, как были при прошлой синхронизации
    assert.deepEqual(paths(planCopyCleanup({ local, remote, base: { [c]: 'H3' } })), [c]);
});

test('a copy with genuinely different content is a real second version and stays', () => {
    const c = copy('characters/Anna.png');
    const local = { 'characters/Anna.png': entry('H1', 'card1:A'), [c]: entry('H2', 'card1:B') };
    assert.deepEqual(planCopyCleanup({ local, remote: {} }), []);
});

test('several copies of the same losing version collapse to the earliest one', () => {
    const [c1, c2, c3] = ['10-00-00', '10-05-00', '10-09-00'].map(stamp => copy('characters/Anna.png', stamp));
    const local = { 'characters/Anna.png': entry('H1', 'card1:A'), [c1]: entry('H2', 'card1:B'), [c2]: entry('H2b', 'card1:B'), [c3]: entry('H2c', 'card1:B') };
    const plan = planCopyCleanup({ local, remote: {} });
    assert.deepEqual(paths(plan), [c2, c3]);
    assert.ok(plan.every(item => item.reason === 'duplicate-copy'));
});

test('a copy whose original is gone is kept — it may be the only remaining version', () => {
    assert.deepEqual(planCopyCleanup({ local: { [copy('chats/log.jsonl')]: entry('H1') }, remote: {} }), []);
});

test('a remote copy that changed since the last sync and differs from the local one is not deleted', () => {
    const c = copy('chats/log.jsonl');
    assert.deepEqual(planCopyCleanup({ local: { 'chats/log.jsonl': entry('H1'), [c]: entry('H1') }, remote: { [c]: entry('H9') }, base: { [c]: 'H1' } }), []);
});

test('paths the current pass is already changing, and disabled categories, are left alone', () => {
    const c = copy('chats/log.jsonl');
    const local = { 'chats/log.jsonl': entry('H1'), [c]: entry('H1') };
    assert.deepEqual(planCopyCleanup({ local, remote: {}, busy: new Set(['chats/log.jsonl']) }), []);
    assert.deepEqual(planCopyCleanup({ local, remote: {}, include: () => false }), []);
});

function memorySide(initial) {
    const files = new Map(Object.entries(initial).map(([path, text]) => [path, { text, modified: 1 }]));
    return {
        files,
        async manifest() { const out = {}; for (const [path, { text, modified }] of files) out[path] = { hash: await computeGitBlobSha(new TextEncoder().encode(text)), size: text.length, modified }; return out; },
        async read(path) { return new Blob([files.get(path).text]); },
        async write(path, blob) { files.set(path, { text: await blob.text(), modified: 1 }); },
        async remove(path) { files.delete(path); },
    };
}
const baseOf = async files => Object.fromEntries(await Promise.all(Object.entries(files).map(async ([path, text]) => [path, await computeGitBlobSha(new TextEncoder().encode(text))])));

test('a sync pass removes the redundant copies on both sides and forgets them in the base', async () => {
    const c1 = copy('characters/Anna.png', '10-00-00'), c2 = copy('characters/Anna.png', '10-05-00');
    const files = { 'characters/Anna.png': 'card', [c1]: 'card', [c2]: 'card' };
    const local = memorySide(files), remote = memorySide(files);
    const result = await runSync({ local, remote, base: await baseOf(files) });
    assert.deepEqual([...local.files.keys()], ['characters/Anna.png']);
    assert.deepEqual([...remote.files.keys()], ['characters/Anna.png']);
    assert.deepEqual(result.cleanedCopies.sort(), [c1, c2]);
    assert.equal(c1 in result.base, false);
    assert.equal(result.ok, true);
});

test('cleanup can be switched off', async () => {
    const files = { 'chats/log.jsonl': 'same', [copy('chats/log.jsonl')]: 'same' };
    const local = memorySide(files), remote = memorySide(files);
    const result = await runSync({ local, remote, base: await baseOf(files), cleanupCopies: false });
    assert.equal(local.files.size, 2);
    assert.deepEqual(result.cleanedCopies, []);
});
