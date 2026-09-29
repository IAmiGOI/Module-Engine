import { kindOf, isEvent } from '../kinds.js';
import { addDirectedEdge } from '../edges.js';
import { resolveSubject, addAliases } from '../subjects.js';

const SUBJECT_CREATE_AFTER = 2; // заглушка сущности — со второй встречи неразрешённого имени (этап 3 плана типов)

/**
 * Разбор структурированного извлечения на состоянии графа (MEMORY_GRAPH_TYPES_PLAN.md, этап 3): известные имена для промпта,
 * разрешение субъектов и связей факта. Чистое разрешение имён — `subjects.js`. `ctx` — доступ к состоянию Ядра, см. `core-ops.js`.
 */
export function createExtractionOps(ctx) {
    const pendingSubjects = new Map(); // имя (нижний регистр) → сколько раз встречалось; в памяти, после перезагрузки счёт заново

    /** Метки сущностей/объектов для промпта: до 60, недавно тронутые и важные — первыми. */
    function knownSubjectNames() {
        return Object.values(ctx.nodes)
            .filter(node => node.label && ['entity', 'object'].includes(kindOf(node)))
            .sort((a, b) => (b.lastTouchedTurn ?? 0) - (a.lastTouchedTurn ?? 0) || (b.importance ?? 0) - (a.importance ?? 0))
            .slice(0, 60).map(node => node.label);
    }

    /** Дескриптор региона ноды для `decideFirstPlacement` (приоритет «регион главного субъекта»); `null`, если у ноды региона нет. */
    function regionDescriptorOf(node) {
        const region = node?.regionId ? ctx.regions[node.regionId] : null;
        return region ? { regionId: node.regionId, sector: region.sector, ring: region.ring } : null;
    }

    /**
     * Подготовка факта до размещения — псевдонимы из ответа; субъекты → ноды; неразрешённый субъект получает ноду-заглушку
     * сущности только со ВТОРОЙ встречи (`pendingSubjects`), чтобы не плодить ноды под случайных статистов.
     * Возвращает `{ subjectIds, relatedIds }` (id существующих нод) или `null`, если чат сменился по ходу.
     */
    async function resolveFactSubjects(fact, { epoch, contextEmbedding }) {
        const nodes = ctx.nodes;
        for (const [name, list] of Object.entries(fact.aliases ?? {})) {
            const ownerId = resolveSubject(name, nodes);
            if (ownerId) addAliases(nodes[ownerId], list);
        }
        const subjectIds = [];
        for (const name of fact.subjects ?? []) {
            let id = resolveSubject(name, ctx.nodes);
            const isSelf = kindOf(fact) !== 'fact' && String(name).trim().toLowerCase() === fact.label.trim().toLowerCase();
            if (!id && !isSelf) {
                const key = name.trim().toLowerCase();
                const seen = (pendingSubjects.get(key) ?? 0) + 1;
                pendingSubjects.set(key, seen);
                if (seen >= SUBJECT_CREATE_AFTER) {
                    const content = `${name} appears in the story.`;
                    const embeddingResult = await ctx.callService('embedding.compute', { text: `${name}: ${content}`, kind: 'passage' });
                    if (!ctx.stillSameChat(epoch)) return null;
                    if (embeddingResult.ok) {
                        id = ctx.placeNewNode({ label: name, content, embedding: embeddingResult.value, importance: 3, kind: 'entity' }, { placementEmbedding: contextEmbedding }).nodeId;
                        pendingSubjects.delete(key);
                    }
                }
            }
            if (id && !subjectIds.includes(id)) subjectIds.push(id);
        }
        const relatedIds = (fact.related ?? []).map(item => ({ id: resolveSubject(item.name, ctx.nodes), relation: item.relation })).filter(item => item.id);
        return { subjectIds, relatedIds };
    }

    /** Рёбра новой ноды к субъектам и связанным (правило рёбер внутри); число созданных. Потолок связей не применяется — у героя их закономерно много. */
    function linkStructuredNode(node, { subjectIds, relatedIds }, sameBatchEvent) {
        const targets = [...subjectIds.map(id => ({ id, relation: 'related' })), ...relatedIds.map(item => ({ id: item.id, relation: item.relation || 'related' }))];
        if (sameBatchEvent && !isEvent(node)) targets.push({ id: sameBatchEvent.id, relation: 'participates' }); // факт указывает на установившее его событие
        let created = 0;
        for (const { id, relation } of targets) {
            const other = ctx.nodes[id];
            if (!other || other.id === node.id) continue;
            // Событие — конец, в который входят: субъект → событие; факт → событие; иначе от новой ноды к цели.
            const [from, to] = isEvent(node) ? [other, node] : [node, other];
            if (!ctx.edgeAllowed(from, to)) continue;
            if (addDirectedEdge(from, to, relation).created) created += 1;
        }
        return created;
    }

    return { knownSubjectNames, regionDescriptorOf, resolveFactSubjects, linkStructuredNode, resetPending: () => pendingSubjects.clear() };
}
