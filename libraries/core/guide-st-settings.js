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

const SAMPLER_KEYS = Object.freeze(['temperature', 'top_p', 'top_k', 'top_a', 'min_p', 'typical_p', 'frequency_penalty', 'presence_penalty', 'repetition_penalty', 'rep_pen', 'max_tokens', 'genamt', 'openai_max_tokens']);

/** Пресет генерации → строка: известные параметры сэмплера человеческими именами, плюс шаблоны контекста/инструкции. Неизвестные поля API не выдумываются — просто не упоминаются. */
export function describePreset(preset) {
    if (!preset?.values) return '';
    const known = SAMPLER_KEYS.filter(key => preset.values[key] !== undefined).map(key => `${key}: ${preset.values[key]}`);
    const parts = [`API: ${preset.api}`, `preset name: "${preset.name || 'unnamed'}"`];
    if (known.length) parts.push(`sampler: ${known.join(', ')}`);
    if (preset.contextTemplate) parts.push(`context template: "${preset.contextTemplate}"`);
    if (preset.instructTemplate) parts.push(`instruct mode ${yesNo(preset.instructEnabled)}, template: "${preset.instructTemplate}"`);
    return parts.join('; ');
}
