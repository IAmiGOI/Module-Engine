/**
 * Модель дерева порядка пресета PM для окна: чистые операции без DOM (PROMPT_MANAGER_PLAN.md, раздел 0 «Интерфейс»).
 * Путь узла — массив индексов от корня: `[2]` — третий узел верхнего уровня, `[2, 0]` — первый ребёнок группы `[2]`.
 * Ветки выбора «одного из» в путь входят как ребёнок: `[i, optionIndex, j]` — поэтому у `choice` дети лежат в `options[k].children`.
 * Все операции возвращают НОВОЕ дерево, исходное не трогают.
 */
import { isDivider, computeValidPairs, createDividerPair, pickDividerColor } from '../../../libraries/core/pm-dividers.js';
import { describeCondition } from './condition-model.js';

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
    if (isDivider(node)) return describeDivider(node);
    if (node.type === 'choice') return { label: node.name || 'Choice', kind: 'choice', detail: `one of ${node.options?.length ?? 0}` };
    const block = blocks.find(b => b.id === node.block);
    if (!block) return { label: node.block, kind: 'missing', detail: 'block is missing' };
    if (block.marker) return { label: block.name ?? block.id, kind: 'marker', detail: block.id };
    return { label: block.name || block.id, kind: 'text', detail: block.position === 'depth' ? `${block.role ?? 'system'} · depth ${block.depth ?? 4}` : (block.role ?? 'system') };
}

/** Подпись полосы-разделителя: верхняя несёт имя и условие («Jev: … не ниже 70%»), нижняя — только закрывает область. */
function describeDivider(node) {
    if (node.edge === 'end') return { label: node.name ? `end · ${node.name}` : 'end of the region', kind: 'divider', detail: '' };
    return { label: node.name || 'Region', kind: 'divider', detail: node.condition ? describeCondition(node.condition) : 'no condition — always sent' };
}

/**
 * Плоский список строк для отрисовки; свёрнутые группы прячут детей. Каждая строка несёт `rails` — цвета областей-разделителей, внутри которых она стоит
 * (внешние первыми): по ним окно рисует цветные рейки слева. Сами полосы стоят на рейках внешних областей, свой цвет у полосы — фоном. Область идёт по порядку
 * документа и пересекает группы (pm-dividers.js), поэтому открытые рейки переходят из группы наружу и обратно.
 */
export function flattenRows(tree, blocks, collapsed = new Set(), path = [], depth = 0, scope = { valid: computeValidPairs(tree), open: [] }) {
    const rows = [];
    const { valid, open } = scope;
    tree.forEach((node, index) => {
        const nodePath = [...path, index];
        const key = nodePath.join('.');
        const children = childrenOf(node);
        const divider = isDivider(node) && valid.has(node.pair);
        const rails = open.map(frame => frame.color);
        if (divider && node.edge === 'begin') open.push({ pair: node.pair, color: node.color });
        if (divider && node.edge === 'end') { const at = open.map(frame => frame.pair).lastIndexOf(node.pair); if (at >= 0) open.splice(at); }
        rows.push({ path: nodePath, key, depth, node, ...describeNode(node, blocks), hasChildren: Boolean(children), collapsed: collapsed.has(key), rails, divider: isDivider(node) ? { edge: node.edge, color: node.color, broken: !valid.has(node.pair) } : null });
        if (children && !collapsed.has(key)) rows.push(...flattenRows(children, blocks, collapsed, nodePath, depth + 1, scope));
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
/** Перенос не должен ставить нижнюю полосу выше верхней: такой ход (и перетаскиванием, и кнопкой) отклоняется, дерево остаётся прежним. */
function keepPairsValid(before, after) {
    const was = computeValidPairs(before);
    const now = computeValidPairs(after);
    return [...was].every(pair => now.has(pair)) ? after : before;
}

export function moveNode(tree, from, target, where) {
    return keepPairsValid(tree, moveNodeUnchecked(tree, from, target, where));
}

function moveNodeUnchecked(tree, from, target, where) {
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
    return keepPairsValid(tree, next);
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

/**
 * Пара полос вокруг выбранной строки (верхняя перед ней, нижняя после) либо пустая пара в конце списка, если ничего не выбрано. Цвет — первый свободный из палитры.
 * Возвращает `{ tree, path }`: новое дерево и путь верхней полосы (её и выделяет окно, там условие).
 */
export function insertDividerPair(tree, selectedPath) {
    const next = clone(tree);
    const [begin, end] = createDividerPair({ color: pickDividerColor(tree) });
    if (!selectedPath) { next.push(begin, end); return { tree: next, path: [next.length - 2] }; }
    const list = parentList(next, selectedPath);
    const at = selectedPath.at(-1);
    list.splice(at + 1, 0, end);
    list.splice(at, 0, begin);
    return { tree: next, path: [...selectedPath.slice(0, -1), at] };
}

/** Удаляет обе полосы пары (где бы они ни стояли): одна без другой ничего не значит. Блоки между ними остаются на местах. */
export function removeDividerPair(tree, pair) {
    const strip = nodes => nodes.filter(node => !(isDivider(node) && node.pair === pair)).map(node => {
        if (node.type === 'group') return { ...node, children: strip(node.children ?? []) };
        if (node.type === 'choice') return { ...node, options: (node.options ?? []).map(option => ({ ...option, children: strip(option.children ?? []) })) };
        return node;
    });
    return strip(clone(tree));
}

/** Меняет поля обеих полос пары разом (имя, цвет): полосы одной пары всегда одного цвета и с одним именем. */
export function patchDividerPair(tree, pair, changes) {
    const next = clone(tree);
    const visit = nodes => nodes.forEach(node => {
        if (isDivider(node) && node.pair === pair) Object.assign(node, changes);
        if (node.type === 'group') visit(node.children ?? []);
        if (node.type === 'choice') node.options?.forEach(option => visit(option.children ?? []));
    });
    visit(next);
    return next;
}

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
