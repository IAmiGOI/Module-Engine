/**
 * Пользовательский выбор «когда» → условие `when` Директора. Вынесено из
 * `modules/tracker/index.js` (первого, у кого это появилось) в общую
 * Библиотеку, когда тот же выбор понадобился Ядру macros — снаружи это два
 * очень разных потребителя (Модуль опроса трекера и Ядро исполнения
 * макросов), но сама форма «выбери момент → получи `{event}`/`{event,
 * every}`/`{every:{ms}}`» — чистая и общая для обоих, ровно то, ради чего
 * существуют Библиотеки (LIBRARIES.md).
 *
 * **Здесь нет "blocking"/пайплайн-этапа.** У Трекера `beforeSend` умеет стать
 * ЭТАПОМ пайплайна `generation.prepare` (ждать перед ответом) — это его
 * СОБСТВЕННАЯ надстройка поверх генерического выбора, потому что только
 * трекер вкладывается в промпт и есть смысл его ждать. У Ядра macros
 * (и у любого будущего потребителя без вклада в промпт) `beforeSend` —
 * ПРОСТО момент, обычный триггер, без блокировки: см. doc-comment
 * `modules/tracker/index.js`'s собственных `computeTriggers()`/
 * `resolveTriggerMode()`, которые оборачивают эти функции своим случаем.
 */

export const TRIGGER_MODES = Object.freeze([
    { value: 'manual', label: 'Manual only' },
    { value: 'beforeSend', label: 'Refresh before the reply' },
    { value: 'onUserMessage', label: 'When the user sends a message' },
    { value: 'onToolCall', label: 'During the reply, on every tool call' },
    { value: 'everyReply', label: 'After every reply' },
    { value: 'everyNReplies', label: 'Every N replies' },
    { value: 'everyNMinutes', label: 'Every N minutes' },
]);

export const REPLY_EVENT = 'generation.completed';
export const USER_MESSAGE_EVENT = 'st.messageSent';
export const TOOL_CALL_EVENT = 'generation.toolCall';
export const BEFORE_SEND_EVENT = 'generation.beforeSend';

/** Выбор пользователя → условие `when` Директора. */
export function computeTriggers(mode, count) {
    const n = Math.max(1, Number(count) || 1);
    if (mode === 'beforeSend') return [{ event: BEFORE_SEND_EVENT }];
    if (mode === 'everyReply') return [{ event: REPLY_EVENT }];
    if (mode === 'everyNReplies') return [{ event: REPLY_EVENT, every: n }];
    if (mode === 'everyNMinutes') return [{ every: { ms: n * 60000 } }];
    if (mode === 'onUserMessage') return [{ event: USER_MESSAGE_EVENT }];
    if (mode === 'onToolCall') return [{ event: TOOL_CALL_EVENT }];
    // `manual` не срабатывает сам — триггеров нет.
    return [];
}

/** Обратное чтение: по сохранённому условию восстановить, что было выбрано. Неизвестную форму не ломаем и не теряем — `custom`. */
export function resolveTriggerMode(triggers) {
    const trigger = (triggers ?? [])[0];
    if (!trigger) return { mode: 'manual', count: 3 };
    const shape = typeof trigger === 'string' ? { event: trigger } : trigger;
    if (shape.every?.ms) return { mode: 'everyNMinutes', count: Math.max(1, Math.round(shape.every.ms / 60000)) };
    if (shape.event === REPLY_EVENT && shape.every) return { mode: 'everyNReplies', count: Number(shape.every) || 1 };
    if (shape.event === REPLY_EVENT) return { mode: 'everyReply', count: 3 };
    if (shape.event === USER_MESSAGE_EVENT) return { mode: 'onUserMessage', count: 3 };
    if (shape.event === TOOL_CALL_EVENT) return { mode: 'onToolCall', count: 3 };
    if (shape.event === BEFORE_SEND_EVENT) return { mode: 'beforeSend', count: 3 };
    return { mode: 'custom', count: 3, custom: shape };
}
