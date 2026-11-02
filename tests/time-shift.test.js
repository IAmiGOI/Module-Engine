import test from 'node:test';
import assert from 'node:assert/strict';
import { shiftTimeLabel, periodForHour } from '../libraries/core/time-shift.js';

test('a 24-hour clock shifts by minutes and keeps the rest of the label', () => {
    assert.equal(shiftTimeLabel('Day 1, 08:00 (Morning)', 90), 'Day 1, 09:30 (Morning)');
    assert.equal(shiftTimeLabel('Day 3, 23:50 (Night)', 20), 'Day 3, 00:10 (Night)');
});

test('a 12-hour clock keeps its AM/PM format and rolls the period over', () => {
    assert.equal(shiftTimeLabel('2026 March 5 09:20 AM (Morning)', 120), '2026 March 5 11:20 AM (Morning)');
    assert.equal(shiftTimeLabel('2026 March 5 11:30 PM (Night)', 60), '2026 March 5 12:30 AM (Night)');
});

test('a negative shift moves the clock backwards too', () => {
    assert.equal(shiftTimeLabel('08:00 (Morning)', -60), '07:00 (Morning)');
    assert.equal(shiftTimeLabel('00:10 (Night)', -20), '23:50 (Night)');
});

test('the period word follows the shifted hour when it is present', () => {
    assert.equal(shiftTimeLabel('08:00 (Morning)', 240), '12:00 (Afternoon)');
    assert.equal(shiftTimeLabel('16:00 (Afternoon)', 120), '18:00 (Evening)');
    assert.equal(shiftTimeLabel('20:00 (Evening)', 300), '01:00 (Night)');
    assert.equal(shiftTimeLabel('01:00 (Night)', 300), '06:00 (Morning)');
});

test('a label without a clock is left alone: null, not a made-up time', () => {
    assert.equal(shiftTimeLabel('unknown', 30), null);
    assert.equal(shiftTimeLabel('', 30), null);
    assert.equal(shiftTimeLabel('Day 4 (Morning)', 30), null);
});

test('periodForHour() names the four periods exactly as the presets do', () => {
    assert.equal(periodForHour(3), 'Night');
    assert.equal(periodForHour(5), 'Morning');
    assert.equal(periodForHour(12), 'Afternoon');
    assert.equal(periodForHour(17), 'Evening');
    assert.equal(periodForHour(21), 'Night');
});
