/**
 * Фильтр «сильного изменения» с забыванием — MEMORY_GRAPH_FIX_PLAN.md, Этап 4 (ROADMAP 5.107г). Старый Уэлфорд
 * (`updateDistanceStats`/`isStrongChange`, index.js) копит среднее и дисперсию за ВСЮ историю без забывания: пока
 * граф маленький, расстояния до ближайшей ноды/центра большие; когда граф вырос (особенно после бутстрапа из
 * большого Lorebook), типичные расстояния заметно меньше, а порог всё ещё держится на старых больших значениях —
 * гейт почти перестаёт срабатывать (П5 плана). Экспоненциальное среднее/дисперсия с окном ~`window` последних
 * наблюдений «забывают» старые выбросы геометрически, а не тянут их вечно.
 */

/** Перевод старого формата Уэлфорда `{count, mean, m2}` в этот, EWMA-совместимый `{count, mean, variance}` — тот же `count`/`mean`, дисперсия по несмещённой оценке (n-1), 0 при одном наблюдении (нечем делить). */
export function migrateWelford({ count, mean, m2 }) {
    return { count, mean, variance: count > 1 ? m2 / (count - 1) : 0 };
}

/** Экспоненциальное среднее и дисперсия — окно ~`window` последних наблюдений. Принимает и свой формат, и старый Уэлфордовский `{count, mean, m2}` (переводит один раз, при первом же обновлении после появления этого фильтра — не нужен отдельный шаг миграции, как у часов в clock.js). */
export function updateEwmaStats(stats, distance, { window = 30 } = {}) {
    if (!stats) return { count: 1, mean: distance, variance: 0 };
    const base = 'm2' in stats ? migrateWelford(stats) : stats;
    const alpha = 2 / (window + 1);
    const diff = distance - base.mean;
    const mean = base.mean + alpha * diff;
    const variance = (1 - alpha) * (base.variance + alpha * diff * diff);
    return { count: base.count + 1, mean, variance };
}

export function ewmaStddev(stats) {
    if (!stats) return 0;
    return Math.sqrt(Math.max(0, stats.variance));
}

/** То же правило, что у `isStrongChange` (index.js), но по EWMA-статистике вместо Уэлфорда. Первые 3 наблюдения — всегда "сильное изменение": нет ещё базовой линии, отказывать графу в собственных первых нодах нечем. */
export function isStrongChangeEwma(distance, stats, k) {
    if (!stats || stats.count < 3) return true;
    return distance > stats.mean + k * ewmaStddev(stats);
}
