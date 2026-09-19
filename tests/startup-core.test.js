import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { createStartupCore } from '../cores/startup/index.js';

/** Ядро запуска на настоящей шине: остальные Ядра — заглушки, записывающие порядок вызовов. */
function build({ plan = false, update = { outcome: 'up-to-date' }, failUpdate = false, failStart = false, failPlan = false, failBackgrounds = false } = {}) {
    const engine = createEngine();
    const order = [];
    const bus = engine.buses.cores;
    bus.register('sync.planLoad', () => { order.push('sync.planLoad'); if (failPlan) throw new Error('config unreadable'); return plan; });
    bus.register('selfUpdate.run', () => { order.push('selfUpdate.run'); if (failUpdate) throw new Error('git is down'); return update; });
    bus.register('backgrounds.sync', () => { order.push('backgrounds.sync'); if (failBackgrounds) throw new Error('repo unreachable'); return { outcome: 'synced' }; });
    bus.register('sync.start', () => { order.push('sync.start'); if (failStart) throw new Error('rooms failed'); return true; });
    bus.register('sync.runOnLoad', () => { order.push('sync.runOnLoad'); return { outcome: 'done' }; });
    const screen = { finishes: [], finish(options) { this.finishes.push(options); } };
    const wired = [];
    const logs = { info: [], warn: [] };
    const core = createStartupCore(engine.registerCaller('core.startup', 'cores', { tier: 'official' }), {
        screen,
        wireBoot: (given, events, options) => { order.push('wireBoot'); wired.push({ screen: given, events, options }); return () => {}; },
        log: { info: (...args) => logs.info.push(args), warn: (...args) => logs.warn.push(args) },
    });
    return { engine, core, order, screen, wired, logs };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('the order is: decide about the sync, wire the loading screen, THEN the update check — and only after it the backgrounds and the sync', async () => {
    const { core, order } = build();
    await core.begin();
    await settle();
    assert.deepEqual(order.slice(0, 3), ['sync.planLoad', 'wireBoot', 'selfUpdate.run'], 'the screen is wired before the update starts, so no early event is missed');
    assert.deepEqual([...order.slice(3)].sort(), ['backgrounds.sync', 'sync.start']);
});

test('the loading screen is told whether a sync is waiting, and it is handed the real screen and the engine events', async () => {
    const held = build({ plan: true });
    await held.core.begin();
    assert.equal(held.wired[0].options.holdForSync, true);
    assert.equal(held.wired[0].screen, held.screen);
    assert.ok(typeof held.wired[0].events.subscribe === 'function');
    const free = build({ plan: false });
    await free.core.begin();
    assert.equal(free.wired[0].options.holdForSync, false);
});

test('with a sync waiting: it starts, runs the page-load pass, and the loading screen is released at the end', async () => {
    const { core, order, screen } = build({ plan: true });
    const result = await core.begin();
    assert.ok(order.indexOf('sync.start') < order.indexOf('sync.runOnLoad'));
    assert.deepEqual(screen.finishes, [{ afterMs: 300 }]);
    assert.equal(result.holdForSync, true);
});

test('without a sync waiting: the sync core is still started (rooms, schedule), but no page-load pass runs and the screen is not closed here', async () => {
    const { core, order, screen } = build({ plan: false });
    await core.begin();
    assert.ok(order.includes('sync.start'));
    assert.equal(order.includes('sync.runOnLoad'), false);
    assert.deepEqual(screen.finishes, [], 'the update events close the screen themselves');
});

test('when the update was installed the page is about to reload, so nothing else is started', async () => {
    const { core, order } = build({ plan: true, update: { outcome: 'updated' } });
    const result = await core.begin();
    assert.deepEqual(order, ['sync.planLoad', 'wireBoot', 'selfUpdate.run']);
    assert.equal(result.outcome, 'updated');
});

test('a failing update check releases the loading screen and starts nothing else, instead of leaving the screen up', async () => {
    const { core, order, screen, logs } = build({ failUpdate: true });
    const result = await core.begin();
    assert.equal(result.outcome, 'update-failed');
    assert.deepEqual(screen.finishes, [{ afterMs: 0 }]);
    assert.equal(order.includes('sync.start'), false);
    assert.match(String(logs.warn[0]), /Self-update skipped/);
});

test('a failing plan means "no sync waiting" — the page still loads normally', async () => {
    const { core, wired, screen } = build({ failPlan: true });
    await core.begin();
    assert.equal(wired[0].options.holdForSync, false);
    assert.deepEqual(screen.finishes, []);
});

test('a sync that cannot start does not run the pass, is reported, and still releases the screen', async () => {
    const { core, order, screen, logs } = build({ plan: true, failStart: true });
    await core.begin();
    assert.equal(order.includes('sync.runOnLoad'), false);
    assert.deepEqual(screen.finishes, [{ afterMs: 300 }]);
    assert.ok(logs.warn.some(entry => /Sync skipped/.test(String(entry))));
});

test('a failing backgrounds sync is only reported and never blocks the rest', async () => {
    const { core, order, logs } = build({ plan: true, failBackgrounds: true });
    await core.begin();
    await settle();
    assert.ok(order.includes('sync.runOnLoad'));
    assert.ok(logs.warn.some(entry => /Backgrounds sync skipped/.test(String(entry))));
});

test('the self-update outcome is always printed to the console, and beginning twice does nothing the second time', async () => {
    const { core, logs, order } = build({ update: { outcome: 'unavailable', reason: 'not a git install' } });
    await core.begin();
    assert.match(logs.info.map(entry => entry.join(' ')).join('\n'), /Self-update: unavailable not a git install/);
    const before = order.length;
    assert.deepEqual(await core.begin(), { outcome: 'already' });
    assert.equal(order.length, before);
});

test('startup.begin is also reachable as a contract on the cores bus', async () => {
    const { engine, order } = build();
    const { request } = await import('../libraries/shared/request.js');
    const result = await request(engine.buses.cores, 'startup.begin', { params: {} });
    assert.equal(result.ok, true);
    assert.ok(order.includes('selfUpdate.run'));
});
