/**
 * Снимки состояния директора и откат. Снимок снимается до хода: ростер,
 * планы, заметки, библиотека, план, арки, часы и журнал банка/имён. Лог
 * директора не откатывается никогда — это история размышлений; отвергнутый
 * ход в нём помечается (`store.markRejected`).
 */
export function createRollback({ store, getSettings, publishEvent }) {
    function snapshotState(runId, journal) {
        return {
            runId,
            journal,
            roster: store.roster(), plan: store.plan(), arcs: store.arcs(),
            notes: store.notes(), library: store.library(), plans: store.plans(), clock: store.clock(),
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
    }

    async function restoreSnapshotFor(mesid, { remove = false } = {}) {
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

    return { snapshotState, restoreState, restoreSnapshotFor };
}
