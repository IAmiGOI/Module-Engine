import { compactLog, totalLogTokens } from '../../libraries/core/decision-log.js';
import { DIRECTOR_ARC_SUMMARY, fillPrompt } from '../../libraries/core/decision-prompts.js';

/** Сжатие лога: сначала сводка завершённых арок, потом сырые старые циклы в архив. */
export function createCompaction({ store, getSettings, deciderWorker, call, now, publishEvent }) {
    /**
     * Порог лога (500 тыс. по умолчанию). Сначала директор отдельным
     * запросом пишет сводку завершённых арок; только потом сырые старые
     * циклы уходят в архив. Нет завершённых арок — предупреждение, лог не
     * трогаем (лучше честный перегруз, чем потерянный контекст).
     */
    async function maybeCompactLog() {
        const settings = getSettings();
        const cycles = store.cycles();
        const before = totalLogTokens(cycles);
        if (before <= settings.logLimitTokens) return null;
        const closed = store.arcs().filter(arc => arc.status === 'closed' && !arc.summary);
        if (!closed.length) {
            publishEvent('decision.log.warning', { reason: 'no closed arcs to summarize; the log is over the limit', tokens: before });
            return null;
        }
        const worker = deciderWorker(settings);
        const prompt = fillPrompt(DIRECTOR_ARC_SUMMARY, { arcs: closed.map(arc => `ARC: ${arc.title}\nStages: ${(arc.stages ?? []).map(stage => stage.note).filter(Boolean).join('; ') || 'none'}`).join('\n\n') });
        let summary = '';
        try {
            summary = await call('model.generate', { workerId: worker.id, prompt, maxTokens: 1200, temperature: 0, stream: false });
        } catch (error) {
            publishEvent('decision.log.warning', { reason: `arc summary failed: ${error?.message ?? error}`, tokens: before });
            return null;
        }
        if (!String(summary ?? '').trim()) {
            publishEvent('decision.log.warning', { reason: 'the director returned an empty arc summary', tokens: before });
            return null;
        }
        const arcs = store.arcs().map(arc => (closed.some(item => item.id === arc.id) ? { ...arc, summary: String(summary).trim(), summaryAt: now() } : arc));
        await store.saveArcs(arcs);
        const result = compactLog(cycles, { limitTokens: settings.logLimitTokens, archiveLimitTokens: settings.archiveLimitTokens, keepCurrent: true });
        await store.saveLog(result.cycles, { archived: result.archived });
        publishEvent('decision.log.compacted', { before, after: totalLogTokens(result.cycles), archived: result.archived.length });
        return result;
    }
    return { maybeCompactLog };
}
