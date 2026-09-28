/**
 * Сравнение "что сейчас в Cytoscape" с "что должно быть после layoutGraph()" — MEMORY_GRAPH_UI_PLAN.md, Этап 4.1
 * (Б3: старый `syncCytoscape()` делал `cy.elements().remove()` и добавлял всё заново на КАЖДОЕ изменение графа —
 * сбрасывал выделение и обрывал перетаскивание, нода "прыгала" обратно при любом чужом `refresh()`, даже пришедшем
 * от совсем другого события). Чистая функция без Cytoscape/DOM — план сам предлагает этот путь для тестирования,
 * раз тесты окна (`memory-graph-panel.test.js`) не заводят фейковый `cy` ("если не делают — вынеси сравнение в
 * чистую функцию diffElements(current, next) → { add, remove, update } и тестируй её"). Вызывающий
 * (`memory-graph-panel.js`) сам превращает живой `cy.elements()` в `current` и применяет результат через
 * `cy.add()`/`.remove()`/`.data()`/`.position()`.
 */

/** Поверхностное сравнение объекта данных ноды/ребра — все значения примитивы (id/label/degree/color/…), вложенных объектов в `data` нет ни у одного элемента. */
function sameData(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every(key => a[key] === b[key]);
}

function samePosition(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.x === b.x && a.y === b.y;
}

/**
 * `current`/`next` — `Map(id → { group: 'nodes' | 'edges', data, position? })` (рёбра без `position` — Cytoscape
 * сам тянет их между узлами по `data.source`/`data.target`). `excludeId` — id ноды, которую СЕЙЧАС держит мышь
 * (`draggingId` в панели, ставится на `grab`/снимается на `free`) — её позицию трогать нельзя: пользователь и так
 * знает, где она, а свежепосчитанная раскладка того же региона могла бы "выдернуть" ноду из-под пальца на
 * середине драга. `data` при этом ВСЁ РАВНО обновляется как обычно — подпись/цвет/размер не должны "замерзать"
 * на время перетаскивания, только позиция.
 * → `{ add: [{id, group, data, position?}], remove: [id, …], update: [{id, data: объект|null, position: объект|null}] }`
 * — `null` в `update`-записи значит "это поле не изменилось, не трогай его" (позволяет вызывающему не переписывать
 * позицию элемента, у которого поменялись только данные, и наоборот).
 */
export function diffElements(current, next, { excludeId = null } = {}) {
    const add = [];
    const remove = [];
    const update = [];
    for (const [id, entry] of next) {
        const prev = current.get(id);
        if (!prev) { add.push({ id, ...entry }); continue; }
        const dataChanged = !sameData(prev.data, entry.data);
        const positionChanged = id !== excludeId && Boolean(entry.position) && !samePosition(prev.position, entry.position);
        if (dataChanged || positionChanged) {
            update.push({ id, data: dataChanged ? entry.data : null, position: positionChanged ? entry.position : null });
        }
    }
    for (const id of current.keys()) {
        if (!next.has(id)) remove.push(id);
    }
    return { add, remove, update };
}
