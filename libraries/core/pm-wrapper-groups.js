/**
 * Склейка парных промптов-обёрток в группы (решение владельца 5.133 / раздел 10.4):
 * `<setting>` … `</setting>` — два отдельных промпта с одним только тегом внутри,
 * между ними порядок держит человек. В PM это одна группа с обёрткой; при экспорте
 * группа снова разворачивается в те же два промпта на тех же местах.
 *
 * Склеиваем только когда безопасно: роль system, содержимое — ровно тег, состояние включения у пары одинаковое и
 * либо оба промпта «относительные», либо оба — вставки на ОДНУ глубину, а всё между ними — вставки той же глубины
 * с порядком между порядками тегов (так в пресетах владельца: `<char instructions>` 8/101 … 8/102–105 … 8/106).
 * Такая группа получает размещение «на глубину» и уходит одним сообщением (ROADMAP.md 5.140). Пара, охватывающая
 * разные глубины (`<last_message>` у Marinara), — не группа, а обёртка последнего сообщения (отдельная функция).
 */
const OPEN_RE = /^<([^<>/\n]{1,60})>$/;
const CLOSE_RE = /^<\/([^<>\n]{1,60})>$/;

const isDepth = block => block?.position === 'depth';

/** Можно ли склеить пару: обе относительные — да; обе на одной глубине — если всё между ними на той же глубине и внутри порядка. */
function sameKind(open, close, between, blocks) {
    if (isDepth(open) !== isDepth(close)) return false;
    if (!isDepth(open)) return true;
    const depth = open.depth ?? 4, from = open.order ?? 100, to = close.order ?? 100;
    if ((close.depth ?? 4) !== depth || from > to) return false;
    return between.every(node => {
        const block = node.type === 'item' ? blocks.get(node.block) : null;
        return isDepth(block) && (block.depth ?? 4) === depth && (block.order ?? 100) >= from && (block.order ?? 100) <= to;
    });
}

function wrapperTag(block, re) {
    if (!block || block.marker) return null;
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
        const open = blocks.get(node.block), close = closeAt < 0 ? null : blocks.get(items[closeAt].block);
        const between = closeAt < 0 ? [] : items.slice(i + 1, closeAt);
        if (closeAt < 0 || items[closeAt].enabled !== node.enabled || !sameKind(open, close, between, blocks)) { out.push(node); continue; }
        out.push({
            type: 'group', id: `group-${node.block}`, name: tag, enabled: node.enabled,
            wrap: { open: node.block, close: items[closeAt].block }, skipWhenEmpty: true,
            ...(isDepth(open) ? { placement: { mode: 'depth', depth: open.depth ?? 4, order: open.order ?? 100 } } : {}),
            children: glueWrapperGroups(between, blocks),
        });
        i = closeAt;
    }
    return out;
}

/**
 * Досклейка уже готового дерева (пресеты, подготовленные до 5.140, где пары на глубине не склеивались): в каждом
 * списке узлов — и внутри групп — склеиваются подходящие пары; существующие группы и прочие узлы не трогаются.
 * Повторный вызов ничего не меняет. Возвращает { tree, changed }.
 */
export function regroupTree(nodes, blocks) {
    let changed = false;
    const walk = list => {
        const glued = glueWrapperGroups(list, blocks);
        if (glued.length !== list.length) changed = true;
        return glued.map(node => (node.type === 'group' && list.includes(node) ? { ...node, children: walk(node.children ?? []) } : node));
    };
    const tree = walk(nodes ?? []);
    return { tree, changed };
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
