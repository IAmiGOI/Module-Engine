import { PARAM_KEYS, TEMPLATE_KEYS } from './pm-preset-format.js';
import { flattenTree } from './pm-wrapper-groups.js';

const SECRET_KEY_RE = /(api[_-]?key|secret|token|password|authorization)/i;
const BLOCK_FIELDS = {
    id: 'identifier', name: 'name', role: 'role', content: 'content', system: 'system_prompt', marker: 'marker',
    forbidOverrides: 'forbid_overrides', depth: 'injection_depth', order: 'injection_order', triggers: 'injection_trigger',
};

/** Секреты чистим при ЛЮБОМ экспорте (решение владельца, раздел 10.5). Возвращает копию. */
export function stripSecrets(object) {
    const out = {};
    for (const [key, value] of Object.entries(object ?? {})) if (!SECRET_KEY_RE.test(key)) out[key] = value;
    return out;
}

function exportPrompt(block, effective) {
    const raw = { ...(block.extra ?? {}) };
    for (const [key, stKey] of Object.entries(BLOCK_FIELDS)) if (block[key] !== undefined) raw[stKey] = block[key];
    if (block.position !== undefined) raw.injection_position = block.position === 'depth' ? 1 : 0;
    // Блок, пришедший из ST, хранит своё исходное `enabled`; блок, созданный в PM, — эффективное состояние.
    if (block.stEnabled === undefined) raw.enabled = effective.get(block.id) ?? false;
    else if (block.stEnabled !== null) raw.enabled = block.stEnabled;
    return raw;
}

/** Внутренний формат → пресет ST. Без потерь для импортированного из ST. */
export function presetToSt(preset) {
    const st = {};
    for (const key of PARAM_KEYS) if (preset.params[key] !== undefined) st[key] = preset.params[key];
    for (const [stKey, key] of Object.entries(TEMPLATE_KEYS)) if (preset.templates[key] !== undefined) st[stKey] = preset.templates[key];
    Object.assign(st, stripSecrets(preset.opaque));
    const primary = flattenTree(preset.tree);
    const effective = new Map(primary.map(entry => [entry.identifier, entry.enabled]));
    st.prompts = preset.blocks.map(block => exportPrompt(block, effective));
    st.prompt_order = preset.orders.map(list => ({
        character_id: list.characterId,
        order: list.raw ?? primary,
    }));
    if (!st.prompt_order.length && primary.length) st.prompt_order = [{ character_id: preset.primaryOrder ?? 100001, order: primary }];
    st.extensions = preset.extensions ?? {};
    return st;
}
