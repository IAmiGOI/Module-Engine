/**
 * Сервис расширений ST — единственное место, знающее про её git-эндпоинты
 * `/api/extensions/discover`, `/version` и `/update`. Те же самые, за которыми
 * стоит кнопка «Update» в её собственном менеджере расширений.
 *
 * Логический адаптер: спросить и вернуть ответ. Решать, надо ли обновляться,
 * ждать ли остывания и что писать в консоль — работа [Ядра
 * самообновления](../cores/self-update/index.js).
 *
 * **Все три эндпоинта существуют только для установки через git.** Копия,
 * положенная руками, получает 404 или сетевую ошибку. Здесь это НЕ ошибка, а
 * ответ «проверить нечего»: любой сбой возвращается конвертом, а вызывающий
 * обязан молчать. Расширение не должно шуметь у того, кто просто скопировал
 * папку.
 */

const DISCOVER_ENDPOINT = '/api/extensions/discover';
const VERSION_ENDPOINT = '/api/extensions/version';
const UPDATE_ENDPOINT = '/api/extensions/update';

// `fetch` привязан к глобальному объекту: браузерный `fetch` требует, чтобы
// `this` был окном, и вызов «голой» ссылки отвечает «Illegal invocation» — то
// есть проверка обновления падала бы на первом же запросе и молча превращалась
// в «проверить нечего».
export function registerStExtensionsService(bus, { getContext, fetch: fetchImpl = globalThis.fetch?.bind(globalThis) } = {}) {
    function headers(extra = {}) {
        return { ...extra, ...(getContext()?.getRequestHeaders?.() ?? {}) };
    }

    async function postJson(endpoint, body) {
        const response = await fetchImpl(endpoint, {
            method: 'POST',
            headers: headers({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
    }

    /**
     * Как ST сама классифицирует установленные расширения. Записи приходят как
     * `{ type: 'system' | 'local' | 'global', name }`, причём `name` — голая
     * папка у `system`, но `third-party/<папка>` у `local` и `global` разом.
     *
     * Именно этот запрос заменил у Alpha определение «глобальности» по адресу
     * скрипта: адрес у общей и личной установки ОДИНАКОВЫЙ, различить их по
     * нему невозможно в принципе, и попытка стоила месяцев неуловимого 404.
     */
    async function discover() {
        const response = await fetchImpl(DISCOVER_ENDPOINT, { headers: headers() });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
    }

    const unregisters = [
        bus.register('stExtensions.discover', () => discover(), { loadMetric: () => 0 }),
        bus.register('stExtensions.version', ({ extensionName, global = false }) =>
            postJson(VERSION_ENDPOINT, { extensionName, ...(global ? { global: true } : {}) }), { loadMetric: () => 0 }),
        bus.register('stExtensions.update', ({ extensionName, global = false }) =>
            postJson(UPDATE_ENDPOINT, { extensionName, ...(global ? { global: true } : {}) }), { loadMetric: () => 0 }),
    ];

    return () => { for (const unregister of unregisters) unregister(); };
}
