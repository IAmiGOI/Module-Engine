/**
 * Чистые решения собственной панели набора текста (пилюля внизу окна, см. cores/ui/input-bar/). Без DOM и браузера — то, что можно
 * проверить как функцию: отправка по Enter, автовысота поля, режим круглой кнопки справа.
 */

/** Значения настройки ST `power_user.send_on_enter` (scripts/power-user.js): -1 выкл, 0 авто (только не на телефоне), 1 всегда. */
export const SEND_ON_ENTER = Object.freeze({ DISABLED: -1, AUTO: 0, ENABLED: 1 });

/**
 * Отправлять ли по нажатию клавиши — как в родном поле ST (`shouldSendOnEnter` в RossAscends-mods.js), плюс Ctrl/⌘+Enter.
 * Shift+Enter — всегда перенос строки; во время ввода через IME (композиция) Enter принадлежит IME.
 */
export function shouldSendOnKey({ key, shiftKey = false, ctrlKey = false, metaKey = false, isComposing = false, touch = false, sendOnEnter = SEND_ON_ENTER.AUTO } = {}) {
    if (key !== 'Enter' || isComposing) return false;
    if (ctrlKey || metaKey) return true;
    if (shiftKey) return false;
    if (sendOnEnter === SEND_ON_ENTER.DISABLED) return false;
    if (sendOnEnter === SEND_ON_ENTER.ENABLED) return true;
    return !touch; // AUTO
}

/**
 * Высота поля по содержимому: не меньше одной строки, не больше `maxHeight` (дальше — прокрутка внутри поля).
 * `scrollHeight` — высота всего текста при `height: auto`.
 */
export function computeFieldHeight({ scrollHeight, minHeight, maxHeight }) {
    const wanted = Math.max(minHeight, Math.round(Number(scrollHeight) || 0));
    const height = Math.min(wanted, Math.max(minHeight, maxHeight));
    return { height, scrolls: wanted > height };
}

/** Верхний предел высоты поля: доля высоты окна, но не выше жёсткого потолка (телефон в ландшафте не должен отдавать окно целиком). */
export function maxFieldHeight(windowHeight, { fraction = 0.4, ceiling = 320, floor = 88 } = {}) {
    return Math.max(floor, Math.min(ceiling, Math.round((Number(windowHeight) || 0) * fraction)));
}

/** Круглая кнопка справа: пока идёт генерация — «Стоп», иначе «Отправить». */
export function sendButtonMode({ generating }) {
    return generating ? 'stop' : 'send';
}

/** Ширина и левый край пилюли по колонке сообщений (`{left, width}` от оверлея). Нет колонки (оверлей ещё не сообщил) — центрируем с полями. */
export function computeBarColumn({ column, windowWidth, sideGap = 12, maxWidth = 960 }) {
    if (column && Number(column.width) > 0) return { left: Math.round(column.left), width: Math.round(column.width) };
    const width = Math.max(120, Math.min(maxWidth, Math.round(windowWidth) - sideGap * 2));
    return { left: Math.round((windowWidth - width) / 2), width };
}
