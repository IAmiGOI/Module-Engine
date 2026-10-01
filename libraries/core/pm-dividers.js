/**
 * Разделители Prompt Manager: две цветные полосы в обычном списке порядка, которые показывают, какие блоки между ними подчиняются условию (например, «Jev
 * ответил Да»). Это НЕ группа: ни обёртки-тега, ни детей, ни своего сообщения. Членство задаёт положение — всё, что стоит ниже верхней полосы и выше нижней
 * того же списка. Вложенные пары работают как скобки и красятся своими цветами.
 *
 * Узел: `{ type: 'divider', id, pair, edge: 'begin' | 'end', color, name?, enabled, condition? }`. Условие лежит на верхней полосе; у выключенной верхней
 * полосы условия нет (блоки между полосами идут всегда). Полосы сами ничего не отправляют. Пара, у которой нет второй половины в том же списке, не действует:
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

/** Пары, у которых обе половины на месте и верхняя стоит выше нижней: `Set<pair>`. Остальные не действуют (см. doc-comment файла). */
export function computeValidPairs(list) {
    const begun = new Set();
    const valid = new Set();
    for (const node of list) {
        if (!isDivider(node)) continue;
        if (node.edge === 'begin') begun.add(node.pair);
        else if (node.edge === 'end' && begun.has(node.pair)) valid.add(node.pair);
    }
    return valid;
}

/** Пары, которые не действуют, с причиной — для превью и подсветки в окне. */
export function computeBrokenPairs(list) {
    const valid = computeValidPairs(list);
    const seen = new Map();
    for (const node of list) if (isDivider(node)) seen.set(node.pair, { pair: node.pair, name: node.name ?? '' });
    return [...seen.values()].filter(item => !valid.has(item.pair));
}

/**
 * Список без полос и без блоков тех областей, чьё условие не выполнено. `passes(beginNode)` → истина, если область отправляется. Вложенные области:
 * закрытая внешняя область уносит и внутренние. `skipped` — по записи на каждую выброшенную область (для отчёта превью).
 */
export function applyDividers(list, { passes }) {
    const valid = computeValidPairs(list);
    const out = [];
    const open = [];
    const skipped = [];
    let hidden = 0;
    for (const node of list) {
        if (!isDivider(node)) {
            if (hidden === 0) out.push(node);
            else if (skipped.length) skipped.at(-1).blocks += 1;
            continue;
        }
        if (!valid.has(node.pair)) continue;
        if (node.edge === 'begin') {
            const hides = hidden === 0 && node.enabled !== false && !passes(node);
            // Область внутри уже скрытой не считаем: уносит её внешняя, а запись в отчёте нужна одна.
            const insideHidden = hidden > 0;
            open.push({ pair: node.pair, hides: hides || insideHidden });
            if (hides) skipped.push({ pair: node.pair, name: node.name ?? '', blocks: 0, reason: 'divider condition' });
            if (hides || insideHidden) hidden += 1;
        } else {
            const at = open.map(frame => frame.pair).lastIndexOf(node.pair);
            if (at < 0) continue;
            // Всё, что открыто выше и не закрыто, закрывается вместе с этой парой: полосы вложены, как скобки.
            for (const frame of open.splice(at)) if (frame.hides) hidden -= 1;
        }
    }
    return { nodes: out, skipped };
}

/** Все условия верхних полос включённых пар в списке (для предзагрузки ответов Jev). */
export function collectDividerConditions(list) {
    const valid = computeValidPairs(list);
    return list.filter(node => isDivider(node) && node.edge === 'begin' && node.enabled !== false && valid.has(node.pair) && node.condition).map(node => node.condition);
}
