import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { createActivityLightCore, ACTIVITY_STATES } from '../cores/ui/activity-light.js';

/** Real engine: ядро на Шине ядер, события гоняются как вживую. */
function setup() {
    const engine = createEngine();
    const host = engine.registerCaller('core.ui.activityLight', 'cores', { tier: 'official' });
    // Управляемые таймеры: конечные состояния обязаны возвращаться в idle САМИ.
    const timers = [];
    const core = createActivityLightCore(host, {
        schedule: (fn, ms) => { const id = { fn, ms }; timers.push(id); return id; },
        cancel: timer => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1); },
    });
    core.load();
    return { engine, core, timers };
}

test('idle by default; generation start/end drives working → success → idle automatically', async () => {
    const { engine, core, timers } = setup();
    assert.equal(core.state.peek(), 'idle');

    engine.events.emit('generation.beforeSend', { runId: 'r1' });
    assert.equal(core.state.peek(), 'working');

    engine.events.emit('generation.completed', { runId: 'r1', outcome: 'ended' });
    assert.equal(core.state.peek(), 'success');
    assert.equal(timers.length, 1, 'final state holds a return-to-idle timer');

    timers[0].fn(); // тик вышел
    assert.equal(core.state.peek(), 'idle');
});

test('stopped WITHOUT error is yellow (warning), not red — user asked for that distinction', () => {
    const { engine, core } = setup();
    engine.events.emit('generation.completed', { outcome: 'stopped' });
    assert.equal(core.state.peek(), 'warning');
    // А вот прерванный ошибкой прогон — красный.
    engine.events.emit('generation.aborted', { error: 'x' });
    assert.equal(core.state.peek(), 'error');
});

test('every failure source maps to red: prepareFailed, tracking/summary/selfUpdate failures', () => {
    const { engine, core } = setup();
    for (const [event, payload] of [
        ['generation.prepareFailed', { error: 'x' }],
        ['tracking.poll.failed', { message: 'x' }],
        ['summary.foldFailed', { message: 'x' }],
        ['selfUpdate.failed', {}],
    ]) {
        engine.events.emit(event, payload);
        assert.equal(core.state.peek(), 'error', event);
        core.onEvent('__reset__', {}); // нет правила — состояние не меняется, гасим сами
        core.state.set('idle');
    }
});

test('non-generation sources work too: tracking poll and selfUpdate', () => {
    const { engine, core } = setup();
    engine.events.emit('tracking.poll.started', { trackerId: 't' });
    assert.equal(core.state.peek(), 'working');
    engine.events.emit('tracking.poll.completed', { trackerId: 't' });
    assert.equal(core.state.peek(), 'success');

    engine.events.emit('selfUpdate.started', {});
    assert.equal(core.state.peek(), 'working');
    engine.events.emit('selfUpdate.applied', {});
    assert.equal(core.state.peek(), 'success');
});

test('notification (notify) overrides anything and BLINKS — and a working event cannot steal the blink', () => {
    const { engine, core } = setup();
    engine.events.emit('generation.beforeSend', {});
    assert.equal(core.state.peek(), 'working');

    engine.events.emit('notifications.shown', { tone: 'ok' });
    assert.equal(core.state.peek(), 'notify', 'notification overrides working');

    // Пока мигаем, рабочее событие НЕ перебивает белый — иначе мигание потерять легко.
    engine.events.emit('generation.sending', {});
    assert.equal(core.state.peek(), 'notify');

    // Тик вышел — вернулись в idle, и обычные события снова работают.
    // (timer for notify is timers[0] — created by the notify transition)
});

test('notify hold timer returns to idle; summary fold success maps to green', async () => {
    const { engine, core, timers } = setup();
    engine.events.emit('notifications.shown', { tone: 'muted' });
    assert.equal(core.state.peek(), 'notify');
    const notifyTimer = timers.at(-1);
    notifyTimer.fn();
    assert.equal(core.state.peek(), 'idle');

    engine.events.emit('summary.folded', { count: 2 });
    assert.equal(core.state.peek(), 'success');
});

test('unknown events are ignored — adding a new source is opt-in via the map', () => {
    const { engine, core } = setup();
    engine.events.emit('st.chatChanged', {});
    engine.events.emit('some.random.event', {});
    assert.equal(core.state.peek(), 'idle');
});
