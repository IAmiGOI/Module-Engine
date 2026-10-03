import test from 'node:test';
import assert from 'node:assert/strict';
import { backupName, buildSums, DAY_MS, HOUR_MS, isUnchanged, parseBackupName, parseSums, parseStamp, planRotation, planTransfer, sha256Hex, stampOf, verifyListing, WEEK_MS } from '../libraries/core/backup-plan.js';

test('a backup name carries time, slot, device, file count, size and the start of its SHA256SUMS hash — and parses back', () => {
    const at = Date.UTC(2026, 9, 3, 18, 30, 5);
    const name = backupName({ at, kind: 'hourly', device: 'My PC!', files: 1243, bytes: 886 * 1048576, sums: '3fa91c2e9999' });
    assert.equal(name, 'STME-backup_20261003T183005Z_hourly_My-PC_1243f_886MB_3fa91c2e');
    assert.deepEqual(parseBackupName(name), { at, kind: 'hourly', device: 'My-PC', files: 1243, size: '886MB', sums: '3fa91c2e', incomplete: false });
    assert.equal(parseBackupName(`${name}_INCOMPLETE`).incomplete, true);
    assert.equal(parseBackupName('my vacation photos'), null);
    assert.equal(parseStamp(stampOf(at)), at);
});

test('SHA256SUMS is the standard "hash  path" format, sorted, and parses back', async () => {
    const entries = [{ path: 'chats/b.jsonl', sha256: await sha256Hex('b') }, { path: 'characters/a.png', sha256: await sha256Hex('a') }];
    const text = buildSums(entries);
    assert.match(text.split('\n')[0], /^[0-9a-f]{64} {2}characters\/a\.png$/);
    assert.deepEqual(parseSums(text), [entries[1], entries[0]]);
    assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('verifyListing() finds missing, extra and corrupted files and passes an exact match', () => {
    const expected = [{ path: 'a', size: 1, sha256: 'x' }, { path: 'b', size: 2, sha256: 'y' }];
    assert.deepEqual(verifyListing(expected, [{ path: 'a', size: 1, sha256: 'x' }, { path: 'b', size: 2, sha256: 'y' }]), { ok: true, missing: [], extra: [], mismatched: [] });
    const bad = verifyListing(expected, [{ path: 'a', size: 1, sha256: 'WRONG' }, { path: 'c', size: 1, sha256: 'z' }]);
    assert.deepEqual([bad.ok, bad.missing, bad.extra, bad.mismatched], [false, ['b'], ['c'], ['a']]);
    assert.equal(verifyListing(expected, [{ path: 'a', size: 9, sha256: 'x' }, { path: 'b', size: 2, sha256: 'y' }]).ok, false, 'a wrong size alone is a failure');
});

test('planTransfer() uploads only what changed and copies the rest inside the cloud', () => {
    const previous = [{ path: 'a', size: 5, sha256: '1' }, { path: 'b', size: 7, sha256: '2' }];
    const current = [{ path: 'a', size: 5, sha256: '1' }, { path: 'b', size: 8, sha256: '3' }, { path: 'c', size: 1, sha256: '4' }];
    const plan = planTransfer(current, previous);
    assert.deepEqual(plan.copy.map(f => f.path), ['a']);
    assert.deepEqual(plan.upload.map(f => f.path), ['b', 'c']);
    assert.deepEqual([plan.uploadBytes, plan.copyBytes], [9, 5]);
    assert.equal(planTransfer(current, null).upload.length, 3);
});

test('the first backups just fill the slots: nothing to promote, nothing removed', () => {
    assert.deepEqual(planRotation({ existing: [], now: 0 }), { promote: [], remove: [] });
    const now = 10 * HOUR_MS;
    assert.deepEqual(planRotation({ existing: [{ id: 'h1', kind: 'hourly', at: now - HOUR_MS }], now }), { promote: [{ id: 'h1', to: 'daily' }], remove: [] });
});

test('a young daily slot is kept and the outgoing hourly is simply dropped', () => {
    const now = 30 * HOUR_MS;
    const plan = planRotation({ existing: [{ id: 'h', kind: 'hourly', at: now - HOUR_MS }, { id: 'd', kind: 'daily', at: now - 5 * HOUR_MS }], now });
    assert.deepEqual(plan, { promote: [], remove: ['h'] });
});

test('an old daily slot is replaced by the outgoing hourly; the old daily becomes the weekly one if that is empty or a week old', () => {
    const now = 40 * DAY_MS;
    const base = [{ id: 'h', kind: 'hourly', at: now - HOUR_MS }, { id: 'd', kind: 'daily', at: now - 25 * HOUR_MS }];
    assert.deepEqual(planRotation({ existing: base, now }), { promote: [{ id: 'd', to: 'weekly' }, { id: 'h', to: 'daily' }], remove: [] });
    const young = planRotation({ existing: [...base, { id: 'w', kind: 'weekly', at: now - 3 * DAY_MS }], now });
    assert.deepEqual(young, { promote: [{ id: 'h', to: 'daily' }], remove: ['d'] });
    const old = planRotation({ existing: [...base, { id: 'w', kind: 'weekly', at: now - 8 * DAY_MS }], now });
    assert.deepEqual(old, { promote: [{ id: 'd', to: 'weekly' }, { id: 'h', to: 'daily' }], remove: ['w'] });
});

test('after leftovers from a crash, only the newest backup of a slot is considered and the rest are removed', () => {
    const now = 100 * HOUR_MS;
    const plan = planRotation({ existing: [{ id: 'h2', kind: 'hourly', at: now - 2 * HOUR_MS }, { id: 'h1', kind: 'hourly', at: now - HOUR_MS }, { id: 'w1', kind: 'weekly', at: now - DAY_MS }, { id: 'w2', kind: 'weekly', at: now - 2 * DAY_MS }], now });
    assert.deepEqual(plan.remove.sort(), ['h2', 'w2']);
});

test('over two weeks of hourly backups exactly three backups remain, with the ages the slots promise', () => {
    let existing = [], id = 0, now = 0;
    for (let hour = 1; hour <= 24 * 14; hour += 1) {
        now = hour * HOUR_MS;
        const plan = planRotation({ existing, now });
        const dropped = new Set(plan.remove);
        const promoted = new Map(plan.promote.map(step => [step.id, step.to]));
        existing = existing.filter(item => !dropped.has(item.id)).map(item => (promoted.has(item.id) ? { ...item, kind: promoted.get(item.id) } : item));
        existing.push({ id: `b${(id += 1)}`, kind: 'hourly', at: now });
        assert.ok(existing.length <= 3, `at hour ${hour}`);
        assert.equal(new Set(existing.map(item => item.kind)).size, existing.length, 'one backup per slot');
    }
    const age = kind => now - existing.find(item => item.kind === kind).at;
    assert.equal(age('hourly'), 0);
    assert.ok(age('daily') <= DAY_MS + HOUR_MS && age('daily') >= HOUR_MS, 'daily is within a day');
    assert.ok(age('weekly') <= WEEK_MS + DAY_MS && age('weekly') >= DAY_MS, 'weekly is between a day and a week old');
});

test('an unchanged data set does not make a new backup', () => {
    assert.equal(isUnchanged({ sums: '3fa91c2e' }, '3fa91c2eabcdef'), true);
    assert.equal(isUnchanged({ sums: '3fa91c2e' }, 'ffffffff'), false);
    assert.equal(isUnchanged(null, 'ffffffff'), false);
});
