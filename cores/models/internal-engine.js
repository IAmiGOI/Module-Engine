import { createDispatchQueue } from '../../libraries/core/dispatch-queue.js';
import { buildProviderRequest, resolveProviderResponseText, resolveStreamDelta } from '../../libraries/core/provider-request.js';
import { createPersistedList } from '../../libraries/core/persisted-list.js';
import { request } from '../../libraries/shared/request.js';
import { buildCustomPreset, resolveGenerateRequest } from './generate-request.js';
import { createWorkerStatus } from './worker-status.js';
import { ST_MAIN_FORMAT } from '../../libraries/core/st-main-request.js';

let requestCounter = 0;
/** Own counter, not `crypto.randomUUID()` — this Ядро already runs in both the real ST page and a bare `node --test`; a monotonic counter needs nothing from either environment and is trivially readable in logs/events ("request #7"), where a UUID would only add noise. */
function generateRequestId() {
    requestCounter += 1;
    return `gen-${requestCounter}`;
}

const PERSISTENCE_NAMESPACE = 'core.models.internal';

export {
    REASONING_MODES, REASONING_EFFORTS, SAMPLER_PRESETS, slugifyPresetName, buildCustomPreset, clampSamplerSettings, clampReasoningSettings,
    resolveGenerateRequest,
} from './generate-request.js';

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
 * разрешиться. `configureWorkers()` также announces `model.workers.changed` —
 * без этого список подключений в форме трекера/«RP Time» оставался тем, что
 * было при загрузке страницы, и добавленное в панели воркеров подключение
 * появлялось там только после ручной перезагрузки.
 *
 * Свои пресеты сэмплера/ризонинга (`customPresets`) персистятся ТЕМ ЖЕ
 * приёмом, вторым независимым списком: `model.presets.get`/`model.presets.set`
 * зеркалят `model.workers.get`/`set` один в один, а `model.presets.changed`
 * даёт любому открытому экрану (карточке трекера, «RP Time») узнать о новом
 * пресете, сохранённом СОСЕДНИМ, без ручной перезагрузки страницы.
 */
/** Провайдер просит подождать (HTTP 429/503, например «OpenRouter could not verify available credits… Retry-After: 10»): ждём и повторяем тот же запрос, а не отдаём отказ человеку. */
const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_MAX_WAIT_MS = 20000;
const readRetryAfterMs = (text, fallbackMs) => { const seconds = Number(/"Retry-After"\s*:\s*"?(\d+)/i.exec(String(text ?? ''))?.[1]); return Math.min(RATE_LIMIT_MAX_WAIT_MS, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : fallbackMs); };

export function createInternalEngineModelsCore(host, { publish, workerWaitMs = 3000, rateLimitWaitMs = 8000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => Date.now(), probeIntervalMs, timers } = {}) {
    // Вес воркера в очереди — его здоровье (worker-status.js): менее стабильный выбирается реже, лежащий — только если живых нет.
    const dispatchQueue = createDispatchQueue({ weightOf: worker => status.weightOf(worker) });
    let workers = [];
    let customPresets = [];
    // Тот же фоллбэк на прямой эмит, что и у Ядра трекинга — только для узких
    // тестов, которые поднимают это Ядро в одиночку, без Ядра событий рядом.
    const publishEvent = publish ?? ((event, payload) => host.events.emit(event, payload));

    const status = createWorkerStatus(host, {
        namespace: PERSISTENCE_NAMESPACE, publish: publishEvent, now, getWorkers: () => workers, getQueue: () => dispatchQueue,
        runProbe: (worker, timeoutMs) => probeWorker(worker, timeoutMs),
        ...(probeIntervalMs !== undefined ? { probeIntervalMs } : {}), ...(timers ? { timers } : {}),
    });

    const persisted = createPersistedList(host, {
        namespace: PERSISTENCE_NAMESPACE,
        key: 'workers',
        apply: list => { workers = Array.isArray(list) ? list : []; },
    });
    /**
     * `model.workers.changed` — тот же приём, что у пресетов: без него список
     * подключений в форме трекера/«RP Time» оставался тем, что было при
     * ЗАГРУЗКЕ страницы, и добавленное (или удалённое) в панели воркеров
     * подключение появлялось там только после ручной перезагрузки.
     */
    async function configureWorkers(list) {
        await persisted.save(list);
        publishEvent('model.workers.changed', { count: workers.length });
        status.prune();
    }
    /**
     * `restoreWorkers()` ТОЖЕ публикует `model.workers.changed`, не только
     * `configureWorkers()` — реальная гонка при старте (harness/engine-wiring.js:
     * `Promise.all([modelsCore.restoreWorkers(), ..., summaryCore.load()])`,
     * оба идут ПАРАЛЛЕЛЬНО): без этого события `model.generate` на пустом
     * ещё-не-восстановленном пуле не может дождаться момента, когда воркеры
     * реально появятся — узнать об этом ему больше неоткуда (см.
     * `waitForWorkersChangeOnce()` ниже).
     */
    async function restoreWorkers() {
        const list = await persisted.restore();
        publishEvent('model.workers.changed', { count: workers.length });
        await status.restore().catch(() => {}); // статистика — не повод не поднять воркеры
        return list;
    }

    const presetsPersisted = createPersistedList(host, {
        namespace: PERSISTENCE_NAMESPACE,
        key: 'customPresets',
        apply: list => { customPresets = Array.isArray(list) ? list : []; },
    });
    /**
     * Пересобирает КАЖДЫЙ пресет через `buildCustomPreset()`, а не сохраняет
     * форму как есть — та же защита, что клэмп у воркеров: ручная правка
     * файла настроек или пустое имя не должны осесть в списке, который потом
     * читает любой открытый экран.
     */
    async function configurePresets(list) {
        const sanitized = (list ?? []).map(preset => buildCustomPreset(preset?.name, preset)).filter(preset => preset.id && preset.name);
        await presetsPersisted.save(sanitized);
        publishEvent('model.presets.changed', { count: sanitized.length });
    }
    const restorePresets = presetsPersisted.restore;

    /**
     * `stream`/`onChunk`/`stallMs` — опциональны, дефолт стриминга `true`:
     * все три формата ([provider-request.js](../../libraries/core/provider-request.js))
     * умеют SSE. Если провайдер по факту проигнорировал `stream: true` и
     * вернул один JSON-блоб (кастомный "openai-совместимый" эндпоинт — не
     * редкость), `onChunk` не позовётся ни разу — тогда добираем текст
     * защитным `resolveProviderResponseText()` НАД сырым телом ответа,
     * которое [services/http.js](../../services/http.js) в любом случае
     * возвращает целиком (`text`), стримился он или нет. Без этого фоллбэка
     * такой эндпоинт молча отвечал бы пустой строкой — silent regression
     * ровно там, где аддитивность контракта была обещана.
     */
    async function dispatchToWorker(worker, generateRequest, { onChunk, onRaw, stallMs, stream = true, signal } = {}) {
        if (worker.format === ST_MAIN_FORMAT) return dispatchToMainConnection(worker, generateRequest, { onChunk, stallMs, signal });
        const providerRequest = buildProviderRequest(worker, generateRequest, { stream });
        let accumulated = '';
        const send = () => request(host.network, 'http.request', {
            params: {
                ...providerRequest, stream, stallMs, signal,
                onChunk: stream ? frame => {
                    const { delta } = resolveStreamDelta(worker.format, frame);
                    if (!delta) return;
                    accumulated += delta;
                    onChunk?.(delta, accumulated);
                } : undefined,
            },
            // Нестриминговый путь ждёт ответ целиком тем же сроком; сам fetch обрывает `signal` очереди (стрим — ещё и watchdog в http.js).
            timeoutMs: stream ? undefined : stallMs,
        });
        let result = await send();
        for (let tries = 0; tries < RATE_LIMIT_RETRIES && result.ok && [429, 503].includes(result.value.status) && !signal?.aborted; tries += 1) {
            publishEvent('model.generate.rateLimited', { workerId: worker.id, status: result.value.status, retry: tries + 1 });
            await sleep(readRetryAfterMs(result.value.text, rateLimitWaitMs));
            accumulated = '';
            result = await send();
        }
        if (!result.ok) throw new Error(result.error.message);
        // Сырое тело ответа (для журнала отладки гида): текст — это лишь то, что мы из него прочли, а tool_calls, ризонинг и finish_reason остаются только здесь.
        onRaw?.({ status: result.value.status, format: worker.format, body: String(result.value.text ?? ''), content: accumulated });
        if (!result.value.ok) throw httpError(worker, result.value.status);
        if (accumulated) return accumulated;
        return resolveProviderResponseText(worker.format, result.value.text);
    }

    /**
     * Основное подключение SillyTavern (`format: 'sillytavern'`, libraries/core/st-main-request.js): запрос уходит на сервер ST с его
     * текущими настройками через Сервис перехвата генерации. Стрима нет — ответ приходит целиком одним «чанком».
     */
    async function dispatchToMainConnection(worker, generateRequest, { onChunk, stallMs, signal }) {
        const result = await request(host.services, 'stGeneration.direct', {
            params: {
                messages: generateRequest.messages, prompt: generateRequest.prompt, systemPrompt: generateRequest.systemPrompt,
                maxTokens: generateRequest.maxTokens, temperature: generateRequest.temperature, signal,
            },
            timeoutMs: stallMs,
        });
        if (!result.ok) throw new Error(result.error.message);
        if (!result.value.ok) throw httpError(worker, result.value.status, result.value.error);
        const text = String(result.value.text ?? '');
        if (text) onChunk?.(text, text);
        return text;
    }

    /** Ошибка ответа с `status` — по нему worker-health.js отличает «воркер недоступен» (5xx, 429) от «запрос не тот» (4xx). */
    function httpError(worker, statusCode, detail = '') {
        const error = new Error(`Model worker "${worker.id}" replied with HTTP ${statusCode}${detail ? `: ${String(detail).slice(0, 200)}` : ''}.`);
        error.status = statusCode;
        return error;
    }

    /**
     * Попытка на конкретном воркере с учётом исхода в его здоровье. Тайм-аут попытки (очередь обрывает её сигналом с причиной
     * `timeout`) — недоступность; отмена без такой причины — не вина воркера и в статистику не идёт.
     */
    async function attempt(worker, generateRequest, options) {
        const startedAt = now();
        try {
            const text = await dispatchToWorker(worker, generateRequest, options);
            status.recordOutcome(worker.id, { ok: true, latencyMs: now() - startedAt });
            return text;
        } catch (error) {
            const reason = options.signal?.aborted ? options.signal.reason : null;
            status.recordOutcome(worker.id, { ok: false, error: reason?.timeout ? reason : error });
            throw error;
        }
    }

    /** Проба «жив ли воркер»: минимальный запрос без стрима, через ту же очередь, что и рабочие. */
    function probeWorker(worker, timeoutMs) {
        const probeRequest = resolveGenerateRequest({ prompt: 'Reply with the single word OK.', maxTokens: 16, temperature: 0 }, worker);
        return dispatchQueue.enqueueWithFallback(
            [{ workers: () => workers.filter(item => item.id === worker.id), timeoutMs }],
            (target, { signal }) => dispatchToWorker(target, probeRequest, { stream: false, signal }),
        );
    }

    // `workerId` ПРИВЯЗЫВАЕТ запрос к одному воркеру (через ту же очередь: занятый — ждёт, на другой не уходит) — так трекер всегда
    // опрашивает свой сайдкар. Без него — весь пул с балансировкой. `fallbackWorkerIds`/`restartOnStall`/`stallMs` — всё по желанию:
    // без них запрос — одна попытка на одном пуле, как раньше.
    /**
     * Ждёт ОДИН `model.workers.changed` (или сдаётся по тайм-ауту), только когда пул для запроса пуст: при старте воркеры
     * восстанавливаются параллельно с первыми вызовами (harness/engine-wiring.js), и без выдержки `model.generate` падал бы
     * «No worker is available.» ровно тогда, когда воркер на подходе. Не бесконечно — опечатка в `workerId` обязана дойти до ошибки.
     */
    function waitForWorkersChangeOnce(timeoutMs) {
        return new Promise(resolve => {
            let done = false;
            const unsubscribe = host.events.subscribe('model.workers.changed', () => {
                if (done) return;
                done = true;
                unsubscribe();
                resolve();
            });
            setTimeout(() => {
                if (done) return;
                done = true;
                unsubscribe();
                resolve();
            }, timeoutMs);
        });
    }

    const cancellers = new Map(); // requestId → AbortController активных запросов (model.generate.cancel)
    const unregisters = [
        // Отмена по `requestId`: гид обрывает ответ (кнопка «Стоп», зацикливание модели). Запрос завершается ошибкой, провайдеру уходит обрыв соединения.
        host.own.register('model.generate.cancel', params => {
            const controller = cancellers.get(params?.requestId);
            if (!controller) return false;
            controller.abort(new Error('The request was stopped.'));
            return true;
        }),
        host.own.register('model.generate', async (params, meta) => {
            const requestId = params?.requestId ?? generateRequestId();
            const controller = new AbortController();
            cancellers.set(requestId, controller);
            // Пулы — функции: очередь читает их в момент запуска, и воркер, удалённый из настроек, пока запрос ждал, его уже не получит.
            const resolvePrimaryPool = () => (params?.workerId ? workers.filter(worker => worker.id === params.workerId) : workers);
            let primaryPool = resolvePrimaryPool();
            if (!primaryPool.length) {
                await waitForWorkersChangeOnce(workerWaitMs);
                primaryPool = resolvePrimaryPool();
            }
            const stallMs = params?.stallMs || undefined;
            const restartOnStall = stallMs && params?.restartOnStall !== false;
            const fallbackPools = (params?.fallbackWorkerIds ?? [])
                .filter(id => workers.some(worker => worker.id === id))
                .map(id => () => workers.filter(worker => worker.id === id));
            const tiers = [
                { workers: resolvePrimaryPool, timeoutMs: stallMs },
                ...(restartOnStall ? [{ workers: resolvePrimaryPool, timeoutMs: stallMs }] : []),
                ...fallbackPools.map(pool => ({ workers: pool, timeoutMs: stallMs })),
            ];

            publishEvent('model.generate.started', { requestId, workerId: params?.workerId });
            let lastWorkerId = params?.workerId;
            return dispatchQueue.enqueueWithFallback(
                tiers,
                (worker, { signal }) => {
                    lastWorkerId = worker.id;
                    return attempt(worker, resolveGenerateRequest(params, worker), {
                        stream: params?.stream !== false,
                        stallMs, signal,
                        onChunk: (delta, text) => publishEvent('model.generate.chunk', { requestId, workerId: worker.id, delta, text }),
                        onRaw: raw => publishEvent('model.generate.raw', { requestId, workerId: worker.id, ...raw }),
                    });
                },
                {
                    // `meta.priority` — call-site flag, see request.js's doc-comment.
                    // Only value it's meaningful for right now is `'pipeline'`
                    // (Summary Core's `askModelToFold()`, always on the generation
                    // critical path) — anything else (including undefined, the
                    // normal case) is background, same as before this field existed.
                    priority: meta?.priority === 'pipeline',
                    signal: controller.signal,
                    onAttemptFailed: ({ tierIndex, error }) => publishEvent('model.generate.retrying', {
                        requestId, failedWorkerId: lastWorkerId, reason: error.message,
                        nextWorkerId: tiers[tierIndex + 1]?.workers()?.[0]?.id,
                    }),
                },
            ).then(
                text => { publishEvent('model.generate.finished', { requestId, workerId: lastWorkerId, text }); return text; },
                error => { publishEvent('model.generate.failed', { requestId, error: { message: error.message } }); throw error; },
            ).finally(() => { cancellers.delete(requestId); });
        }),
        // Настройка — настоящими контрактами: UI движка — Модуль, и правка ключей API в обход Гейта обошла бы всю систему прав.
        // Простые методы (`configureWorkers()` и т. п.) остаются сборщику движка.
        host.own.register('model.workers.get', () => workers),
        host.own.register('model.workers.set', params => configureWorkers(params?.workers ?? [])),
        host.own.register('model.presets.get', () => customPresets),
        host.own.register('model.presets.set', params => configurePresets(params?.presets ?? [])),
    ];

    return {
        configureWorkers, restoreWorkers, configurePresets, restorePresets,
        /** Плановые пробы раз в 10 минут — включает сборка движка после восстановления воркеров, не конструктор (тестам таймер не нужен). */
        startMonitoring: () => status.start(),
        probeWorkers: workerId => status.probeNow(workerId),
        unregister: () => { status.unregister(); for (const unregister of unregisters) unregister(); },
    };
}
