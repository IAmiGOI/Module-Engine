import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { createGuideAvatar, BASE_URL } from '../cores/guide/avatar.js';

/** Real engine, controllable clock/timer/workers/storage/checklist — same shape as activity-light.test.js's own setup(). */
function setup({ tierHours = [5, 10], chibiPoses = [], nekoUnlocked = false, workers = [], stored = {}, onTierUp } = {}) {
    const engine = createEngine();
    const bus = engine.buses.cores;
    const host = engine.registerCaller('core.guide.avatar', 'cores', { tier: 'official' });
    let clock = 0;
    let workersNow = workers;
    let neko = nekoUnlocked;
    const announced = [];
    bus.register('storage.settings.get', ({ key, fallback }) => stored[key] ?? fallback);
    bus.register('storage.settings.set', ({ key, value }) => { stored[key] = value; return true; });
    bus.register('model.workers.status', () => workersNow);
    const timers = [];
    const saveTimers = [];
    const avatar = createGuideAvatar(host, {
        now: () => clock,
        tierHours, chibiPoses: () => chibiPoses, getNekoUnlocked: async () => neko,
        onTierUp: tier => { announced.push(tier); onTierUp?.(tier); },
        schedule: fn => { const id = { fn }; timers.push(id); return id; },
        cancel: id => { const i = timers.indexOf(id); if (i >= 0) timers.splice(i, 1); },
        scheduleTimeout: fn => { const id = { fn }; saveTimers.push(id); return id; },
        cancelTimeout: id => { const i = saveTimers.indexOf(id); if (i >= 0) saveTimers.splice(i, 1); },
    });
    return {
        engine, avatar, timers, announced,
        setClock: value => { clock = value; },
        setWorkers: list => { workersNow = list; },
        setNeko: value => { neko = value; },
        tick: async () => { for (const t of [...timers]) await t.fn(); },
        flushSave: async () => { for (const t of [...saveTimers]) await t.fn(); },
        fileName: () => decodeURIComponent(avatar.url.peek().slice(BASE_URL.length)),
    };
}

test('load() with no prior usage and no trouble resolves the plain tier-1 file — a fresh install starts fully dressed, no health alert', async () => {
    const t = setup();
    await t.avatar.load();
    assert.equal(t.fileName(), 'tier-1-full.png');
});

test('a "down" worker turns the avatar red immediately on load, independent of the tick interval', async () => {
    const t = setup({ workers: [{ state: 'down' }] });
    await t.avatar.load();
    assert.equal(t.fileName(), 'status-red.png');
});

test('the health event (model.workers.status.changed) refreshes the avatar right away, without waiting for the next tick', async () => {
    const t = setup();
    await t.avatar.load();
    assert.equal(t.fileName(), 'tier-1-full.png');
    t.setWorkers([{ state: 'down' }]);
    t.engine.events.emit('model.workers.status.changed', { workers: [{ state: 'down' }] });
    await new Promise(resolve => setTimeout(resolve, 0)); // the handler is async (`void refreshHealth()`) — let its microtasks settle
    assert.equal(t.fileName(), 'status-red.png');
});

test('noteReply() matches a chibi pose against the RAW text immediately — no need to wait for a tick', async () => {
    const t = setup({ chibiPoses: [{ id: 'music', keywords: ['song'] }] });
    await t.avatar.load();
    t.avatar.noteReply('<think>maybe suggest a song</think>Here is one.');
    assert.equal(t.fileName(), 'chibi-music.png');
});

test('red/green health REPLACES a matched chibi pose with chibi angry/happy — not the plain status image, since a chibi pose is active', async () => {
    const t = setup({ chibiPoses: [{ id: 'music', keywords: ['song'] }], workers: [{ state: 'down' }] });
    await t.avatar.load();
    t.avatar.noteReply('a song for you');
    assert.equal(t.fileName(), 'chibi-angry.png');
});

test('accumulated open time crosses tier thresholds across ticks, and the debounced save persists it under the guide\'s own namespace', async () => {
    const stored = {};
    const t = setup({ tierHours: [1, 2], stored });
    await t.avatar.load();
    t.setClock(0);
    // 3 ticks of 25 minutes each = 1h15 — past the first threshold (1h), still under the second (2h).
    for (let i = 1; i <= 3; i += 1) { t.setClock(i * 25 * 60 * 1000); await t.tick(); }
    assert.equal(t.fileName(), 'tier-1-shorts.png');
    await t.flushSave();
    assert.ok(stored.avatarState.usageMs >= 74 * 60 * 1000, 'debounced save actually wrote the accumulated ms');
});

test('onTierUp() fires once per crossed threshold, in order, as soon as the tick pushes usage past it', async () => {
    const t = setup({ tierHours: [1, 2] });
    await t.avatar.load();
    // one big jump straight past both thresholds — she should still announce 2 then 3, not skip straight to 3.
    t.setClock(3 * 60 * 60 * 1000);
    await t.tick();
    assert.deepEqual(t.announced, [2, 3]);
    // further ticks at the same (or higher) usage must not re-announce anything already announced.
    await t.tick();
    assert.deepEqual(t.announced, [2, 3]);
});

test('the announced tier persists across a reload — she does not re-announce a tier she already announced in a previous session', async () => {
    const stored = {};
    const first = setup({ tierHours: [1, 2], stored });
    await first.avatar.load();
    first.setClock(90 * 60 * 1000); // past the first threshold only
    await first.tick();
    assert.deepEqual(first.announced, [2]);
    await first.flushSave();

    const second = setup({ tierHours: [1, 2], stored });
    await second.avatar.load(); // reads the same `stored` — announcedTier: 2 carried over
    assert.deepEqual(second.announced, [], 'no re-announcement just from loading at the same tier');
    second.setClock(0);
    second.setClock(150 * 60 * 1000); // now past the second threshold too
    await second.tick();
    assert.deepEqual(second.announced, [3], 'only the newly-crossed tier, not tier 2 again');
});

test('neko, once unlocked, prefixes the tier file — and normalFallbackFor() gives the window the plain path to fall back to if that file 404s', async () => {
    const t = setup({ nekoUnlocked: true });
    await t.avatar.load();
    assert.equal(t.fileName(), 'neko-tier-1-full.png');
    const fallback = t.avatar.normalFallbackFor(t.avatar.url.peek());
    assert.equal(decodeURIComponent(new URL(fallback).pathname.split('/').pop()), 'tier-1-full.png');
});

test('normalFallbackFor() returns null for a URL that was never neko-prefixed — nothing to fall back to', async () => {
    const t = setup();
    await t.avatar.load();
    assert.equal(t.avatar.normalFallbackFor(t.avatar.url.peek()), null);
});

test('unregister() clears the tick timer and the health subscription without throwing', async () => {
    const t = setup();
    await t.avatar.load();
    assert.equal(t.timers.length, 1);
    assert.doesNotThrow(() => t.avatar.unregister());
    assert.equal(t.timers.length, 0);
});
