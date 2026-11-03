import { splitBankImportance, createBankRecord, hashText, BANK_BUILDER_VERSION } from '../../libraries/core/decision-banks.js';
import { BANK_TIMELINE_ADJUST, fillPrompt } from '../../libraries/core/decision-prompts.js';
import { normalizeTimelineBanks } from '../../libraries/core/decision-brief.js';

/** Правка готовых банков под таймлайн: один запрос модели директора, без поиска. */
export function createTimelineAdjust({ call, getSettings, publishEvent, bankStore, records, matchesName, currentTimeline, queue }) {
    async function adjustOne(record, timeline, note = '') {
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
            const updated = createBankRecord({ ...record, text, timelineHash: hashText(timeline), status: 'ready', builderVersion: BANK_BUILDER_VERSION });
            await bankStore.putBase({ ...updated, rawSource: '' });
            await bankStore.putChat(updated);
            publishEvent('decision.bank.timeline', { name: record.name });
            return updated;
        } catch (error) {
            publishEvent('decision.bank.warning', { name: record.name, message: `Timeline adjust failed: ${error?.message ?? error}` });
            return null;
        }
    }

    async function applyTimeline({ timeline = '', timelineBanks = [] } = {}) {
        const value = String(timeline ?? '').trim();
        if (!value) return { ok: true, adjusted: 0, queued: 0 };
        const hash = hashText(value);
        const adjusted = [];
        const queued = [];
        for (const item of normalizeTimelineBanks(timelineBanks)) {
            const record = records().find(entry => matchesName(entry, item.name));
            if (!record || record.status !== 'ready') { queue.add(item.name); queued.push(item.name); continue; }
            if (record.timelineHash === hash) continue;
            if (await adjustOne(record, value, item.note)) adjusted.push(item.name);
        }
        return { ok: true, adjusted: adjusted.length, queued: queued.length };
    }

    return { adjustOne, applyTimeline };
}
