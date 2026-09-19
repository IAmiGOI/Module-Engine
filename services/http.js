import { createSseFrameParser } from '../libraries/core/sse-stream.js';

/**
 * Сервис HTTP — the real, single leaf implementation of "reach the
 * internet". Просто логический адаптер (ARCHITECTURE.md): no logic of its
 * own beyond making one real request — every decision (whether this caller
 * is even ALLOWED to reach the network at all) happens in
 * libraries/shared/network-gate.js, before this Сервис is ever reached.
 *
 * Registered on `buses.network` (engine.js), NEVER `buses.services` — that
 * separation is what makes the dedicated network Gate's check actually
 * mean something (see network-gate.js's own doc comment for the bypass
 * this closes).
 */
export function registerHttpService(networkBus, { fetch: fetchImpl = globalThis.fetch?.bind(globalThis) } = {}) {
    return networkBus.register('http.request', async ({ url, method = 'GET', headers, body, responseType, stream, onChunk, stallMs }) => {
        if (stream) return dispatchStreamingRequest(fetchImpl, { url, method, headers, body, onChunk, stallMs });

        const response = await fetchImpl(url, { method, headers, body });
        // responseType: 'blob' — БИНАРНЫЙ ответ (например, картинка для окна
        // «Картинка», cores/ui/picture-panel.js). Дефолтный `text` прогоняет
        // тело через UTF-8 декодер: байты картинки портятся безвозвратно
        // (replacement character'ы), показывать такое нельзя. blob отдаёт
        // тело живьём; в абстрактных тестах (node) остаётся тем же объектом,
        // что вернул fetch, — конвертация в data:/objectURL — забота UI-ядра.
        // Параметр ОПЦИОНАЛЬНЫЙ: без него поведение прежнее, весь остальной
        // код движка не затронут.
        // Ошибочный ответ на запрос blob отдаётся текстом: по нему вызывающий отличает «нет такого файла» от сбоя (облако).
        const payload = responseType === 'blob' && response.ok ? { blob: await response.blob() } : { text: await response.text() };
        return {
            status: response.status,
            ok: response.ok,
            headers: Object.fromEntries(response.headers?.entries?.() ?? []),
            ...payload,
        };
    }, { loadMetric: () => 0 });
}

/**
 * Стриминговый путь — опциональный (`params.stream`), не трогает поведение
 * ни одного существующего вызывающего кода. `onChunk(frame)` — функция ПРЯМО
 * в `params` (тот же приём, что уже применён к `stEvents.subscribe({ params:
 * { handler } })` в Ядре событий: контракты этого движка — внутрипроцессный
 * вызов, а не сериализация через сеть, так что живая функция в параметрах —
 * не новый трюк для этой кодовой базы).
 *
 * `stallMs`, если задан, охраняет ВЕСЬ путь одним таймером — от отправки
 * запроса до последнего байта, а не только "между чанками": сервер, который
 * молчит ещё ДО заголовков ответа, стопорит запрос ровно так же, как и
 * оборвавшийся посреди тела поток. Таймер взводится заново на каждый реально
 * полученный чанк — именно поэтому это НЕ то же самое, что `timeoutMs` у
 * [request.js](../libraries/shared/request.js) (тот меряет только "весь
 * вызов от начала", годится лишь нестримингового пути, см. dispatchToWorker
 * в cores/models/internal-engine.js).
 */
async function dispatchStreamingRequest(fetchImpl, { url, method, headers, body, onChunk, stallMs }) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let stalled = false;
    let timer = null;
    const armTimer = () => {
        if (!stallMs) return;
        clearTimeout(timer);
        timer = setTimeout(() => { stalled = true; controller?.abort(); }, stallMs);
    };

    armTimer();
    try {
        const response = await fetchImpl(url, { method, headers, body, signal: controller?.signal });
        const text = await readSseBody(response, { onChunk, armTimer });
        clearTimeout(timer);
        return {
            status: response.status,
            ok: response.ok,
            headers: Object.fromEntries(response.headers?.entries?.() ?? []),
            text,
        };
    } catch (error) {
        clearTimeout(timer);
        // Отличаем НАШ таймаут от реального сетевого/провайдерского отказа:
        // без этого вызывающий (Ядро моделей) видел бы generic "AbortError"
        // и не смог бы отличить "стрим завис" от "ключ протух" в событии
        // `model.generate.retrying`.
        if (stalled) throw new Error(`http.request: stream stalled — no data for ${stallMs}ms.`);
        throw error;
    }
}

/**
 * Читает `response.body` чанк за чанком, кормит
 * [sse-stream.js](../libraries/core/sse-stream.js) и зовёт `onChunk` на
 * каждый готовый фрейм; возвращает накопленный сырой текст (тот же вид, что
 * дал бы `response.text()`, для вызывающего, которому `onChunk` не нужен).
 *
 * Без настоящего `ReadableStream` в `response.body` (тестовый двойник
 * `fetch`, отвечающий только `.text()`; в теории — окружение без потокового
 * `fetch` вовсе) честно откатывается на `response.text()` целиком, ноль
 * фреймов в `onChunk` — то же защитное поведение, что уже держит
 * `dispatchToWorker()` в internal-engine.js на случай, если провайдер САМ
 * проигнорировал `stream: true`. Не бросает — стриминг всегда optional-degrade,
 * никогда hard-fail.
 */
async function readSseBody(response, { onChunk, armTimer }) {
    if (typeof response.body?.getReader !== 'function') return response.text();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseFrameParser();
    let text = '';

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        armTimer();
        const chunkText = decoder.decode(value, { stream: true });
        text += chunkText;
        for (const frame of parser.push(chunkText)) onChunk?.(frame);
    }
    for (const frame of parser.flush()) onChunk?.(frame);
    return text;
}
