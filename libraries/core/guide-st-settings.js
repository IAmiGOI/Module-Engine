/**
 * Настройки самой SillyTavern (не движка) для гида (cores/guide/context.js): чистые функции — сырые данные `services/st-worldinfo.js` и
 * `services/st-preset.js` → строка для промпта. Только описание для АНАЛИЗА, действий на изменение этих настроек у гида нет: правка — за родными
 * экранами World Info и пресетов ST (см. doc-comment обоих Сервисов).
 */

const yesNo = value => (value ? 'on' : 'off');

/** Глобальные настройки World Info → строка с пояснением каждого поля. */
export function describeWorldInfo(settings) {
    if (!settings) return '';
    const parts = [
        `scan depth ${settings.depth} messages`,
        `token budget ${settings.budget}${settings.budgetCap ? ` (hard cap ${settings.budgetCap})` : ''}`,
        `insertion order ${settings.insertionStrategy}`,
        `recursive scanning ${yesNo(settings.recursive)}${settings.recursive && settings.maxRecursionSteps ? ` (max ${settings.maxRecursionSteps} steps)` : ''}`,
        `include character/persona names in the scan text ${yesNo(settings.includeNames)}`,
        `case-sensitive keys ${yesNo(settings.caseSensitive)}`,
        `match whole words only ${yesNo(settings.matchWholeWords)}`,
        `group scoring ${yesNo(settings.useGroupScoring)}`,
    ];
    if (settings.minActivations) parts.push(`minimum activations ${settings.minActivations} (search back up to ${settings.minActivationsDepthMax || 'no limit'} extra messages to reach it)`);
    if (settings.overflowAlert) parts.push('warns when an entry does not fit the budget');
    return parts.join('; ');
}

/**
 * Каждый API называет одно и то же по-своему (temperature/temp, repetition_penalty/rep_pen…) — списки ниже сводят их к общим подписям.
 * Взято по исходнику самой ST (openai.js, textgen-settings.js, kai-settings.js, nai-settings.js), не угадано — и это уже стоило одной
 * ошибки: `openai`'ные имена ниже раньше были взяты из таблицы DOM-биндингов openai.js (её КЛЮЧИ — внутренние ярлыки вроде `temperature`,
 * которых в самом `oai_settings` нет), а не из настоящего объекта настроек, где поля лежат под суффиксом `_openai` (`temp_openai`,
 * `freq_pen_openai`…) — найдено на живом ответе: `describePreset` показывала только `max tokens`, ни один другой параметр не совпадал
 * с реальным полем. Заодно `openai_max_tokens` — это ответ модели (response length), а не общий контекст (`openai_max_context`) — обе
 * подписаны отдельно, чтобы не путать с общим лимитом.
 */
const KOBOLD_FIELDS = [['temp', 'temperature'], ['top_p', 'top_p'], ['top_k', 'top_k'], ['top_a', 'top_a'], ['min_p', 'min_p'], ['typical', 'typical_p'], ['tfs', 'tail-free sampling'], ['rep_pen', 'repetition penalty'], ['rep_pen_range', 'repetition penalty range']];
const SAMPLER_FIELDS = Object.freeze({
    openai: [['temp_openai', 'temperature'], ['top_p_openai', 'top_p'], ['top_k_openai', 'top_k'], ['top_a_openai', 'top_a'], ['min_p_openai', 'min_p'], ['freq_pen_openai', 'frequency penalty'], ['pres_pen_openai', 'presence penalty'], ['repetition_penalty_openai', 'repetition penalty'], ['openai_max_tokens', 'max output tokens'], ['openai_max_context', 'max context']],
    textgenerationwebui: [['temp', 'temperature'], ['top_p', 'top_p'], ['top_k', 'top_k'], ['top_a', 'top_a'], ['min_p', 'min_p'], ['typical_p', 'typical_p'], ['tfs', 'tail-free sampling'], ['rep_pen', 'repetition penalty'], ['freq_pen', 'frequency penalty'], ['presence_pen', 'presence penalty']],
    kobold: KOBOLD_FIELDS,
    koboldhorde: KOBOLD_FIELDS,
    novel: [['temperature', 'temperature'], ['top_p', 'top_p'], ['top_k', 'top_k'], ['top_a', 'top_a'], ['min_p', 'min_p'], ['typical_p', 'typical_p'], ['tail_free_sampling', 'tail-free sampling'], ['repetition_penalty', 'repetition penalty']],
});

/** Пресет генерации → строка: известные параметры сэмплера человеческими именами (по своей раскладке полей для этого API), плюс шаблоны контекста/инструкции. Неизвестные поля API не выдумываются — просто не упоминаются. */
export function describePreset(preset) {
    if (!preset?.api) return '';
    const fields = SAMPLER_FIELDS[preset.api] ?? [];
    const known = preset.values ? fields.filter(([key]) => preset.values[key] !== undefined).map(([key, label]) => `${label}: ${preset.values[key]}`) : [];
    const parts = [`API: ${preset.api}`, `preset name: "${preset.name || 'unnamed'}"`];
    if (known.length) parts.push(`sampler: ${known.join(', ')}`);
    if (preset.contextTemplate) parts.push(`context template: "${preset.contextTemplate}"`);
    if (preset.instructTemplate) parts.push(`instruct mode ${yesNo(preset.instructEnabled)}, template: "${preset.instructTemplate}"`);
    return parts.join('; ');
}
