/**
 * Сервис инструментов ST — единственное место, знающее про
 * `context.registerFunctionTool`/`unregisterFunctionTool`. Просто логический
 * адаптер: зарегистрировать определение, снять по имени. Ни оборачивания
 * колбэка, ни учёта вызовов — это внутренняя логика Ядра жизненного цикла
 * генерации ([cores/generation/index.js](../cores/generation/index.js)),
 * которое и передаёт сюда уже инструментированное определение.
 *
 * Форма определения — ровно та, что у настоящего ST (см. рабочий код Alpha,
 * modules/dice): `{ name, displayName, description, parameters, action }`,
 * где `action(args)` возвращает результат для модели.
 */
export function registerStToolsService(bus, { getContext } = {}) {
    const unregisters = [
        bus.register('stTools.register', ({ definition }) => {
            const context = getContext();
            if (typeof context.registerFunctionTool !== 'function') {
                throw new Error('stTools: SillyTavern function-tool API (context.registerFunctionTool) is unavailable.');
            }
            // Снять одноимённый перед регистрацией — так же делает Alpha: иначе
            // повторная регистрация (например, после переоткрытия чата) может
            // оставить в ST старое определение рядом с новым.
            context.unregisterFunctionTool?.(definition?.name);
            context.registerFunctionTool(definition);
            return true;
        }, { loadMetric: () => 0 }),

        bus.register('stTools.unregister', ({ name }) => {
            getContext().unregisterFunctionTool?.(name);
            return true;
        }, { loadMetric: () => 0 }),
    ];

    return () => { for (const unregister of unregisters) unregister(); };
}
