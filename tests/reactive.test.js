import test from 'node:test';
import assert from 'node:assert/strict';
import { signal, computed, effect } from '../cores/ui/reactive.js';

test('signal() reads back what was written, and reflects the initial value before any write', () => {
    const count = signal(0);
    assert.equal(count(), 0);

    count.set(5);
    assert.equal(count(), 5);
});

test('update() derives the next value from the current one', () => {
    const count = signal(1);
    count.update(n => n + 1);
    assert.equal(count(), 2);
});

test('peek() reads the current value without registering as a dependent', () => {
    const count = signal(0);
    let runs = 0;
    effect(() => { count.peek(); runs += 1; });

    count.set(1);

    assert.equal(runs, 1, 'peek() must not have created a dependency — the effect must not re-run');
});

test('set() with a value Object.is-equal to the current one is a no-op — no dependent re-runs', () => {
    const count = signal(5);
    let runs = 0;
    effect(() => { count(); runs += 1; });

    count.set(5);

    assert.equal(runs, 1, 'setting the same value must not trigger a re-run');
});

test('computed() re-evaluates only when a signal it actually reads changes, not an unrelated one', () => {
    const a = signal(1);
    const b = signal(100);
    let evaluations = 0;
    const doubled = computed(() => { evaluations += 1; return a() * 2; });

    assert.equal(doubled(), 2);
    assert.equal(evaluations, 1);

    b.set(999); // doubled() never read b — must not re-evaluate
    assert.equal(evaluations, 1);

    a.set(3);
    assert.equal(doubled(), 6);
    assert.equal(evaluations, 2);
});

test('computed() can chain off another computed()', () => {
    const base = signal(2);
    const doubled = computed(() => base() * 2);
    const quadrupled = computed(() => doubled() * 2);

    assert.equal(quadrupled(), 8);
    base.set(3);
    assert.equal(quadrupled(), 12);
});

test('effect() runs immediately on creation, before any signal changes at all', () => {
    let ran = false;
    effect(() => { ran = true; });
    assert.equal(ran, true);
});

test('effect() re-runs every time a signal it reads changes', () => {
    const count = signal(0);
    const seen = [];
    effect(() => seen.push(count()));

    count.set(1);
    count.set(2);

    assert.deepEqual(seen, [0, 1, 2]);
});

test('effect() can depend on a computed(), and re-runs when the computed\'s own underlying signal changes', () => {
    const base = signal(1);
    const doubled = computed(() => base() * 2);
    const seen = [];
    effect(() => seen.push(doubled()));

    base.set(5);

    assert.deepEqual(seen, [2, 10]);
});

test('the dispose function returned by effect() stops all future runs permanently', () => {
    const count = signal(0);
    let runs = 0;
    const dispose = effect(() => { count(); runs += 1; });

    dispose();
    count.set(1);
    count.set(2);

    assert.equal(runs, 1, 'no run must happen after dispose(), no matter how many times the signal changes afterward');
});

test('a dependent that re-subscribes to the SAME signal during its own re-run is neither skipped nor double-visited on that same set() call', () => {
    // Regression shape: set() snapshots `dependents` into an array before
    // iterating specifically so a dependent's own re-run (which re-reads the
    // signal, re-registering itself) can't corrupt the in-progress iteration
    // of the very Set it's still mutating.
    const trigger = signal(0);
    let runs = 0;
    effect(() => { trigger(); runs += 1; });

    trigger.set(1);

    assert.equal(runs, 2, 'exactly one extra run for the one set() call — not zero (skipped) and not more (double-visited)');
});
