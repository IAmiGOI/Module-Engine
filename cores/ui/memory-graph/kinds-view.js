/**
 * Вид нод в окне графа structured (MEMORY_GRAPH_TYPES_PLAN.md, этап 8) — чистые функции, без DOM и Cytoscape.
 * Окно берёт режим из `memoryGraph.mode`: у legacy-графа ни одна функция отсюда не вызывается, элементы карты остаются прежними.
 */

/** Вид ноды показывается ЦВЕТОМ (метрика `kind`, режим карты «Types»), а не формой — все ноды остаются кругами (решение владельца). */
export const KIND_LABEL = Object.freeze({ entity: 'Entity', object: 'Object', fact: 'Fact', event: 'Event' });
const KINDS = Object.keys(KIND_LABEL);

const kindOf = node => (KINDS.includes(node?.kind) ? node.kind : 'fact');

/** Поля элемента Cytoscape для ноды structured-графа (`data(kind|core|subtype)`). */
export function nodeKindData(node) {
    const kind = kindOf(node);
    return { kind, core: Boolean(node.core), subtype: kind === 'object' ? (node.subtype ?? '') : '', superseded: Boolean(node.supersededBy) };
}

/**
 * Концы ребра для рисования: у ребра события — направленно (запись `dir: 'out'`, запись `'in'` того же ребра пропускается,
 * чтобы не рисовать его дважды); лор — как раньше, без стрелки (`null` значит «рисуй обычным способом»).
 */
export function directedEdgeEnds(node, edge) {
    if (edge.dir === 'in') return { skip: true };
    if (edge.dir === 'out') return { skip: false, source: node.id, target: edge.to, directed: true, chain: edge.type === 'next' };
    return null;
}

/** Правила стиля structured — только по данным (`data(directed|chain)`), поэтому на legacy-элементах, у которых этих полей нет, не срабатывают. */
export function structuredStyleRules() {
    return [
        { selector: 'edge[?directed]', style: { 'target-arrow-shape': 'triangle', 'target-arrow-color': 'data(lineColor)', 'arrow-scale': 0.8, 'curve-style': 'bezier' } },
        { selector: 'edge[?chain]', style: { width: 1.6, 'line-opacity': 0.7 } },
        { selector: 'node[?superseded]', style: { opacity: 0.4 } }, // устаревшее значение состояния — история, приглушена
    ];
}

/** Флажки Show окна: какие виды показывать и «только Core». */
export const DEFAULT_KIND_FILTERS = Object.freeze({ entity: true, object: true, fact: true, event: true, coreOnly: false });

/** Скрыть ли ноду фильтрами по видам (класс `.filtered`, раскладка не пересчитывается). */
export function hiddenByKind(node, filters) {
    if (filters.coreOnly && !node.core) return true;
    return filters[kindOf(node)] === false;
}

// --- События рядом с якорем -------------------------------------------------

const hashOf = text => { let hash = 0; for (const ch of String(text)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0; return hash; };
const GOLDEN_ANGLE = 2.399963229728653;

/** Событие раскладывается по орбите вокруг якоря — не Core (Core-событие живёт как обычная нода региона) и с известным якорем. */
export function isOrbitEvent(node, nodesById) {
    return kindOf(node) === 'event' && !node.core && Boolean(eventAnchorId(node, nodesById));
}

/** Якорь события — первая нода, из которой в него идёт `participates` (в записи события — `dir: 'in'`). */
export function eventAnchorId(event, nodesById) {
    const edge = (event.edges ?? []).find(item => item.type === 'participates' && item.dir === 'in' && nodesById[item.to]);
    return edge ? edge.to : null;
}

/**
 * Позиции событий: по орбите вокруг якоря вне диска региона, детерминированно (порядок — по `createdAt`, затем `id`), так что
 * событие ничего не сдвигает и не зависит от других. `positions`/`radii` — Map якорей из раскладки; `orbitGap` — зазор от края якоря.
 */
export function placeEventsNearAnchors(events, nodesById, positions, radii, { orbitGap = 26, ringStep = 16, perRing = 6 } = {}) {
    const byAnchor = new Map();
    for (const event of events) {
        const anchorId = eventAnchorId(event, nodesById);
        if (!anchorId || !positions.has(anchorId)) continue;
        if (!byAnchor.has(anchorId)) byAnchor.set(anchorId, []);
        byAnchor.get(anchorId).push(event);
    }
    const placed = new Map();
    for (const [anchorId, list] of byAnchor) {
        const anchor = positions.get(anchorId);
        const base = (hashOf(anchorId) % 360) * Math.PI / 180;
        list.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || String(a.id).localeCompare(String(b.id)));
        list.forEach((event, index) => {
            const radius = (radii.get(anchorId) ?? 8) + orbitGap + Math.floor(index / perRing) * ringStep;
            const angle = base + index * GOLDEN_ANGLE;
            placed.set(event.id, { x: anchor.x + radius * Math.cos(angle), y: anchor.y + radius * Math.sin(angle) });
        });
    }
    return placed;
}
