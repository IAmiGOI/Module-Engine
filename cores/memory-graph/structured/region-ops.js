import { planRegionSplit } from '../region-split.js';
import { regionKeyForLabel } from '../region-birth.js';
import { isCore, isEvent } from '../kinds.js';

/**
 * Формирование регионов в Ядре графа: темы, которые уже есть ВНУТРИ региона (`region-split.js`), получают свои регионы. Не
 * привязано к переполнению — регион делится, как только в нём набралось достаточно нод с устойчивой общей темой, а не когда его
 * нечем больше кормить вытеснением. `ctx` — доступ к состоянию Ядра, см. `core-ops.js`.
 */
export function createRegionOps(ctx) {
    let lastSweepTurn = -Infinity;

    /** Кандидаты региона на выход в новую тему: обычные ноды (не Core, не события) с эмбедингом. */
    function splitCandidates(region) {
        return region.nodeIds.map(id => ctx.nodes[id]).filter(node => node && !isCore(node) && !isEvent(node) && node.embedding);
    }

    /** Очереди слияния/реконсолидации, чьи ноды после переноса оказались в РАЗНЫХ регионах, больше не имеют смысла — убираем. */
    function pruneStaleQueues() {
        const regionOf = id => ctx.nodes[id]?.regionId ?? null;
        for (const [key, entry] of Object.entries(ctx.mergeQueue)) if (regionOf(entry.nodeIdA) !== regionOf(entry.nodeIdB)) delete ctx.mergeQueue[key];
        for (const [key, entry] of Object.entries(ctx.reconsolidationQueue)) if (new Set((entry.nodeIds ?? []).map(regionOf)).size > 1) delete ctx.reconsolidationQueue[key];
    }

    /** Делит регион `key` по найденным темам; возвращает созданные `[{ regionId, centerNodeId, nodeIds }]` (пусто — делить нечего). */
    function splitRegion(key) {
        const { nodes, regions, settings } = ctx;
        const region = regions[key];
        if (!region) return [];
        const room = settings.maxRegions - Object.keys(regions).length;
        if (room < 1) return [];
        const plan = planRegionSplit(splitCandidates(region), {
            minNodes: settings.regionSplitMinNodes, minCluster: settings.regionSplitMinCluster, mergeZ: settings.regionSplitMergeZ, maxNewRegions: Math.min(room, 3),
        });
        const created = [];
        for (const cluster of plan.clusters) {
            const center = nodes[cluster.centerId];
            const newKey = regionKeyForLabel(center.label, Object.keys(regions));
            const moving = new Set(cluster.ids);
            regions[key] = { ...regions[key], nodeIds: regions[key].nodeIds.filter(id => !moving.has(id)) };
            regions[newKey] = { name: center.label, centerNodeId: center.id, subCenterIds: [], nodeIds: [...cluster.ids], wordProfile: {} };
            for (const id of cluster.ids) nodes[id].regionId = newKey;
            // Центр региона — защищённая нода (как у любого региона: первая нода региона закреплена), в structured она же Core.
            center.protectedNode = true;
            center.core = true;
            created.push({ regionId: newKey, centerNodeId: center.id, nodeIds: [...cluster.ids] });
        }
        return created;
    }

    /** Проход по всем регионам: каждый, где есть что делить, делится. Синхронно, внутри уже идущей записи. Возвращает созданные регионы. */
    function runRegionSplit() {
        if (!ctx.features.regionBirth) return [];
        const created = [];
        for (const key of Object.keys(ctx.regions)) created.push(...splitRegion(key));
        if (created.length) pruneStaleQueues();
        for (const item of created) ctx.publishEvent('memoryGraph.regionCreated', { regionId: item.regionId, centerNodeId: item.centerNodeId, source: 'split' });
        return created;
    }

    /** Периодический проход (не чаще `regionSplitEveryTurns` ходов) со своей записью на диск; `force` — по требованию (кнопка/тест). */
    async function sweepRegionSplits({ force = false } = {}) {
        if (!ctx.features.regionBirth) return { created: [] };
        return ctx.enqueueWrite(async () => {
            if (!force && ctx.turnCounter - lastSweepTurn < ctx.settings.regionSplitEveryTurns) return { created: [] };
            lastSweepTurn = ctx.turnCounter;
            const created = runRegionSplit();
            if (created.length) await Promise.all([ctx.persistNodes(), ctx.persistRegions(), ctx.persistMergeQueue(), ctx.persistReconsolidationQueue()]);
            return { created };
        });
    }

    return { sweepRegionSplits, runRegionSplit, resetClock: () => { lastSweepTurn = -Infinity; } };
}
