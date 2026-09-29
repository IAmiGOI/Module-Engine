import { coreCap, planRegionRole } from '../core-tier.js';
import { rankCoreCandidates } from '../core-candidates.js';
import { shouldSeedRegion, regionKeyForLabel, bestCenterSimilarity } from '../region-birth.js';
import { isCore } from '../kinds.js';

/**
 * Операции с Core в Ядре графа (MEMORY_GRAPH_TYPES_PLAN.md, этапы 4–6): повышение, рождение региона, прогон кандидатов,
 * ручное закрепление, сообщение «Plot core». Чистые решения — в `core-tier.js`, `core-candidates.js`, `region-birth.js`; здесь
 * они применяются к живому состоянию графа. `ctx` — доступ к состоянию Ядра (`nodes`, `regions`, … — геттеры: их значения
 * подменяются при загрузке чата, поэтому читаются заново в начале каждой операции).
 */
export function createCoreOps(ctx) {
    let lastCoreSweepTurn = -Infinity;

    /** Рождение региона вокруг Core: ключ нового региона или `null`. Потолок `maxRegions` и порог «не похож ни на один центр» — region-birth.js. */
    function seedRegionFor(node) {
        const { nodes, regions, settings, features } = ctx;
        if (!features.regionBirth || !node.embedding || Object.keys(regions).length >= settings.maxRegions) return null;
        const own = node.regionId ? regions[node.regionId] : null;
        if (own && (own.centerNodeId === node.id || own.subCenterIds.includes(node.id))) return null; // уже центр/под-центр — регион у неё есть
        const anchors = ctx.collectAnchors().filter(anchor => anchor.regionId !== node.regionId || regions[anchor.regionId]?.centerNodeId !== node.id);
        const reference = Object.values(nodes).filter(other => other.id !== node.id && !isCore(other) && other.embedding).map(other => bestCenterSimilarity(other.embedding, anchors)).filter(value => value !== null);
        if (!shouldSeedRegion(node.embedding, anchors, reference)) return null;
        // Из прежнего региона нода уходит (она была там обычной): вычёркиваем её оттуда, как это делает удаление ноды.
        if (own) regions[node.regionId] = { ...own, nodeIds: own.nodeIds.filter(id => id !== node.id) };
        const key = regionKeyForLabel(node.label, Object.keys(regions));
        regions[key] = { name: node.label, centerNodeId: node.id, subCenterIds: [], nodeIds: [node.id], wordProfile: {} };
        node.regionId = key;
        ctx.publishEvent('memoryGraph.regionCreated', { regionId: key, centerNodeId: node.id });
        return key;
    }

    /**
     * Повысить ноду до Core. Ручное закрепление (`manual`) потолок не проверяет, автоповышение — да. Далёкий от всех центров Core
     * засевает НОВЫЙ регион; иначе нода получает роль в своём регионе: под-центр либо смена ролью с центром, если важнее
     * (старый центр остаётся под-центром при наличии места). Событие без региона — просто Core. `{ ok, role?, reason? }`.
     */
    function promoteToCore(nodeId, { manual = false } = {}) {
        const { nodes, regions, settings, features, graphMeta } = ctx;
        const node = nodes[nodeId];
        if (!node) return { ok: false, reason: 'no such node' };
        if (!features.core) return { ok: false, reason: 'core needs a structured graph' };
        if (!isCore(node)) {
            const coreCount = Object.values(nodes).filter(isCore).length;
            const cap = coreCap(Object.keys(nodes).length, { coreMaxShare: settings.coreMaxShare, coreMinCap: settings.coreMinCap, bootstrapCoreCount: graphMeta.bootstrapCoreCount ?? 0 });
            if (!manual && coreCount >= cap) return { ok: false, reason: 'core cap reached' };
        }
        // Считаем ДО того, как нода станет Core: её собственные сходства не должны попасть в образец «типичного» графа.
        const seeded = seedRegionFor(node);
        node.core = true;
        node.protectedNode = true;
        if (seeded) return { ok: true, role: 'center', seeded };
        const key = node.regionId;
        const region = key ? regions[key] : null;
        const plan = planRegionRole(node, region, nodes, { subCentersPerRegion: settings.subCentersPerRegion });
        if (plan.role === 'center') {
            const oldCenterId = region.centerNodeId;
            const room = region.subCenterIds.length < settings.subCentersPerRegion;
            regions[key] = {
                ...region,
                centerNodeId: node.id,
                subCenterIds: [...region.subCenterIds.filter(id => id !== node.id), ...(plan.demoteCenter && oldCenterId && room ? [oldCenterId] : [])],
            };
        } else if (plan.role === 'subCenter') regions[key] = { ...region, subCenterIds: [...region.subCenterIds, node.id] };
        return { ok: true, role: plan.role };
    }

    /**
     * Повысить кандидатов в Core (core-candidates.js) до потолка. Синхронно, вызывается ИЗНУТРИ уже идущей записи
     * (после размещения в `checkAndPlace`, из `sweepCores`). Возвращает `[{ id, label, reasons }]` повышенных.
     */
    function runCoreSweep() {
        const { nodes, features } = ctx;
        if (!features.core) return [];
        const coreIds = new Set(Object.values(nodes).filter(isCore).map(node => node.id));
        const promoted = [];
        for (const candidate of rankCoreCandidates(nodes, coreIds)) {
            const result = promoteToCore(candidate.id);
            if (!result.ok) { if (result.reason === 'core cap reached') break; continue; }
            nodes[candidate.id].corePromotedBy = candidate.reasons;
            promoted.push({ id: candidate.id, label: nodes[candidate.id].label, reasons: candidate.reasons });
            ctx.publishEvent('memoryGraph.coreCreated', { nodeId: candidate.id, reasons: candidate.reasons });
        }
        return promoted;
    }

    /** Периодический прогон повышения (не чаще `coreSweepEveryTurns` ходов) — со своей записью на диск. */
    async function sweepCores() {
        if (!ctx.features.core) return { promoted: [] };
        return ctx.enqueueWrite(async () => {
            if (ctx.turnCounter - lastCoreSweepTurn < ctx.settings.coreSweepEveryTurns) return { promoted: [] };
            lastCoreSweepTurn = ctx.turnCounter;
            const promoted = runCoreSweep();
            if (promoted.length) await Promise.all([ctx.persistNodes(), ctx.persistRegions()]);
            return { promoted };
        });
    }

    /** Текст сообщения «сюжетный каркас» (до 8 Core по важности, затем связям) или `null`, если настройка выключена / Core нет. */
    function plotCoreMessage() {
        const { nodes, settings, features } = ctx;
        if (!features.core || !settings.plotSkeletonInPrompt) return null;
        const labels = Object.values(nodes).filter(isCore)
            .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0) || (b.degree ?? 0) - (a.degree ?? 0))
            .slice(0, 8).map(node => node.label);
        return labels.length ? `Plot core: ${labels.join(', ')}` : null;
    }

    /** Ручное закрепление ноды как Core (кнопка «Make core»): потолок не действует. */
    async function pinNode({ id } = {}) {
        return ctx.enqueueWrite(async () => {
            const result = promoteToCore(id, { manual: true });
            if (!result.ok) return { ok: false, error: result.reason };
            await Promise.all([ctx.persistNodes(), ctx.persistRegions()]);
            ctx.publishEvent('memoryGraph.nodeUpdated', { nodeId: id });
            return { ok: true, role: result.role };
        });
    }

    return { promoteToCore, runCoreSweep, sweepCores, plotCoreMessage, pinNode, resetClock: () => { lastCoreSweepTurn = -Infinity; } };
}
