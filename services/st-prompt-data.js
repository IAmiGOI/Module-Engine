/**
 * Сервис данных для сборки промпта (Prompt Manager): единственное место, читающее сырую ST ради сборки.
 *  - `stPromptData.read`  — карточка персонажа, персона, имена, режим (`mainApi`, группа), источник Chat Completion;
 *  - `stPromptData.presets` — пресеты Chat Completion из `/api/settings/get` (имена и содержимое) + имя выбранного.
 * Только чтение: ничего в ST не пишет.
 */
export function registerStPromptDataService(bus, { getContext, fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
    function read() {
        const context = getContext() ?? {};
        const id = context.characterId;
        const character = id != null ? context.characters?.[id] : null;
        const data = character?.data ?? {};
        const power = context.powerUserSettings ?? {};
        return {
            mainApi: context.mainApi ?? null,
            chatCompletionSource: context.chatCompletionSettings?.chat_completion_source ?? null,
            isGroup: context.groupId != null,
            user: context.name1 ?? 'User',
            char: context.name2 ?? character?.name ?? '',
            description: character?.description ?? data.description ?? '',
            personality: character?.personality ?? data.personality ?? '',
            scenario: character?.scenario ?? data.scenario ?? '',
            mesExamples: character?.mes_example ?? data.mes_example ?? '',
            // Как у ST: карточный промпт действует, пока включены «Prefer Char. Prompt / Jailbreak» (по умолчанию включены); у чата может быть свой системный промпт.
            systemPrompt: power.prefer_character_prompt === false ? '' : (context.chatMetadata?.system_prompt || data.system_prompt || ''),
            postHistoryInstructions: power.prefer_character_jailbreak === false ? '' : (data.post_history_instructions ?? ''),
            depthPrompt: { prompt: data.extensions?.depth_prompt?.prompt ?? '', depth: Number(data.extensions?.depth_prompt?.depth ?? 4), role: data.extensions?.depth_prompt?.role ?? 'system' },
            persona: power.persona_description ?? '',
            chatLength: context.chat?.length ?? 0,
            chatId: context.getCurrentChatId?.() ?? null,
            model: (() => { try { return String(context.getChatCompletionModel?.() ?? ''); } catch { return ''; } })(),
            selectedPresetName: context.getPresetManager?.('openai')?.getSelectedPresetName?.() ?? null,
            wiScanDepth: context.worldInfoSettings?.world_info_depth ?? null,
            wiBudgetPercent: context.worldInfoSettings?.world_info_budget ?? null,
        };
    }

    async function presets() {
        const context = getContext() ?? {};
        const response = await fetchImpl('/api/settings/get', { method: 'POST', headers: context.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' }, body: '{}' });
        if (!response.ok) throw new Error(`stPromptData.presets: /api/settings/get answered ${response.status}.`);
        const data = await response.json();
        const names = data?.openai_setting_names ?? [];
        const contents = data?.openai_settings ?? [];
        const out = [];
        names.forEach((name, index) => {
            try { out.push({ name, preset: typeof contents[index] === 'string' ? JSON.parse(contents[index]) : contents[index] }); } catch { /* битый файл пресета пропускается, как это делает ST */ }
        });
        return out;
    }

    /** Копия истории чата ST в её родном виде (`mes`, `is_user`, `extra`…) — для превью вне генерации. */
    const chat = () => (getContext()?.chat ?? []).map(entry => ({ ...entry }));

    /** Стриминг ST (`stream_openai`): читает и ставит; ядро PM возвращает прежнее значение по окончании генерации. */
    function streaming(params) {
        const settings = getContext()?.chatCompletionSettings;
        if (!settings) return null;
        const previous = Boolean(settings.stream_openai);
        if (params && typeof params.value === 'boolean') settings.stream_openai = params.value;
        return { previous, current: Boolean(settings.stream_openai) };
    }

    const unregisters = [bus.register('stPromptData.streaming', params => streaming(params)), bus.register('stPromptData.chat', () => chat()), bus.register('stPromptData.read', () => read()), bus.register('stPromptData.presets', () => presets())];
    return { read, presets, unregister: () => { for (const unregister of unregisters) unregister(); } };
}
