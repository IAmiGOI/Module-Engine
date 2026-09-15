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

// --- priority: two lanes, priority drains first, neither preempts an already-running item -----

test('a priority item queued AFTER a regular one still dispatches first once a worker frees', async () => {
    const queue = createDispatchQueue();
    const workers = [{ id: 'a' }];
    const order = [];
    const dBusy = deferred();

    queue.enqueue(workers, () => dBusy.promise); // occupies the only worker
    await flushMicrotasks();

    const pRegular = queue.enqueue(workers, () => { order.push('regular'); return Promise.resolve('r'); });
    const pPriority = queue.enqueue(workers, () => { order.push('priority'); return Promise.resolve('p'); }, { priority: true });
    await flushMicrotasks();
    assert.equal(order.length, 0, 'sanity — the worker is still busy, nothing queued has run yet');

    dBusy.resolve('done');
    await Promise.all([pRegular, pPriority]);

    assert.deepEqual(order, ['priority', 'regular'], 'priority must be dispatched before the earlier-queued regular item');
});

test('a priority item never interrupts an already-running regular item — queueing only affects WAITING items', async () => {
    const queue = createDispatchQueue();
    const workers = [{ id: 'a' }];
    const order = [];
    const dRunning = deferred();

    const pRunning = queue.enqueue(workers, () => { order.push('running-start'); return dRunning.promise; });
    await flushMicrotasks(); // 'running' already dispatched, holding the only worker

    const pPriority = queue.enqueue(workers, () => { order.push('priority'); return Promise.resolve('p'); }, { priority: true });
    await flushMicrotasks();
    assert.equal(order.length, 1, 'the priority item must wait — it cannot preempt an in-flight run()');

    dRunning.resolve('done');
    await Promise.all([pRunning, pPriority]);
    assert.deepEqual(order, ['running-start', 'priority']);
});

test('queueLength() counts BOTH lanes together', async () => {
    const queue = createDispatchQueue();
    const workers = [{ id: 'a' }];
    const dBusy = deferred();

    queue.enqueue(workers, () => dBusy.promise);
    await flushMicrotasks();
    queue.enqueue(workers, () => Promise.resolve('regular'));
    queue.enqueue(workers, () => Promise.resolve('priority'), { priority: true });
    await flushMicrotasks();

    assert.equal(queue.queueLength(), 2);
    dBusy.resolve('done');
});

async function flushMicrotasks(rounds = 10) {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
}

// --- enqueueWithFallback(): цепочка попыток по РАЗНЫМ пулам, поверх enqueue() -----

test('enqueueWithFallback() with a single tier behaves exactly like a bare enqueue() — no regression for a caller with no fallback configured', async () => {
    const queue = createDispatchQueue();

    const result = await queue.enqueueWithFallback([{ workers: [{ id: 'a' }] }], worker => Promise.resolve(`ran on ${worker.id}`));

    assert.equal(result, 'ran on a');
});

test('enqueueWithFallback() moves to the next tier when the first tier\'s run() rejects', async () => {
    const queue = createDispatchQueue();
    const tiers = [{ workers: [{ id: 'primary' }] }, { workers: [{ id: 'backup' }] }];

    const result = await queue.enqueueWithFallback(tiers, worker =>
        worker.id === 'primary' ? Promise.reject(new Error('primary is down')) : Promise.resolve(`ran on ${worker.id}`));

    assert.equal(result, 'ran on backup');
});

test('enqueueWithFallback() moves to the next tier when a tier\'s timeoutMs is exceeded, even though the first attempt never actually rejects', async () => {
    const queue = createDispatchQueue();
    const stuck = deferred();
    const tiers = [{ workers: [{ id: 'primary' }], timeoutMs: 20 }, { workers: [{ id: 'backup' }] }];

    const result = await queue.enqueueWithFallback(tiers, worker => worker.id === 'primary' ? stuck.promise : Promise.resolve('ran on backup'));

    assert.equal(result, 'ran on backup');
});

test('enqueueWithFallback() calls onAttemptFailed with the tier index and error BEFORE moving on — this is what lets a caller turn a fallback hop into an observable event', async () => {
    const queue = createDispatchQueue();
    const failures = [];
    const tiers = [{ workers: [{ id: 'primary' }] }, { workers: [{ id: 'backup' }] }];

    await queue.enqueueWithFallback(
        tiers,
        worker => worker.id === 'primary' ? Promise.reject(new Error('boom')) : Promise.resolve('ok'),
        { onAttemptFailed: failure => failures.push(failure) },
    );

    assert.equal(failures.length, 1);
    assert.equal(failures[0].tierIndex, 0);
    assert.match(failures[0].error.message, /boom/);
});

test('enqueueWithFallback() rejects with the LAST tier\'s error once every tier is exhausted', async () => {
    const queue = createDispatchQueue();
    const tiers = [{ workers: [{ id: 'a' }] }, { workers: [{ id: 'b' }] }];

    await assert.rejects(
        queue.enqueueWithFallback(tiers, worker => Promise.reject(new Error(`${worker.id} failed`))),
        /b failed/,
    );
});

test('enqueueWithFallback() with an empty tiers list rejects immediately instead of hanging', async () => {
    const queue = createDispatchQueue();

    await assert.rejects(queue.enqueueWithFallback([], () => Promise.resolve('unreachable')), /no tiers/);
});

test('enqueueWithFallback() still load-balances WITHIN one tier\'s pool — a fallback tier with several workers is not pinned to just the first', async () => {
    const queue = createDispatchQueue();
    const dBusy = deferred();
    const backupPool = [{ id: 'b1' }, { id: 'b2' }];
    const tiers = [{ workers: [{ id: 'primary' }] }, { workers: backupPool }];

    queue.enqueue(backupPool, worker => worker.id === 'b1' ? dBusy.promise : Promise.resolve('busy-b2'));
    await flushMicrotasks();

    const picks = [];
    const result = await queue.enqueueWithFallback(tiers, worker => {
        if (worker.id === 'primary') return Promise.reject(new Error('primary down'));
        picks.push(worker.id);
        return Promise.resolve(`ran on ${worker.id}`);
    });

    assert.deepEqual(picks, ['b2'], 'b1 was already busy from the unrelated enqueue() above — the tier must still pick the idle one');
    assert.equal(result, 'ran on b2');
    dBusy.resolve('done');
});
