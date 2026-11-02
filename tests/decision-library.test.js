import test from 'node:test';
import assert from 'node:assert/strict';
import {
    setLevel, removeOnLeavingRoster, setPlan, interruptPlan, duePlans, completePlan, planFor, librarySection,
} from '../libraries/core/decision-library.js';
import { parseClock, advanceClock, formatDuration } from '../libraries/core/decision-clock.js';

test('the library accepts levels 1–5, and level 5 only while the character is in the roster', () => {
    const one = setLevel({}, { character: 'Lena', level: 1 });
    assert.equal(one.ok, true);
    assert.equal(one.library.lena.level, 1);
    assert.equal(setLevel({}, { character: 'Lena', level: 5 }).ok, false);
    assert.equal(setLevel({}, { character: 'Lena', level: 5, inRoster: true }).ok, true);
    assert.equal(setLevel({}, { character: 'Lena', level: 9 }).ok, false);
});

test('leaving the roster deletes a level-5 record and keeps the others', () => {
    const five = setLevel({}, { character: 'One-off', level: 5, inRoster: true }).library;
    assert.deepEqual(removeOnLeavingRoster(five, { character: 'One-off' }).library, {});
    const one = setLevel({}, { character: 'Lena', level: 1 }).library;
    assert.equal(removeOnLeavingRoster(one, { character: 'Lena' }).library.lena.level, 1);
});

test('plan durations are bounded by level: 3–12 h for level 1, days for level 2, and level 4 takes none', () => {
    const tooShort = setPlan([], { character: 'Lena', level: 1, summary: 'Wait.', durationMinutes: 60 });
    assert.equal(tooShort.ok, false);
    assert.match(tooShort.error, /3–12 hours/);
    const good = setPlan([], { character: 'Lena', level: 1, summary: 'Wait.', durationMinutes: 360, clockMinutes: 100 });
    assert.equal(good.ok, true);
    assert.equal(good.plan.dueAt, 460);
    assert.equal(setPlan([], { character: 'Lena', level: 4, summary: 'Nothing.', durationMinutes: 600 }).ok, false);
});

test('a character in the roster gets an approximate plan without a due time', () => {
    const applied = setPlan([], { character: 'Lena', level: 1, summary: 'Stay in the room.', inRoster: true, clockMinutes: 100 });
    assert.equal(applied.ok, true);
    assert.equal(applied.plan.dueAt, null);
    assert.equal(applied.plan.interrupted, true);
    assert.equal(applied.plan.approximate, true);
});

test('due plans come oldest-first, and only unfinished, non-interrupted timed plans', () => {
    const plans = [
        { character: 'B', dueAt: 200, interrupted: false },
        { character: 'A', dueAt: 100, interrupted: false },
        { character: 'C', dueAt: 50, interrupted: true },
        { character: 'D', dueAt: 60, interrupted: false, resolvedAt: 1 },
    ];
    assert.deepEqual(duePlans(plans, 250).map(plan => plan.character), ['A', 'B']);
    assert.deepEqual(duePlans(plans, 90).map(plan => plan.character), []);
});

test('interrupting a plan clears its due time, and completing it removes it from the queue', () => {
    const plans = setPlan([], { character: 'Lena', level: 1, summary: 'Wait.', durationMinutes: 300 }).plans;
    const interrupted = interruptPlan(plans, { character: 'Lena' });
    assert.equal(interrupted[0].dueAt, null);
    assert.equal(duePlans(interrupted, 1000).length, 0);
    const done = completePlan(plans, { character: 'Lena', now: 5 });
    assert.equal(done[0].resolvedAt, 5);
    assert.equal(planFor(done, { character: 'Lena' }), null);
});

test('the library section is compact and uses RP minutes to say how long a plan has left', () => {
    const library = setLevel({}, { character: 'Lena', level: 1 }).library;
    const plans = setPlan([], { character: 'Lena', level: 1, summary: 'Find the key.', durationMinutes: 180, clockMinutes: 0 }).plans;
    const section = librarySection(library, plans, 60);
    assert.match(section, /Lena \(level 1\): Find the key/);
    assert.match(section, /due in 2 h/);
});

test('the clock reads a day and a clock, and shifts by minutes', () => {
    assert.deepEqual(parseClock('Day 3, 08:30 (Morning)'), { minutes: 3 * 1440 + 510, day: 3, hour: 8, minute: 30 });
    assert.equal(parseClock('11:30 PM').minutes, 23 * 60 + 30);
    assert.equal(parseClock('unknown'), null);
    assert.deepEqual(advanceClock({ minutes: 100 }, 30, { now: () => 1 }), { minutes: 130, updatedAt: 1 });
    assert.equal(formatDuration(180), '3 h');
    assert.equal(formatDuration(1500), '1 d 1 h');
});
