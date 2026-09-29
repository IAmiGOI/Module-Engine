/**
 * Виды нод и правило рёбер (MEMORY_GRAPH_TYPES_PLAN.md, этап 1) — чистые функции, без состояния и без знания о режимах:
 * решать, звать ли их, — дело вызывающего (`features.kinds`, modes.js).
 *
 * Вид (`kind`) — ЧТО это: `entity` (живое существо), `object` (вещь; подвиды `item`/`place`/`group` — место и организация тоже
 * объекты), `fact` (лор, устойчивое знание), `event` (что случилось, точка таймлайна). Уровень (`core`) — насколько важно для
 * сюжета; это отдельная ось: Core бывает любого вида, защищён и ИГНОРИРУЕТ правила таймлайна (решение владельца).
 *
 * Правило рёбер. Слой лора (не-события между собой) — двусторонний, как раньше. Событие «отрастает» от лора: в него можно
 * указывать из любой ноды (`participates`), из него — только в другое событие (`next`). Ребро событие → не-событие запрещено,
 * если ни один из концов не Core. Смысл: лор не зависит от таймлайна — событие можно свернуть или удалить, связность лора
 * не рвётся; из ветви нельзя вырастить ствол.
 */

export const KINDS = Object.freeze(['entity', 'object', 'fact', 'event']);
export const OBJECT_SUBTYPES = Object.freeze(['item', 'place', 'group']);
export const EDGE_ROLES = Object.freeze({ PARTICIPATES: 'participates', NEXT: 'next' });

/** Нода без `kind` (старые данные, legacy) читается как факт. */
export const kindOf = node => (KINDS.includes(node?.kind) ? node.kind : 'fact');
export const isEvent = node => kindOf(node) === 'event';
/** Только `node.core`: старые данные получают его при конвертации legacy → structured (modes.js). */
export const isCore = node => Boolean(node?.core);

/** Подвид — только у объекта и только из известных; иначе `null`. */
export function subtypeOf(node) {
    return kindOf(node) === 'object' && OBJECT_SUBTYPES.includes(node?.subtype) ? node.subtype : null;
}

/** Можно ли ребро `from → to`. `{ ok: true }` или `{ ok: false, reason }`. Core на любом конце снимает ограничения таймлайна. */
export function checkEdge(from, to) {
    if (isCore(from) || isCore(to)) return { ok: true };
    if (isEvent(from) && !isEvent(to)) return { ok: false, reason: 'An event can only continue into another event.' };
    return { ok: true };
}

/**
 * Тип ребра для пары: событие → событие — `next`; не-событие → событие — `participates`; иначе — запрошенный или `related`.
 * (`requestedType` для рёбер, у которых есть событие на конце, игнорируется: события несут ровно два вида рёбер, поэтому
 * разворот направления при нужде без потерь.)
 */
export function edgeTypeFor(from, to, requestedType) {
    if (isEvent(from) && isEvent(to)) return EDGE_ROLES.NEXT;
    if (isEvent(to) && !isEvent(from)) return EDGE_ROLES.PARTICIPATES;
    return String(requestedType ?? '').trim() || 'related';
}

/** Нормализация вида и подвида из внешнего ввода (контракты, ответы модели): неизвестное — `fact` / без подвида. */
export function normalizeKind(kind, subtype) {
    const normalizedKind = KINDS.includes(kind) ? kind : 'fact';
    return { kind: normalizedKind, subtype: normalizedKind === 'object' && OBJECT_SUBTYPES.includes(subtype) ? subtype : null };
}
