/**
 * Решения для перетаскивания/создания/соединения — MEMORY_GRAPH_UI_PLAN.md, Этап 7 (пункт 6 запроса владельца).
 * ТОЛЬКО чистые функции ("что делать", не "как сделать") — тот же принцип, что у `elements-diff.js`/
 * `retrieval-overlay.js`: панель (`memory-graph-panel.js`) сама вызывает Cytoscape/`moveNode()`/`createEdge()`,
 * эти функции только решают.
 */

/**
 * Отпустили ноду после перетаскивания. `fromRegionId` — регион ноды ДО драга; `zoneUnderPointer` — зона под
 * курсором в момент отпускания (`zoneAt()`, layout.js) или `null`, если курсор вне любой зоны.
 * → `'snap-back'` (нода возвращается на СВОЮ позицию из раскладки — та же зона, зона накопителя, или пусто вообще)
 *   | `{ move: regionId }` (переезд в ДРУГОЙ, настоящий регион — `regionId` берёт `moveNode()`, Этап 2 API).
 * Накопитель (`regionId: null` у зоны) НАРОЧНО не даёт переезд руками — план явно перечисляет это отдельным
 * случаем ("зона накопителя или пусто — вернуть на место, ничего не менять"): каскад размещения сам решает, когда
 * нода попадает в накопитель, ручного "положи её в очередь" через драг быть не должно.
 */
export function dropDecision(fromRegionId, zoneUnderPointer) {
    if (!zoneUnderPointer) return 'snap-back';
    if (zoneUnderPointer.regionId === null) return 'snap-back'; // накопитель
    if (zoneUnderPointer.regionId === fromRegionId) return 'snap-back'; // та же зона — решение владельца: "возвращается на место"
    return { move: zoneUnderPointer.regionId };
}

/**
 * Режим "Connect" (кнопка, Этап 7.3) — состояние: `{ selectedId: string|null }`. Клик по ноде:
 * - ничего не выбрано → выбрать её (`{selectedId: clickedId}`, без `create`);
 * - выбрана ТА ЖЕ нода → снять выбор (`{selectedId: null}`, план: "клик по той же ноде снимает выбор");
 * - выбрана ДРУГАЯ нода → готово создавать ребро (`{selectedId: null}` — режим остаётся для СЛЕДУЮЩЕЙ пары, план:
 *   "режим остаётся для следующего"), плюс `create: [selectedId, clickedId]`.
 */
export function connectModeStep(state, clickedNodeId) {
    const selectedId = state?.selectedId ?? null;
    if (selectedId === null) return { next: { selectedId: clickedNodeId }, create: null };
    if (selectedId === clickedNodeId) return { next: { selectedId: null }, create: null };
    return { next: { selectedId: null }, create: [selectedId, clickedNodeId] };
}

/**
 * Типы рёбер, уже встречающиеся в графе, плюс `'related'` по умолчанию (план 7.3) — для выпадающего списка рядом с
 * кнопкой "Connect"/Shift-drag. `'related'` — ВСЕГДА первым и ВСЕГДА в списке, даже если граф пуст (форма должна
 * предложить хоть что-то с самого начала, до первого реального ребра).
 */
export function edgeTypesInGraph(nodes) {
    const types = new Set(['related']);
    for (const node of nodes ?? []) {
        for (const edge of node.edges ?? []) {
            if (edge?.type) types.add(edge.type);
        }
    }
    return ['related', ...[...types].filter(type => type !== 'related').sort()];
}
