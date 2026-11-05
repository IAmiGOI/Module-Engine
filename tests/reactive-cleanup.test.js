import test from 'node:test';
import assert from 'node:assert/strict';
import { signal, computed, effect } from '../cores/ui/reactive.js';

test('a computed made inside a recompute is disposed by the next recompute: old children stop running and nothing piles up', () => {
    const tick = signal(0);
    const events = signal(0);
    let childRuns = 0;
    const parent = computed(() => {
        events();
        return computed(() => { childRuns += 1; return tick(); });
    });
    for (let i = 1; i <= 50; i += 1) events.set(i);
    childRuns = 0;
    tick.set(1);
    assert.equal(childRuns, 1, 'only the live child recomputes, not fifty dead ones');
    assert.equal(parent()(), 1);
});

test('a recompute stops listening to signals it no longer reads, and a disposed effect never runs again', () => {
    const flag = signal(true);
    const a = signal(0);
    let runs = 0;
    const dispose = effect(() => { runs += 1; if (flag()) a(); });
    flag.set(false);
    runs = 0;
    a.set(1);
    assert.equal(runs, 0, 'a is no longer a dependency');
    dispose();
    flag.set(true);
    assert.equal(runs, 0);
});
