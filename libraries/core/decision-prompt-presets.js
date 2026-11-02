/**
 * Пресеты раздела и обмен промптами: сохранить, загрузить, дублировать,
 * удалить; импорт промптов из пресета ST с выбором раздела; экспорт и импорт
 * JSON раздела. Чистые данные — файлы читает и скачивает окно через сервисы.
 */
import { createTextBlock, normalizeSection } from './decision-prompt-model.js';

const clone = value => structuredClone(value);
let presetCounter = 0;
const newPresetId = () => `preset_${Date.now().toString(36)}_${(presetCounter += 1).toString(36)}`;

export function savePreset(section, name) {
    const next = clone(section);
    const active = next.presets.find(preset => preset.id === next.activePresetId);
    if (active) {
        active.blocks = clone(next.blocks);
        active.tree = clone(next.tree);
        if (String(name ?? '').trim()) active.name = String(name).trim();
        return next;
    }
    const preset = {
        id: newPresetId(), name: String(name ?? '').trim() || `Preset ${next.presets.length + 1}`,
        blocks: clone(next.blocks), tree: clone(next.tree),
    };
    next.presets.push(preset);
    next.activePresetId = preset.id;
    return next;
}

export function loadPreset(section, id) {
    const preset = (section.presets ?? []).find(item => item.id === id);
    if (!preset) return section;
    return { ...clone(section), blocks: clone(preset.blocks), tree: clone(preset.tree), activePresetId: id };
}

export function duplicatePreset(section, id) {
    const source = (section.presets ?? []).find(item => item.id === id);
    if (!source) return section;
    const copy = { id: newPresetId(), name: `${source.name} (copy)`, blocks: clone(source.blocks), tree: clone(source.tree) };
    return { ...clone(section), presets: [...section.presets, copy], activePresetId: copy.id };
}

export function deletePreset(section, id) {
    const next = clone(section);
    next.presets = next.presets.filter(preset => preset.id !== id);
    if (next.activePresetId === id) next.activePresetId = '';
    return next;
}

export function appendBlocks(section, blocks) {
    const next = clone(section);
    for (const block of blocks ?? []) {
        next.blocks.push(block);
        next.tree.push({ type: 'item', block: block.id, enabled: true });
    }
    return next;
}

/** Промпты пресета ST для выбора раздела. Маркеры ST отдают пустой текст — их видно, но по умолчанию не берут. */
export function stPrompts(source) {
    const st = typeof source === 'string' ? JSON.parse(source) : source;
    if (!st || typeof st !== 'object' || !Array.isArray(st.prompts)) throw new Error('This file is not a Chat Completion preset (no "prompts" list).');
    return st.prompts.map((prompt, index) => {
        const marker = String(prompt?.marker ?? '').trim();
        return {
            key: String(prompt?.identifier ?? `prompt_${index}`),
            name: String(prompt?.name ?? prompt?.identifier ?? `Prompt ${index + 1}`),
            role: ['system', 'user', 'assistant'].includes(prompt?.role) ? prompt.role : 'system',
            content: String(prompt?.content ?? ''),
            enabled: prompt?.enabled !== false,
            marker: marker || null,
            markerText: marker,
        };
    });
}

/** Выбор раздела на каждый промпт: `{ [key]: 'director' | 'writer' }`. Пустой текст и маркеры не берутся. */
export function blocksFromStPrompts(prompts, choices = {}) {
    const director = [];
    const writer = [];
    for (const prompt of prompts) {
        const where = choices[prompt.key];
        if (where !== 'director' && where !== 'writer') continue;
        if (prompt.marker || !prompt.content.trim()) continue;
        const block = createTextBlock({ name: prompt.name, role: prompt.role, content: prompt.content });
        (where === 'director' ? director : writer).push(block);
    }
    return { director, writer };
}

export function exportSection(section, sectionId) {
    return { kind: 'decision-prompt-section', version: 1, section: sectionId, blocks: clone(section.blocks), tree: clone(section.tree) };
}

/** JSON раздела → рабочий блок и дерево. Пресеты раздела сохраняются. */
export function importSection(section, json, sectionId) {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    if (!data || data.kind !== 'decision-prompt-section') throw new Error('This file is not a decision prompt section.');
    if (Number(data.version) !== 1) throw new Error(`Unsupported section version: ${data.version}.`);
    if (data.section && data.section !== sectionId) throw new Error(`This file belongs to the ${data.section} section, not ${sectionId}.`);
    const imported = normalizeSection({ blocks: data.blocks, tree: data.tree });
    const blocks = imported.blocks;
    const tree = imported.tree;
    return { ...clone(section), blocks, tree, activePresetId: '' };
}
