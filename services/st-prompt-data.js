/**
 * Данные SillyTavern, которые движку нужны вне сборки промпта: имена и
 * открытый чат (гид, тест карточки), режим подключения, и вызов функций ST
 * (`function_calling`), без которого движок не получит свои инструменты.
 *
 * Prompt Manager удалён (часть 3): его `presets`, `chat`, `streaming` и поля
 * карточки/персоны, нужные только ему, ушли вместе с ним.
 */
export function registerStPromptDataService(bus, { getContext } = {}) {
    function read() {
        const context = getContext() ?? {};
        const id = context.characterId;
        const character = id != null ? context.characters?.[id] : null;
        return {
            mainApi: context.mainApi ?? null,
            chatCompletionSource: context.chatCompletionSettings?.chat_completion_source ?? null,
            isGroup: context.groupId != null,
            user: context.name1 ?? 'User',
            char: context.name2 ?? character?.name ?? '',
            chatLength: context.chat?.length ?? 0,
            chatId: context.getCurrentChatId?.() ?? null,
            model: (() => { try { return String(context.getChatCompletionModel?.() ?? ''); } catch { return ''; } })(),
        };
    }

    /**
     * Вызов функций ST (`function_calling`): читает и включает. ST отправляет
     * инструменты в запрос, только когда эта настройка включена. Движок
     * включает её сам, когда у него есть свои инструменты (Notebook и др.).
     * Флажок в панели ST обновляется тоже: ST перечитывает ВСЕ свои поля из
     * разметки при любом изменении настроек.
     */
    function functionCalling(params) {
        const context = getContext();
        const settings = context?.chatCompletionSettings;
        if (!settings) return null;
        const previous = Boolean(settings.function_calling);
        if (params && typeof params.value === 'boolean' && params.value !== previous) {
            settings.function_calling = params.value;
            try { const box = globalThis.document?.getElementById?.('openai_function_calling'); if (box) box.checked = params.value; } catch { /* панели может не быть */ }
            context.saveSettingsDebounced?.();
        }
        return { previous, current: Boolean(settings.function_calling) };
    }

    const unregisters = [
        bus.register('stPromptData.functionCalling', params => functionCalling(params)),
        bus.register('stPromptData.read', () => read()),
    ];
    return { read, unregister: () => { for (const unregister of unregisters) unregister(); } };
}
