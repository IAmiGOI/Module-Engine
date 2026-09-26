/** Живые показатели панели: подписки на события движка (без опроса по таймеру). */
export function createPanelWatch(deps) {
    const { host, eventCount, generationStage, loadTrackerFields, loadLorebook, syncCard, loadSummaries, notify, loadMemoryGraphCount, memoryGraphFlash, memoryGraphProgress, flash } = deps;

    /** Живые показатели: панель не опрашивает движок по таймеру — она реагирует на те же события, что и всё остальное. */
    function watch() {
        return [
            host.events.subscribe('events.any', () => {
                eventCount.set(eventCount.peek() + 1);
            }),
            host.events.subscribe('generation.beforeSend', () => generationStage.set('running')),
            host.events.subscribe('generation.completed', () => generationStage.set('idle')),
            // Трекер добавили/убрали/переименовали ГДЕ-ТО ЕЩЁ (Модуль
            // «Трекер», «RP Time») — пикер под редактором кода обязан узнать
            // об этом сам, без перезагрузки страницы (тот же баг класса, что
            // уже ловили с list подключений — см. ROADMAP.md 5.23).
            host.events.subscribe('tracking.trackersChanged', () => loadTrackerFields()),
            // Ядро работы с WI пересканировало САМО (правка в родном
            // редакторе ST, смена глобального выбора книг, смена чата — см.
            // его doc-comment) — список здесь обязан узнать об этом без
            // ручного нажатия Rescan в этой карточке.
            host.events.subscribe('lorebook.scanned', () => loadLorebook()),
            ...syncCard.watch(),
            // Свёртка происходит САМА на каждой генерации (`generation.prepare`
            // держит порог) — панель узнаёт о новых/пропавших саммари тем же
            // событием, без ручного Rescan. Тост здесь — для АВТОМАТИЧЕСКОЙ
            // свёртки: пользователь должен видеть, что часть истории только что
            // свернулась (ручная «Fold now» тостится сама в forceSummaryFold()).
            host.events.subscribe('summary.folded', payload => {
                loadSummaries();
                notify('ok', `Summary folded — ${payload?.count ?? '?'} active now`);
            }),
            // Зашли в другой чат — Ядро саммари перечитало свой список
            // (`summary.reloaded`), панель обязана показать саммари УЖЕ ТЕКУЩЕГО
            // чата сразу, без ручного нажатия Fold (тот же класс бага, что
            // уже ловили у лорбука выше).
            host.events.subscribe('summary.reloaded', () => loadSummaries()),
            ...[
                'memoryGraph.nodeCreated', 'memoryGraph.nodeDeleted', 'memoryGraph.nodeEvicted',
                'memoryGraph.nodesMerged', 'memoryGraph.nodesReconsolidated', 'memoryGraph.bootstrapped',
            ].map(event => host.events.subscribe(event, () => loadMemoryGraphCount())),
            // Бутстрап-прогресс — отдельная тройка событий (`started`
            // подтверждает, что реальная работа НАЧАЛАСЬ — `bootstrapMax
            // Tokens`-размера Lorebook может идти десятки секунд; `progress`
            // тикает по ходу; `finished` гасит пульсацию БЕЗУСЛОВНО — и на
            // успехе, и на любом раннем отказе, иначе индикатор завис бы
            // навсегда при пустом Проходе 1/2).
            host.events.subscribe('memoryGraph.bootstrapStarted', payload => {
                memoryGraphFlash.set('testing');
                memoryGraphProgress.set({ done: 0, total: Math.max(1, payload?.totalSteps ?? 1), phase: 'reading' });
            }),
            host.events.subscribe('memoryGraph.bootstrapProgress', payload => {
                memoryGraphProgress.set({ done: payload?.done ?? 0, total: Math.max(1, payload?.total ?? 1), phase: payload?.phase ?? '', detail: payload?.detail ?? null });
            }),
            host.events.subscribe('memoryGraph.bootstrapFinished', payload => {
                memoryGraphProgress.set(null);
                flash(memoryGraphFlash, payload?.success ? 'ok' : 'error');
            }),
            // Тот же автоматический фолд может и упасть (провайдер ответил,
            // но `chatHistory.hide` или следующий батж каскада — нет) — в
            // отличие от ручного «Fold now» (`forceSummaryFold()` ниже,
            // который сам получает `result.error.message`), у автоматического
            // пути нет своего вызывающего, который увидел бы отказ: сообщение
            // просто не сворачивалось молча. Без этого тоста пользователь не
            // видел вообще НИЧЕГО — ни успеха, ни ошибки.
            host.events.subscribe('summary.foldFailed', payload => notify('error', `Summary fold failed: ${payload?.message ?? 'unknown error'}`)),
        ];
    }

    return { watch };
}
