import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { normalizeWidget, nextInstanceId, widgetBlockId, isValidInstance, safeBodyHtml, WIDGET_SIZE_LIMITS, widgetCss } from '../libraries/shared/widget-contract.js';
import clock, { formatClock, msToNextMinute } from '../widgets/clock/widget.js';
import { scanWidgetFolders, widgetsDir } from '../tools/widgets-index.mjs';

const good = { id: 'demo', title: ' Demo ', create: () => ({ html: () => '<div class="hb"></div>' }) };

test('a widget definition is validated and normalized without throwing: id, title, create, rights, size clamped to the limits', () => {
    const ok = normalizeWidget(good);
    assert.equal(ok.ok, true);
    assert.deepEqual([ok.widget.title, ok.widget.rights, ok.widget.size], ['Demo', [], { w: 220, h: 130 }]);
    const huge = normalizeWidget({ ...good, size: { w: 5000, h: 5 } });
    assert.deepEqual(huge.widget.size, { w: WIDGET_SIZE_LIMITS.maxW, h: WIDGET_SIZE_LIMITS.minH });
    for (const bad of [null, 'x', { ...good, id: 'Bad Id' }, { ...good, id: '' }, { ...good, title: '  ' }, { ...good, create: null }, { ...good, rights: [1] }, { ...good, rights: 'x' }]) {
        const result = normalizeWidget(bad);
        assert.equal(result.ok, false);
        assert.ok(result.error.length > 0);
    }
});

test('instances get the first free id (a widget can be placed several times); block ids are namespaced', () => {
    assert.equal(nextInstanceId([]), 'w1');
    assert.equal(nextInstanceId(['w1', 'w3']), 'w2');
    assert.equal(widgetBlockId('w2'), 'widget:w2');
    assert.equal(isValidInstance({ html: () => '' }), true);
    assert.equal(isValidInstance({}), false);
    assert.equal(isValidInstance(null), false);
});

test('a widget that throws or returns junk does not break the frame: the block shows the error text instead', () => {
    const esc = value => String(value).replace(/</g, '&lt;');
    assert.ok(safeBodyHtml({ html: () => '<div>ok</div>' }, esc).includes('ok'));
    assert.ok(safeBodyHtml({ html: () => { throw new Error('boom <b>'); } }, esc).includes('Widget error: boom &lt;b>'));
    assert.ok(safeBodyHtml({ html: () => 42 }, esc).includes('no HTML'));
    assert.ok(widgetCss({ text: '#111', muted: '#222', accent: '#333' }).includes('#333'));
});

test('clock: 24-hour and 12-hour formatting (the period is separate, so the time stays short), two short date lines, and the timer is aimed at the next minute boundary', () => {
    const at = new Date(2026, 8, 26, 14, 5, 30, 0);
    assert.deepEqual([formatClock(at).time, formatClock(at).period], ['14:05', '']);
    assert.deepEqual([formatClock(at, { hour12: true }).time, formatClock(at, { hour12: true }).period], ['2:05', 'PM']);
    assert.deepEqual([formatClock(new Date(2026, 8, 26, 0, 7), { hour12: true }).time, formatClock(new Date(2026, 8, 26, 0, 7), { hour12: true }).period], ['12:07', 'AM']);
    assert.deepEqual([formatClock(new Date(2026, 8, 26, 12, 0), { hour12: true }).time, formatClock(new Date(2026, 8, 26, 12, 0), { hour12: true }).period], ['12:00', 'PM']);
    const { weekday, date } = formatClock(at, { locale: 'en-US' });
    assert.equal(weekday, 'Saturday');
    assert.equal(date, 'September 26');
    assert.equal(msToNextMinute(new Date(2026, 8, 26, 14, 5, 30, 0)), 30040);
    assert.equal(msToNextMinute(new Date(2026, 8, 26, 14, 5, 0, 0)), 60040);
});

test('the clock widget follows the contract, needs no rights, draws only its own block and remembers the format', async () => {
    assert.equal(normalizeWidget(clock).ok, true);
    assert.deepEqual(clock.rights, []);
    assert.equal(clock.size.w, clock.size.h, 'the clock block is square');
    assert.ok(clock.size.w <= 160, 'and compact');
    const store = new Map();
    let invalidated = 0;
    const instance = clock.create({ now: () => new Date(2026, 8, 26, 9, 3), invalidate: () => { invalidated += 1; }, storage: { get: async key => store.get(key), set: async (key, value) => { store.set(key, value); } } });
    assert.equal(isValidInstance(instance), true);
    assert.ok(instance.html().includes('09:03'));
    instance.onAction('format');
    assert.ok(instance.html().includes('9:03') && instance.html().includes('>AM<'));
    assert.equal(store.get('hour12'), true);
    assert.equal(invalidated, 1);
    instance.onAction('nothing');
    assert.equal(invalidated, 1, 'an unknown action changes nothing');
    await instance.start();
    assert.ok(instance.html().includes('>AM<'), 'the saved format is restored on start');
    instance.stop();
    const source = readFileSync(new URL('../widgets/clock/widget.js', import.meta.url), 'utf8');
    assert.equal(/^\s*import\s/m.test(source), false, 'a widget file has no imports — no dependencies');
});

test('widgets/index.json lists exactly the widget folders that exist (run node tools/widgets-index.mjs after adding one)', () => {
    const listed = JSON.parse(readFileSync(new URL('../widgets/index.json', import.meta.url), 'utf8')).widgets;
    assert.deepEqual(listed, scanWidgetFolders());
    assert.ok(listed.includes('clock'));
    assert.ok(readdirSync(widgetsDir).includes('index.json'));
});
