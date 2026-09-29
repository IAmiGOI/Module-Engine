import { isCore, isEvent } from './kinds.js';
import { sortEvents } from './edges.js';

/**
 * Сворачивание старых событий вместо вытеснения (MEMORY_GRAPH_TYPES_PLAN.md, этап 2): событий много, все они нужны хронологии,
 * поэтому старые не удаляются, а пересказываются одним событием-сводкой. Core-события не сворачиваются никогда.
 *
 * `events` — все ноды-события графа. Оставляет `keepRecent` самых свежих нетронутыми и берёт до `foldBatch` самых старых из
 * остальных; пачка меньше двух не стоит вызова модели — `[]`. Свёрнутое событие не должно входить в цепочку Core-события:
 * такие события просто не попадают в кандидаты.
 */
export function pickEventsToFold(events, { keepRecent = 12, foldBatch = 6 } = {}) {
    const ordered = sortEvents((events ?? []).filter(isEvent));
    if (ordered.length <= keepRecent) return [];
    const older = ordered.slice(0, ordered.length - keepRecent).filter(event => !isCore(event));
    const batch = older.slice(0, foldBatch);
    return batch.length >= 2 ? batch : [];
}
