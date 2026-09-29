/**
 * Вид нод в окне графа structured (MEMORY_GRAPH_TYPES_PLAN.md, этап 8) — чистые функции, без DOM и Cytoscape.
 * Окно берёт режим из `memoryGraph.mode`: у legacy-графа ни одна функция отсюда не вызывается, элементы карты остаются прежними.
 */

/** Форма узла по виду: сущность — круг, объект — скруглённый квадрат (место и группа — подвиды объекта), факт — ромб, событие — шестиугольник. */
export const KIND_SHAPE = Object.freeze({ entity: 'ellipse', object: 'round-rectangle', fact: 'diamond', event: 'hexagon' });
export const KIND_LABEL = Object.freeze({ entity: 'Entity', object: 'Object', fact: 'Fact', event: 'Event' });
const KINDS = Object.keys(KIND_SHAPE);

const kindOf = node => (KINDS.includes(node?.kind) ? node.kind : 'fact');

/** Поля элемента Cytoscape для ноды structured-графа (`data(kind|core|shape|subtype)`). */
export function nodeKindData(node) {
    const kind = kindOf(node);
    return { kind, shape: KIND_SHAPE[kind], core: Boolean(node.core), subtype: kind === 'object' ? (node.subtype ?? '') : '' };
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

/** Правила стиля structured — только по данным (`data(shape)` и т. п.), поэтому на legacy-элементах, у которых этих полей нет, не срабатывают. */
export function structuredStyleRules() {
    return [
        { selector: 'node[shape]', style: { shape: 'data(shape)' } },
        // Core — крупная светлая обводка и подпись при любом масштабе (та же обводка, что раньше показывала защищённые ноды).
        { selector: 'node[?core]', style: { 'border-width': 3, 'border-color': '#fff', label: 'data(label)', 'font-size': 9, 'text-valign': 'bottom', 'text-margin-y': 4, color: '#eef2ff', 'text-outline-color': '#0b0f1a', 'text-outline-width': 2 } },
        { selector: 'edge[?directed]', style: { 'target-arrow-shape': 'triangle', 'target-arrow-color': 'data(lineColor)', 'arrow-scale': 0.8, 'curve-style': 'bezier' } },
        { selector: 'edge[?chain]', style: { width: 1.6, 'line-opacity': 0.7 } },
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
