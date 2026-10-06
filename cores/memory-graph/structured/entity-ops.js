import { findEntityCandidates } from '../entity-candidates.js';
import { addDirectedEdge } from '../edges.js';
import { isEvent } from '../kinds.js';

const IMPORTANCE_BASE = 3;
const IMPORTANCE_MAX = 8;

/**
 * Сущности, найденные по самому тексту нод (`entity-candidates.js`), получают ноды — когда модель не назвала их в `subjects` и
 * поэтому нода так и не завелась («Nyx» в семи записях). Без вызова модели: содержимое — перечень записей, где имя встречается,
 * рёбра — к этим записям. `ctx` — доступ к состоянию Ядра, см. `core-ops.js`.
 */
export function createEntityOps(ctx) {
    let lastSweepTurn = -Infinity;

    const labelMentioned = (name, node) => {
        const text = `${node.label ?? ''}. ${node.content ?? ''}`.toLowerCase();
        return text.includes(name.toLowerCase());
    };

    /** Регион, где живёт большинство записей с этим именем, — туда и встаёт новая нода (`subjectRegion` каскада размещения). */
    function dominantRegion(nodeIds) {
        const votes = new Map();
        for (const id of nodeIds) { const key = ctx.nodes[id]?.regionId; if (key && ctx.regions[key]) votes.set(key, (votes.get(key) ?? 0) + 1); }
        const best = [...votes].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0]?.[0];
        if (!best) return null;
        const region = ctx.regions[best];
        return { regionId: best, sector: region.sector, ring: region.ring };
    }

    /** Многословное имя («Tea Party») — скорее место/группа, однословное («Nyx») — скорее существо; точнее без модели не сказать. */
    const kindFor = name => (/\s/.test(name) ? { kind: 'object', subtype: 'group' } : { kind: 'entity' });

    /** Создаёт ноду для одного кандидата; `{ nodeId, links }` либо `null` (чат сменился / нет эмбединга). Вызывается внутри записи. */
    async function createEntity(candidate, epoch) {
        const mentioning = candidate.nodeIds.map(id => ctx.nodes[id]).filter(Boolean);
        const labels = mentioning.filter(node => !isEvent(node)).slice(0, 3).map(node => node.label).filter(Boolean);
        const content = `${candidate.name} — mentioned in ${mentioning.length} records${labels.length ? `, e.g. ${labels.map(label => `"${label}"`).join('; ')}` : ''}.`;
        const embedding = await ctx.callService('embedding.compute', { text: `${candidate.name}: ${content}`, kind: 'passage' });
        if (!ctx.stillSameChat(epoch)) return null;
        if (!embedding.ok) return null;
        const importance = Math.min(IMPORTANCE_MAX, IMPORTANCE_BASE + Math.floor(mentioning.length / 2));
        const placed = ctx.placeNewNode({ label: candidate.name, content, embedding: embedding.value, importance, ...kindFor(candidate.name) }, { source: 'mentions', subjectRegion: dominantRegion(candidate.nodeIds) });
        const created = ctx.nodes[placed.nodeId];
        if (!created) return null;
        let links = 0;
        for (const other of mentioning) {
            if (other.id === created.id || !labelMentioned(candidate.name, other)) continue;
            if (!ctx.edgeAllowed(created, other)) continue;
            if (addDirectedEdge(created, other, 'related').created) links += 1;
        }
        return { nodeId: created.id, status: placed.status, links };
    }

    /** Периодический проход (не чаще `entitySweepEveryTurns` ходов): новые сущности по тексту нод. `force` — по требованию. Возвращает `{ created: [{ name, nodeId, links }] }`. */
    async function sweepEntities({ force = false } = {}) {
        if (!ctx.features.kinds) return { created: [] };
        return ctx.enqueueWrite(async () => {
            if (!force && ctx.turnCounter - lastSweepTurn < ctx.settings.entitySweepEveryTurns) return { created: [] };
            lastSweepTurn = ctx.turnCounter;
            const epoch = ctx.epoch;
            const candidates = findEntityCandidates(ctx.nodes, { minMentions: ctx.settings.entityMinMentions, maxCandidates: ctx.settings.entityMaxPerSweep });
            const created = [];
            for (const candidate of candidates) {
                const result = await createEntity(candidate, epoch);
                if (!result) { if (!ctx.stillSameChat(epoch)) return { created: [] }; continue; }
                created.push({ name: candidate.name, ...result });
            }
            if (created.length) {
                await Promise.all([ctx.persistNodes(), ctx.persistRegions(), ctx.persistStaging(), ctx.persistMergeQueue(), ctx.persistReconsolidationQueue()]);
                for (const item of created) ctx.publishEvent('memoryGraph.nodeCreated', { nodeId: item.nodeId, status: item.status, source: 'mentions' });
            }
            return { created };
        });
    }

    return { sweepEntities, resetClock: () => { lastSweepTurn = -Infinity; } };
}
