/**
 * Сервис событий ST — единственное место во всём движке, которое знает про
 * `context.eventSource`/`context.eventTypes`. Просто логический адаптер
 * (ARCHITECTURE.md): подписать/отписать/перечислить — и всё. Никакой
 * трансляции имён на Шину событий, никаких защит от штормов, никакого
 * состояния: и то, и другое, и третье — внутренняя логика, она в
 * [cores/events/index.js](../cores/events/index.js).
 *
 * `handler` передаётся функцией прямо в params — тот же приём, что уже
 * используют [st-macros.js](st-macros.js) (обработчик макроса) и
 * [dom.js](dom.js) (живой DOM-узел): контракты этой Шины не пересекают
 * процесс, так что функция здесь — обычное значение, а не то, что нужно
 * как-то сериализовать. Отписка требует ТУ ЖЕ ссылку на функцию — её
 * хранит вызывающий (Ядро), поэтому сам Сервис остаётся без состояния.
 *
 * Реальная форма API взята с уже работающего кода Alpha (см. её
 * core/module-engine.js): подписка идёт по КЛЮЧУ (`'CHAT_CHANGED'`),
 * который `context.eventTypes` переводит в настоящее имя события; снятие —
 * через `off()`, с фоллбэком на `removeListener()` для сборок ST, где есть
 * только он.
 */
export function registerStEventsService(bus, { getContext } = {}) {
    /** ST публикует константы в `context.eventTypes`; вызывающий может передать и КЛЮЧ, и уже готовое имя — оба работают. */
    function resolveEventName(context, event) {
        return context.eventTypes?.[event] ?? event;
    }

    function requireEventSource(context) {
        if (!context.eventSource?.on) throw new Error('stEvents: SillyTavern event API (context.eventSource) is unavailable.');
        return context.eventSource;
    }

    const unregisters = [
        bus.register('stEvents.subscribe', ({ event, handler }) => {
            const context = getContext();
            requireEventSource(context).on(resolveEventName(context, event), handler);
            return true;
        }, { loadMetric: () => 0 }),

        bus.register('stEvents.unsubscribe', ({ event, handler }) => {
            const context = getContext();
            const source = requireEventSource(context);
            const name = resolveEventName(context, event);
            if (typeof source.off === 'function') source.off(name, handler);
            else source.removeListener?.(name, handler);
            return true;
        }, { loadMetric: () => 0 }),

        /** Все ключи событий, о которых знает ЭТА сборка ST — реальный discovery, а не захардкоженный у нас список (см. приоритет "безопасность от изменений ST"). */
        bus.register('stEvents.types', () => Object.keys(getContext().eventTypes ?? {}), { loadMetric: () => 0 }),
    ];

    return () => { for (const unregister of unregisters) unregister(); };
}
