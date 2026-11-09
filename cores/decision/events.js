/**
 * Подписки ядра «директор + прозаик». Здесь только реакции на события:
 * завершение/отмена/вытеснение прогона, смена чата, свайп и удаление,
 * отчёты субагента, старт по набору текста. Логика хода — в index.js.
 */
import { afterTurnEnabled } from '../../libraries/core/decision-settings.js';

export function createDecisionEvents({
    host, getSettings, getPending, setPending, clearAttempts, deleteAttempt, persist,
    discardPending, getLastFailure, noteCorrection, notify, revealCard, restoreSnapshotFor, lastMesid,
    cycle, reload, chatChanged = () => {}, advance = () => Promise.resolve(), startDraft, canReregister, registerStages, publishEvent, decideStage,
    speculate = null,
}) {
    let typingActive = false;
    // Подготовка — явная машина шагов: событие только просит пересмотреть факты,
    // а решение «чей шаг и кого будить» принимает `advance()`.
    const runAdvance = () => Promise.resolve(advance()).catch(error => publishEvent('decision.failed', { runId: null, message: `preparation: ${error?.message ?? error}` }));

    function onBeforeSend(payload) {
        const pending = getPending();
        if (pending && payload?.runId && pending.runId !== payload.runId) {
            setPending(null);
            clearAttempts();
        }
        // Ветку не начинаем, пока идёт настоящий ход: текстовое поле в это время ещё не очищено.
        speculate?.generationStarted?.();
    }

    function onCompleted(payload) {
        speculate?.generationEnded?.();
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
                // «После хода» идёт по тексту ответа писателя: исход пишется по странице, а не по замыслу формы.
                // Советник читает Ведомость уже после него — иначе разбирал бы прошлый ход.
                const writerText = String(stored?.writerText ?? '').trim();
                const afterTurn = afterTurnEnabled(getSettings()) && typeof cycle.runAfterTurn === 'function'
                    ? cycle.runAfterTurn({ runId: pending.runId, built: pending.built, writerText, form: pending.form })
                        .catch(error => publishEvent('decision.failed', { runId: pending.runId, message: `after the turn: ${error?.message ?? error}` }))
                    : Promise.resolve();
                afterTurn
                    .then(() => cycle.maybeRunCounsellor?.())
                    // Director идёт после Советника: Petition уже лежат в очереди (часть 19).
                    .then(() => cycle.maybeRunDirector?.())
                    // God — последним: Молитва из «после хода» и Советника уже в очереди (фаза 5).
                    .then(() => cycle.maybeRunGod?.())
                    .catch(error => publishEvent('decision.failed', { runId: pending.runId, message: `the Counsellor, the Director or God: ${error?.message ?? error}` }));
            })
            .catch(error => publishEvent('decision.failed', { runId: pending.runId, message: `could not save the director run: ${error?.message ?? error}` }));
    }

    function onAborted(payload) {
        speculate?.generationEnded?.();
        if (payload?.stage === decideStage) {
            const failure = getLastFailure();
            if (failure?.kind === 'config') {
                notify('error', `Director: ${failure.message} The generation was not sent.`);
                revealCard();
            } else if (failure?.kind === 'preparation') {
                // Отказ уже показан в `decide()` — второй раз то же сообщение не нужно.
            } else {
                notify('error', 'Decision core: the director failed twice, so this generation was cancelled.');
            }
        }
        const pending = getPending();
        if (!payload?.runId || !pending || pending.runId === payload.runId) discardPending();
        deleteAttempt(payload?.runId);
    }

    function onSuperseded(payload) {
        speculate?.generationEnded?.();
        const pending = getPending();
        if (!payload?.runId || !pending || pending.runId === payload.runId) discardPending();
        deleteAttempt(payload?.runId);
    }

    function onStagesChanged() {
        if (canReregister()) registerStages().catch(() => {});
    }

    function onChatChanged() {
        // Ветка от старого чата не должна пережить смену: отпечаток всё равно не совпадёт, но платить за неё незачем.
        speculate?.discard?.('changed');
        setPending(null);
        clearAttempts();
        chatChanged();
        reload().catch(() => {});
    }

    function onSwipe() {
        speculate?.discard?.('changed');
        lastMesid().then(mesid => restoreSnapshotFor(mesid)).catch(() => {});
    }

    function onDeleted(payload) {
        speculate?.discard?.('changed');
        const mesid = payload?.args?.[0];
        // Откат снимка возвращает и окно сцены; строка-поправка нужна, только если снимка не было.
        restoreSnapshotFor(mesid, { remove: true })
            .then(restored => (restored ? null : noteCorrection?.({ mesid, action: 'deleted' })))
            .catch(() => {});
    }

    function onEdited(payload) {
        speculate?.discard?.('changed');
        const mesid = payload?.args?.[0] ?? payload?.mesid ?? (typeof payload === 'number' ? payload : null);
        if (mesid === null || mesid === undefined) return;
        noteCorrection?.({ mesid, action: 'edited' }).catch(() => {});
    }

    function onTyping(payload) {
        // Спекуляция слушает паузы всегда; старая «Start on typing» ниже живёт своей настройкой и не переиспользуется.
        speculate?.inputBarChanged?.(payload);
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
            // Повторы (часть 19): каждая попытка — строкой в журнале директора.
            host.events.subscribe('decision.retry', payload => {
                cycle.logRetry?.(payload).catch(() => {});
            }),
            // Новые Petition/Телеграммы будят Director и вне цепочки хода (ответ Советнику, отчёт).
            host.events.subscribe('decision.counsellor.finished', () => {
                cycle.maybeRunDirector?.().catch(error => publishEvent('decision.failed', { runId: null, message: `the Director: ${error?.message ?? error}` }));
                // Ответы на вопросы Бога закрыли Декларацию — шаг подготовки двигается по фактам.
                runAdvance();
            }),
            // Бог или директор ответили на отправленное Советником — тот отчитывается пользователю по их записи.
            host.events.subscribe('decision.god.finished', payload => {
                if (payload?.report) cycle.relayStatus?.(payload.report).catch(() => {});
                runAdvance();
            }),
            host.events.subscribe('decision.director.finished', payload => {
                if (payload?.report) cycle.relayStatus?.(payload.report).catch(() => {});
                runAdvance();
            }),
            // Холодный старт банков отсортирован — следующий шаг смотрит на факты.
            host.events.subscribe('decision.bank.sorted', () => runAdvance()),
            // Вопрос Бога — Советнику сразу: он передаёт его пользователю, а не ждёт следующего разбора.
            host.events.subscribe('decision.god.question', () => {
                cycle.relayGodQuestions?.().catch(error => publishEvent('decision.failed', { runId: null, message: `the Counsellor: ${error?.message ?? error}` }));
            }),
            // Новая Молитва от Советника — повод для God, даже если ход не шёл.
            host.events.subscribe('decision.counsellor.prayer', () => {
                cycle.maybeRunGod?.().catch(error => publishEvent('decision.failed', { runId: null, message: `God: ${error?.message ?? error}` }));
            }),
        ];
    }

    return { listen, onBeforeSend, onCompleted, onAborted, onSuperseded, onStagesChanged };
}
