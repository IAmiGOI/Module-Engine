/**
 * Здоровье воркеров — чистая статистика доступности, без сети и таймеров (их держит Ядро моделей). Из неё растёт вес воркера в
 * очереди (dispatch-queue.js): чем чаще воркер недоступен, тем реже его выбирают.
 *
 * Что считается. Не всякая ошибка — недоступность: кривой JSON в ответе модели или наша собственная отмена ничего не говорят о том,
 * жив ли воркер. Поэтому исход классифицируется (`classifyFailure`):
 * - `unavailable` — сеть не достучалась, тайм-аут или зависший стрим, HTTP 5xx / 408 / 429. Это и есть «воркер недоступен»;
 * - `rejected` — HTTP 401 / 403 / 404 и прочие 4xx: воркер отвечает, но этот запрос не примет никогда (ключ, модель, адрес). Тоже
 *   снижает вес — повторять такой запрос бессмысленно, — но в статистике отдельно;
 * - `ignored` — отмена нами и ошибки разбора ответа: в здоровье не идут вовсе.
 *
 * Как считается. Успехи и отказы — счётчики с экспоненциальным затуханием (период полураспада `halfLifeMs`, по умолчанию час):
 * вчерашние сбои почти ничего не весят, свежие — в полную силу. Надёжность = (успехи + 2) / (успехи + отказы + 2) — оптимистичная
 * априорная оценка: воркер без сбоев считается надёжным на 100% с первого же ответа, а не «50%, пока не докажет». Вес = надёжность²,
 * чтобы разница была заметной: 90% → 0.81, 50% → 0.25.
 * Состояния: `unknown` (ещё ни одного исхода), `up`, `degraded` (надёжность < 80%), `down` (`downAfter` отказов подряд) — такой
 * воркер получает вес 0, то есть запросы идут ему, только если живых в пуле нет. Первый же успех (обычный запрос или проба)
 * возвращает его в строй.
 */

export const FAILURE_KINDS = Object.freeze(['unavailable', 'rejected', 'ignored']);
const UNAVAILABLE_STATUSES = new Set([408, 425, 429]);
const UNAVAILABLE_PATTERN = /timed out|stalled|failed to fetch|networkerror|network error|fetch failed|econn|enotfound|etimedout|socket|load failed|unreachable/i;

/** Ошибка исхода → `unavailable` / `rejected` / `ignored`. Читает `error.status` (HTTP), `error.name` и текст. */
export function classifyFailure(error) {
    if (!error) return 'ignored';
    if (error.name === 'AbortError' && !error.timeout) return 'ignored';
    const status = Number(error.status);
    if (Number.isFinite(status) && status > 0) {
        if (status >= 500 || UNAVAILABLE_STATUSES.has(status)) return 'unavailable';
        if (status >= 400) return 'rejected';
    }
    if (error.timeout || UNAVAILABLE_PATTERN.test(String(error.message ?? ''))) return 'unavailable';
    if (error.name === 'TypeError') return 'unavailable'; // так браузерный fetch сообщает о недостижимом адресе и CORS
    return 'ignored';
}

function emptyRecord() {
    return {
        success: 0, failure: 0, updatedAt: null,
        consecutiveFailures: 0, latencyMs: null,
        totals: { success: 0, unavailable: 0, rejected: 0 },
        lastSuccessAt: null, lastFailureAt: null, lastError: null, lastProbeAt: null,
    };
}

export function createWorkerHealth({ now = () => Date.now(), halfLifeMs = 60 * 60 * 1000, downAfter = 3, degradedBelow = 0.8 } = {}) {
    const records = new Map();

    function recordOf(workerId) {
        if (!records.has(workerId)) records.set(workerId, emptyRecord());
        return records.get(workerId);
    }

    function decay(record, at) {
        if (record.updatedAt !== null && at > record.updatedAt) {
            const factor = 0.5 ** ((at - record.updatedAt) / halfLifeMs);
            record.success *= factor;
            record.failure *= factor;
        }
        record.updatedAt = at;
    }

    /** Успешный ответ. `latencyMs` — сглаженная задержка (скользящее среднее), `probe` — это была проба, а не рабочий запрос. */
    function recordSuccess(workerId, { latencyMs, probe = false } = {}) {
        const record = recordOf(workerId);
        const at = now();
        decay(record, at);
        record.success += 1;
        record.totals.success += 1;
        record.consecutiveFailures = 0;
        record.lastSuccessAt = at;
        if (probe) record.lastProbeAt = at;
        if (Number.isFinite(latencyMs)) record.latencyMs = record.latencyMs === null ? latencyMs : Math.round(record.latencyMs * 0.7 + latencyMs * 0.3);
    }

    /** Отказ. Возвращает класс ошибки; `ignored` в статистику не попадает. */
    function recordFailure(workerId, error, { probe = false } = {}) {
        const kind = classifyFailure(error);
        if (kind === 'ignored') return kind;
        const record = recordOf(workerId);
        const at = now();
        decay(record, at);
        record.failure += 1;
        record.totals[kind] += 1;
        record.consecutiveFailures += 1;
        record.lastFailureAt = at;
        record.lastError = { kind, message: String(error?.message ?? error).slice(0, 300), at };
        if (probe) record.lastProbeAt = at;
        return kind;
    }

    function reliabilityOf(record) {
        decay(record, now());
        return (record.success + 2) / (record.success + record.failure + 2);
    }

    function stateOf(workerId) {
        const record = records.get(workerId);
        if (!record || (!record.totals.success && !record.totals.unavailable && !record.totals.rejected)) return 'unknown';
        if (record.consecutiveFailures >= downAfter) return 'down';
        return reliabilityOf(record) < degradedBelow ? 'degraded' : 'up';
    }

    /** Вес для очереди: 1 без данных, надёжность² для живого, 0 для лежащего. */
    function weightOf(workerId) {
        const state = stateOf(workerId);
        if (state === 'unknown') return 1;
        if (state === 'down') return 0;
        return reliabilityOf(records.get(workerId)) ** 2;
    }

    /** Снимок для панели и события: всё, что нужно показать, одними числами. */
    function snapshot(workerId) {
        const record = records.get(workerId) ?? emptyRecord();
        const state = stateOf(workerId);
        return {
            workerId, state,
            reliability: state === 'unknown' ? null : Math.round(reliabilityOf(record) * 1000) / 1000,
            weight: Math.round(weightOf(workerId) * 1000) / 1000,
            latencyMs: record.latencyMs,
            consecutiveFailures: record.consecutiveFailures,
            totals: { ...record.totals },
            lastSuccessAt: record.lastSuccessAt, lastFailureAt: record.lastFailureAt,
            lastError: record.lastError ? { ...record.lastError } : null,
            lastProbeAt: record.lastProbeAt,
        };
    }

    /** Для сохранения на диск и восстановления после перезагрузки страницы: без этого история сбоев обнулялась бы каждый F5. */
    function exportState() {
        return Object.fromEntries([...records].map(([id, record]) => [id, JSON.parse(JSON.stringify(record))]));
    }

    function importState(state) {
        records.clear();
        for (const [id, saved] of Object.entries(state ?? {})) {
            if (!saved || typeof saved !== 'object') continue;
            const record = emptyRecord();
            for (const key of ['success', 'failure', 'consecutiveFailures']) record[key] = Math.max(0, Number(saved[key]) || 0);
            record.updatedAt = Number.isFinite(saved.updatedAt) ? saved.updatedAt : null;
            record.latencyMs = Number.isFinite(saved.latencyMs) ? saved.latencyMs : null;
            for (const key of Object.keys(record.totals)) record.totals[key] = Math.max(0, Number(saved.totals?.[key]) || 0);
            for (const key of ['lastSuccessAt', 'lastFailureAt', 'lastProbeAt']) record[key] = Number.isFinite(saved[key]) ? saved[key] : null;
            record.lastError = saved.lastError && typeof saved.lastError === 'object' ? { ...saved.lastError } : null;
            records.set(id, record);
        }
    }

    return {
        recordSuccess, recordFailure, stateOf, weightOf, snapshot,
        forget: workerId => records.delete(workerId),
        reset: workerId => records.set(workerId, emptyRecord()),
        exportState, importState,
    };
}
