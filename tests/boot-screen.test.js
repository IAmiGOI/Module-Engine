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
