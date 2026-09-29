/**
 * Модель дерева порядка пресета PM для окна: чистые операции без DOM (PROMPT_MANAGER_PLAN.md, раздел 0 «Интерфейс»).
 * Путь узла — массив индексов от корня: `[2]` — третий узел верхнего уровня, `[2, 0]` — первый ребёнок группы `[2]`.
 * Ветки выбора «одного из» в путь входят как ребёнок: `[i, optionIndex, j]` — поэтому у `choice` дети лежат в `options[k].children`.
 * Все операции возвращают НОВОЕ дерево, исходное не трогают.
 */
const clone = value => structuredClone(value);

export function childrenOf(node) {
    if (node.type === 'group') return node.children;
    return null;
}

export function getAt(tree, path) {
    let list = tree;
    let node = null;
    for (const index of path) {
        node = list?.[index];
        if (!node) return null;
        list = childrenOf(node);
    }
    return node;
}

function parentList(tree, path) {
    let list = tree;
    for (const index of path.slice(0, -1)) list = childrenOf(list[index]);
    return list;
}

const samePath = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const isPrefix = (prefix, path) => prefix.length < path.length && prefix.every((v, i) => v === path[i]);

/** Подпись узла для строки списка. */
export function describeNode(node, blocks) {
    if (node.type === 'group') return { label: node.name || 'Group', kind: 'group', detail: node.wrap ? `<${node.name}> … </${node.name}>` : '' };
    if (node.type === 'inject') return { label: node.name || node.contribution, kind: 'module', detail: node.placement?.mode === 'depth' ? `module · depth ${node.placement.depth}` : 'module contribution' };
    if (node.type === 'note') return { label: node.text || 'Note', kind: 'note', detail: '' };
    if (node.type === 'choice') return { label: node.name || 'Choice', kind: 'choice', detail: `one of ${node.options?.length ?? 0}` };
    const block = blocks.find(b => b.id === node.block);
    if (!block) return { label: node.block, kind: 'missing', detail: 'block is missing' };
    if (block.marker) return { label: block.name ?? block.id, kind: 'marker', detail: block.id };
    return { label: block.name || block.id, kind: 'text', detail: block.position === 'depth' ? `${block.role ?? 'system'} · depth ${block.depth ?? 4}` : (block.role ?? 'system') };
}

/** Плоский список строк для отрисовки; свёрнутые группы прячут детей. */
export function flattenRows(tree, blocks, collapsed = new Set(), path = [], depth = 0) {
    const rows = [];
    tree.forEach((node, index) => {
        const nodePath = [...path, index];
        const key = nodePath.join('.');
        const children = childrenOf(node);
        rows.push({ path: nodePath, key, depth, node, ...describeNode(node, blocks), hasChildren: Boolean(children), collapsed: collapsed.has(key) });
        if (children && !collapsed.has(key)) rows.push(...flattenRows(children, blocks, collapsed, nodePath, depth + 1));
    });
    return rows;
}

export function toggleAt(tree, path) {
    const next = clone(tree);
    const node = getAt(next, path);
    if (node) node.enabled = !node.enabled;
    return next;
}

export function removeAt(tree, path) {
    const next = clone(tree);
    parentList(next, path).splice(path.at(-1), 1);
    return next;
}

export function insertAt(tree, path, node) {
    const next = clone(tree);
    parentList(next, path).splice(path.at(-1), 0, clone(node));
    return next;
}

/**
 * Перенос узла. `target` — путь узла-цели, `where`: 'before' | 'after' | 'inside' (в конец группы-цели).
 * Нельзя переносить узел в самого себя или в свою же ветку; такой запрос ничего не меняет.
 */
export function moveNode(tree, from, target, where) {
    if (samePath(from, target) || isPrefix(from, target)) return tree;
    const next = clone(tree);
    const targetNode = getAt(next, target);
    if (!targetNode) return tree;
    const [node] = parentList(next, from).splice(from.at(-1), 1);
    if (where === 'inside' && targetNode.type === 'group') { targetNode.children.push(node); return next; }
    // Цель ищем по ссылке уже ПОСЛЕ удаления: индексы за удалённым узлом сдвинулись.
    const find = list => {
        for (let i = 0; i < list.length; i++) {
            if (list[i] === targetNode) return { list, index: i };
            const inner = childrenOf(list[i]) && find(list[i].children);
            if (inner) return inner;
        }
        return null;
    };
    const place = find(next);
    if (!place) return tree;
    place.list.splice(place.index + (where === 'after' ? 1 : 0), 0, node);
    return next;
}

/** Сдвиг на одну позицию вверх/вниз внутри того же списка (кнопки для тач-экрана и клавиатуры). */
export function stepNode(tree, path, delta) {
    const list = parentList(tree, path);
    const to = path.at(-1) + delta;
    if (to < 0 || to >= list.length) return tree;
    const next = clone(tree);
    const target = parentList(next, path);
    [target[path.at(-1)], target[to]] = [target[to], target[path.at(-1)]];
    return next;
}

let counter = 0;
const newBlockId = () => `blk_${Date.now().toString(36)}${(counter++).toString(36)}`;

/** Новый текстовый блок: возвращает { block, node } — вызывающий кладёт блок в `preset.blocks`, узел — в дерево. */
export function createTextBlock({ name = 'New prompt', role = 'system', content = '' } = {}) {
    const id = newBlockId();
    return { block: { id, name, role, content }, node: { type: 'item', block: id, enabled: true } };
}

/** Новая группа с обёрткой `<тег>` … `</тег>`: два блока-тега и узел группы. */
export function createWrapperGroup(tag = 'section') {
    const open = createTextBlock({ name: `<${tag}>`, content: `<${tag}>` });
    const close = createTextBlock({ name: `</${tag}>`, content: `</${tag}>` });
    return { blocks: [open.block, close.block], node: { type: 'group', id: `group-${open.block.id}`, name: tag, enabled: true, wrap: { open: open.block.id, close: close.block.id }, skipWhenEmpty: true, children: [] } };
}

export const createNote = text => ({ type: 'note', text: text || 'Note', enabled: true });

/** Удаление узла вместе с блоками, на которые больше никто не ссылается (блоки-обёртки группы — тоже). */
export function unusedBlockIds(tree, blocks) {
    const used = new Set();
    const walk = nodes => nodes.forEach(node => {
        if (node.type === 'item') used.add(node.block);
        if (node.type === 'group') { used.add(node.wrap.open); used.add(node.wrap.close); walk(node.children); }
        if (node.type === 'choice') node.options?.forEach(option => walk(option.children ?? []));
    });
    walk(tree);
    return blocks.filter(block => !used.has(block.id) && !block.marker).map(block => block.id);
}
