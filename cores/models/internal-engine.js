import { createDispatchQueue } from '../../libraries/core/dispatch-queue.js';
import { buildProviderRequest, resolveProviderResponseText } from '../../libraries/core/provider-request.js';
import { createPersistedList } from '../../libraries/core/persisted-list.js';
import { request } from '../../libraries/shared/request.js';

const PERSISTENCE_NAMESPACE = 'core.models.internal';

const REQUEST_DEFAULTS = Object.freeze({ systemPrompt: '', temperature: 0.7, maxTokens: 1000, topP: 1, topK: 0, seed: 0 });

/** Defensive reader — any missing/malformed field falls back to a sane default rather than reaching a provider with `undefined` in it. */
export function resolveGenerateRequest(params) {
    const source = params ?? {};
    return {
        prompt: String(source.prompt ?? ''),
        systemPrompt: String(source.systemPrompt ?? REQUEST_DEFAULTS.systemPrompt),
        temperature: Number.isFinite(source.temperature) ? source.temperature : REQUEST_DEFAULTS.temperature,
        maxTokens: Number.isFinite(source.maxTokens) ? source.maxTokens : REQUEST_DEFAULTS.maxTokens,
        topP: Number.isFinite(source.topP) ? source.topP : REQUEST_DEFAULTS.topP,
        topK: Number.isFinite(source.topK) ? source.topK : REQUEST_DEFAULTS.topK,
        seed: Number.isFinite(source.seed) ? source.seed : REQUEST_DEFAULTS.seed,
    };
}

/**
 * Ядро внутренних моделей движка (CORES.md, приоритет 1 среди модельных
 * Ядер) — бывший Alpha SideCar: несколько взаимозаменяемых, API-совместимых
 * удалённых воркеров (openai/anthropic/google-формат), опрашиваемых через
 * общую Библиотеку очереди ([dispatch-queue.js](../../libraries/core/dispatch-queue.js))
 * и формируемых через [provider-request.js](../../libraries/core/provider-request.js).
 * Сама реализация не делает HTTP-вызовов — только строит запрос и отдаёт его
 * `host.network` (Сервис HTTP через Гейт для сети, см. ARCHITECTURE.md); это
 * тот же Ядро/Сервис-разрез, что уже применён к DOM (final-ui-pc.js/dom.js).
 *
 * `host` приходит из `engine.registerCaller(callerId, 'cores', { tier,
 * networkAccess: true, ... })` — БЕЗ `networkAccess: true` на регистрации
 * эта Ядро физически не сможет достучаться до `http.request` (см.
 * network-gate.js), и это правильно: права назначает вызывающий раннер, не
 * само Ядро.
 *
 * Настройки воркеров (эндпоинт/ключ/модель) реально персистятся через
 * `storage.settings` ([persisted-list.js](../../libraries/core/persisted-list.js))
 * — `configureWorkers()` и в памяти обновляет пул, и пишет через; `restoreWorkers()`
 * читает то, что было сохранено в прошлый раз, и вызывается ОДИН РАЗ явно
 * при сборке движка (см. harness/engine-wiring.js), не из конструктора —
 * самозагрузка внутри конструктора гонялась бы с вызовом configureWorkers()
 * самим вызывающим кодом, случившимся раньше, чем асинхронное чтение успеет
 * разрешиться.
 */
export function createInternalEngineModelsCore(host) {
    const dispatchQueue = createDispatchQueue();
    let workers = [];

    const persisted = createPersistedList(host, {
        namespace: PERSISTENCE_NAMESPACE,
        key: 'workers',
        apply: list => { workers = Array.isArray(list) ? list : []; },
    });
    const configureWorkers = persisted.save;
    const restoreWorkers = persisted.restore;

    async function dispatchToWorker(worker, generateRequest) {
        const providerRequest = buildProviderRequest(worker, generateRequest);
        const result = await request(host.network, 'http.request', { params: providerRequest });
        if (!result.ok) throw new Error(result.error.message);
        if (!result.value.ok) throw new Error(`Model worker "${worker.id}" replied with HTTP ${result.value.status}.`);
        return resolveProviderResponseText(worker.format, result.value.text);
    }

    // `workerId`, if given, PINS the request to that one worker (still through
    // the same queue — a busy pinned worker still queues, it just never
    // load-balances onto a different one). Omitted (the normal case): the
    // full pool, load-balanced as usual. First real caller — Ядро трекинга,
    // where "каждый трекер привязан к сайдкару" means every poll must land
    // on the SAME configured worker every time, not whichever is least busy.
    // An unknown `workerId` naturally reaches the existing "No worker is
    // available" failure below — no special-casing needed for that case.
    const unregisters = [
        host.own.register('model.generate', params => {
            const candidates = params?.workerId ? workers.filter(worker => worker.id === params.workerId) : workers;
            return dispatchQueue.enqueue(candidates, worker => dispatchToWorker(worker, resolveGenerateRequest(params)));
        }),
        // Configuration as real CONTRACTS, not just the plain `configureWorkers()`
        // method below: the engine's own UI is a Модуль, and a Модуль editing
        // endpoints/API keys through a direct JS reference would bypass the Гейт
        // and the whole rights system for the single most sensitive thing here.
        // The plain methods stay for assembly-time use by the Раннер, which
        // holds the reference legitimately (see harness/engine-wiring.js).
        host.own.register('model.workers.get', () => workers),
        host.own.register('model.workers.set', params => configureWorkers(params?.workers ?? [])),
    ];

    return { configureWorkers, restoreWorkers, unregister: () => { for (const unregister of unregisters) unregister(); } };
}
