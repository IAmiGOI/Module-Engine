import { edgeTypeFor, isEvent } from './kinds.js';
import { gameTimeKey } from './game-time.js';

/**
 * Рёбра structured-графа (MEMORY_GRAPH_TYPES_PLAN.md, этап 2) — чистые функции над объектами нод.
 *
 * Ребро с концом-событием хранится НАПРАВЛЕННО, но записью в обоих концах (обход графа ходит по `edges` в обе стороны и
 * менять его не нужно): у начала `{ to, type, dir: 'out' }`, у конца `{ to: начало, type, dir: 'in' }`. Ребра лора между
 * не-событиями остаются прежними, без `dir`.
 */

/** Есть ли уже ребро `a → b` этого типа (в любом из двух концов). */
const hasEdge = (a, b, type) => (a.edges ?? []).some(edge => edge.to === b.id && edge.type === type);

/**
 * Записывает ребро `from → to`. Тип для рёбер с событием определяет вид концов (`edgeTypeFor`), `requestedType` — для лора.
 * `maxDegree` — потолок связей ОБЫЧНОЙ (не Core) ноды; `null` — без потолка (ручное создание его не применяет, как и раньше).
 * Возвращает `{ ok, type, created }`.
 */
export function addDirectedEdge(from, to, requestedType, { maxDegree = null } = {}) {
    const type = edgeTypeFor(from, to, requestedType);
    if (hasEdge(from, to, type)) return { ok: true, type, created: false };
    const over = node => maxDegree !== null && !node.core && (node.degree ?? 0) >= maxDegree;
    if (over(from) || over(to)) return { ok: false, type, created: false };
    const directed = isEvent(from) || isEvent(to);
    from.edges = [...(from.edges ?? []), directed ? { to: to.id, type, dir: 'out' } : { to: to.id, type }];
    to.edges = [...(to.edges ?? []), directed ? { to: from.id, type, dir: 'in' } : { to: from.id, type }];
    from.degree = (from.degree ?? 0) + 1;
    to.degree = (to.degree ?? 0) + 1;
    return { ok: true, type, created: true };
}

const orderKey = node => { const key = gameTimeKey(node.gameTime); return [key !== null ? key : Infinity, node.createdTurn ?? 0]; };
const compareEvents = (a, b) => {
    const [aTime, aTurn] = orderKey(a);
    const [bTime, bTurn] = orderKey(b);
    return aTime === bTime ? aTurn - bTurn : aTime < bTime ? -1 : 1;
};

/**
 * События, привязанные к ноде-якорю (входящие в событие рёбра `participates` идут ОТ якоря), в порядке времени
 * (`gameTime`, иначе `createdTurn`), плюс всё, что тянется от них по цепочкам `next`. Возвращает массив нод-событий без повторов.
 */
export function timelineOf(nodesById, anchorId) {
    const anchor = nodesById[anchorId];
    if (!anchor) return [];
    const roots = (anchor.edges ?? []).filter(edge => edge.type === 'participates' && edge.dir !== 'in').map(edge => nodesById[edge.to]).filter(node => node && isEvent(node));
    const seen = new Set();
    const result = [];
    const visit = event => {
        if (seen.has(event.id)) return;
        seen.add(event.id);
        result.push(event);
        const following = (event.edges ?? []).filter(edge => edge.type === 'next' && edge.dir === 'out').map(edge => nodesById[edge.to]).filter(Boolean);
        for (const next of following.sort(compareEvents)) visit(next);
    };
    for (const root of roots.sort(compareEvents)) visit(root);
    return result;
}

/** Сортировка событий по времени — общая для окна и промпта. */
export const sortEvents = events => [...events].sort(compareEvents);
