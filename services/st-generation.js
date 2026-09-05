/**
 * Сервис перехвата генерации ST — единственное место во всём движке, которое
 * знает, ГДЕ SillyTavern придерживает генерацию и КУДА он её отправляет.
 * Логический адаптер, как и остальные Сервисы: держать/менять/отменять он не
 * решает, только предоставляет две точки и зовёт переданный обработчик.
 * Что там делать — внутренняя логика Ядра жизненного цикла генерации.
 *
 * Обе точки выяснены по исходнику SillyTavern 1.16.0, а не по памяти:
 *
 * **1. Придержать и отменить — `generate_interceptor`.** Штатный механизм:
 * поле в manifest.json указывает ИМЯ ГЛОБАЛЬНОЙ функции, и ST её `await`-ит
 * (`public/scripts/extensions.js` → `runGenerationInterceptors`, вызов из
 * `public/script.js`, до сборки World Info и промпта). Даёт задержку любой
 * длины, `abort(immediately)` с чистым выходом через `unblockGeneration()`,
 * и МУТИРУЕМУЮ КОПИЮ истории (`coreChat`) — правки формируют промпт, но не
 * трогают сохранённый чат. На `dryRun` не вызывается вообще.
 *
 * **2. Забрать саму отправку — обёртка `fetch`.** Подменить
 * `context.sendGenerationRequest` НЕЛЬЗЯ: ST зовёт свою локальную функцию
 * напрямую (`script.js`), а импортированную привязку ES-модуля извне не
 * переприсвоить — подмена в контексте задела бы только другие расширения, но
 * не саму генерацию. Зато все пять путей отправки идут через ГЛОБАЛЬНЫЙ
 * `fetch` на фиксированный список эндпоинтов (см. `GENERATION_ENDPOINTS`),
 * так что обёртка на них — настоящая и единственная точка «до отправки».
 *
 * Это осознанно ИНТРУЗИВНО. Штатный аддитивный путь (правка `generate_data`
 * на `GENERATE_AFTER_DATA`) даёт содержимое, но не даёт ни отмены, ни
 * подмены ответа. Решение владельца проекта — брать отправку целиком: движок
 * ведёт промптинг сам, а расширения переезжают в него Модулями. Записано
 * тут явно, потому что цена решения — несовместимость со сторонними
 * расширениями, которые рассчитывают на нетронутый путь отправки ST.
 */

/** Все пути, которыми SillyTavern 1.16.0 реально отправляет генерацию. Взято из исходника, а не угадано: script.js `getGenerateUrl()`, openai.js, textgen-settings.js, kai-settings.js, nai-settings.js. */
export const GENERATION_ENDPOINTS = Object.freeze([
    '/api/backends/chat-completions/generate',
    '/api/backends/text-completions/generate',
    '/api/backends/kobold/generate',
    '/api/backends/koboldhorde/generate',
    '/api/novelai/generate',
]);

/** Статус для отменённой нами отправки. ST на «не ok» уходит в свою обычную ветку ошибки, так что отмена выглядит для него как обычный отказ бэкенда, а не как поломка. */
const CANCELLED_STATUS = 499;

function pathOf(input) {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input ?? ''));
    try { return new URL(url, 'http://localhost').pathname; }
    catch { return url; }
}

/** Наш ли это запрос на генерацию. Только POST: у тех же префиксов есть `/status` и `/props`, которые трогать незачем. */
export function isGenerationRequest(input, init) {
    const method = String(init?.method ?? (typeof input === 'object' ? input?.method : '') ?? 'GET').toUpperCase();
    return method === 'POST' && GENERATION_ENDPOINTS.includes(pathOf(input));
}

function jsonResponse(body, status) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// `getContext` этому Сервису не нужен — обе точки живут не в контексте ST, а
// на глобальном объекте (`globalThis[имя]` для перехватчика и `fetch` для
// отправки). `target` существует ровно чтобы тесты могли подсунуть свой
// «глобальный объект» вместо настоящего.
export function registerStGenerationService(bus, { target = globalThis } = {}) {
    let installedInterceptor = null; // имя глобальной функции
    let originalFetch = null;

    /**
     * Ставит обработчик под ИМЕНЕМ ИЗ МАНИФЕСТА — оно должно совпадать с
     * полем `generate_interceptor` в manifest.json, иначе ST просто не найдёт
     * функцию и молча пойдёт дальше (там `typeof globalThis[key] === 'function'`
     * без единого предупреждения).
     */
    function installInterceptor({ name, handler }) {
        const key = String(name ?? '').trim();
        if (!key) throw new Error('stGeneration.installInterceptor: "name" is required (must match manifest.json\'s generate_interceptor).');
        if (typeof handler !== 'function') throw new Error('stGeneration.installInterceptor: "handler" must be a function.');
        target[key] = async (chat, contextSize, abort, type) => handler({ chat, contextSize, abort, type });
        installedInterceptor = key;
        return key;
    }

    function uninstallInterceptor({ name } = {}) {
        const key = name ?? installedInterceptor;
        if (!key) return false;
        delete target[key];
        if (installedInterceptor === key) installedInterceptor = null;
        return true;
    }

    /**
     * Забирает отправку себе. `handler({ endpoint, payload })` отвечает:
     *   `{ payload }`     — отправить это вместо исходного (обычный случай);
     *   `{ cancel, reason }` — не отправлять вовсе, ST получит отказ;
     *   `{ replyWith }`   — ответить самим, к бэкенду не ходить вообще.
     * Всё, что не наш эндпоинт, уходит в исходный `fetch` нетронутым.
     */
    function installSendHook({ handler }) {
        if (typeof handler !== 'function') throw new Error('stGeneration.installSendHook: "handler" must be a function.');
        if (originalFetch) throw new Error('stGeneration.installSendHook: a send hook is already installed.');
        originalFetch = target.fetch;
        const passthrough = originalFetch;

        target.fetch = async (input, init) => {
            if (!isGenerationRequest(input, init)) return passthrough(input, init);

            let payload = null;
            try { payload = JSON.parse(init.body); }
            // Тело не наш JSON — значит форма запроса не та, что мы знаем.
            // Пропустить нетронутым честнее, чем уронить пользователю
            // генерацию из-за нашего же неверного предположения.
            catch { return passthrough(input, init); }

            const decision = await handler({ endpoint: pathOf(input), payload });
            if (decision?.cancel) return jsonResponse({ error: { message: decision.reason ?? 'Generation cancelled by ST Module Engine.' } }, CANCELLED_STATUS);
            if (decision?.replyWith !== undefined) return jsonResponse(decision.replyWith, 200);
            return passthrough(input, { ...init, body: JSON.stringify(decision?.payload ?? payload) });
        };
        return true;
    }

    function uninstallSendHook() {
        if (!originalFetch) return false;
        target.fetch = originalFetch;
        originalFetch = null;
        return true;
    }

    const unregisters = [
        bus.register('stGeneration.installInterceptor', params => installInterceptor(params), { loadMetric: () => 0 }),
        bus.register('stGeneration.uninstallInterceptor', params => uninstallInterceptor(params), { loadMetric: () => 0 }),
        bus.register('stGeneration.installSendHook', params => installSendHook(params), { loadMetric: () => 0 }),
        bus.register('stGeneration.uninstallSendHook', () => uninstallSendHook(), { loadMetric: () => 0 }),
        /** Реальный список охраняемых путей — чтобы панель/диагностика показывали его, а не дублировали у себя. */
        bus.register('stGeneration.endpoints', () => [...GENERATION_ENDPOINTS], { loadMetric: () => 0 }),
        /** Ждёт ли ST наш перехватчик прямо сейчас — то есть установлен ли он и виден ли под своим именем. */
        bus.register('stGeneration.installed', () => ({ interceptor: installedInterceptor, sendHook: Boolean(originalFetch) }), { loadMetric: () => 0 }),
    ];

    return () => {
        uninstallSendHook();
        uninstallInterceptor();
        for (const unregister of unregisters) unregister();
    };
}
