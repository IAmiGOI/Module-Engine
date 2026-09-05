import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { request } from '../libraries/shared/request.js';
import { createNotificationsCore } from '../cores/ui/notifications.js';

/** Управляемое время: автоснятие проверяется без настоящих пауз. */
function fakeClock() {
    let nextId = 0;
    const pending = new Map();
    return {
        schedule: (fn) => { nextId += 1; pending.set(nextId, fn); return nextId; },
        cancel: id => pending.delete(id),
        runAll: () => { for (const fn of [...pending.values()]) fn(); pending.clear(); },
        pendingCount: () => pending.size,
    };
}

function build() {
    const engine = createEngine();
    const clock = fakeClock();
    const host = engine.registerCaller('core.ui.notifications', 'cores', { tier: 'official' });
    const core = createNotificationsCore(host, { mount: node => node, schedule: clock.schedule, cancel: clock.cancel });
    return { engine, core, clock };
}

test('a notification shows up as data, with its tone — no DOM anywhere in the Ядро', () => {
    const { core } = build();

    core.notify({ tone: 'ok', text: 'Saved 1 connection' });

    assert.deepEqual(core.items().map(item => [item.tone, item.text]), [['ok', 'Saved 1 connection']]);
});

test('an empty message is refused instead of showing a blank floating box', () => {
    const { core } = build();

    assert.throws(() => core.notify({ text: '   ' }), /"text" is required/);
});

test('a repeated message extends the one already showing instead of stacking a copy', () => {
    const { core } = build();
    core.notify({ tone: 'error', text: 'Failed to fetch' });

    core.notify({ tone: 'error', text: 'Failed to fetch' });

    assert.equal(core.items().length, 1, 'pressing Save five times must not fill the corner with five identical lines');
});

test('the same text with a DIFFERENT tone is a different message — success and failure must not be collapsed together', () => {
    const { core } = build();
    core.notify({ tone: 'ok', text: 'demo' });

    core.notify({ tone: 'error', text: 'demo' });

    assert.equal(core.items().length, 2);
});

test('a notification disappears on its own — it is temporary by nature', () => {
    const { core, clock } = build();
    core.notify({ tone: 'ok', text: 'Saved' });

    clock.runAll();

    assert.deepEqual(core.items(), []);
});

test('only the newest few stay — beyond that it stops being a notification and becomes a feed', () => {
    const { core } = build();

    for (let i = 1; i <= 7; i += 1) core.notify({ text: `message ${i}` });

    assert.deepEqual(core.items().map(item => item.text), ['message 4', 'message 5', 'message 6', 'message 7']);
});

test('dismissing by hand cancels its timer too — a stale timer must not fire against a later message', () => {
    const { core, clock } = build();
    const id = core.notify({ text: 'Saved' });

    core.dismiss(id);

    assert.deepEqual(core.items(), []);
    assert.equal(clock.pendingCount(), 0);
});

test('any Ядро or Модуль can notify over the bus — that is the whole point of it being one shared surface', async () => {
    const { engine, core } = build();
    const moduleHost = engine.registerCaller('module.demo', 'modules', { tier: 'community', allowedContracts: ['ui.notify'] });

    const result = await request(moduleHost.cores, 'ui.notify', { params: { tone: 'ok', text: 'from a Module' } });

    assert.equal(result.ok, true);
    assert.deepEqual(core.items().map(item => item.text), ['from a Module']);
});

test('a Module without the right cannot spam the corner', async () => {
    const { engine, core } = build();
    const moduleHost = engine.registerCaller('module.rude', 'modules', { tier: 'community', allowedContracts: [] });

    const result = await request(moduleHost.cores, 'ui.notify', { params: { text: 'let me in' } });

    assert.equal(result.ok, false);
    assert.deepEqual(core.items(), []);
});

test('the rendered tree is a floating stack, not something living inside the page flow', () => {
    const { core } = build();
    core.notify({ tone: 'ok', text: 'Saved' });

    const tree = core.tree();

    assert.match(tree.props.class, /stme-floating/);
    assert.match(tree.props.class, /top-left/);
});

test('unregister() clears pending timers — a torn-down Ядро must not fire into nothing later', () => {
    const { core, clock } = build();
    core.notify({ text: 'Saved' });

    core.unregister();

    assert.equal(clock.pendingCount(), 0);
});
