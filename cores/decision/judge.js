import { runDecisionCycle, normalizeGenerateAnswer } from '../../libraries/core/decision-agent.js';
import { FORCED_MEMORY_TOOL, AWAIT_TOOL } from '../../libraries/core/decision-tools.js';
import { DIRECTOR_FORCED_MEMORY, fillPrompt } from '../../libraries/core/decision-prompts.js';

/** Forced Memory: какие саммари батча не сворачивать. Без воркера — пусто. */
export function createJudge({ getSettings, deciderWorker, call, now, publishEvent }) {
    /** Forced Memory: какие саммари батча не сворачивать. Без воркера — пусто, без вызова модели. */
    async function judgeForcedMemory({ batch = [] } = {}) {
        const settings = getSettings();
        const list = (Array.isArray(batch) ? batch : []).filter(record => record?.id);
        if (!list.length) return { keep: [] };
        let worker;
        try { worker = deciderWorker(settings); } catch (error) {
            if (error?.code === 'decision-config') return { keep: [] };
            throw error;
        }
        const ids = new Set(list.map(record => record.id));
        const kept = new Set();
        const prompt = fillPrompt(DIRECTOR_FORCED_MEMORY, {
            summaries: list.map(record => `[${record.id}] (level ${record.level}, messages #${record.startIndex}–#${record.endIndex})\n${record.text}`).join('\n\n'),
        });
        await runDecisionCycle({
            messages: [{ role: 'system', content: prompt }],
            tools: [FORCED_MEMORY_TOOL, AWAIT_TOOL],
            generate: async ({ messages, tools, toolChoice, returnMessage }) => normalizeGenerateAnswer(await call('model.generate', {
                workerId: worker.id, messages, tools, toolChoice, stream: false, returnMessage, maxTokens: 800, temperature: 0,
            })),
            handlers: {
                forced_memory: async args => {
                    if (args.op === 'keep' && ids.has(args.summaryId)) kept.add(args.summaryId);
                    if (args.op === 'unkeep') kept.delete(args.summaryId);
                    return { ok: true };
                },
                await: async () => ({ ok: true }),
            },
            maxSteps: 20,
            implicitAwait: true,
            now,
        });
        const keep = [...kept];
        publishEvent('decision.forcedMemory.judged', { batch: list.length, keep: keep.length });
        return { keep };
    }
    return { judgeForcedMemory };
}
