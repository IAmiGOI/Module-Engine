/**
 * Разделители Prompt Manager: две цветные полосы в обычном списке порядка, которые показывают, какие блоки между ними подчиняются условию (например, «Jev
 * ответил Да»). Это НЕ группа: ни обёртки-тега, ни детей, ни своего сообщения. Членство задаёт положение — всё, что стоит ниже верхней полосы и выше нижней
 * в порядке документа (полосы могут стоять в разных группах). Вложенные пары работают как скобки и красятся своими цветами.
 *
 * Узел: `{ type: 'divider', id, pair, edge: 'begin' | 'end', color, name?, enabled, condition? }`. Условие лежит на верхней полосе; у выключенной верхней
 * полосы условия нет (блоки между полосами идут всегда). Полосы сами ничего не отправляют. Пара, у которой нет второй половины (или нижняя выше верхней), не действует:
 * лучше отправить лишнее, чем молча потерять блоки из-за сломанной разметки.
 */

export const DIVIDER_PALETTE = Object.freeze(['#e5484d', '#f5a524', '#30a46c', '#0091ff', '#8e4ec6', '#d6409f', '#12a594', '#8d8d8d']);

export const isDivider = node => node?.type === 'divider';

let dividerCounter = 0;
const newDividerId = () => `div_${Date.now().toString(36)}${(dividerCounter++).toString(36)}`;

/** Цвет для новой пары: первый из палитры, которого ещё нет среди уже стоящих полос (чтобы вложенные пары различались), иначе по кругу. */
export function pickDividerColor(tree) {
    const used = new Set();
    const walk = nodes => nodes.forEach(node => {
        if (isDivider(node)) used.add(node.color);
        if (node.type === 'group') walk(node.children ?? []);
        if (node.type === 'choice') node.options?.forEach(option => walk(option.children ?? []));
    });
    walk(tree ?? []);
    return DIVIDER_PALETTE.find(color => !used.has(color)) ?? DIVIDER_PALETTE[used.size % DIVIDER_PALETTE.length];
}

/** Новая пара полос `[begin, end]` одного цвета. */
export function createDividerPair({ color = DIVIDER_PALETTE[0], name = '' } = {}) {
    const pair = newDividerId();
    return [
        { type: 'divider', id: `${pair}_begin`, pair, edge: 'begin', color, name, enabled: true },
        { type: 'divider', id: `${pair}_end`, pair, edge: 'end', color, name, enabled: true },
    ];
}

/** Узлы одной области полос: список и все его группы по порядку документа. Варианты выбора (choice) — отдельные области: полосы в них не связаны с внешними. */
function* walkScope(list) {
    for (const node of list ?? []) {
        yield node;
        if (node.type === 'group') yield* walkScope(node.children);
    }
}

function* walkScopes(list) {
    yield list;
    for (const node of walkScope(list)) if (node.type === 'choice') for (const option of node.options ?? []) yield* walkScopes(option.children ?? []);
}

/**
 * Пары, у которых обе половины на месте и верхняя стоит выше нижней В ПОРЯДКЕ ДОКУМЕНТА (группы раскрыты: верхняя может быть внутри группы, а нижняя —
 * снаружи или в другой группе): `Set<pair>`. Остальные не действуют (см. doc-comment файла).
 */
export function computeValidPairs(list) {
    const valid = new Set();
    for (const scope of walkScopes(list)) {
        const begun = new Set();
        for (const node of walkScope(scope)) {
            if (!isDivider(node)) continue;
            if (node.edge === 'begin') begun.add(node.pair);
            else if (node.edge === 'end' && begun.has(node.pair)) valid.add(node.pair);
        }
    }
    return valid;
}

/** Пары, которые не действуют, с причиной — для превью и подсветки в окне. */
export function computeBrokenPairs(list) {
    const valid = computeValidPairs(list);
    const seen = new Map();
    for (const scope of walkScopes(list)) for (const node of walkScope(scope)) if (isDivider(node)) seen.set(node.pair, { pair: node.pair, name: node.name ?? '' });
    return [...seen.values()].filter(item => !valid.has(item.pair));
}

/**
 * Дерево без полос и без блоков тех областей, чьё условие не выполнено. `passes(beginNode)` → истина, если область отправляется. Область идёт по порядку
 * документа и пересекает группы: группа, открытая внутри скрытой области, остаётся, только если в ней есть что-то после закрытия области (обёртка нужна
 * ей самой). Вложенные области: закрытая внешняя уносит и внутренние. `skipped` — по записи на каждую выброшенную область (для отчёта превью).
 */
export function applyDividers(list, { passes }) {
    if (!Array.isArray(list)) throw new TypeError('The preset tree must be a list.');
    const valid = computeValidPairs(list);
    const skipped = [];
    const countGone = () => { if (skipped.length) skipped.at(-1).blocks += 1; };
    const stripScope = scopeList => {
        const state = { open: [], hidden: 0 };
        const walk = nodes => {
            const out = [];
            for (const node of nodes ?? []) {
                if (isDivider(node)) {
                    if (!valid.has(node.pair)) continue;
                    if (node.edge === 'begin') {
                        const hides = state.hidden === 0 && node.enabled !== false && !passes(node);
                        state.open.push({ pair: node.pair, hides: hides || state.hidden > 0 });
                        if (hides) skipped.push({ pair: node.pair, name: node.name ?? '', blocks: 0, reason: 'divider condition' });
                        if (hides || state.hidden > 0) state.hidden += 1;
                    } else {
                        const at = state.open.map(frame => frame.pair).lastIndexOf(node.pair);
                        if (at >= 0) for (const frame of state.open.splice(at)) if (frame.hides) state.hidden -= 1;
                    }
                    continue;
                }
                const hiddenHere = state.hidden > 0;
                if (node.type === 'group') {
                    const children = walk(node.children);
                    if (hiddenHere && !children.length) { countGone(); continue; }
                    out.push({ ...node, children });
                    continue;
                }
                if (hiddenHere) { countGone(); continue; }
                out.push(node.type === 'choice' ? { ...node, options: (node.options ?? []).map(option => ({ ...option, children: stripScope(option.children ?? []) })) } : node);
            }
            return out;
        };
        return walk(scopeList);
    };
    return { nodes: stripScope(list), skipped };
}

/** Все условия верхних полос включённых пар в списке (для предзагрузки ответов Jev). */
export function collectDividerConditions(list) {
    const valid = computeValidPairs(list);
    const found = [];
    for (const scope of walkScopes(list)) for (const node of walkScope(scope)) if (isDivider(node) && node.edge === 'begin' && node.enabled !== false && valid.has(node.pair) && node.condition) found.push(node.condition);
    return found;
}
