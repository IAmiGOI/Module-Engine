import { createDispatchQueue } from '../../libraries/core/dispatch-queue.js';
import { buildProviderRequest, resolveProviderResponseText } from '../../libraries/core/provider-request.js';
import { createPersistedList } from '../../libraries/core/persisted-list.js';
import { request } from '../../libraries/shared/request.js';

const PERSISTENCE_NAMESPACE = 'core.models.internal';

const REQUEST_DEFAULTS = Object.freeze({ systemPrompt: '', temperature: 0.7, maxTokens: 1000, topP: 1, topK: 0, seed: 0 });

/** `inherit` — не трогать: провайдер решает сам, и в запрос не уходит вообще ничего про ризонинг (см. provider-request.js). Названия и смысл — те же, что в SideCar Alpha (`REASONING_MODE_OPTIONS`). */
export const REASONING_MODES = Object.freeze(['inherit', 'enabled', 'disabled']);
/** Смысла нет ни у Anthropic, ни у Google — эффорт понимает только OpenRouter'овский unified `reasoning`; для остальных полей это просто отправная точка на случай, если включат вручную. */
export const REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high']);

/**
 * Пресеты сэмплера — и, теперь, ризонинга. Ни разу не про то, КАКОЙ воркер
 * («сайдкар») возьмётся отвечать: воркера выбирает `dispatchQueue` сама (или
 * пиннинг через `workerId` — см. doc-comment Ядра ниже), это отдельный, уже
 * решённый вопрос. Ровно тот же приём, что `TIME_PRESETS` у Модуля «RP Time»:
 * готовая отправная точка одним нажатием, а не восемь полей вслепую, — но
 * подкрутить дальше вручную по-прежнему можно, пресет лишь заполняет их.
 *
 * Сэмплерные значения — не выдумка: те же самые границы (0–2 / 0–1 / 0–200),
 * что были проверены на практике в SideCar Alpha (core/sidecar-service.js).
 * Ризонинг у "Deterministic"/"Precise" выключен НАМЕРЕННО, не забыт: это
 * пресеты под трекеры и строгий JSON, а рассуждающая модель отвечает
 * заметно дольше и на этом не выигрывает ничего. У "Balanced"/"Creative" —
 * `inherit` (решает сам провайдер): включать ризонинг никому не в убыток
 * (запрос его просит только если явно включён), но и настаивать на нём тоже
 * незачем, раз задача не требует.
 */
export const SAMPLER_PRESETS = Object.freeze([
    {
        id: 'deterministic',
        name: 'Deterministic (greedy)',
        description: 'Same input, same output every time — for anything that must parse the same way twice.',
        temperature: 0, topP: 1, topK: 1, maxTokens: 1000,
        reasoningMode: 'disabled', reasoningEffort: 'low', reasoningBudget: 0,
    },
    {
        id: 'precise',
        name: 'Precise',
        description: 'Low temperature, mostly consistent — a safe default for trackers and strict JSON.',
        temperature: 0.2, topP: 0.9, topK: 0, maxTokens: 1000,
        reasoningMode: 'disabled', reasoningEffort: 'low', reasoningBudget: 0,
    },
    {
        id: 'balanced',
        name: 'Balanced',
        description: 'A reasonable middle ground for most tasks.',
        temperature: 0.7, topP: 1, topK: 0, maxTokens: 1000,
        reasoningMode: 'inherit', reasoningEffort: 'medium', reasoningBudget: 0,
    },
    {
        id: 'creative',
        name: 'Creative',
        description: 'Higher temperature — more varied wording, less predictable.',
        temperature: 1.1, topP: 0.95, topK: 0, maxTokens: 1000,
        reasoningMode: 'inherit', reasoningEffort: 'medium', reasoningBudget: 0,
    },
]);

function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    const chosen = Number.isFinite(number) ? number : fallback;
    return Math.max(min, Math.min(max, chosen));
}

/**
 * Защитное чтение настроек сэмплера у ОДНОГО воркера — те же границы, что и
 * у ползунков в панели, применённые и к тому, что реально лежит на диске:
 * ручная правка сохранённого файла или старая запись без этих полей вообще
 * не должны уйти к провайдеру как есть.
 */
export function clampSamplerSettings(values = {}) {
    return {
        temperature: clampNumber(values.temperature, 0, 2, REQUEST_DEFAULTS.temperature),
        topP: clampNumber(values.topP, 0, 1, REQUEST_DEFAULTS.topP),
        topK: Math.round(clampNumber(values.topK, 0, 200, REQUEST_DEFAULTS.topK)),
        maxTokens: Math.round(clampNumber(values.maxTokens, 1, 32768, REQUEST_DEFAULTS.maxTokens)),
    };
}

/** Тот же приём, отдельной функцией: ризонинг — самостоятельный набор настроек рядом с сэмплером, а не его часть, и клэмп у него свой (перечисление, а не диапазон, для двух из трёх полей). */
export function clampReasoningSettings(values = {}) {
    return {
        reasoningMode: REASONING_MODES.includes(values.reasoningMode) ? values.reasoningMode : 'inherit',
        reasoningEffort: REASONING_EFFORTS.includes(values.reasoningEffort) ? values.reasoningEffort : 'medium',
        reasoningBudget: Math.round(clampNumber(values.reasoningBudget, 0, 32768, 0)),
    };
}

/**
 * Defensive reader — any missing/malformed field falls back to a sane
 * default rather than reaching a provider with `undefined` in it.
 *
 * Пресет сэмплера/ризонинга — свойство ЗАПРОСА (трекера, «Времени» и т.д.),
 * а не воркера: один и тот же сайдкар должен уметь тем же вызовом что строго
 * трекать JSON, что вести творческую генерацию, с разными настройками
 * одновременно — привязать это к воркеру такую возможность бы отняло.
 * Поэтому явный параметр САМОГО запроса (`params.temperature` и т.п.)
 * побеждает всегда; `worker` читается вторым слоем НА СЛУЧАЙ, если у него
 * когда-либо будут свои поля (сейчас панель воркеров их не заводит — см.
 * cores/ui/engine-panel.js), а `REQUEST_DEFAULTS` — запасное дно под обоими.
 */
export function resolveGenerateRequest(params, worker) {
    const source = params ?? {};
    const samplerDefaults = clampSamplerSettings(worker);
    const reasoningDefaults = clampReasoningSettings(worker);
    return {
        prompt: String(source.prompt ?? ''),
        systemPrompt: String(source.systemPrompt ?? REQUEST_DEFAULTS.systemPrompt),
        temperature: Number.isFinite(source.temperature) ? source.temperature : samplerDefaults.temperature,
        maxTokens: Number.isFinite(source.maxTokens) ? source.maxTokens : samplerDefaults.maxTokens,
        topP: Number.isFinite(source.topP) ? source.topP : samplerDefaults.topP,
        topK: Number.isFinite(source.topK) ? source.topK : samplerDefaults.topK,
        seed: Number.isFinite(source.seed) ? source.seed : REQUEST_DEFAULTS.seed,
        reasoningMode: REASONING_MODES.includes(source.reasoningMode) ? source.reasoningMode : reasoningDefaults.reasoningMode,
        reasoningEffort: REASONING_EFFORTS.includes(source.reasoningEffort) ? source.reasoningEffort : reasoningDefaults.reasoningEffort,
        reasoningBudget: Number.isFinite(source.reasoningBudget) ? source.reasoningBudget : reasoningDefaults.reasoningBudget,
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
            return dispatchQueue.enqueue(candidates, worker => dispatchToWorker(worker, resolveGenerateRequest(params, worker)));
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
