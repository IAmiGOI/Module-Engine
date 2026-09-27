/**
 * Глобальные настройки World Info самой SillyTavern (scan depth, budget, стратегия вставки, рекурсия…) — только чтение, для гида (cores/guide).
 *
 * Их НЕТ на публичном `getContext()` (тот же вывод уже сделан в `services/st-lorebook.js`'s doc-comment для `selected_world_info`/`world_info.charLore`,
 * проверено по актуальному исходнику `st-context.js`), только `export let` в самом `scripts/world-info.js`. Extension и сама ST — один и тот же
 * бандл модулей, поэтому `import()` этого пути отдаёт ЖИВЫЕ биндинги: каждый вызов — свежее значение на момент вызова, а не снимок при загрузке
 * страницы. Изменить их отсюда нельзя (ES-биндинги на импорте — только для чтения), правка остаётся за родным экраном World Info ST — этот Сервис
 * только объясняет то, что там уже стоит.
 */
export function registerStWorldInfoService(bus, { importScript = () => import('/scripts/world-info.js') } = {}) {
    async function settings() {
        const module = await importScript();
        const strategy = Object.entries(module.world_info_insertion_strategy ?? {}).find(([, value]) => value === module.world_info_character_strategy);
        return {
            depth: module.world_info_depth,
            budget: module.world_info_budget,
            budgetCap: module.world_info_budget_cap,
            insertionStrategy: strategy?.[0] ?? String(module.world_info_character_strategy),
            recursive: Boolean(module.world_info_recursive),
            maxRecursionSteps: module.world_info_max_recursion_steps,
            minActivations: module.world_info_min_activations,
            minActivationsDepthMax: module.world_info_min_activations_depth_max,
            includeNames: Boolean(module.world_info_include_names),
            caseSensitive: Boolean(module.world_info_case_sensitive),
            matchWholeWords: Boolean(module.world_info_match_whole_words),
            useGroupScoring: Boolean(module.world_info_use_group_scoring),
            overflowAlert: Boolean(module.world_info_overflow_alert),
        };
    }

    const unregister = bus.register('stWorldInfo.settings', () => settings());
    return { settings, unregister };
}
