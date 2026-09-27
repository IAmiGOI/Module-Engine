/**
 * Текущий пресет генерации самой SillyTavern — только чтение, для гида (cores/guide). Найдено и исправлено на живых данных (ROADMAP 5.105щ
 * отдало неверный `values`): `PresetManager.getSelectedPreset()` — НЕ настройки сэмплера, это буквально `<option>.value` выбранного пункта
 * в `<select>` пресета (строка типа `"gui"` у встроенного KoboldAI-пресета, имя у "keyed" API вроде Chat Completion, индекс у остальных) —
 * прочитано по исходнику `preset-manager.js`, а не угадано; `getSelectedPresetName()` честно читает текст опции и годится как есть.
 *
 * Настоящие ЖИВЫЕ значения сэмплера лежат в разных местах по API (`context.mainApi`):
 * - `openai` (Chat Completion) — `getContext().chatCompletionSettings` (= `oai_settings`), отдаётся публично.
 * - `textgenerationwebui` (Text Completion) — `getContext().textCompletionSettings` (= `textgenerationwebui_settings`), тоже публично.
 * - `kobold`/`koboldhorde` — `kai_settings` из `scripts/kai-settings.js`, публично не отдаётся — тот же приём живого импорта, что у
 *   `services/st-worldinfo.js` (`export const`, но поля мутируются на месте, так что читать нужно каждый раз заново).
 * - `novel` — так же `nai_settings` из `scripts/nai-settings.js`.
 * Имена полей сэмплера у каждого API свои (`temperature` vs `temp`, `repetition_penalty` vs `rep_pen`…) — сведение к общим подписям
 * оставлено `describePreset` в `libraries/core/guide-st-settings.js`, этот Сервис отдаёт значения как есть, под своим `api`.
 */
export function registerStPresetService(bus, { getContext = () => null, importKai = () => import('/scripts/kai-settings.js'), importNai = () => import('/scripts/nai-settings.js') } = {}) {
    async function valuesFor(api, context) {
        if (api === 'openai') return context.chatCompletionSettings ?? null;
        if (api === 'textgenerationwebui') return context.textCompletionSettings ?? null;
        if (api === 'kobold' || api === 'koboldhorde') return (await importKai()).kai_settings ?? null;
        if (api === 'novel') return (await importNai()).nai_settings ?? null;
        return null;
    }

    async function current() {
        const context = getContext();
        if (!context) return null;
        const api = context.mainApi;
        const manager = context.getPresetManager?.(api);
        const power = context.powerUserSettings ?? {};
        return {
            api,
            name: manager?.getSelectedPresetName?.() ?? '',
            values: await valuesFor(api, context),
            contextTemplate: power.context?.preset ?? '',
            instructEnabled: Boolean(power.instruct?.enabled),
            instructTemplate: power.instruct?.preset ?? '',
        };
    }

    const unregister = bus.register('stPreset.current', () => current());
    return { current, unregister };
}
