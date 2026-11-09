import { DECISION_MEMORY_NAMESPACE } from '../../libraries/core/decision-settings.js';

/**
 * Снимки состояния директора и откат. Снимок снимается до хода: ростер,
 * планы, заметки, библиотека, план, арки, часы и журнал банка/имён. Лог
 * директора не откатывается никогда — это история размышлений; отвергнутый
 * ход в нём помечается (`store.markRejected`).
 */
// Знания персонажей тоже откатываются: иначе «Пак узнал…» из отброшенной попытки хода оставалось навсегда.
const KNOWLEDGE = { namespace: DECISION_MEMORY_NAMESPACE, key: 'knowledge' };
// Great Bank — тоже: знания, внешность, одежда пишутся туда «после хода». Без отката перегенерированный ход видел
// «фактор уже принял предложение» из отброшенной версии и спорил со сценой («Wait… but the knowledge bank shows…»).
const GREAT = { namespace: DECISION_MEMORY_NAMESPACE, key: 'greatBank' };
const copy = value => (value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : null);
const queuesOf = papers => copy({
    petitions: papers?.petitions ?? [], prayers: papers?.prayers ?? [], telegrams: papers?.telegrams ?? [], awaitingDecree: papers?.awaitingDecree ?? null,
});

export function createRollback({ store, getSettings, publishEvent, call = null }) {
    async function snapshotState(runId, journal) {
        const knowledge = call ? await call('storage.chatMemory.get', { ...KNOWLEDGE, fallback: {} }).catch(() => null) : null;
        const great = call ? await call('storage.chatMemory.get', { ...GREAT, fallback: {} }).catch(() => null) : null;
        return {
            runId,
            journal,
            roster: store.roster(), plan: store.plan(), arcs: store.arcs(),
            notes: store.notes(), library: store.library(), plans: store.plans(), clock: store.clock(),
            ...(knowledge && typeof knowledge === 'object' ? { knowledge: JSON.parse(JSON.stringify(knowledge)) } : {}),
            ...(copy(great) ? { greatBank: copy(great) } : {}),
            // Строки журнала и очереди ролей: без них отброшенная версия хода оставляла строку Советнику,
            // он писал по ней Петицию, а Директор переписывал Указ по ходу, которого не было.
            ...(typeof store.ledger === 'function' ? { ledger: copy(store.ledger()) ?? [] } : {}),
            ...(typeof store.papers === 'function' ? { papers: queuesOf(store.papers()) } : {}),
        };
    }

    async function restoreState(state) {
        if (!state) return;
        await Promise.all([
            store.saveRoster(state.roster ?? { active: [] }),
            store.savePlan(state.plan ?? null), store.saveArcs(state.arcs ?? []),
            store.saveNotes(state.notes ?? {}), store.saveLibrary(state.library ?? {}),
            store.savePlans(state.plans ?? []), store.saveClock(state.clock ?? { minutes: 0 }),
        ]);
        if (state.journal) await store.restoreJournal(state.journal).catch(() => {});
        if (call && state.knowledge && typeof state.knowledge === 'object') await call('storage.chatMemory.set', { ...KNOWLEDGE, value: state.knowledge }).catch(() => {});
        if (call && state.greatBank && typeof state.greatBank === 'object') await call('storage.chatMemory.set', { ...GREAT, value: state.greatBank }).catch(() => {});
        if (Array.isArray(state.ledger) && typeof store.saveLedger === 'function') await store.saveLedger(state.ledger).catch(() => {});
        // Только очереди: разговор игрока с Советником и вопросы Бога после снимка остаются.
        if (state.papers && typeof store.savePapers === 'function' && typeof store.papers === 'function') {
            await store.savePapers({ ...store.papers(), ...copy(state.papers) }).catch(() => {});
        }
    }

    // Откаты идут по одному, и ход может их дождаться: событие удаления сообщения не ждут, и откат ложился
    // уже поверх нового хода (или ход снимал снимок раньше отката).
    let inflight = Promise.resolve();
    const settled = () => inflight;
    function restoreSnapshotFor(mesid, options = {}) {
        const job = inflight.then(() => restoreOne(mesid, options));
        inflight = job.catch(() => {});
        return job;
    }

    async function restoreOne(mesid, { remove = false } = {}) {
        if (mesid === null || mesid === undefined) return false;
        // Лог — история размышлений: не откатываем, а помечаем отвергнутый ход.
        const run = store.runs()[String(mesid)];
        if (run?.id) await store.markRejected(run.id).catch(() => {});
        if (!getSettings().snapshots) return false;
        const state = store.snapshot(mesid);
        if (!state) return false;
        if (state.runId) await store.markRejected(state.runId).catch(() => {});
        await restoreState(state);
        if (remove) await store.deleteSnapshot(mesid);
        publishEvent('decision.snapshot.restored', { mesid: String(mesid) });
        return true;
    }

    /**
     * Знания, записанные с начала первой попытки хода, — вон: снимок мог уже нести их (до починки отката они переживали
     * переигровку), и резолвер читал «она уже ответила так» и отвечал так же, слово в слово, каждую переигровку.
     */
    async function pruneKnowledgeSince(since) {
        if (!call || !Number.isFinite(Number(since)) || Number(since) <= 0) return 0;
        const great = await call('storage.chatMemory.get', { ...GREAT, fallback: {} }).catch(() => null);
        if (!great || typeof great !== 'object') return 0;
        let removed = 0;
        const next = {};
        for (const [key, character] of Object.entries(great)) {
            const items = Array.isArray(character?.knowledge?.items) ? character.knowledge.items : null;
            if (!items) { next[key] = character; continue; }
            const kept = items.filter(item => !(Number(item?.at) >= Number(since)));
            removed += items.length - kept.length;
            next[key] = kept.length === items.length ? character : { ...character, knowledge: { ...character.knowledge, items: kept } };
        }
        if (removed) await call('storage.chatMemory.set', { ...GREAT, value: next }).catch(() => {});
        return removed;
    }

    return { snapshotState, restoreState, restoreSnapshotFor, settled, pruneKnowledgeSince };
}
