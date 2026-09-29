import { PM_FORMAT_VERSION, PARAM_KEYS, TEMPLATE_KEYS, createEmptyPreset } from './pm-preset-format.js';
import { glueWrapperGroups } from './pm-wrapper-groups.js';
import { importStRegexScripts } from './pm-rules.js';

/** Поля промпта ST, которые понимаем: имя в ST -> имя в блоке. Остальное уходит в `extra`. */
const PROMPT_FIELDS = {
    identifier: 'id', name: 'name', role: 'role', content: 'content', system_prompt: 'system', marker: 'marker',
    forbid_overrides: 'forbidOverrides', injection_depth: 'depth', injection_order: 'order',
    injection_trigger: 'triggers', enabled: 'stEnabled',
};

function importPrompt(raw) {
    const block = {};
    const extra = {};
    for (const [key, value] of Object.entries(raw)) {
        if (key === 'injection_position') block.position = value === 1 ? 'depth' : 'relative';
        else if (PROMPT_FIELDS[key]) block[PROMPT_FIELDS[key]] = value;
        else extra[key] = value;
    }
    if (Object.keys(extra).length) block.extra = extra;
    if (block.stEnabled === undefined) block.stEnabled = null; // в источнике поля не было — при экспорте не выдумываем
    return block;
}

/** Основной список порядка: самый длинный (у ST это «глобальный» 100001), при равенстве — последний. */
function pickPrimaryOrder(lists) {
    let best = null;
    for (const list of lists) if (!best || list.order.length >= best.order.length) best = list;
    return best;
}

/**
 * Пресет ST Chat Completion (объект или JSON-строка) → внутренний формат.
 * Включение берём из `prompt_order[].enabled` (эффективное), поле `enabled` самого промпта
 * остаётся в блоке как `stEnabled` только ради точного экспорта.
 */
export function stToPreset(source, { name = 'Imported preset' } = {}) {
    const st = typeof source === 'string' ? JSON.parse(source) : source;
    if (!st || typeof st !== 'object' || !Array.isArray(st.prompts)) throw new Error('This file is not a Chat Completion preset (no "prompts" list).');
    const preset = createEmptyPreset(name);
    preset.formatVersion = PM_FORMAT_VERSION;
    const known = new Set(['prompts', 'prompt_order', 'extensions', ...PARAM_KEYS, ...Object.keys(TEMPLATE_KEYS)]);
    for (const [key, value] of Object.entries(st)) {
        if (PARAM_KEYS.includes(key)) preset.params[key] = value;
        else if (TEMPLATE_KEYS[key]) preset.templates[TEMPLATE_KEYS[key]] = value;
        else if (!known.has(key)) preset.opaque[key] = value;
    }
    if (st.extensions !== undefined) preset.extensions = st.extensions;
    preset.rules = importStRegexScripts(st.extensions?.regex_scripts); // extensions остаётся как есть — для точного экспорта
    preset.blocks = st.prompts.map(importPrompt);

    const lists = (Array.isArray(st.prompt_order) ? st.prompt_order : []).filter(list => Array.isArray(list?.order));
    const primary = pickPrimaryOrder(lists);
    preset.orders = lists.map(list => ({ characterId: list.character_id, raw: list === primary ? null : list.order }));
    preset.primaryOrder = primary ? primary.character_id : null;
    const flat = primary
        ? primary.order.map(entry => ({ type: 'item', block: entry.identifier, enabled: entry.enabled !== false }))
        : preset.blocks.map(block => ({ type: 'item', block: block.id, enabled: block.stEnabled !== false }));
    preset.tree = glueWrapperGroups(flat, new Map(preset.blocks.map(block => [block.id, block])));
    return preset;
}
