/**
 * Подписки ядра «директор + прозаик». Здесь только реакции на события:
 * завершение/отмена/вытеснение прогона, смена чата, свайп и удаление,
 * отчёты субагента, старт по набору текста. Логика хода — в index.js.
 */
export function createDecisionEvents({
    host, getSettings, getPending, setPending, clearAttempts, deleteAttempt, persist,
    discardPending, getLastFailure, noteCorrection, notify, revealCard, restoreSnapshotFor, lastMesid,
    cycle, reload, chatChanged = () => {}, startDraft, canReregister, registerStages, publishEvent, decideStage,
}) {
    let typingActive = false;

    function onBeforeSend(payload) {
        const pending = getPending();
        if (pending && payload?.runId && pending.runId !== payload.runId) {
            setPending(null);
            clearAttempts();
        }
    }

    function onCompleted(payload) {
        const pending = getPending();
        if (!pending) return;
        const mismatched = payload?.runId && pending.runId && payload.runId !== pending.runId;
        if (mismatched || payload?.outcome !== 'ended') {
            discardPending();
            return;
        }
        setPending(null);
        clearAttempts();
        persist(pending)
            .then(stored => {
                cycle.recordTurn?.({ pending, stored });
                // Уже после записи: строка броска читает runs[mesid], и до этого события записи ещё нет.
                publishEvent('decision.run.saved', { runId: pending.runId, mesid: stored?.mesid ?? null });
            })
            .catch(error => publishEvent('decision.failed', { runId: pending.runId, message: `could not save the director run: ${error?.message ?? error}` }));
    }

    function onAborted(payload) {
        if (payload?.stage === decideStage) {
            const failure = getLastFailure();
            if (failure?.kind === 'config') {
                notify('error', `Director: ${failure.message} The generation was not sent.`);
                revealCard();
            } else {
                notify('error', 'Decision core: the director failed twice, so this generation was cancelled.');
            }
        }
        const pending = getPending();
        if (!payload?.runId || !pending || pending.runId === payload.runId) discardPending();
        deleteAttempt(payload?.runId);
    }

    function onSuperseded(payload) {
        const pending = getPending();
        if (!payload?.runId || !pending || pending.runId === payload.runId) discardPending();
        deleteAttempt(payload?.runId);
    }

    function onStagesChanged() {
        if (canReregister()) registerStages().catch(() => {});
    }

    function onChatChanged() {
        setPending(null);
        clearAttempts();
        chatChanged();
        reload().catch(() => {});
    }

    function onSwipe() {
        lastMesid().then(mesid => restoreSnapshotFor(mesid)).catch(() => {});
    }

    function onDeleted(payload) {
        const mesid = payload?.args?.[0];
        restoreSnapshotFor(mesid, { remove: true }).catch(() => {});
        noteCorrection?.({ mesid, action: 'deleted' }).catch(() => {});
    }

    function onEdited(payload) {
        const mesid = payload?.args?.[0] ?? payload?.mesid ?? (typeof payload === 'number' ? payload : null);
        if (mesid === null || mesid === undefined) return;
        noteCorrection?.({ mesid, action: 'edited' }).catch(() => {});
    }

    function onTyping(payload) {
        const active = Boolean(payload?.active);
        if (!active) { typingActive = false; return; }
        if (typingActive) return;
        typingActive = true;
        const settings = getSettings();
        if (!settings.startOnTyping || !settings.turnDraft || getPending()) return;
        startDraft();
    }

    function listen() {
        return [
            host.events.subscribe('generation.beforeSend', onBeforeSend),
            host.events.subscribe('generation.completed', onCompleted),
            host.events.subscribe('generation.superseded', onSuperseded),
            host.events.subscribe('generation.aborted', onAborted),
            host.events.subscribe('pipeline.stagesChanged', onStagesChanged),
            host.events.subscribe('model.workers.changed', () => { reload().catch(() => {}); }),
            host.events.subscribe('st.chatChanged', onChatChanged),
            host.events.subscribe('decision.researcher.report', payload => {
                cycle.onResearcherReport(payload).catch(error => publishEvent('decision.failed', { runId: null, message: `researcher wake: ${error?.message ?? error}` }));
            }),
            // Свайп и удаление: вернуть состояние к снимку до этого хода.
            host.events.subscribe('st.messageSwiped', onSwipe),
            host.events.subscribe('st.messageDeleted', onDeleted),
            host.events.subscribe('st.messageEdited', onEdited),
            // Старт по набору текста — только когда включены и настройка, и заготовка.
            host.events.subscribe('ui.inputBar.changed', onTyping),
        ];
    }

    return { listen, onBeforeSend, onCompleted, onAborted, onSuperseded, onStagesChanged };
}
