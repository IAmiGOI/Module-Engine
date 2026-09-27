/**
 * Очередь + балансировка + диспатч — общий планировщик модельных Ядер (CORES.md). Ничего не знает ни про HTTP, ни про форму запроса:
 * вызывающий даёт пул воркеров и `run(worker, { signal })`, здесь решается только КАКОЙ воркер и КОГДА.
 *
 * Правила (переписано с политики Alpha — та годилась для одного локального сервера, но не для нескольких облачных API):
 * - **Без затора в голове очереди.** На каждом прогоне берётся ПЕРВЫЙ запрос, который можно запустить, а не только голова: запрос к
 *   занятому воркеру A больше не держит запрос к свободному B. Порядок внутри одного пула сохраняется — ранний запрос проверяется раньше.
 * - **Параллельность на воркер.** `worker.maxConcurrent` (по умолчанию 1): локальная модель тянет один запрос, облачный API — десятки.
 * - **Выбор — плавный взвешенный round-robin** (как в nginx) среди воркеров со свободным местом. Вес — `weightOf(worker)` (здоровье
 *   воркера, см. worker-health.js): при равных весах воркеры чередуются, менее стабильный получает долю запросов по своему весу. Вес 0
 *   («лежит») — воркер пропускается, пока в пуле есть кто-то живой; если лежат все — берутся все поровну (лучше попытка, чем отказ).
 *   Детерминированно, без случайности: поведение воспроизводимо в тестах.
 * - **Пул читается в момент запуска.** `workers` может быть функцией: удалённый или изменённый в настройках воркер не получит запрос,
 *   уже стоящий в очереди.
 * - **Настоящая отмена.** `signal` (AbortSignal) снимает ещё ждущий запрос с очереди, а запущенному передаётся в `run` — тот обрывает
 *   HTTP. `enqueueWithFallback` по тайм-ауту попытки ОТМЕНЯЕТ её, а не бросает висеть: раньше просроченная попытка продолжала держать
 *   воркер и всё равно выполнялась — два оплаченных вызова, один выброшенный результат.
 * - **Приоритет — отдельная очередь.** `priority: true` просматривается первой на каждом прогоне: запрос на критическом пути ответа
 *   пользователю (пайплайн генерации) получает следующее освободившееся место раньше фоновых.
 */

export class DispatchAbortError extends Error {
    constructor(message = 'The request was cancelled.') {
        super(message);
        this.name = 'AbortError';
    }
}

export function createDispatchQueue({ weightOf = () => 1 } = {}) {
    const priorityQueue = [];
    const queue = [];
    const running = new Map(); // workerId -> count
    const currentWeight = new Map(); // workerId -> состояние плавного round-robin

    const runningCount = workerId => running.get(workerId) ?? 0;
    const limitOf = worker => Math.max(1, Math.floor(Number(worker?.maxConcurrent) || 1));
    const hasCapacity = worker => runningCount(worker.id) < limitOf(worker);
    const resolvePool = item => {
        const pool = typeof item.workers === 'function' ? item.workers() : item.workers;
        return Array.isArray(pool) ? pool.filter(worker => worker && worker.id) : [];
    };

    /** Плавный взвешенный round-robin среди воркеров со свободным местом. `null` — все заняты. */
    function pickWorker(pool) {
        const free = pool.filter(hasCapacity);
        if (!free.length) return null;
        let weights = free.map(worker => Math.max(0, Number(weightOf(worker)) || 0));
        if (weights.every(weight => weight === 0)) weights = free.map(() => 1);
        const candidates = free.map((worker, index) => ({ worker, weight: weights[index] })).filter(candidate => candidate.weight > 0);
        const total = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
        let best = null;
        for (const candidate of candidates) {
            const value = (currentWeight.get(candidate.worker.id) ?? 0) + candidate.weight;
            currentWeight.set(candidate.worker.id, value);
            if (!best || value > best.value) best = { worker: candidate.worker, value };
        }
        currentWeight.set(best.worker.id, best.value - total);
        return best.worker;
    }

    function start(item, worker) {
        running.set(worker.id, runningCount(worker.id) + 1);
        item.started = true;
        item.detach?.();
        let work;
        try { work = Promise.resolve(item.run(worker, { signal: item.signal })); } catch (error) { work = Promise.reject(error); }
        // Место освобождается ДО того, как вызывающий узнает результат: иначе его следующий запрос застал бы воркер «ещё занятым».
        const release = () => { running.set(worker.id, runningCount(worker.id) - 1); pump(); };
        work.then(value => { release(); item.resolve(value); }, error => { release(); item.reject(error); });
    }

    function pumpList(list) {
        for (let index = 0; index < list.length;) {
            const item = list[index];
            const pool = resolvePool(item);
            if (!pool.length) { list.splice(index, 1); item.detach?.(); item.reject(new Error('No worker is available.')); continue; }
            const worker = pickWorker(pool);
            if (!worker) { index += 1; continue; }
            list.splice(index, 1);
            start(item, worker);
        }
    }

    function pump() {
        pumpList(priorityQueue);
        pumpList(queue);
    }

    /**
     * Ставит запрос в очередь; `run(worker, { signal })` выполнится, когда в пуле найдётся место. `workers` — массив или функция,
     * возвращающая его (читается в момент запуска). `signal` — отмена: ждущий запрос снимается сразу, запущенный узнаёт через `signal`.
     */
    function enqueue(workers, run, { priority = false, signal } = {}) {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) { reject(new DispatchAbortError()); return; }
            const list = priority ? priorityQueue : queue;
            const item = { workers, run, resolve, reject, signal, started: false };
            if (signal) {
                const onAbort = () => {
                    if (item.started) return; // запущенный запрос оборвёт сам `run` по тому же сигналу
                    const index = list.indexOf(item);
                    if (index >= 0) list.splice(index, 1);
                    reject(new DispatchAbortError());
                };
                signal.addEventListener('abort', onAbort, { once: true });
                item.detach = () => signal.removeEventListener('abort', onAbort);
            }
            list.push(item);
            pump();
        });
    }

    /**
     * Цепочка попыток по РАЗНЫМ пулам: `tiers = [{ workers, timeoutMs }, ...]`. Попытка, упавшая или не уложившаяся в `timeoutMs`,
     * отменяется (снимается с очереди или обрывается) и уступает следующему пулу; `onAttemptFailed({ tierIndex, error })` — перед
     * переходом. Внешний `signal` отменяет всю цепочку. Кончились пулы — ошибка ПОСЛЕДНЕЙ попытки.
     */
    async function enqueueWithFallback(tiers, run, { onAttemptFailed, priority = false, signal } = {}) {
        let lastError = new Error('enqueueWithFallback(): no tiers were given.');
        for (const [tierIndex, tier] of (tiers ?? []).entries()) {
            if (signal?.aborted) throw new DispatchAbortError();
            const attempt = new AbortController();
            const forward = () => attempt.abort();
            signal?.addEventListener('abort', forward, { once: true });
            let timer = null;
            try {
                // Сначала сама попытка, потом таймер: при равных сроках своя ошибка попытки (например, «stalled» стрима) точнее «timed out».
                const work = enqueue(tier.workers, run, { priority, signal: attempt.signal });
                const timeout = tier.timeoutMs > 0 ? new Promise((_, reject) => {
                    timer = setTimeout(() => {
                        const error = new Error(`attempt timed out after ${tier.timeoutMs}ms`);
                        error.timeout = true;
                        attempt.abort(error); // причина видна в `signal.reason`: вызывающий отличит «не уложился» от отмены пользователем
                        reject(error);
                    }, tier.timeoutMs);
                }) : null;
                if (timeout) work.catch(() => {}); // проигравшая гонку попытка не должна всплыть необработанной
                return await (timeout ? Promise.race([work, timeout]) : work);
            } catch (error) {
                // Попытка проиграна, по какой бы причине ни было (свой тайм-аут вызывающего, ошибка) — её HTTP не должен продолжать жить.
                if (!attempt.signal.aborted) attempt.abort(error);
                if (signal?.aborted) throw new DispatchAbortError();
                lastError = error;
                onAttemptFailed?.({ tierIndex, error });
            } finally {
                if (timer !== null) clearTimeout(timer);
                signal?.removeEventListener('abort', forward);
            }
        }
        throw lastError;
    }

    return {
        enqueue,
        enqueueWithFallback,
        runningCount,
        queueLength: () => queue.length + priorityQueue.length,
        /** Сколько запросов ждёт место у пула, где есть этот воркер — для панели состояния. */
        waitingFor: workerId => [...priorityQueue, ...queue].filter(item => resolvePool(item).some(worker => worker.id === workerId)).length,
    };
}
