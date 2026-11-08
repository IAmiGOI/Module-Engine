/**
 * Одноразовая чистка старых блоков разделов (до пяти ролей): их смысл теперь в
 * банке, Указе, правилах хода и STORY SETTINGS, а часть ссылается на инструменты,
 * которых у резолвера нет (set_character_plan, decisionReason). Решение владельца
 * 2026-11-08: убрать всё, кроме FOV и Range у Writer. Блок убирается по имени —
 * из раздела, из его дерева и из копий в наборах. Чистая функция.
 */
export const LEGACY_BLOCKS = Object.freeze({
    director: ['Need Guidelines', 'GOAL Gudelines', 'Decision Guidelines', 'PSYCHO', 'Attention points', 'Where?'],
    writer: ['Second Person', 'Attention Points', 'Pace and Time skips', 'New prompt'],
});

const ALL_NAMES = new Set([...LEGACY_BLOCKS.director, ...LEGACY_BLOCKS.writer, 'Goal Guidelines']);

const prune = (nodes, ids) => (Array.isArray(nodes) ? nodes : [])
    .filter(node => !(node?.type === 'item' && ids.has(node.block)))
    .map(node => (Array.isArray(node?.children) ? { ...node, children: prune(node.children, ids) } : node));

function clean(holder, names) {
    const drop = (holder?.blocks ?? []).filter(block => names.has(String(block?.name ?? '').trim()));
    if (!drop.length) return { holder, removed: [] };
    const ids = new Set(drop.map(block => block.id).filter(Boolean));
    return {
        holder: { ...holder, blocks: holder.blocks.filter(block => !names.has(String(block?.name ?? '').trim())), tree: prune(holder.tree, ids) },
        removed: drop.map(block => block.name),
    };
}

/** Разделы → { sections, removed }; ничего не нашлось — removed пуст и sections те же. */
export function withoutLegacyBlocks(sections = {}) {
    const next = { ...(sections ?? {}) };
    const removed = [];
    for (const [id, list] of Object.entries(LEGACY_BLOCKS)) {
        const section = next[id];
        if (!section || typeof section !== 'object') continue;
        const names = new Set(list);
        const own = clean(section, names);
        removed.push(...own.removed.map(name => `${id}: ${name}`));
        // Наборы могли хранить копии блоков другого раздела (у Writer лежали блоки Director) — чистятся по всем старым именам.
        const presets = (own.holder.presets ?? []).map(preset => clean(preset, ALL_NAMES).holder);
        next[id] = { ...own.holder, ...(Array.isArray(own.holder.presets) ? { presets } : {}) };
    }
    return { sections: next, removed };
}
