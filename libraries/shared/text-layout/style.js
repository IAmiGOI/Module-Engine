/**
 * Стиль фрагмента текста и строка шрифта для Canvas 2D. Одна и та же строка шрифта служит ключом измерения (`measure`) и шрифтом отрисовки
 * (`textPainter.paint`) — иначе ширины, по которым переносились строки, и нарисованный текст разошлись бы.
 *
 * Цвет хранится не значением, а ролью (`@body`/`@em`/`@quote`/`@link`) либо явным цветом из разметки (`<font color>`, `span style="color"`,
 * раскраска говорящих): раскладке цвет не нужен вовсе, а роли разрешает отрисовка по теме — смена цветов темы не требует перекладывать текст.
 */

export const BASE_STYLE = Object.freeze({
    italic: false, weight: 400, mono: false, scale: 1, color: '@body', underline: false, strike: false,
});

/** Значения по умолчанию совпадают с правилами зеркала/растра (`libraries/shared/chat-viewport-body-css.js`). */
export const DEFAULT_THEME = Object.freeze({
    fontSize: 15,
    lineHeight: 1.4,
    fontFamily: 'sans-serif',
    monoFamily: 'monospace',
    blockGap: 10,
    listIndentEm: 1.4,
    quoteIndent: 10,
});

export function resolveTheme(theme = {}) {
    const merged = { ...DEFAULT_THEME };
    for (const [key, value] of Object.entries(theme ?? {})) if (value !== undefined && value !== null && value !== '') merged[key] = value;
    return merged;
}

/** Новый стиль поверх родительского — объекты неизменяемые, общий родитель не портится. */
export function deriveStyle(parent, patch) {
    return Object.freeze({ ...parent, ...patch });
}

export function computeFontSize(style, theme) {
    return theme.fontSize * (style.scale || 1);
}

/** Межстрочный интервал блока: число из темы умножается на СОБСТВЕННЫЙ размер шрифта блока (`line-height: 1.4` — множитель, не px). */
export function computeLineHeight(style, theme) {
    return computeFontSize(style, theme) * theme.lineHeight;
}

/** `italic 700 15px "Noto Sans", sans-serif` — формат свойства `font` Canvas 2D. */
export function buildFontSpec(style, theme) {
    const family = style.mono ? theme.monoFamily : theme.fontFamily;
    return `${style.italic ? 'italic ' : ''}${style.weight} ${computeFontSize(style, theme)}px ${family}`;
}

/** Равенство стилей по значению — соседние куски одного стиля склеиваются в один прогон отрисовки. */
export function isSameStyle(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.italic === b.italic && a.weight === b.weight && a.mono === b.mono && a.scale === b.scale
        && a.color === b.color && a.underline === b.underline && a.strike === b.strike;
}
