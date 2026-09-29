import { normalizeKind, kindOf } from '../kinds.js';
import { parseRegionKindsResponse } from '../bootstrap-prompts.js';
import { BOOTSTRAP_SYSTEM_PROMPT } from '../bootstrap-prompts.js';

/**
 * «Reclassify» (MEMORY_GRAPH_TYPES_PLAN.md, этап 4/8): по требованию уточняет виды нод у графа, где все ноды — факты (после
 * конвертации из legacy). Один вызов модели на регион с тем же форматом `kinds`, что у Прохода 3 бутстрапа; результат применяет
 * тот же разбор. События и уже уточнённые ноды (не `fact`) не трогаются. `ctx` — доступ к состоянию Ядра, см. `core-ops.js`.
 */
export function createReclassifyOps(ctx) {
    function buildPrompt(members) {
        const listing = members.map(node => `${node.id}. ${node.label}: ${node.content}`).join('\n');
        return `These entries all belong to the SAME region of a memory graph:\n\n${listing}\n\nClassify entries that are NOT plain lore facts: "entity" (a living being: character, creature) or "object" (a thing, place or group; add "subtype": "item" | "place" | "group"). Leave out anything that is simply a fact or piece of world lore.\n\nReply with ONLY a JSON object, using the exact ids given above: {"kinds": {"id": {"kind": "entity" | "object", "subtype": "item" | "place" | "group"}, ...}} (empty kinds if nothing applies).`;
    }

    async function reclassify() {
        if (!ctx.features.kinds) return { ok: false, error: 'Reclassify needs a structured graph.' };
        return ctx.enqueueWrite(async () => {
            const epoch = ctx.epoch;
            const { settings } = ctx;
            let changed = 0;
            for (const region of Object.values(ctx.regions)) {
                const members = region.nodeIds.map(id => ctx.nodes[id]).filter(node => node && kindOf(node) === 'fact');
                if (!members.length) continue;
                const result = await ctx.call('model.generate', { prompt: buildPrompt(members), workerId: settings.workerId ?? undefined, maxTokens: settings.bootstrapMaxTokens, temperature: settings.bootstrapTemperature, systemPrompt: BOOTSTRAP_SYSTEM_PROMPT, stallMs: settings.stallMs, fallbackWorkerIds: settings.fallbackWorkerIds });
                if (!ctx.stillSameChat(epoch)) return { ok: false, error: 'The chat changed.' };
                if (!result.ok) continue; // один сбой не блокирует остальные регионы
                const kinds = parseRegionKindsResponse(ctx.parseModelJson(result.value), members.map(node => ({ id: node.id })));
                for (const [id, value] of Object.entries(kinds)) {
                    Object.assign(ctx.nodes[id], normalizeKind(value.kind, value.subtype));
                    changed += 1;
                }
            }
            if (changed) await ctx.persistNodes();
            ctx.publishEvent('memoryGraph.reclassified', { changed });
            return { ok: true, changed };
        });
    }

    return { reclassify };
}
