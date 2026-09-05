/**
 * Очередь + балансировка по нагрузке + диспатч — the shared pattern all 5
 * модельных Ядра (CORES.md) use to spread requests across several
 * interchangeable workers (Alpha's SidecarManager #queue/#running/#pick/
 * #pump, generalized: this library knows nothing about HTTP, providers, or
 * even what a "request" looks like — the caller supplies `workers` and a
 * `run(worker)` function; this only ever decides WHICH worker and WHEN).
 *
 * Policy (ported as-is from Alpha, proven in production there): pick the
 * least-loaded worker; if even the least-loaded one is already busy, every
 * worker must be busy too (by definition of "least loaded"), so the whole
 * queue waits — no polling, `pump()` re-runs itself the moment any worker's
 * `run()` settles. A worker only ever runs ONE item at a time; the queue is
 * what absorbs everything beyond that, not concurrent dispatch per worker.
 */
export function createDispatchQueue() {
    const queue = [];
    const running = new Map(); // workerId -> count

    function pickWorker(workers) {
        return [...workers].sort((a, b) => runningCount(a.id) - runningCount(b.id))[0];
    }

    function runningCount(workerId) {
        return running.get(workerId) ?? 0;
    }

    function pump() {
        while (queue.length) {
            const worker = pickWorker(queue[0].workers);
            if (!worker) { queue.shift().reject(new Error('No worker is available.')); continue; }
            if (runningCount(worker.id) > 0) return;
            const item = queue.shift();
            running.set(worker.id, runningCount(worker.id) + 1);
            item.run(worker).then(item.resolve, item.reject).finally(() => {
                running.set(worker.id, runningCount(worker.id) - 1);
                pump();
            });
        }
    }

    /** Queues one item against the current `workers` list, and runs it via `run(worker)` once a worker is free. */
    function enqueue(workers, run) {
        return new Promise((resolve, reject) => { queue.push({ workers, run, resolve, reject }); pump(); });
    }

    return { enqueue, runningCount, queueLength: () => queue.length };
}
