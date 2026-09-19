import test from 'node:test';
import assert from 'node:assert/strict';
import { describeConnection, describeCounts, describeLastRun, describeProgress, describeSummary, formatAgo } from '../libraries/shared/sync-panel-model.js';

const NOW = 1_800_000_000_000;

test('relative times read naturally and a missing time is "never"', () => {
    assert.equal(formatAgo(NOW, null), 'never');
    assert.equal(formatAgo(NOW, NOW - 10_000), 'just now');
    assert.equal(formatAgo(NOW, NOW - 5 * 60_000), '5 min ago');
    assert.equal(formatAgo(NOW, NOW - 3 * 3_600_000), '3 h ago');
    assert.equal(formatAgo(NOW, NOW - 2 * 86_400_000), '2 d ago');
});

test('counts are summarized in one line, nothing changed reads as up to date', () => {
    assert.equal(describeCounts({ pushed: 2, pulled: 1, deletedLocal: 1, deletedRemote: 1, conflicts: 0, failed: 0 }), '2 sent, 1 received, 2 removed');
    assert.equal(describeCounts({ pushed: 3 }, { sent: 'uploaded' }), '3 uploaded');
    assert.equal(describeCounts({ pushed: 0, pulled: 0 }), 'everything up to date');
    assert.equal(describeCounts({ deferred: 1, failed: 2 }), '1 postponed (open chat), 2 failed');
    assert.match(describeCounts({ conflicts: 2 }), /2 conflicts kept as a copy/);
});

test('a finished pass with devices and GitHub lists both, with the time last', () => {
    const view = describeLastRun({ at: NOW - 120_000, peers: [{ pair: 'Phone', ok: true, counts: { pushed: 1, pulled: 0 } }], github: { outcome: 'done', ok: true, counts: { pushed: 4 } } }, NOW);
    assert.deepEqual(view.lines, ['Phone: 1 sent', 'GitHub: 4 uploaded', '2 min ago']);
    assert.equal(view.tone, 'ok');
});

test('failures turn the tone: file errors warn, a failed GitHub or channel is an error', () => {
    const warn = describeLastRun({ at: NOW, peers: [{ pair: 'Phone', ok: false, counts: { failed: 1 }, errors: ['chats/a: disk full'] }] }, NOW);
    assert.equal(warn.tone, 'warn');
    assert.ok(warn.lines.includes('⚠ chats/a: disk full'));
    const error = describeLastRun({ at: NOW, peers: [], github: { outcome: 'failed', errors: ['GitHub rejected the token (401)'] } }, NOW);
    assert.equal(error.tone, 'error');
    assert.ok(error.lines.includes('GitHub: GitHub rejected the token (401)'));
    assert.equal(describeLastRun({ at: NOW, peers: [{ outcome: 'failed', error: 'channel closed' }] }, NOW).tone, 'error');
});

test('special outcomes have their own sentences', () => {
    assert.deepEqual(describeLastRun(null, NOW).lines, ['Not synced yet in this session.']);
    assert.deepEqual(describeLastRun({ outcome: 'busy' }, NOW).lines, ['A sync is already running.']);
    assert.equal(describeLastRun({ at: NOW, peers: [], github: null }, NOW).lines[0], 'No devices are online right now.');
    assert.equal(describeLastRun({ at: NOW, peers: [{ outcome: 'requested', pair: 'PC' }] }, NOW).lines[0], 'Asked PC to sync.');
    assert.equal(describeLastRun({ at: NOW, peers: [], github: { outcome: 'unconfigured' } }, NOW).lines[0], 'GitHub: not configured.');
});

test('a cloud pass is listed by its provider name, and its failure turns the tone', () => {
    const ok = describeLastRun({ at: NOW, peers: [], cloud: { outcome: 'done', provider: 'dropbox', ok: true, counts: { pushed: 2 } } }, NOW);
    assert.ok(ok.lines.includes('Dropbox: 2 uploaded'));
    const bad = describeLastRun({ at: NOW, peers: [], cloud: { outcome: 'failed', provider: 'google', errors: ['Google Drive is out of space.'] } }, NOW);
    assert.equal(bad.tone, 'error');
    assert.ok(bad.lines.includes('Google Drive: Google Drive is out of space.'));
    assert.ok(describeLastRun({ at: NOW, peers: [], cloud: { outcome: 'unconfigured' } }, NOW).lines.includes('Cloud drive: not connected.'));
});

test('progress becomes a percentage and a readable label, and no progress is null', () => {
    assert.equal(describeProgress(null), null);
    assert.deepEqual(describeProgress({ target: 'device:Phone', phase: 'syncing', done: 3, total: 12, path: 'chats/Alice/big chat.jsonl' }), { percent: 25, label: 'Syncing with Phone: 3/12 — big chat.jsonl' });
    assert.equal(describeProgress({ target: 'github', phase: 'scanning', done: 0, total: 0 }).label, 'Checking files with GitHub: 0/0');
    assert.equal(describeProgress({ target: 'github', phase: 'syncing', done: 5, total: 4 }).percent, 100);
});

test('connections show a tone, a state word and when they last synced', () => {
    assert.deepEqual(describeConnection({ status: 'open', lastSync: NOW - 60_000 }, NOW), { tone: 'ok', state: 'online', lastSync: 'last sync: 1 min ago' });
    assert.equal(describeConnection({ status: 'connecting' }, NOW).tone, 'warn');
    assert.deepEqual(describeConnection({ status: 'offline', lastSync: null }, NOW), { tone: 'muted', state: 'offline', lastSync: 'last sync: never' });
});

test('the card subtitle sums up devices, GitHub and the last pass', () => {
    const status = { config: { pairs: [{}, {}], github: { enabled: true } }, connections: [{ status: 'open' }, { status: 'offline' }], last: { at: NOW - 3_600_000 } };
    assert.equal(describeSummary(status, NOW), '2 devices paired, 1 online · GitHub on · last sync 1 h ago');
    assert.equal(describeSummary({ config: { pairs: [], github: { enabled: false } }, connections: [], last: null }, NOW), 'No devices paired');
    assert.equal(describeSummary(null, NOW), 'Sync status is not available yet.');
    assert.match(describeSummary({ config: { pairs: [], github: { enabled: false }, cloud: { enabled: true, provider: 'google' } }, connections: [], last: null }, NOW), /Google Drive on/);
});
