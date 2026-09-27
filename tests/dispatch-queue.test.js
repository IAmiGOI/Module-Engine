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

// --- Переписанная политика: без затора, параллельность, веса, отмена -------

test('a request for a busy worker no longer blocks a later request for an idle worker queued behind it', async () => {
    const queue = createDispatchQueue();
    const busy = deferred();
    queue.enqueue([{ id: 'a' }], () => busy.promise);
    const blocked = queue.enqueue([{ id: 'a' }], () => Promise.resolve('second on a'));

    const result = await queue.enqueue([{ id: 'b' }], worker => Promise.resolve(`ran on ${worker.id}`));

    assert.equal(result, 'ran on b');
    busy.resolve('first');
    assert.equal(await blocked, 'second on a');
});

test('a worker with maxConcurrent 2 runs two requests at once and queues the third', async () => {
    const queue = createDispatchQueue();
    const pool = [{ id: 'cloud', maxConcurrent: 2 }];
    const first = deferred();
    const second = deferred();
    let thirdStarted = false;
    queue.enqueue(pool, () => first.promise);
    queue.enqueue(pool, () => second.promise);
    const third = queue.enqueue(pool, () => { thirdStarted = true; return Promise.resolve('third'); });
    await flushMicrotasks();

    assert.equal(queue.runningCount('cloud'), 2);
    assert.equal(thirdStarted, false);
    first.resolve('one');
    assert.equal(await third, 'third');
    second.resolve('two');
});

test('weighted selection sends a half-reliable worker a quarter as many requests as a healthy one', async () => {
    const weights = { good: 1, flaky: 0.25 };
    const queue = createDispatchQueue({ weightOf: worker => weights[worker.id] });
    const pool = [{ id: 'good' }, { id: 'flaky' }];
    const picks = { good: 0, flaky: 0 };

    for (let index = 0; index < 50; index += 1) await queue.enqueue(pool, worker => { picks[worker.id] += 1; return Promise.resolve(); });

    assert.equal(picks.good, 40);
    assert.equal(picks.flaky, 10);
});

test('equal weights alternate between idle workers instead of always picking the first in the list', async () => {
    const queue = createDispatchQueue();
    const pool = [{ id: 'a' }, { id: 'b' }];
    const picks = [];

    for (let index = 0; index < 4; index += 1) await queue.enqueue(pool, worker => { picks.push(worker.id); return Promise.resolve(); });

    assert.deepEqual(picks, ['a', 'b', 'a', 'b']);
});

test('a worker with weight 0 is skipped while a live worker exists, and still used when it is the only choice', async () => {
    const queue = createDispatchQueue({ weightOf: worker => (worker.id === 'down' ? 0 : 1) });
    const picks = [];

    for (let index = 0; index < 3; index += 1) await queue.enqueue([{ id: 'down' }, { id: 'up' }], worker => { picks.push(worker.id); return Promise.resolve(); });
    await queue.enqueue([{ id: 'down' }], worker => { picks.push(worker.id); return Promise.resolve(); });

    assert.deepEqual(picks, ['up', 'up', 'up', 'down']);
});

test('a pool given as a function is read when the request starts, so a worker removed while it waited never receives it', async () => {
    const queue = createDispatchQueue();
    let pool = [{ id: 'a' }];
    const busy = deferred();
    queue.enqueue([{ id: 'a' }], () => busy.promise);
    const waiting = queue.enqueue(() => pool, worker => Promise.resolve(`ran on ${worker.id}`));

    pool = [{ id: 'replacement' }];
    busy.resolve();

    assert.equal(await waiting, 'ran on replacement');
});

test('aborting the signal of a waiting request removes it from the queue and rejects it', async () => {
    const queue = createDispatchQueue();
    const busy = deferred();
    queue.enqueue([{ id: 'a' }], () => busy.promise);
    const controller = new AbortController();
    let ran = false;
    const waiting = queue.enqueue([{ id: 'a' }], () => { ran = true; return Promise.resolve(); }, { signal: controller.signal });

    controller.abort();

    await assert.rejects(waiting, { name: 'AbortError' });
    assert.equal(queue.queueLength(), 0);
    busy.resolve();
    await flushMicrotasks();
    assert.equal(ran, false);
});

test('a timed-out fallback attempt is aborted with a timeout reason, so the worker is freed instead of finishing a paid call nobody reads', async () => {
    const queue = createDispatchQueue();
    let seenSignal = null;
    const tiers = [{ workers: [{ id: 'slow' }], timeoutMs: 10 }, { workers: [{ id: 'backup' }] }];

    const result = await queue.enqueueWithFallback(tiers, (worker, { signal }) => {
        if (worker.id === 'backup') return Promise.resolve('from backup');
        seenSignal = signal;
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted by caller'))));
    });

    assert.equal(result, 'from backup');
    assert.equal(seenSignal.aborted, true);
    assert.equal(seenSignal.reason.timeout, true);
    await flushMicrotasks();
    assert.equal(queue.runningCount('slow'), 0);
});

test('a fallback attempt that timed out while still waiting in the queue is removed and never runs later', async () => {
    const queue = createDispatchQueue();
    const busy = deferred();
    queue.enqueue([{ id: 'a' }], () => busy.promise);
    const ranOn = [];

    const result = await queue.enqueueWithFallback(
        [{ workers: [{ id: 'a' }], timeoutMs: 10 }, { workers: [{ id: 'b' }] }],
        worker => { ranOn.push(worker.id); return Promise.resolve(`ran on ${worker.id}`); },
    );
    busy.resolve();
    await flushMicrotasks();

    assert.equal(result, 'ran on b');
    assert.deepEqual(ranOn, ['b']);
});

test('an external signal cancels the whole fallback chain', async () => {
    const queue = createDispatchQueue();
    const controller = new AbortController();
    const chain = queue.enqueueWithFallback([{ workers: [{ id: 'a' }] }, { workers: [{ id: 'b' }] }],
        (worker, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')))),
        { signal: controller.signal });
    await flushMicrotasks();

    controller.abort();

    await assert.rejects(chain, { name: 'AbortError' });
});

test('waitingFor() counts the queued requests whose pool includes the worker', async () => {
    const queue = createDispatchQueue();
    const busy = deferred();
    queue.enqueue([{ id: 'a' }], () => busy.promise);
    const second = queue.enqueue([{ id: 'a' }], () => Promise.resolve());

    assert.equal(queue.waitingFor('a'), 1);
    assert.equal(queue.waitingFor('b'), 0);
    busy.resolve();
    await second;
});
