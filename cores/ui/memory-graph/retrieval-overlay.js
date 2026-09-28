/**
 * Подсветка последнего ретрива на канвасе — MEMORY_GRAPH_UI_PLAN.md, Этап 5 (пункт 4 запроса владельца).
 * ТОЛЬКО чистая функция "ретрив → классы Cytoscape", без DOM/Cytoscape — тот же принцип, что у `layout.js`/
 * `elements-diff.js`: панель (`memory-graph-panel.js`) сама решает, КОГДА звать эту функцию (переключатель
 * "Retrieval overlay", выбор точки в истории — Этап 5.3) и как применить результат (`ele.addClass()`/`removeClass()`).
 *
 * Ядро (`cores/memory-graph/index.js`, Этап 2 плана) отдаёт ретрив как
 * `{ at, sticky, beaconIds, segments: [{from,to}], standaloneIds, noiseIds, query }`. `standaloneIds` — подмножество
 * `beaconIds` (маяки без связи в маршруте) и НЕ разбирается здесь отдельно: маяк остаётся маяком независимо от
 * того, стоит ли он в `segments` — класс `.beacon` для ЛЮБОГО id из `beaconIds`.
 */

/** Владелец решил: подсветка — ПЕРЕКЛЮЧАТЕЛЬ, не таймер (см. doc-comment плана) — эта функция ничего не знает про включён/выключен, только "что показать, если включено". */
export function retrievalClasses(retrieval, allNodeIds, allEdges) {
    const classes = new Map();
    if (!retrieval) return classes; // ретрива ещё не было (свежий процесс/чат) — карта пуста, разметку вообще не трогаем

    const beaconIds = new Set(retrieval.beaconIds ?? []);
    const noiseIds = new Set(retrieval.noiseIds ?? []);
    const segments = retrieval.segments ?? [];
    const routeNodeIds = new Set();
    for (const segment of segments) {
        if (segment?.from != null) routeNodeIds.add(segment.from);
        if (segment?.to != null) routeNodeIds.add(segment.to);
    }
    // Вырожденный ретрив (объект есть, но пуст — например `standaloneIds`/`noiseIds` не пришли ни разу за сессию) —
    // тоже без разметки, не "всё разом dimmed": пользователь не должен видеть погасший граф без единой причины.
    if (!beaconIds.size && !noiseIds.size && !segments.length) return classes;

    for (const id of allNodeIds) {
        if (beaconIds.has(id)) classes.set(id, 'beacon');
        else if (routeNodeIds.has(id)) classes.set(id, 'route-node'); // промежуточный узел маршрута, сам не маяк
        else if (noiseIds.has(id)) classes.set(id, 'noise');
        else classes.set(id, 'dimmed');
    }
    for (const edge of allEdges) {
        // Ребро на маршруте — ЛЮБОЕ направление (данные графа двусторонние, `segments` не гарантирует тот же
        // порядок from/to, что и `source`/`target` самого ребра Cytoscape).
        const onRoute = segments.some(segment => (
            (segment.from === edge.source && segment.to === edge.target)
            || (segment.from === edge.target && segment.to === edge.source)
        ));
        classes.set(edge.id, onRoute ? 'route' : 'dimmed');
    }
    return classes;
}

/**
 * Цепочка маршрута текстом ("A → C → B", Этап 5.5 — секция "Retrieval" в сайдбаре). `segments` — список рёбер
 * ПОДРЯД (Ядро строит маршрут `buildBeaconRoute()`, math.js — каждый сегмент продолжает предыдущий), поэтому цепочка
 * узлов — `from` первого сегмента, затем `to` каждого по порядку; `labelById` — `Map(id → label)` для подписи (сами
 * `segments` несут только id). Не найденный label — сам id (не должно происходить на практике, но не молчаливый `undefined`).
 */
export function routeChainLabels(segments, labelById) {
    if (!segments?.length) return [];
    const ids = [segments[0].from, ...segments.map(segment => segment.to)];
    return ids.map(id => labelById.get(id) ?? id);
}
