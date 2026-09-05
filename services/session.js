/**
 * Сервис сессии страницы — единственное место, знающее про `sessionStorage` и
 * перезагрузку окна.
 *
 * Понадобился ровно из-за самообновления: применив обновление, движок
 * перезагружает страницу, и отметка «мы только что пытались» обязана пережить
 * эту перезагрузку — иначе после неё проверка запустится снова, снова обновит,
 * снова перезагрузит. Ни память Ядра, ни `storage.settings` тут не годятся:
 * первая умирает вместе со страницей, вторая живёт вечно и заблокировала бы
 * проверку навсегда.
 *
 * У Alpha на этом месте был второй из трёх её багов: она хранила ПОСТОЯННЫЙ
 * флаг `'1'`, и после первого же удачного автообновления все дальнейшие
 * проверки в этой вкладке молча не выполнялись. Поэтому здесь хранится ВРЕМЯ,
 * а решение «остыло ли» принимает Ядро.
 */
export function registerSessionService(bus, { storage = globalThis.sessionStorage, reload } = {}) {
    const doReload = reload ?? (() => globalThis.location?.reload?.());

    const unregisters = [
        bus.register('session.get', ({ key, fallback = null }) => {
            try { return storage?.getItem(key) ?? fallback; }
            catch { return fallback; } // приватный режим/запрет хранилища — не повод падать
        }, { loadMetric: () => 0 }),

        bus.register('session.set', ({ key, value }) => {
            try { storage?.setItem(key, String(value)); return true; }
            catch { return false; }
        }, { loadMetric: () => 0 }),

        /** Перезагрузка страницы — отдельным контрактом, чтобы Ядро не трогало `window` само. */
        bus.register('session.reload', () => { doReload(); return true; }, { loadMetric: () => 0 }),
    ];

    return () => { for (const unregister of unregisters) unregister(); };
}
