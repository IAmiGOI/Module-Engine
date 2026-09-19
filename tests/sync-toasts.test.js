import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { createSyncToastsCore, describeResultToast, passMovedFiles } from '../cores/ui/sync-toasts.js';

const NOW = 1_800_000_000_000;

function build({ bootActive = false } = {}) {
    const engine = createEngine();
    const calls = [];
    engine.buses.cores.register('ui.notify', params => { calls.push(['notify', params]); return 'id'; });
    engine.buses.cores.register('ui.notify.dismiss', params => { calls.push(['dismiss', params]); return true; });
    let time = NOW;
    const host = engine.registerCaller('core.ui.syncToasts', 'cores', { tier: 'official' });
    const core = createSyncToastsCore(host, { isBootActive: () => bootActive, now: () => time, throttleMs: 400 });
    const emit = (event, payload) => engine.events.emit(event, payload);
    return { engine, calls, core, emit, advance: ms => { time += ms; } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const progress = (done, total, extra = {}) => ({ progress: { target: 'device:Phone', phase: 'syncing', done, total, path: 'chats/A/log.jsonl', ...extra } });

test('while a pass moves files, ONE sticky toast shows its progress and is updated in place', async () => {
    const { calls, emit, advance } = build();
    emit('sync.progress', progress(1, 12));
    await settle();
    advance(500);
    emit('sync.progress', progress(2, 12));
    await settle();
    const notifies = calls.filter(call => call[0] === 'notify');
    assert.equal(notifies.length, 2);
    for (const [, params] of notifies) { assert.equal(params.key, 'sync-progress'); assert.equal(params.sticky, true); }
    assert.match(notifies[1][1].text, /Syncing with Phone: 2\/12/);
});

test('progress updates faster than the throttle are skipped so the toast does not flicker', async () => {
    const { calls, emit, advance } = build();
    emit('sync.progress', progress(1, 100));
    await settle();
    advance(50);
    emit('sync.progress', progress(2, 100));
    emit('sync.progress', progress(3, 100));
    await settle();
    assert.equal(calls.filter(call => call[0] === 'notify').length, 1);
});

test('an empty pass (nothing to transfer) never shows a toast, but "connecting" does — someone pressed the button and waits', async () => {
    const { calls, emit } = build();
    emit('sync.progress', progress(0, 0));
    emit('sync.progress', { progress: { target: 'device:Phone', phase: 'scanning', done: 0, total: 0 } });
    await settle();
    assert.equal(calls.length, 0);
    emit('sync.progress', { progress: { target: 'device:Phone', phase: 'connecting', done: 0, total: 0 } });
    await settle();
    assert.match(calls[0][1].text, /Connecting to Phone/);
});

test('when the pass ends the progress toast goes away and is replaced by the result', async () => {
    const { calls, emit } = build();
    emit('sync.progress', progress(1, 3));
    await settle();
    emit('sync.finished', { at: NOW, target: 'all', peers: [{ pair: 'Phone', ok: true, counts: { pushed: 2, pulled: 1 } }] });
    await settle();
    assert.deepEqual(calls.at(-2), ['dismiss', { key: 'sync-progress' }]);
    const [, result] = calls.at(-1);
    assert.equal(result.tone, 'ok');
    assert.equal(result.text, 'Phone: 2 sent, 1 received');
    assert.equal(result.key, undefined, 'the result is an ordinary toast that fades by itself');
});

test('a scheduled pass that moved nothing stays silent, one that moved files or failed speaks, a manual one always speaks', async () => {
    const quiet = { at: NOW, target: 'scheduled', peers: [{ pair: 'Phone', ok: true, counts: { pushed: 0, pulled: 0 } }] };
    assert.equal(describeResultToast(quiet, { now: NOW }), null);
    assert.equal(describeResultToast({ ...quiet, target: 'load' }, { now: NOW }), null);
    assert.ok(describeResultToast({ ...quiet, target: 'all' }, { now: NOW }), 'manual: always');
    assert.match(describeResultToast({ ...quiet, peers: [{ pair: 'Phone', ok: true, counts: { pulled: 4 } }] }, { now: NOW }).text, /4 received/);
    const failed = describeResultToast({ at: NOW, target: 'scheduled', peers: [], cloud: { outcome: 'failed', provider: 'google', errors: ['Google Drive is full.'] } }, { now: NOW });
    assert.equal(failed.tone, 'error');
    assert.ok(failed.timeoutMs > 6000, 'problems stay a bit longer');
    assert.equal(describeResultToast({ outcome: 'busy' }, { now: NOW }), null);
    assert.equal(passMovedFiles({ peers: [], github: { counts: { deletedRemote: 1 } } }), true);
});

test('while the loading screen is up there are no toasts — it shows the progress itself', async () => {
    const { calls, emit } = build({ bootActive: true });
    emit('sync.progress', progress(1, 5));
    emit('sync.finished', { at: NOW, target: 'load', peers: [{ pair: 'Phone', ok: true, counts: { pushed: 3 } }] });
    await settle();
    assert.deepEqual(calls.filter(call => call[0] === 'notify'), []);
});

test('a result of a pass that never showed progress still dismisses nothing and does not fail', async () => {
    const { calls, emit } = build();
    emit('sync.finished', { at: NOW, target: 'scheduled', peers: [] });
    await settle();
    assert.deepEqual(calls, []);
});

test('after presets or themes were written a reload hint toast appears (ST keeps its lists in memory), but not behind the loading screen', async () => {
    const shown = build();
    shown.emit('sync.reloadHint', {});
    await settle();
    assert.match(shown.calls[0][1].text, /reload the page/);
    assert.equal(shown.calls[0][1].key, 'sync-reload');
    const hidden = build({ bootActive: true });
    hidden.emit('sync.reloadHint', {});
    await settle();
    assert.deepEqual(hidden.calls, []);
});
