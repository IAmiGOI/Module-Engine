import { createWorkerHealth } from '../../libraries/core/worker-health.js';
import { request } from '../../libraries/shared/request.js';

/**
 * Живое состояние воркеров Ядра внутренних моделей — «dynamic state»: здоровье каждого (worker-health.js), периодические пробы,
 * сохранение статистики между перезагрузками и контракты для панели. Ядро (internal-engine.js) сообщает сюда исход каждой попытки;
 * очередь спрашивает отсюда вес воркера — менее стабильный выбирается реже.
 *
 * Пробы. Раз в `probeIntervalMs` (10 минут) каждому воркеру уходит минимальный запрос (несколько токенов, без стрима), если за этот
 * интервал у него не было ни одного настоящего исхода: живой трафик уже сказал всё, что скажет проба, а платить за лишний запрос
 * незачем. Лежащий воркер трафика не получает (вес 0) — поэтому пробы и возвращают его в строй. Проба идёт через ту же очередь, что и
 * рабочие запросы, — не обгоняет их и не перегружает локальную модель, которая тянет один запрос за раз.
 *
 * Контракты: `model.workers.status` → `[снимок]` (см. `snapshot` в worker-health.js, плюс `running`/`waiting` очереди),
 * `model.workers.probe({ workerId? })` — «Проверить сейчас», `model.workers.resetStats({ workerId })`.
 * Событие: `model.workers.status.changed` — `{ workers: [снимок] }`, после каждого исхода и пробы.
 */

export const PROBE_INTERVAL_MS = 10 * 60 * 1000;
export const PROBE_TIMEOUT_MS = 20000;
const SAVE_DELAY_MS = 5000;
// Обёртки, а не сами функции: браузерный `setTimeout`, вызванный как метод чужого объекта, бросает «Illegal invocation».
const BROWSER_TIMERS = Object.freeze({
    setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: id => clearInterval(id),
    setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id),
});

export function createWorkerStatus(host, {
    namespace, publish, getWorkers, getQueue, runProbe, now = () => Date.now(),
    probeIntervalMs = PROBE_INTERVAL_MS, timers = BROWSER_TIMERS,
} = {}) {
    const health = createWorkerHealth({ now });
    let probeTimer = null;
    let saveTimer = null;
    const probing = new Set();

    function snapshotAll() {
        const queue = getQueue();
        return getWorkers().map(worker => ({
            ...health.snapshot(worker.id),
            name: worker.name || worker.id,
            maxConcurrent: Math.max(1, Math.floor(Number(worker.maxConcurrent) || 1)),
            running: queue.runningCount(worker.id),
            waiting: queue.waitingFor(worker.id),
            probing: probing.has(worker.id),
        }));
    }

    function scheduleSave() {
        if (saveTimer !== null) return;
        saveTimer = timers.setTimeout(() => {
            saveTimer = null;
            request(host.own, 'storage.settings.set', { params: { namespace, key: 'health', value: health.exportState() } });
        }, SAVE_DELAY_MS);
    }

    function changed() {
        publish('model.workers.status.changed', { workers: snapshotAll() });
        scheduleSave();
    }

    /** Исход рабочей попытки или пробы. Отмену нами (`signal` без причины-тайм-аута) не считаем: воркер тут ни при чём. */
    function recordOutcome(workerId, { ok, error, latencyMs, probe = false }) {
        if (ok) health.recordSuccess(workerId, { latencyMs, probe });
        else if (health.recordFailure(workerId, error, { probe }) === 'ignored') return;
        changed();
    }

    async function probe(worker) {
        if (probing.has(worker.id)) return health.snapshot(worker.id);
        probing.add(worker.id);
        changed();
        const startedAt = now();
        try {
            await runProbe(worker, PROBE_TIMEOUT_MS);
            health.recordSuccess(worker.id, { latencyMs: now() - startedAt, probe: true });
        } catch (error) {
            // Проба не бывает «ни при чём»: ошибка, не похожая на сеть или тайм-аут (неподдерживаемый API в ST, непонятный ответ), значит,
            // что воркер отвечает, но работать не может, — это отказ (`rejected`), а не тишина.
            if (health.recordFailure(worker.id, error, { probe: true }) === 'ignored') {
                health.recordFailure(worker.id, Object.assign(new Error(error?.message ?? String(error)), { status: 400 }), { probe: true });
            }
        } finally {
            probing.delete(worker.id);
            changed();
        }
        return health.snapshot(worker.id);
    }

    function isQuiet(workerId, at) {
        const snap = health.snapshot(workerId);
        const lastActivity = Math.max(snap.lastSuccessAt ?? 0, snap.lastFailureAt ?? 0);
        return at - lastActivity >= probeIntervalMs;
    }

    /** Плановый обход: пробуем только тех, о ком за интервал ничего не известно. */
    function probeDue() {
        const at = now();
        return Promise.all(getWorkers().filter(worker => isQuiet(worker.id, at)).map(probe));
    }

    async function probeNow(workerId) {
        const targets = getWorkers().filter(worker => !workerId || worker.id === workerId);
        if (!targets.length) throw new Error(workerId ? `No model worker with id "${workerId}".` : 'No model workers are configured.');
        return Promise.all(targets.map(probe));
    }

    async function restore() {
        const result = await request(host.own, 'storage.settings.get', { params: { namespace, key: 'health', fallback: {} } });
        if (result.ok) health.importState(result.value);
    }

    /** Удалённые из списка воркеры не должны висеть в статистике вечно. */
    function prune() {
        const known = new Set(getWorkers().map(worker => worker.id));
        for (const id of Object.keys(health.exportState())) if (!known.has(id)) health.forget(id);
        changed();
    }

    function start() {
        if (probeTimer !== null || !(probeIntervalMs > 0)) return;
        probeTimer = timers.setInterval(() => { probeDue(); }, probeIntervalMs);
        probeTimer?.unref?.(); // в node (тесты сборки) таймер не должен держать процесс
    }

    function stop() {
        if (probeTimer !== null) timers.clearInterval(probeTimer);
        probeTimer = null;
        if (saveTimer !== null) timers.clearTimeout(saveTimer);
        saveTimer = null;
    }

    const unregisters = [
        host.own.register('model.workers.status', () => snapshotAll()),
        host.own.register('model.workers.probe', params => probeNow(params?.workerId)),
        host.own.register('model.workers.resetStats', params => {
            for (const worker of getWorkers()) if (!params?.workerId || worker.id === params.workerId) health.reset(worker.id);
            changed();
            return true;
        }),
    ];

    return {
        weightOf: worker => health.weightOf(worker.id),
        recordOutcome, probeDue, probeNow, restore, prune, start, stop, snapshotAll,
        unregister: () => { stop(); for (const unregister of unregisters) unregister(); },
    };
}
