import { signal } from './reactive.js';
import { createActivityTracker } from '../../libraries/core/activity-tracker.js';

/**
 * Ядро «светофора активности» — Activity Light на полоске пилюли-дока.
 *
 * **Что это.** Одна полоска на краю экрана — единственный элемент движка,
 * который виден ВСЕГДА, не открывая никаких панелей. Поэтому именно ей
 * отдана роль «индикаторной лампочки»: она красится в цвет ТЕКУЩЕЙ фазы
 * жизни движка. Ядро принимает события начала/конца работы от ВСЕХ
 * источников — Ядра генерации, трекинг, саммари, самообновление — и сводит
 * их в одно состояние по ПАРАЛЛЕЛЬНЫМ ЗАДАЧАМ (см.
 * libraries/core/activity-tracker.js): пока идёт хоть одна — `working`;
 * итог показывается, когда закончились ВСЕ. Раньше побеждало последнее
 * событие, и «саммари свернулось» гасило оранжевый посреди ещё идущей
 * генерации.
 *
 * **Почему Ядро, а не Модуль.** По критерию из ARCHITECTURE.md: состояние
 * «движок занят/упал» — не фича, которую пользователь подключает, а
 * наблюдаемость самой машины; и слушает оно события Ядер, что для Модуля
 * недостижимо (Шина ядер ему не видна).
 *
 * **Шкала (просили ровно её):**
 *   idle      — синий, спокойная переливка      (ничего не происходит)
 *   warning   — жёлтый, переливка               (остановлено БЕЗ ошибки)
 *   working   — оранжевый, переливка            (что-то идёт прямо сейчас)
 *   success   — зелёный, переливка              (завершилось успешно)
 *   error     — красный, переливка              (ошибка)
 *   notify    — МИГАЮЩИЙ белый                  (уведомление — единственное мигание)
 *
 * «Переливается, как сейчас» — переливку рисует CSS (старый shimmer-градиент
 * полоски), ядро перекрашивает его через CSS-переменную и класс состояния.
 * Конечные состояния (success/warning/error) живут ТИКАМИ и сами возвращаются
 * к idle — лампочка не должна вечно гореть о том, что уже кончилось.
 */

export const ACTIVITY_STATES = Object.freeze({
    idle: 'idle',         // синий
    working: 'working',   // оранжевый
    success: 'success',   // зелёный
    warning: 'warning',   // жёлтый — остановлено без ошибки
    error: 'error',       // красный
    notify: 'notify',     // мигающий белый — уведомление
});

/** Сколько мгновение держится конечное состояние, прежде чем вернуться в idle. */
const SUCCESS_HOLD_MS = 2500;
const WARNING_HOLD_MS = 4000;
const ERROR_HOLD_MS = 6000;
const NOTIFY_HOLD_MS = 5000;

/**
 * Правила «событие → действие над задачами». Действие: `{ job, phase: 'start' | 'touch' | 'end', result? }` для событий с парой
 * начало/конец; `{ phase: 'result', result }` для событий без своей задачи (итог откладывается, пока идёт другая работа);
 * `{ phase: 'notify' }` — уведомление. Новый источник добавляет строку — ядро остаётся тем же.
 *
 * Разбор по смыслу (не «любое событие = working»):
 *  - beforeSend/sending/toolCall/st.generationStarted — задача `generation`; completed/aborted/prepareFailed — её конец
 *    (stopped без ошибки — «жёлтый»); `superseded` — прогон вытеснен НОВЫМ, который стартует сразу за ним, поэтому это не
 *    конец задачи (иначе свайп показывал бы красное посреди живой генерации);
 *  - `tracking.poll.*` — задача на каждый трекер (`tracking:<id>`): несколько опросов идут параллельно;
 *  - `selfUpdate.*`, `memoryGraph.bootstrap*` — свои задачи;
 *  - `summary.folded/foldFailed` — итог без собственной задачи: свёртка идёт ВНУТРИ подготовки генерации (этап
 *    `generation.prepare`), то есть посреди работающей задачи `generation`, и без учёта задач гасила бы лампочку раньше времени;
 *  - `notifications.shown` — белое мигание, перекрывает всё на время.
 */
const GENERATION = { job: 'generation', phase: 'start' };
const EVENT_MAP = Object.freeze({
    // Начало генерации основной LLM ловим ПРЯМО с мостированного `st.generationStarted` (живой прогон показал, что иначе
    // полоска оставалась синей до ToolCall). Третий аргумент события ST — `dryRun` (сухой прогон, конца у него не бывает).
    'st.generationStarted': payload => (payload?.args?.[2] ? null : GENERATION),
    'generation.beforeSend': GENERATION,
    'generation.sending': GENERATION,
    'generation.toolCall': GENERATION,
    'generation.completed': payload => ({ job: 'generation', phase: 'end', result: payload?.outcome === 'stopped' ? 'warning' : 'success' }),
    'generation.superseded': { job: 'generation', phase: 'touch' },
    'generation.aborted': { job: 'generation', phase: 'end', result: 'error' },
    'generation.prepareFailed': { job: 'generation', phase: 'end', result: 'error' },
    // --- трекинг ---
    'tracking.poll.started': payload => ({ job: `tracking:${payload?.trackerId ?? ''}`, phase: 'start' }),
    'tracking.poll.completed': payload => ({ job: `tracking:${payload?.trackerId ?? ''}`, phase: 'end', result: 'success' }),
    'tracking.poll.failed': payload => ({ job: `tracking:${payload?.trackerId ?? ''}`, phase: 'end', result: 'error' }),
    // --- саммари: итоги без задачи ---
    'summary.folded': { phase: 'result', result: 'success' },
    'summary.foldFailed': { phase: 'result', result: 'error' },
    // --- самообновление ---
    'selfUpdate.started': { job: 'selfUpdate', phase: 'start' },
    'selfUpdate.applied': { job: 'selfUpdate', phase: 'end', result: 'success' },
    'selfUpdate.failed': { job: 'selfUpdate', phase: 'end', result: 'error' },
    // --- уведомления — единственное МИГАНИЕ ---
    'notifications.shown': { phase: 'notify' },
    // --- Граф памяти: построение из Lorebook (может идти минутами — ровно тот случай, для которого светофор и существует).
    // `bootstrapStarted` публикуется ТОЛЬКО когда реальная работа подтверждена, значит `success:false` в конце — настоящий отказ.
    'memoryGraph.bootstrapStarted': { job: 'memoryGraph', phase: 'start' },
    'memoryGraph.bootstrapFinished': payload => ({ job: 'memoryGraph', phase: 'end', result: payload?.success ? 'success' : 'error' }),
});

/** Сколько держится каждый конечный цвет. */
const HOLD_MS = { success: SUCCESS_HOLD_MS, warning: WARNING_HOLD_MS, error: ERROR_HOLD_MS, notify: NOTIFY_HOLD_MS };

export function createActivityLightCore(host, { schedule = setTimeout, cancel = clearTimeout, now = Date.now } = {}) {
    const state = signal(ACTIVITY_STATES.idle);
    const tracker = createActivityTracker({ now });
    let holdTimer = null;
    let notifyTimer = null;
    const subscriptions = [];

    /** Показанное состояние — из задач; уведомление (мигание) перекрывает его на своё время, потом лампочка возвращается к тому, что есть на деле. */
    function render() {
        if (notifyTimer) return;
        const shown = tracker.display();
        if (holdTimer) { cancel(holdTimer); holdTimer = null; }
        state.set(shown);
        const hold = HOLD_MS[shown];
        if (hold) {
            holdTimer = schedule(() => {
                holdTimer = null;
                tracker.clearTerminal();
                render();
            }, hold);
        }
    }

    function showNotify() {
        if (holdTimer) { cancel(holdTimer); holdTimer = null; }
        if (notifyTimer) cancel(notifyTimer);
        state.set(ACTIVITY_STATES.notify);
        notifyTimer = schedule(() => { notifyTimer = null; render(); }, HOLD_MS.notify);
    }

    function onEvent(eventName, payload) {
        const rule = EVENT_MAP[eventName];
        if (!rule) return;
        const action = typeof rule === 'function' ? rule(payload) : rule;
        if (!action?.phase) return;
        if (action.phase === 'notify') { showNotify(); return; }
        if (action.phase === 'start') tracker.start(action.job);
        else if (action.phase === 'touch') tracker.touch(action.job);
        else if (action.phase === 'end') tracker.end(action.job, action.result);
        else if (action.phase === 'result') tracker.result(action.result);
        render();
    }

    function load() {
        for (const eventName of Object.keys(EVENT_MAP)) {
            subscriptions.push(host.events.subscribe(eventName, payload => onEvent(eventName, payload)));
        }
    }

    return {
        load,
        /** Текущее состояние — читают виджет пилюли (сигнал) и тесты. */
        state,
        /** Ручной вызов для тестов: как будто пришло событие. */
        onEvent,
        /** Какие задачи сейчас считаются идущими — для диагностики и тестов. */
        activeJobs: () => tracker.jobs(),
        stop: () => {
            if (holdTimer) cancel(holdTimer);
            if (notifyTimer) cancel(notifyTimer);
            for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
        },
    };
}
