import test from 'node:test';
import assert from 'node:assert/strict';
import { BOOT_STAGES, createBootScreen, wireBootScreen } from '../harness/boot-screen.js';

function fakeScreen() {
    const log = [];
    return { log, setStage: (name, opts) => log.push(['stage', name, opts?.timeoutMs ?? null]), finish: opts => log.push(['finish', opts?.afterMs ?? 0]) };
}
function fakeEvents() {
    const handlers = new Map();
    return { subscribe: (name, fn) => { handlers.set(name, fn); return () => handlers.delete(name); }, emit: (name, payload) => handlers.get(name)?.(payload) };
}

test('the boot screen has a stage with text and a progress share for every step of the self-update run', () => {
    for (const name of ['starting', 'checking', 'upToDate', 'downloading', 'installed', 'failed']) {
        assert.ok(BOOT_STAGES[name].text.length > 0, name);
        assert.ok(BOOT_STAGES[name].progress > 0 && BOOT_STAGES[name].progress <= 1, name);
    }
    assert.ok(BOOT_STAGES.checking.progress < BOOT_STAGES.downloading.progress, 'progress only moves forward');
});

test('an up-to-date check shows the stage briefly and closes; the trailing finished event does not reopen anything', () => {
    const screen = fakeScreen();
    const events = fakeEvents();
    wireBootScreen(screen, events);
    events.emit('selfUpdate.checking');
    events.emit('selfUpdate.upToDate');
    events.emit('selfUpdate.finished', { outcome: 'up-to-date' });
    assert.deepEqual(screen.log.map(row => row.slice(0, 2)), [['stage', 'checking'], ['stage', 'upToDate'], ['finish', 450], ['finish', 120]]);
});

test('a found update keeps the screen up through download and install — finished with outcome "updated" must NOT close it (the page reloads)', () => {
    const screen = fakeScreen();
    const events = fakeEvents();
    wireBootScreen(screen, events);
    events.emit('selfUpdate.checking');
    events.emit('selfUpdate.started', { branch: 'main' });
    events.emit('selfUpdate.applied', { branch: 'main' });
    events.emit('selfUpdate.finished', { outcome: 'updated' });
    assert.deepEqual(screen.log.map(row => row[1]), ['checking', 'downloading', 'installed']);
    assert.equal(screen.log.some(row => row[0] === 'finish'), false);
});

test('a run with nothing to say (cooling down / not a git install) closes the screen right away', () => {
    const screen = fakeScreen();
    const events = fakeEvents();
    wireBootScreen(screen, events);
    events.emit('selfUpdate.finished', { outcome: 'unavailable' });
    assert.deepEqual(screen.log, [['finish', 120]]);
});

test('without a document (Node) there is no screen, and wiring a missing screen is harmless', () => {
    assert.equal(createBootScreen(undefined), null);
    assert.equal(typeof wireBootScreen(null, fakeEvents()), 'function');
});

test('with a sync waiting, the screen does NOT close after the update check — it moves to "syncing" and follows the sync until it finishes', () => {
    const screen = fakeScreen();
    const events = fakeEvents();
    wireBootScreen(screen, events, { holdForSync: true });
    events.emit('selfUpdate.checking');
    events.emit('selfUpdate.upToDate');
    events.emit('selfUpdate.finished', { outcome: 'up-to-date' });
    assert.equal(screen.log.some(row => row[0] === 'finish'), false, 'still open');
    assert.equal(screen.log.at(-1)[1], 'syncing');
    events.emit('sync.progress', { progress: { target: 'device:Phone', phase: 'syncing', done: 3, total: 12, path: 'chats/a/b.jsonl' } });
    events.emit('sync.finished', { peers: [] });
    assert.deepEqual(screen.log.slice(-2).map(row => row.slice(0, 2)), [['stage', 'syncDone'], ['finish', 500]]);
});

test('without a sync waiting the screen behaves exactly as before, and sync events are ignored', () => {
    const screen = fakeScreen();
    const events = fakeEvents();
    wireBootScreen(screen, events);
    events.emit('selfUpdate.upToDate');
    events.emit('sync.progress', { progress: { target: 'github', phase: 'syncing', done: 1, total: 2 } });
    events.emit('sync.finished', {});
    assert.deepEqual(screen.log.map(row => row.slice(0, 2)), [['stage', 'upToDate'], ['finish', 450]]);
});

test('a failed update check still leads to the sync, and the sync stage carries its own text, progress and an idle timeout', () => {
    const rows = [];
    const screen = { setStage: (name, options) => rows.push([name, options]), finish: () => rows.push(['finish']) };
    const events = fakeEvents();
    wireBootScreen(screen, events, { holdForSync: true });
    events.emit('selfUpdate.failed');
    assert.equal(rows.at(-1)[0], 'syncing');
    assert.ok(rows.at(-1)[1].timeoutMs > 0, 'an idle timeout releases the interface if the sync stalls');
    events.emit('sync.progress', { progress: { target: 'github', phase: 'syncing', done: 5, total: 10, path: 'a/b.png' } });
    const [, options] = rows.at(-1);
    assert.match(options.text, /Syncing with GitHub: 5\/10/);
    assert.ok(options.progress > 0.7 && options.progress < 1);
});

test('progress events that arrive before the sync stage began (or with no progress) do not move the screen', () => {
    const screen = fakeScreen();
    const events = fakeEvents();
    wireBootScreen(screen, events, { holdForSync: true });
    events.emit('sync.progress', { progress: { target: 'github', phase: 'syncing', done: 1, total: 2 } });
    assert.deepEqual(screen.log, []);
});

test('the boot stages know the two sync steps', () => {
    assert.ok(BOOT_STAGES.syncing.text.length > 0 && BOOT_STAGES.syncDone.progress === 1);
});

test('the class that hides ST\'s own splash is released only after that splash is gone — otherwise it flashes under the closing boot screen', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const classes = new Set();
    let splashPresent = true;
    const el = () => ({
        className: '', dataset: {}, style: {}, hidden: false, textContent: '',
        classList: { add: name => classes.add(`el:${name}`), remove: () => {} },
        setAttribute() {}, addEventListener() {}, remove() {},
        querySelector: () => el(),
    });
    const doc = {
        body: { append() {} },
        documentElement: { classList: { add: name => classes.add(name), remove: name => classes.delete(name) } },
        createElement: el,
        getElementById: id => (id === 'loader' && splashPresent ? {} : null),
    };
    const screen = createBootScreen(doc);
    assert.ok(classes.has('stme-boot-active'));
    screen.finish();
    t.mock.timers.tick(450 + 10);
    t.mock.timers.tick(450 + 10);
    assert.ok(classes.has('stme-boot-active'), 'the splash is still there — keep it hidden');
    splashPresent = false;
    t.mock.timers.tick(150);
    assert.equal(classes.has('stme-boot-active'), false, 'the splash is gone — release');
});
