/**
 * Модель раздела промптов директора и прозаика. Чистые данные без DOM и шин:
 * блоки, дерево пользователя, пресеты и закреплённые системные строки.
 *
 * Путь узла — массив индексов от корня: `[2]` — третий узел, `[2, 0]` —
 * первый ребёнок группы `[2]`. Системные строки живут вне дерева; их путь —
 * `['system', index]`, и операции над ними модель отвергает: сдвинуть,
 * удалить или выключить встроенную инструкцию нельзя.
 */
import { DIRECTOR_SYSTEM, WRITER_SYSTEM } from './decision-prompts.js';
import { normalizeCondition } from './decision-prompt-conditions.js';

export const PROMPT_SECTION_IDS = Object.freeze(['director', 'writer']);
export const PROMPT_ROLES = Object.freeze(['system', 'user', 'assistant']);
export const PROMPT_SECTIONS_VERSION = 1;

const clone = value => structuredClone(value);
let counter = 0;

const SYSTEM = {
    director: [{ id: 'director.system', name: 'Resolver instructions', role: 'system', text: DIRECTOR_SYSTEM }],
    writer: [{ id: 'writer.system', name: 'Writer instructions', role: 'system', text: WRITER_SYSTEM }],
};

/** Закреплённые строки раздела — только чтение; в настройках не хранятся. */
export function systemLines(sectionId) {
    return (SYSTEM[sectionId] ?? []).map(line => ({ ...line, locked: true }));
}

export function newBlockId() {
    counter += 1;
    return `blk_${Date.now().toString(36)}_${counter.toString(36)}`;
}

export function createTextBlock({ name = 'New prompt', role = 'system', content = '', id } = {}) {
    return { id: id ?? newBlockId(), name: String(name), role: PROMPT_ROLES.includes(role) ? role : 'system', content: String(content) };
}

export function createGroup(tag = 'section', { id, name } = {}) {
    return {
        type: 'group', id: id ?? `group_${newBlockId()}`, name: String(name ?? tag), tag: String(tag),
        enabled: true, skipWhenEmpty: true, children: [],
    };
}

export function emptySection() {
    return { blocks: [], tree: [], presets: [], activePresetId: '' };
}

export function defaultPromptSections() {
    return Object.fromEntries(PROMPT_SECTION_IDS.map(id => [id, emptySection()]));
}

export const isSystemPath = path => Array.isArray(path) && path[0] === 'system';

/** Есть ли хотя бы один пользовательский промпт в любом разделе. */
export function sectionsAreEmpty(sections) {
    return PROMPT_SECTION_IDS.every(id => !(sections?.[id]?.blocks?.length) && !(sections?.[id]?.tree?.length));
}

function normalizeBlock(block) {
    if (!block || typeof block !== 'object' || typeof block.id !== 'string' || !block.id) return null;
    return createTextBlock({ id: block.id, name: block.name, role: block.role, content: block.content });
}

function normalizeNode(node, blocks) {
    if (!node || typeof node !== 'object') return null;
    if (node.type === 'group') {
        const children = (Array.isArray(node.children) ? node.children : []).map(child => normalizeNode(child, blocks)).filter(Boolean);
        return {
            type: 'group', id: String(node.id ?? `group_${newBlockId()}`), name: String(node.name ?? node.tag ?? 'Group'),
            tag: String(node.tag ?? node.name ?? 'section'), enabled: node.enabled !== false,
            skipWhenEmpty: node.skipWhenEmpty !== false, condition: normalizeCondition(node.condition) ?? undefined, children,
        };
    }
    if (!blocks.has(String(node.block ?? ''))) return null;
    return {
        type: 'item', block: String(node.block), enabled: node.enabled !== false,
        condition: normalizeCondition(node.condition) ?? undefined,
    };
}

function normalizeTree(tree, blocks) {
    return (Array.isArray(tree) ? tree : []).map(node => normalizeNode(node, blocks)).filter(Boolean);
}

/** Защитное чтение раздела: ручная правка настроек не должна ломать окно и сборку. */
export function normalizeSection(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    const seen = new Set();
    const blocks = (Array.isArray(source.blocks) ? source.blocks : [])
        .map(normalizeBlock)
        .filter(block => {
            if (!block || seen.has(block.id)) return false;
            seen.add(block.id);
            return true;
        });
    const blockIds = new Set(blocks.map(block => block.id));
    const presets = (Array.isArray(source.presets) ? source.presets : []).map((preset, index) => {
        if (!preset || typeof preset !== 'object') return null;
        const presetBlocks = (Array.isArray(preset.blocks) ? preset.blocks : []).map(normalizeBlock).filter(Boolean);
        return {
            id: String(preset.id ?? `preset_${index}`), name: String(preset.name ?? `Preset ${index + 1}`),
            blocks: presetBlocks, tree: normalizeTree(preset.tree, new Set(presetBlocks.map(block => block.id))),
        };
    }).filter(Boolean);
    const activePresetId = String(source.activePresetId ?? '');
    return {
        blocks, tree: normalizeTree(source.tree, blockIds), presets,
        activePresetId: presets.some(preset => preset.id === activePresetId) ? activePresetId : '',
    };
}

function sectionWithLegacyPrompt(text) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) return emptySection();
    const block = createTextBlock({ name: 'Your prompt', role: 'system', content: trimmed, id: `legacy_${newBlockId()}` });
    return { blocks: [block], tree: [{ type: 'item', block: block.id, enabled: true }], presets: [], activePresetId: '' };
}

/**
 * Миграция двух полей части 3. Если `promptSections` уже есть, она
 * используется как есть: миграция не повторяется и не воскрешает очищенное.
 */
export function migratePromptSections(value, legacyPrompts = {}) {
    const source = value && typeof value === 'object' ? value : null;
    const sections = defaultPromptSections();
    for (const id of PROMPT_SECTION_IDS) {
        sections[id] = source ? normalizeSection(source[id]) : sectionWithLegacyPrompt(legacyPrompts?.[id]);
    }
    return sections;
}

function listAt(tree, path) {
    let list = tree;
    let node = null;
    for (const index of path) {
        node = list[index];
        if (!node) return null;
        list = node.children ?? [];
    }
    return node;
}

function parentList(tree, path) {
    if (path.length === 1) return tree;
    const parent = listAt(tree, path.slice(0, -1));
    return parent?.children ?? null;
}

/** Узел по пути; системная строка отдаётся копией и только на чтение. */
export function getNode(section, path) {
    if (isSystemPath(path)) return null;
    return listAt(section?.tree ?? [], path);
}

export function flattenRows(sectionId, section, collapsed = new Set()) {
    const rows = systemLines(sectionId).map((line, index) => ({
        path: ['system', index], kind: 'system', label: line.name, detail: 'locked', locked: true, node: line, hasChildren: false,
    }));
    const walk = (nodes, depth, prefix) => {
        nodes.forEach((node, index) => {
            const path = [...prefix, index];
            if (node.type === 'group') {
                rows.push({
                    path, kind: 'group', label: node.name, detail: `<${node.tag}>`, node, depth,
                    hasChildren: node.children.length > 0, collapsed: collapsed.has(path.join(':')),
                });
                if (!collapsed.has(path.join(':'))) walk(node.children, depth + 1, path);
            } else {
                const block = section.blocks.find(item => item.id === node.block);
                rows.push({ path, kind: 'item', label: block?.name ?? 'missing prompt', detail: block?.role ?? '', node, depth, hasChildren: false });
            }
        });
    };
    walk(section?.tree ?? [], 0, []);
    return rows;
}

export function patchBlock(section, blockId, changes) {
    const next = clone(section);
    const block = next.blocks.find(item => item.id === blockId);
    if (block) Object.assign(block, changes);
    return next;
}

export function patchNode(section, path, changes) {
    if (isSystemPath(path)) return section;
    const next = clone(section);
    const node = listAt(next.tree, path);
    if (node) Object.assign(node, changes);
    return next;
}

export function toggleNode(section, path) {
    if (isSystemPath(path)) return section;
    const next = clone(section);
    const node = listAt(next.tree, path);
    if (node) node.enabled = node.enabled === false;
    return next;
}

function collectUsed(nodes, used = new Set()) {
    for (const node of nodes) {
        if (node.type === 'group') collectUsed(node.children ?? [], used);
        else used.add(node.block);
    }
    return used;
}

export function removeNode(section, path) {
    if (isSystemPath(path)) return section;
    const next = clone(section);
    const list = parentList(next.tree, path);
    if (!list || path.at(-1) >= list.length) return section;
    list.splice(path.at(-1), 1);
    const used = collectUsed(next.tree);
    next.blocks = next.blocks.filter(block => used.has(block.id));
    return next;
}

export function moveNode(section, from, target, where) {
    if (isSystemPath(from) || isSystemPath(target)) return section;
    const next = clone(section);
    const sourceList = parentList(next.tree, from);
    const targetNode = listAt(next.tree, target);
    if (!sourceList || !targetNode) return section;
    if (from.length === target.length && from.every((value, index) => value === target[index])) return section;
    if (from.length < target.length && from.every((value, index) => value === target[index])) return section;
    const [node] = sourceList.splice(from.at(-1), 1);
    if (!node) return section;
    if (where === 'inside' && targetNode.type === 'group') { targetNode.children.push(node); return next; }
    const place = findNode(next.tree, targetNode);
    if (!place) return section;
    place.list.splice(place.index + (where === 'after' ? 1 : 0), 0, node);
    return next;
}

function findNode(nodes, wanted, parent = null) {
    for (let index = 0; index < nodes.length; index += 1) {
        if (nodes[index] === wanted) return { list: nodes, index };
        const found = findNode(nodes[index].children ?? [], wanted, nodes[index]);
        if (found) return found;
    }
    return null;
}

export function stepNode(section, path, delta) {
    if (isSystemPath(path)) return section;
    const next = clone(section);
    const list = parentList(next.tree, path);
    const to = (path.at(-1) ?? 0) + delta;
    if (!list || to < 0 || to >= list.length) return section;
    [list[path.at(-1)], list[to]] = [list[to], list[path.at(-1)]];
    return next;
}

export function addBlock(section, block, afterPath = null) {
    const next = clone(section);
    next.blocks.push(block);
    const node = { type: 'item', block: block.id, enabled: true };
    insertNode(next.tree, afterPath, node);
    return next;
}

export function addGroup(section, group, afterPath = null) {
    const next = clone(section);
    insertNode(next.tree, afterPath, group);
    return next;
}

function insertNode(tree, afterPath, node) {
    if (!afterPath) { tree.push(node); return; }
    const list = parentList(tree, afterPath);
    if (!list) { tree.push(node); return; }
    list.splice(afterPath.at(-1) + 1, 0, node);
}
