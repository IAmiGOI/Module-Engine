/**
 * Core — уровень «важно для сюжета» (MEMORY_GRAPH_TYPES_PLAN.md, этап 4) — чистые решения, без состояния графа.
 * Роли внутри региона (центр / под-центр) достаются только Core; автоповышение ограничено потолком, ручное закрепление — нет.
 */

/**
 * Потолок числа Core для АВТОповышения: `max(coreMinCap, ceil(coreMaxShare × нод), Core на конец бутстрапа)`. Последнее слагаемое —
 * бутстрап делает центрами и под-центрами десятки нод, и они не должны запирать автоповышение навсегда (и не считаются превышением).
 */
export function coreCap(nodeCount, { coreMaxShare = 0.08, coreMinCap = 5, bootstrapCoreCount = 0 } = {}) {
    return Math.max(coreMinCap, Math.ceil(coreMaxShare * nodeCount), bootstrapCoreCount);
}

/** Должна ли нода `candidate` сменить центр региона `center`: важнее; при равной важности — больше связей. Равные — нет (центр не дёргаем зря). */
export function shouldSwapCenter(candidate, center) {
    if (!center || candidate.id === center.id) return false;
    const importance = (candidate.importance ?? 0) - (center.importance ?? 0);
    if (importance !== 0) return importance > 0;
    return (candidate.degree ?? 0) > (center.degree ?? 0);
}

/**
 * Что делает повышение до Core с регионом: `{ role: 'center' | 'subCenter' | 'none', demoteCenter }`.
 * Центр меняется, если кандидат важнее (старый центр становится под-центром, если в регионе есть место — иначе остаётся просто Core);
 * иначе кандидат становится под-центром, пока не исчерпан `subCentersPerRegion`; при превышении он Core без роли.
 */
export function planRegionRole(candidate, region, nodesById, { subCentersPerRegion = 2 } = {}) {
    if (!region || region.centerNodeId === candidate.id || region.subCenterIds.includes(candidate.id)) return { role: 'none' };
    const center = nodesById[region.centerNodeId];
    if (!center) return { role: 'center' };
    if (shouldSwapCenter(candidate, center)) return { role: 'center', demoteCenter: true };
    return region.subCenterIds.length < subCentersPerRegion ? { role: 'subCenter' } : { role: 'none' };
}
