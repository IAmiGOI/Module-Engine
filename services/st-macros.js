/**
 * Сервис для регистрации `{{macro}}` в самом ST — просто логический адаптер,
 * реальный API-поверхность скопирована из Alpha's core/data-bus.js
 * (`#registerMacro`/`#unregisterMacro`), которая уже проверена на реальном
 * ST: современный `context.macros.register(name, {handler, ...})` первым,
 * легаси `context.registerMacro(name, handler)` — фоллбэком.
 *
 * `handler` передаётся ЦЕЛИКОМ, как функция, через params — контракты этой
 * Шины не пересекают процесс (см. services/dom.js, который так же передаёт
 * живые DOM-узлы), так что это не сериализуется и не требует особого
 * механизма: ST зовёт `handler` напрямую и синхронно каждый раз, когда где-то
 * встречает `{{name}}` — Ядро исполнения макросов передаёт сюда функцию,
 * читающую его собственный уже-закэшированный результат, а не что-то,
 * что заново считает значение по требованию (см. cores/macros/index.js).
 */
export function registerStMacrosService(bus, { getContext } = {}) {
    function registerMacro({ name, handler }) {
        const context = getContext();
        if (typeof context.macros?.register === 'function') {
            context.macros.register(name, { handler, category: 'STATE', description: `ST Module Engine macro "${name}".` });
        } else if (typeof context.registerMacro === 'function') {
            context.registerMacro(name, handler);
        } else {
            throw new Error('stMacros.register: neither context.macros.register nor context.registerMacro is available in this ST build.');
        }
        return true;
    }

    function unregisterMacro({ name }) {
        const context = getContext();
        if (typeof context.macros?.registry?.unregisterMacro === 'function') context.macros.registry.unregisterMacro(name);
        else context.unregisterMacro?.(name);
        return true;
    }

    const unregisters = [
        bus.register('stMacros.register', registerMacro, { loadMetric: () => 0 }),
        bus.register('stMacros.unregister', unregisterMacro, { loadMetric: () => 0 }),
    ];
    return () => { for (const unregister of unregisters) unregister(); };
}
