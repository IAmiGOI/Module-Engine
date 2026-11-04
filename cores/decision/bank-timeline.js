import { splitBankImportance, createBankRecord, bankFrameHash, BANK_BUILDER_VERSION } from '../../libraries/core/decision-banks.js';
import { BANK_TIMELINE_ADJUST, fillPrompt } from '../../libraries/core/decision-prompts.js';
import { normalizeTimelineBanks } from '../../libraries/core/decision-brief.js';

const TIMELINE_CONCURRENCY = 3;

/** Правка готовых банков под таймлайн: один запрос модели директора, без поиска. */
export function createTimelineAdjust({ call, getSettings, publishEvent, bankStore, records, matchesName, currentTimeline, currentGuide = () => '', queue }) {
    const inFlight = new Set();
    const epochNow = () => (typeof bankStore.epoch === 'function' ? bankStore.epoch() : 0);
    async function adjustOne(record, timeline, note = '', epoch = epochNow()) {
        // Воркер сборщиков банков, а не директора: у директора один слот, и десятки правок держали бы ходы в очереди.
        const settings = getSettings();
        const workerId = String(settings.researcher?.workerId || settings.decider?.workerId || '').trim();
        if (!workerId) {
            publishEvent('decision.bank.warning', { name: record.name, message: 'Timeline adjust skipped: no director worker is configured.' });
            return null;
        }
        try {
            const guide = String(currentGuide() ?? '').trim();
            const prompt = fillPrompt(BANK_TIMELINE_ADJUST, { name: record.name, timeline, guide, note: String(note ?? ''), bank: record.text });
            const answer = await call('model.generate', { workerId, prompt, maxTokens: 4000, temperature: 0.2, stream: false });
            const { text } = splitBankImportance(String(answer ?? ''));
            if (!text) throw new Error('The model returned an empty bank.');
            if (epoch !== epochNow()) return null; // чат сменился, пока шёл запрос: правка старого чата не пишется в новый
            const updated = createBankRecord({ ...record, text, timelineHash: bankFrameHash(timeline, guide), status: 'ready', builderVersion: BANK_BUILDER_VERSION });
            await bankStore.putBase({ ...updated, rawSource: '' });
            await bankStore.putChat(updated);
            publishEvent('decision.bank.timeline', { sourceKey: record.sourceKey, name: record.name });
            return updated;
        } catch (error) {
            publishEvent('decision.bank.warning', { name: record.name, message: `Timeline adjust failed: ${error?.message ?? error}` });
            return null;
        }
    }

    /**
     * Правка под рамку чата (таймлайн + указание директора сборщикам) — КАЖДОГО готового банка, собранного не под неё:
     * банки холодного старта строятся параллельно с bootstrap, а наборы банков приходят из других чатов. Список директора
     * (`timelineBanks`) — только заметки к отдельным банкам, а не выбор, кого править.
     */
    async function applyTimeline({ timelineBanks = [] } = {}) {
        const value = String(currentTimeline() ?? '').trim();
        const hash = bankFrameHash(value, currentGuide());
        if (!hash) return { ok: true, adjusted: 0, queued: 0 };
        const epoch = epochNow();
        const notes = normalizeTimelineBanks(timelineBanks);
        const adjusted = [];
        const queued = [];
        const jobs = [];
        for (const item of notes) {
            if (!records().some(entry => matchesName(entry, item.name))) { queue.add(item.name); queued.push(item.name); }
        }
        for (const record of records()) {
            if (record.status !== 'ready' || !String(record.text ?? '').trim() || record.timelineHash === hash || inFlight.has(record.sourceKey)) continue;
            const note = notes.find(item => matchesName(record, item.name))?.note ?? '';
            inFlight.add(record.sourceKey);
            jobs.push({ record, note });
        }
        // По несколько банков сразу, а не строго по одному: каждый — отдельный запрос модели.
        const next = async () => {
            while (jobs.length && epoch === epochNow()) {
                const { record, note } = jobs.shift();
                publishEvent('decision.bank.started', { sourceKey: record.sourceKey, name: record.name });
                try {
                    if (await adjustOne(record, value, note, epoch)) adjusted.push(record.name);
                    else publishEvent('decision.bank.failed', { sourceKey: record.sourceKey, name: record.name, message: 'Timeline adjust failed.' });
                } finally { inFlight.delete(record.sourceKey); }
            }
        };
        await Promise.all(Array.from({ length: Math.min(TIMELINE_CONCURRENCY, jobs.length) }, next));
        for (const { record } of jobs) inFlight.delete(record.sourceKey);
        return { ok: true, adjusted: adjusted.length, queued: queued.length };
    }

    return { adjustOne, applyTimeline };
}
