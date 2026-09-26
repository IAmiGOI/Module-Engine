/**
 * Порядок блоков стола в потоковой раскладке (телефон/узкое окно): чистые функции, без DOM. Сохранённый порядок — список id блоков; блоки, которых в нём нет
 * (новые карточки, виджеты), идут после известных в обычном порядке, а id, которых больше нет на столе, при применении просто пропускаются.
 */

/** Блоки в сохранённом порядке: известные — по списку, остальные — следом, как были. */
export function applyOrder(blocks, order = []) {
    const rank = new Map(order.map((id, index) => [id, index]));
    const known = blocks.filter(block => rank.has(block.id)).sort((a, b) => rank.get(a.id) - rank.get(b.id));
    return [...known, ...blocks.filter(block => !rank.has(block.id))];
}

/**
 * Куда встанет перетаскиваемый блок, если его отпустить в точке `point` (координаты содержимого стола): рядом с блоком под точкой (или ближайшим), до него или
 * после — смотря, в какой половине блока точка. Возвращает новый список id; если места не нашлось (блок один) — прежний порядок.
 */
export function reorderAt(placements, movedId, point) {
    const ids = placements.map(item => item.id);
    const others = placements.filter(item => item.id !== movedId);
    if (!others.length || !ids.includes(movedId)) return ids;
    const center = item => ({ x: item.x + item.w / 2, y: item.y + item.h / 2 });
    const inside = item => point.x >= item.x && point.x <= item.x + item.w && point.y >= item.y && point.y <= item.y + item.h;
    const distance = item => Math.hypot(point.x - center(item).x, point.y - center(item).y);
    const target = others.find(inside) ?? others.reduce((best, item) => (distance(item) < distance(best) ? item : best));
    const c = center(target);
    const dy = point.y - c.y;
    const after = Math.abs(dy) > target.h / 4 ? dy > 0 : point.x >= c.x;
    const rest = ids.filter(id => id !== movedId);
    rest.splice(rest.indexOf(target.id) + (after ? 1 : 0), 0, movedId);
    return rest;
}
