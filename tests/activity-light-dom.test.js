import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityLightCore } from '../cores/ui/activity-light.js';
import { effect, signal } from '../cores/ui/reactive.js';

/**
 * Диагностический набор (найден живьём 2026-09-08): полоска пилюли в реальной
 * ST горела синим ВЕЧНО. Эти тесты проверяют ВСЮ цепочку покраски — Ядро +
 * сигнал + effect() из reactive.js + classList зоны, т.е. ровно то место,
 * которого не касались юнит-тесты activity-light.test.js (они проверяли только
 * маппинг событий в состояние).
 */

// Мок DOM-узла с classList так же, как в реальном браузере.
function fakeZone() {
    const classes = new Set();
    return {
        classList: {
            add: (...cs) => cs.forEach(c => classes.add(c)),
            remove: (...cs) => cs.forEach(c => classes.delete(c)),
            contains: c => classes.has(c),
        },
        _classes: classes,
    };
}

/** Копия логики покраски зоны из index.js (addLauncherDock). */
function mountLight(zone, activityState) {
    let previousClass = null;
    effect(() => {
        const next = `stme-light-${activityState()}`;
        if (previousClass) zone.classList.remove(previousClass);
        zone.classList.add(next);
        previousClass = next;
    });
}

test('the full chain repaints the zone: event → core state → signal → effect → classList', () => {
    const subs = new Map(); // eventName -> [callbacks], как настоящая шина
    const engineHost = { events: { subscribe: (name, cb) => { (subs.get(name) ?? subs.set(name, []).get(name)).push(cb); return () => {}; } } };
    const core = createActivityLightCore(engineHost);
    core.load();

    const zone = fakeZone();
    mountLight(zone, core.state);
    assert.ok(zone.classList.contains('stme-light-idle'), 'mount paints idle');

    // Событие приходит ЧЕРЕЗ шину (host.events.subscribe), как в wiring.
    for (const cb of subs.get('generation.beforeSend') ?? []) cb({ runId: 'r1' });
    assert.ok(zone.classList.contains('stme-light-working'), 'working repaints the zone');
    assert.ok(!zone.classList.contains('stme-light-idle'), 'old class removed');
});

test('a state that was already set BEFORE the dock mounted is reflected immediately', () => {
    const engineHost = { events: { subscribe: () => () => {} } };
    const core = createActivityLightCore(engineHost);
    core.load();
    core.onEvent('generation.beforeSend', {}); // working ДО монтирования дока
    assert.equal(core.state.peek(), 'working');

    const zone = fakeZone();
    mountLight(zone, core.state);
    // effect() запускается сразу при подписке и читает актуальное значение —
    // если эта проверка падает, «вечно синий» вернулся бы тем же путём.
    assert.ok(zone.classList.contains('stme-light-working'), 'initial paint must use the CURRENT value, not the default');
});

test('notify blink survives a working event and returns to idle via the hold timer', () => {
    const timers = [];
    const engineHost = { events: { subscribe: () => () => {} } };
    const core = createActivityLightCore(engineHost, {
        schedule: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
        cancel: t => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    });
    core.load();

    const zone = fakeZone();
    mountLight(zone, core.state);

    core.onEvent('notifications.shown', {});
    assert.ok(zone.classList.contains('stme-light-notify'));

    core.onEvent('generation.sending', {}); // рабочий сигнал НЕ сбивает мигание
    assert.ok(zone.classList.contains('stme-light-notify'), 'working must not steal the blink');

    timers.at(-1).fn(); // тик удержания вышел
    assert.ok(zone.classList.contains('stme-light-idle'));
});
