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

    /**
     * `enqueueWithFallback(tiers, run)` — a chain of attempts over
     * DIFFERENT worker pools, built ON TOP of `enqueue()` (which stays
     * untouched: its own tests and behavior are unaffected). Same idea as
     * [pipeline-runner.js](pipeline-runner.js)'s `fallbacks` chain — "second
     * worker, then the main ST model" is the exact Alpha failure this
     * generalizes — but this library still knows nothing about HTTP or
     * providers, only "which pool, and how long to wait".
     *
     * `tiers = [{ workers, timeoutMs }, ...]`. Each tier is tried via the
     * real `enqueue()` (so load-balancing within a tier's pool is
     * unchanged), raced against `timeoutMs` if given. A tier failing OR
     * timing out moves to the next; `onAttemptFailed({ tierIndex, error })`
     * fires before each move, so a caller (the models Ядро) can turn it into
     * a `model.generate.retrying` event without this library knowing events
     * exist. Empty/exhausted `tiers` rejects with the LAST attempt's error —
     * a single-tier call behaves identically to a bare `enqueue()`.
     */
    async function enqueueWithFallback(tiers, run, { onAttemptFailed } = {}) {
        let lastError = new Error('enqueueWithFallback(): no tiers were given.');
        for (const [tierIndex, tier] of (tiers ?? []).entries()) {
            try {
                return await withTierTimeout(enqueue(tier.workers, run), tier.timeoutMs);
            } catch (error) {
                lastError = error;
                onAttemptFailed?.({ tierIndex, error });
            }
        }
        throw lastError;
    }

    return { enqueue, enqueueWithFallback, runningCount, queueLength: () => queue.length };
}

/** Same tiny pure race pattern as `withTimeout()` in [pipeline-runner.js](pipeline-runner.js) — duplicated on purpose: that library is deliberately self-contained, and this is a handful of lines, not worth a shared abstraction for. */
async function withTierTimeout(promise, timeoutMs) {
    if (!timeoutMs || timeoutMs <= 0) return promise;
    let timer = null;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`attempt timed out after ${timeoutMs}ms`)), timeoutMs); }),
        ]);
    } finally {
        if (timer !== null) clearTimeout(timer);
    }
}
