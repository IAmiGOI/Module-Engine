import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatchQueue } from '../libraries/core/dispatch-queue.js';

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

test('a single enqueue() picks the only worker and resolves with run()\'s result', async () => {
    const queue = createDispatchQueue();
    const workers = [{ id: 'a' }];

    const result = await queue.enqueue(workers, worker => Promise.resolve(`ran on ${worker.id}`));

    assert.equal(result, 'ran on a');
});

test('two concurrent items go to two DIFFERENT idle workers rather than queueing behind one', async () => {
    const queue = createDispatchQueue();
    const workers = [{ id: 'a' }, { id: 'b' }];
    const started = [];
    const d1 = deferred();
    const d2 = deferred();

    const p1 = queue.enqueue(workers, worker => { started.push(worker.id); return d1.promise; });
    const p2 = queue.enqueue(workers, worker => { started.push(worker.id); return d2.promise; });
    await flushMicrotasks();

    assert.deepEqual(started.sort(), ['a', 'b'], 'both workers must have been dispatched to immediately, not queued');
    d1.resolve('r1'); d2.resolve('r2');
    assert.deepEqual(await Promise.all([p1, p2]), ['r1', 'r2']);
});

test('a third item queues behind the first two (both workers busy) and dispatches only once one frees', async () => {
    const queue = createDispatchQueue();
    const workers = [{ id: 'a' }, { id: 'b' }];
    const started = [];
    const d1 = deferred();
    const d2 = deferred();

    queue.enqueue(workers, worker => { started.push(worker.id); return d1.promise; });
    queue.enqueue(workers, worker => { started.push(worker.id); return d2.promise; });
    await flushMicrotasks();
    assert.equal(queue.queueLength(), 0, 'sanity — nothing queued yet, both workers were idle');

    const p3 = queue.enqueue(workers, worker => { started.push(worker.id); return Promise.resolve('r3'); });
    await flushMicrotasks();
    assert.equal(queue.queueLength(), 1, 'the third item must wait — both workers already have one running');
    assert.equal(started.length, 2, 'the third item\'s run() must not have started yet');

    d1.resolve('r1');
    await p3;
    assert.equal(started.length, 3, 'the third item dispatches as soon as worker "a" frees up');
});

test('runningCount() reflects an in-flight item and drops back to 0 once it settles', async () => {
    const queue = createDispatchQueue();
    const workers = [{ id: 'a' }];
    const d = deferred();

    const p = queue.enqueue(workers, () => d.promise);
    await flushMicrotasks();
    assert.equal(queue.runningCount('a'), 1);

    d.resolve('done');
    await p;
    // p resolves from the `.then(item.resolve, ...)` link; the `.finally()`
    // that decrements runningCount is chained one microtask AFTER that, so
    // awaiting `p` alone can observe the count before it's actually dropped.
    await flushMicrotasks();
    assert.equal(queue.runningCount('a'), 0);
});

test('a rejecting run() propagates the rejection to the caller AND frees the worker for the next queued item', async () => {
    const queue = createDispatchQueue();
    const workers = [{ id: 'a' }];

    const p1 = queue.enqueue(workers, () => Promise.reject(new Error('worker exploded')));
    const p2 = queue.enqueue(workers, () => Promise.resolve('recovered'));

    await assert.rejects(p1, /worker exploded/);
    assert.equal(await p2, 'recovered', 'the queue must keep moving after one item fails');
});

test('enqueue() with no workers at all rejects immediately with a clear error, never hangs', async () => {
    const queue = createDispatchQueue();

    await assert.rejects(queue.enqueue([], () => Promise.resolve('unreachable')), /No worker is available/);
});

test('the least-loaded worker is always picked — a worker with 0 running is preferred over one already running 1', async () => {
    const queue = createDispatchQueue();
    const workers = [{ id: 'a' }, { id: 'b' }];
    const dBusy = deferred();
    queue.enqueue(workers, worker => worker.id === 'a' ? dBusy.promise : Promise.resolve('b done'));
    await flushMicrotasks(); // worker "a" (first in the sort when tied at 0) is now busy

    const picks = [];
    queue.enqueue(workers, worker => { picks.push(worker.id); return Promise.resolve('x'); });
    await flushMicrotasks();

    assert.deepEqual(picks, ['b'], 'worker "b" (still idle) must be picked over the already-busy worker "a"');
    dBusy.resolve('a done');
});

async function flushMicrotasks(rounds = 10) {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
}
