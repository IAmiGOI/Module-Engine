import { signal } from './reactive.js';

/**
 * Ядро «светофора активности» —Activity Light на полоске пилюли-дока.
 *
 * **Что это.** Одна полоска на краю экрана — единственный элемент движка,
 * который виден ВСЕГДА, не открывая никаких панелей. Поэтому именно ей
 * отдана роль «индикаторной лампочки»: она красится в цвет ТЕКУЩЕЙ фазы
 * жизни движка. Ядро принимает события начала/конца работы от ВСЕХ
 * источников — Ядра генерации, трекинг, саммари, самообновление — и сводит
 * их в одно состояние (последний громкий факт приоритетнее фона).
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
 * Карта «событие → состояние». Здесь перечислены ВСЕ источники движка,
 * говорящие о начале/конце работы; новый источник просто добавляет строку —
 * ядро остаётся тем же.
 *
 * Разбор по смыслу (не «любое событие = working»):
 *  - beforeSend/sending/toolCall — машина генерации в работе;
 *  - tracking.poll.started — опрос модели трекером;
 *  - selfUpdate.started — самообновление тянет код из сети;
 *  - completed(ended) — успех; stopped БЕЗ ошибки — «жёлтый» (прервано
 *    пользователем/системой, ошибка не случилась); aborted/superseded/failed —
 *    ошибки; superseded — вытесненный прогон тоже сбой знания о мире, но
 *    частый при свайпах — поэтому «жёлтый», не «красный»;
 *  - notifications (`ui.notify` Ядра уведомлений объявляется событием
 *    `notifications.shown` — проводка добавляет publish в Ядро) — белый.
 */
const EVENT_MAP = Object.freeze({
    // --- генерация (Ядро генерации) ---
    'generation.beforeSend': { state: 'working' },
    'generation.sending': { state: 'working' },
    'generation.toolCall': { state: 'working' },
    'generation.completed': payload => ({ state: payload?.outcome === 'stopped' ? 'warning' : 'success' }),
    'generation.superseded': { state: 'warning' },
    'generation.aborted': { state: 'error' },
    'generation.prepareFailed': { state: 'error' },
    // --- трекинг (Ядро трекинга) ---
    'tracking.poll.started': { state: 'working' },
    'tracking.poll.completed': { state: 'success' },
    'tracking.poll.failed': { state: 'error' },
    // --- саммари (Ядро саммари) ---
    'summary.folded': { state: 'success' },
    'summary.foldFailed': { state: 'error' },
    // --- самообновление (Ядро самообновления) ---
    'selfUpdate.started': { state: 'working' },
    'selfUpdate.applied': { state: 'success' },
    'selfUpdate.failed': { state: 'error' },
    // --- уведомления (Ядро уведомлений) — единственное МИГАНИЕ ---
    'notifications.shown': { state: 'notify' },
});

/** Сколько держится каждый конечный цвет. */
const HOLD_MS = { success: SUCCESS_HOLD_MS, warning: WARNING_HOLD_MS, error: ERROR_HOLD_MS, notify: NOTIFY_HOLD_MS };

export function createActivityLightCore(host, { schedule = setTimeout, cancel = clearTimeout, now = Date.now } = {}) {
    const state = signal(ACTIVITY_STATES.idle);
    let holdTimer = null;
    const subscriptions = [];

    /** `notify` приоритетнее всего (единственное мигание — его видно всегда), `working` перебивает конечные цвета. */
    function setState(next) {
        if (holdTimer) { cancel(holdTimer); holdTimer = null; }
        state.set(next);
        const hold = HOLD_MS[next];
        if (hold) holdTimer = schedule(() => { holdTimer = null; state.set(ACTIVITY_STATES.idle); }, hold);
    }

    function onEvent(eventName, payload) {
        const rule = EVENT_MAP[eventName];
        if (!rule) return;
        const resolved = typeof rule === 'function' ? rule(payload) : rule;
        if (!resolved?.state || !ACTIVITY_STATES[resolved.state]) return;
        // «Работаю» не гасит ошибку: ошибка держится свой тик, работа после неё
        // всё равно перекрасит полоску, когда начнётся. А вот уведомление
        // перекрывает всё — оно на то и мигание.
        if (resolved.state !== 'notify' && state.peek() === 'notify') return;
        setState(resolved.state);
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
        stop: () => {
            if (holdTimer) cancel(holdTimer);
            for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
        },
    };
}
