/**
 * Склейка парных промптов-обёрток в группы (решение владельца 5.133 / раздел 10.4):
 * `<setting>` … `</setting>` — два отдельных промпта с одним только тегом внутри,
 * между ними порядок держит человек. В PM это одна группа с обёрткой; при экспорте
 * группа снова разворачивается в те же два промпта на тех же местах.
 *
 * Склеиваем только когда безопасно: оба промпта «относительные» (не инжект в историю),
 * роль system, содержимое — ровно тег, и состояние включения у пары одинаковое.
 */
const OPEN_RE = /^<([^<>/\n]{1,60})>$/;
const CLOSE_RE = /^<\/([^<>\n]{1,60})>$/;

function wrapperTag(block, re) {
    if (!block || block.marker || block.position === 'depth') return null;
    if ((block.role ?? 'system') !== 'system' || typeof block.content !== 'string') return null;
    const match = re.exec(block.content.trim());
    return match ? match[1].trim() : null;
}

function findClose(items, from, tag, blocks) {
    let depth = 0;
    for (let i = from + 1; i < items.length; i++) {
        const node = items[i];
        if (node.type !== 'item') continue;
        const block = blocks.get(node.block);
        if (wrapperTag(block, OPEN_RE) === tag) depth++;
        else if (wrapperTag(block, CLOSE_RE) === tag) { if (depth === 0) return i; depth--; }
    }
    return -1;
}

/** Плоский порядок → дерево с группами. Ничего не меняет, если обёрток нет. */
export function glueWrapperGroups(items, blocks) {
    const out = [];
    for (let i = 0; i < items.length; i++) {
        const node = items[i];
        const tag = node.type === 'item' ? wrapperTag(blocks.get(node.block), OPEN_RE) : null;
        const closeAt = tag ? findClose(items, i, tag, blocks) : -1;
        if (closeAt < 0 || items[closeAt].enabled !== node.enabled) { out.push(node); continue; }
        out.push({
            type: 'group', id: `group-${node.block}`, name: tag, enabled: node.enabled,
            wrap: { open: node.block, close: items[closeAt].block }, skipWhenEmpty: true,
            children: glueWrapperGroups(items.slice(i + 1, closeAt), blocks),
        });
        i = closeAt;
    }
    return out;
}

/**
 * Дерево → плоский порядок `{identifier, enabled}` для prompt_order ST. Узлы, у которых нет аналога в ST
 * (вклады модулей `inject`, заметки `note`), в файл ST не попадают; выбор «одного из» уходит выбранной веткой.
 */
export function flattenTree(nodes) {
    const out = [];
    for (const node of nodes) {
        if (node.type === 'group') {
            out.push({ identifier: node.wrap.open, enabled: node.enabled });
            out.push(...flattenTree(node.children));
            out.push({ identifier: node.wrap.close, enabled: node.enabled });
        } else if (node.type === 'choice') {
            const option = node.options?.find(o => o.id === node.selected) ?? node.options?.[0];
            if (node.enabled && option) out.push(...flattenTree(option.children ?? []));
        } else if (node.type === 'item') out.push({ identifier: node.block, enabled: node.enabled });
    }
    return out;
}
