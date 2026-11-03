import { splitBankImportance, createBankRecord, hashText, BANK_BUILDER_VERSION } from '../../libraries/core/decision-banks.js';
import { BANK_TIMELINE_ADJUST, fillPrompt } from '../../libraries/core/decision-prompts.js';
import { normalizeTimelineBanks } from '../../libraries/core/decision-brief.js';

const TIMELINE_CONCURRENCY = 3;

/** Правка готовых банков под таймлайн: один запрос модели директора, без поиска. */
export function createTimelineAdjust({ call, getSettings, publishEvent, bankStore, records, matchesName, currentTimeline, queue }) {
    const epochNow = () => (typeof bankStore.epoch === 'function' ? bankStore.epoch() : 0);
    async function adjustOne(record, timeline, note = '', epoch = epochNow()) {
        const workerId = String(getSettings().decider?.workerId ?? '').trim();
        if (!workerId) {
            publishEvent('decision.bank.warning', { name: record.name, message: 'Timeline adjust skipped: no director worker is configured.' });
            return null;
        }
        try {
            const prompt = fillPrompt(BANK_TIMELINE_ADJUST, { name: record.name, timeline, note: String(note ?? ''), bank: record.text });
            const answer = await call('model.generate', { workerId, prompt, maxTokens: 4000, temperature: 0.2, stream: false });
            const { text } = splitBankImportance(String(answer ?? ''));
            if (!text) throw new Error('The model returned an empty bank.');
            if (epoch !== epochNow()) return null; // чат сменился, пока шёл запрос: правка старого чата не пишется в новый
            const updated = createBankRecord({ ...record, text, timelineHash: hashText(timeline), status: 'ready', builderVersion: BANK_BUILDER_VERSION });
            await bankStore.putBase({ ...updated, rawSource: '' });
            await bankStore.putChat(updated);
            publishEvent('decision.bank.timeline', { sourceKey: record.sourceKey, name: record.name });
            return updated;
        } catch (error) {
            publishEvent('decision.bank.warning', { name: record.name, message: `Timeline adjust failed: ${error?.message ?? error}` });
            return null;
        }
    }

    async function applyTimeline({ timeline = '', timelineBanks = [] } = {}) {
        const value = String(timeline ?? '').trim();
        if (!value) return { ok: true, adjusted: 0, queued: 0 };
        const epoch = epochNow();
        const hash = hashText(value);
        const adjusted = [];
        const queued = [];
        const jobs = [];
        for (const item of normalizeTimelineBanks(timelineBanks)) {
            const record = records().find(entry => matchesName(entry, item.name));
            if (!record || record.status !== 'ready') { queue.add(item.name); queued.push(item.name); continue; }
            if (record.timelineHash === hash) continue;
            jobs.push({ record, item });
        }
        // По несколько банков сразу, а не строго по одному: каждый — отдельный запрос модели.
        const next = async () => {
            while (jobs.length && epoch === epochNow()) {
                const { record, item } = jobs.shift();
                publishEvent('decision.bank.started', { sourceKey: record.sourceKey, name: record.name });
                if (await adjustOne(record, value, item.note, epoch)) adjusted.push(item.name);
                else publishEvent('decision.bank.failed', { sourceKey: record.sourceKey, name: record.name, message: 'Timeline adjust failed.' });
            }
        };
        await Promise.all(Array.from({ length: Math.min(TIMELINE_CONCURRENCY, jobs.length) }, next));
        return { ok: true, adjusted: adjusted.length, queued: queued.length };
    }

    return { adjustOne, applyTimeline };
}
