/**
 * Текущий пресет генерации самой SillyTavern — только чтение, для гида (cores/guide). В отличие от World Info (services/st-worldinfo.js), тут есть
 * устойчивая публичная поверхность: `getContext().mainApi` + `getContext().getPresetManager(api).getSelectedPreset()` — то же, чем пользуется
 * собственный UI ST для пресетов, а не внутренние модули напрямую. Форма `values` зависит от API (у Chat Completion и Text Completion разные поля
 * сэмплера) — отдаётся как есть, гид читает её сама (см. знания «Generation preset»); контекстный и инструктивный шаблоны — из `power_user`
 * (`context.preset`/`instruct.preset`), они общие для любого API.
 */
export function registerStPresetService(bus, { getContext = () => null } = {}) {
    function current() {
        const context = getContext();
        if (!context) return null;
        const api = context.mainApi;
        const manager = context.getPresetManager?.(api);
        const values = manager?.getSelectedPreset?.();
        if (!values) return null;
        const power = context.powerUserSettings ?? {};
        return {
            api,
            name: manager.getSelectedPresetName?.() ?? '',
            values,
            contextTemplate: power.context?.preset ?? '',
            instructEnabled: Boolean(power.instruct?.enabled),
            instructTemplate: power.instruct?.preset ?? '',
        };
    }

    const unregister = bus.register('stPreset.current', () => current());
    return { current, unregister };
}
