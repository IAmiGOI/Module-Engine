/**
 * Кандидаты в Core (MEMORY_GRAPH_TYPES_PLAN.md, этап 6) — чистые функции: счёт нормированных сигналов, без состояния графа.
 * Повышение — при счёте не ниже `CORE_SCORE_THRESHOLD`; кого и сколько повышать (потолок, регион, рождение региона) решает Ядро.
 */

export const CORE_SCORE_THRESHOLD = 4;

/** 75-й процентиль числового массива (0, если пусто): «выше него» — верхняя четверть графа. */
export function percentile75(values) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return 0;
    return sorted[Math.min(sorted.length - 1, Math.floor(0.75 * sorted.length))];
}

/**
 * Счёт ноды и причины. Сигналы: важность ≥ 9 (+2), модель предложила Core (`coreProposed`, +2 — само по себе не повышает: порог 4),
 * связей больше 75-го процентиля графа (+1), попаданий в ретрив больше 75-го процентиля (+1), запись лорбука `constant` (+1),
 * связана с ≥ 2 существующими Core (+1). `context`: `{ degreeP75, retrievedP75, coreIds: Set }`.
 */
export function coreScore(node, { degreeP75 = Infinity, retrievedP75 = Infinity, coreIds = new Set() } = {}) {
    const reasons = [];
    let score = 0;
    const add = (points, reason) => { score += points; reasons.push(reason); };
    if ((node.importance ?? 0) >= 9) add(2, 'high importance');
    if (node.coreProposed) add(2, 'proposed by the model');
    if ((node.degree ?? 0) > degreeP75) add(1, 'many links');
    if ((node.retrievedCount ?? 0) > retrievedP75) add(1, 'often retrieved');
    if (node.constant) add(1, 'always-on lorebook entry');
    if ((node.edges ?? []).filter(edge => coreIds.has(edge.to)).length >= 2) add(1, 'linked to several cores');
    return { score, reasons };
}

/** Не-Core ноды со счётом не ниже порога, лучшие первыми: `[{ id, score, reasons }]`. */
export function rankCoreCandidates(nodes, coreIds, { threshold = CORE_SCORE_THRESHOLD } = {}) {
    const all = Object.values(nodes);
    const context = { degreeP75: percentile75(all.map(node => node.degree ?? 0)), retrievedP75: percentile75(all.map(node => node.retrievedCount ?? 0)), coreIds };
    return all
        .filter(node => !coreIds.has(node.id))
        .map(node => ({ id: node.id, ...coreScore(node, context) }))
        .filter(entry => entry.score >= threshold)
        .sort((a, b) => b.score - a.score);
}
