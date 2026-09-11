import { request } from '../../libraries/shared/request.js';

const NAMESPACE = 'core.firstLoad';
const COUNT_KEY = 'launchCount';

/**
 * Ядро First Load — счётчик запусков движка и момент «первого контакта».
 *
 * **Зачем оно существует.** Все постоянные данные движка живут в
 * `extensionSettings` через [Ядро сохранения](../settings/index.js), но сам
 * факт «пользователь открыл нас ВПЕРВЫЕ» до сих пор нигде не фиксировался:
 * движок при первом запуске выглядел ровно как на десятом — пустая панель,
 * ни один Модуль не включён, и пользователю неоткуда узнать, что тумблеры
 * вообще существуют. Это Ядро — владелец той единицы состояния.
 *
 * **Почему Ядро, а не Модуль или кусок index.js.** По критерию
 * ARCHITECTURE.md: «движок без него не работает» — счётчик нужен любому
 * сценарию онбординга, а пользователь его не подключает. И это наблюдаемость
 * самой машины, а не фича.
 *
 * ## Дисциплина счёта
 *
 *  - **Инкремент — на КОНСТРУКЦИИ (`load()`), а не на чтении.** Каждый
 *    вызов `status()` без записи не двигает счётчик: чтений за сессию
 *    бывает много (панель, диагностикa), а запуск один.
 *  - **Читаем-пишем одним ходом через `storage.settings.set`** — то же
 *    Ядро сохранения, тот же дебаунс ST (`saveSettingsDebounced`, сервис
 *    extension-settings). Отдельного «прочитать и не писать» хода нет:
 *    нечего писать, если не меняли.
 *  - **Гонка с ранним чтением не угрожает**: `settings`-данные глобальные,
 *    а не per-chat (класс 2 живёт только в `chatMetadata`), и инкремент
 *    выполняется в `engine-wiring` ПОСЛЕ восстановления конфигурации.
 *  - **Счётчик от 0 → 1 и есть «первый запуск»**: решение принимается по
 *    значению ДО инкремента. Сбой страницы между чтением и записью
 *    оставит счётчик равным 0 — пользователь получит онбординг ещё раз,
 *    а не потеряет его навсегда (безопасная сторона того же выбора, что
 *    и «отметка о попытке — время, а не флаг» у самообновления).
 *
 * Событие `firstLoad.firstLaunch` публикуется через [Ядро событий]
 * (../events/index.js) — подписчики (сценарий первого запуска в UI) не
 * должны знать, где физически лежит счётчик.
 */
export const FIRST_LAUNCH_EVENT = 'firstLoad.firstLaunch';

export function createFirstLoadCore(host, { publish, namespace = NAMESPACE, countKey = COUNT_KEY } = {}) {
    const publishEvent = publish ?? ((event, payload) => host.events.emit(event, payload));

    let launches = null; // null = ещё не считали в этой сессии

    async function readCount() {
        const result = await request(host.own, 'storage.settings.get', {
            params: { namespace, key: countKey, fallback: 0 },
        });
        if (!result.ok) throw new Error(result.error.message);
        return Number(result.value) || 0;
    }

    /**
     * Один раз за сессию: читает счётчик, инкрементирует, сохраняет и —
     * если это был самый первый запуск — объявляет `firstLoad.firstLaunch`.
     * Повторные вызовы идемпотентны: возвращают уже посчитанное значение
     * и НЕ инкрементируют и НЕ публикуют заново.
     */
    async function load() {
        if (launches !== null) return { count: launches, firstLaunch: launches === 1 };
        const previous = await readCount();
        const count = previous + 1;
        const result = await request(host.own, 'storage.settings.set', {
            params: { namespace, key: countKey, value: count },
        });
        if (!result.ok) throw new Error(result.error.message);
        launches = count;
        const firstLaunch = previous === 0;
        if (firstLaunch) publishEvent(FIRST_LAUNCH_EVENT, { count });
        return { count, firstLaunch };
    }

    /** Чистое чтение текущего значения — без записи, без событий. До `load()` — `null`. */
    function status() {
        return launches;
    }

    /**
     * Тестовый ход (не контракт): обнулить счётчик. Пользовательского UI
     * для этого нет намеренно — «снова увидеть онбординг» решается в
     * браузере через удаление ключа, а не кнопкой, которую можно нажать
     * случайно.
     */
    async function resetForTests() {
        const result = await request(host.own, 'storage.settings.set', {
            params: { namespace, key: countKey, value: 0 },
        });
        if (!result.ok) throw new Error(result.error.message);
        launches = null;
    }

    return { load, status, resetForTests, NAMESPACE };
}