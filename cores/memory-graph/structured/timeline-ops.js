import { pickEventsToFold } from '../timeline-compact.js';

/**
 * Сворачивание старых событий в сводку (MEMORY_GRAPH_TYPES_PLAN.md, этап 2): выбор пачки — `timeline-compact.js`, здесь —
 * вызов модели и слияние через `foldNodesInGraph` (связи `participates` объединяются, цепочка `next` замыкается через сводку).
 * `ctx` — доступ к состоянию Ядра, см. `core-ops.js`.
 */
export function createTimelineOps(ctx) {
    let lastTimelineFoldTurn = -Infinity;

    /** Не чаще раза в `timelineFoldEveryTurns` ходов. Устойчиво к сбою модели: не удалось — события остаются, попытка повторится через тот же интервал. */
    async function sweepTimeline() {
        if (!ctx.features.timeline) return { folded: 0 };
        return ctx.enqueueWrite(async () => {
            const { nodes, settings } = ctx;
            if (ctx.turnCounter - lastTimelineFoldTurn < settings.timelineFoldEveryTurns) return { folded: 0 };
            lastTimelineFoldTurn = ctx.turnCounter;
            const batch = pickEventsToFold(Object.values(nodes), { keepRecent: settings.timelineKeepRecent, foldBatch: settings.timelineFoldBatch });
            if (!batch.length) return { folded: 0 };
            const epoch = ctx.epoch;
            const listing = batch.map((node, i) => `${i + 1}. ${node.label}: ${node.content}`).join('\n');
            const prompt = `These ${batch.length} older events of a story happened in this order:\n\n${listing}\n\nRetell them as ONE shorter event that keeps who did what and how it turned out. Reply with ONLY a JSON object: {"label": short name, "content": the retelling, "importance": 0-10}.`;
            const result = await ctx.call('model.generate', { prompt, workerId: settings.workerId ?? undefined, maxTokens: settings.reconsolidationMaxTokens, stallMs: settings.stallMs, fallbackWorkerIds: settings.fallbackWorkerIds });
            if (!ctx.stillSameChat(epoch) || !result.ok) return { folded: 0 };
            const parsed = ctx.parseModelJson(result.value);
            if (!parsed?.label || !parsed?.content) return { folded: 0 };
            const embeddingResult = await ctx.callService('embedding.compute', { text: `${parsed.label}: ${parsed.content}`, kind: 'passage' });
            if (!ctx.stillSameChat(epoch) || !embeddingResult.ok) return { folded: 0 };
            const verdict = { label: String(parsed.label), content: String(parsed.content), importance: Number(parsed.importance) || 0 };
            const mergedId = ctx.foldNodesInGraph(batch.map(node => node.id), verdict, embeddingResult.value);
            if (!mergedId) return { folded: 0 };
            await Promise.all([ctx.persistNodes(), ctx.persistRegions()]);
            ctx.publishEvent('memoryGraph.nodesMerged', { mergedId, from: batch.map(node => node.id) });
            return { folded: batch.length, mergedId };
        });
    }

    return { sweepTimeline, resetClock: () => { lastTimelineFoldTurn = -Infinity; } };
}
