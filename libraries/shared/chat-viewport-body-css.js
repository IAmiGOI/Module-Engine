/**
 * CSS тела сообщения для растровой текстуры Chat Viewport. Текстура рисуется в ИЗОЛИРОВАННОМ
 * `data:`-документе (`foreignObject`, см. `services/html-rasterizer.js`): он НЕ наследует переменные
 * темы страницы, поэтому реальные цвета темы читаются снаружи и вшиваются сюда КОНКРЕТНЫМИ
 * значениями, а не `var(--...)`.
 *
 * `font-size`/`line-height` ЗАФИКСИРОВАНЫ числом, а не читаются живьём (найдено живьём, дважды):
 * читать с ещё пустого зеркала нельзя — computed `line-height: normal` без реального текста отдаёт
 * строку `"normal"`, а не px; и даже прочитанное число не помогло бы — в изолированном документе
 * нет веб-шрифтов страницы, метрики другие. Надёжно только задать ОДНО число с обеих сторон: здесь
 * и на `.stme-chat-viewport-mirror` (`styles/chat-viewport/mirror-row.css`) — значения ДОЛЖНЫ совпадать.
 *
 * `font-family`, в отличие от них, читается с зеркала: computed-строка семейства не зависит от
 * наличия текста. Захардкоженный `system-ui` заметно отличался от кастомного веб-шрифта темы ST.
 *
 * `margin: 0` на всём внутри: зеркало меряет высоту через `getBoundingClientRect()` без внешних
 * отступов, а в изолированном SVG у `<p>` действует браузерный `1em` сверху и снизу — он съедал
 * зафиксированную высоту бокса (21px у однострочного), и короткие сообщения обрезались почти целиком.
 *
 * Абзацы: ОДИН набор правил здесь и на зеркале (`styles/chat-viewport/mirror-row.css`) — сброс отступов и `PARAGRAPH_GAP_PX` между соседними блоками
 * (`> * + *`, отступа перед первым и после последнего нет — внешние поля не схлопываются с обёрткой). Раньше зеркало мерило с отступами абзацев браузера (1em), а
 * текстура рисовалась без них: абзацы слипались в сплошной текст, а под сообщением оставалась пустота высотой в сумму пропущенных промежутков. Списки и цитаты
 * тоже с ОДИНАКОВЫМИ левыми отступами (раньше `padding: 0` в текстуре съедал маркеры и отступ, а зеркало их мерило).
 */

const FALLBACK_BODY_COLOR = '#dcdcd2';
const FALLBACK_QUOTE_COLOR = '#e18a24';
const FALLBACK_EM_COLOR = '#919191';
const FALLBACK_FONT_FAMILY = 'system-ui, sans-serif';

export const BODY_FONT_SIZE_PX = 15;
export const BODY_LINE_HEIGHT = 1.4;
/** Промежуток между соседними блоками (абзацы, списки, цитаты) — как `margin-bottom: 10px` у `.mes_text p` в ST. Пара к CSS зеркала. */
export const PARAGRAPH_GAP_PX = 10;
/**
 * Класс невидимой float-заглушки под аватарку (`cores/ui/chat-viewport/body-sync.js`). Она — первый ЭЛЕМЕНТ тела, и без исключения `> * + *` давал первому
 * абзацу отступ сверху. У зеркала (не BFC) этот отступ схлопывается наружу и в высоту не входит, а в растре — входит: текст рисовался на 10px ниже измеренного,
 * и низ последней строки обрезался по краю текстуры (проверено в Chromium: зеркало 52px, чернила растра до 55px).
 */
export const AVATAR_SPACER_CLASS = 'stme-chat-viewport-avatar-spacer';

export function buildChatViewportBodyCss({ bodyColor, quoteColor, emColor, fontFamily } = {}) {
    const body = '.stme-chat-viewport-body';
    return `${body} { color: ${bodyColor || FALLBACK_BODY_COLOR}; `
        + `font-size: ${BODY_FONT_SIZE_PX}px; line-height: ${BODY_LINE_HEIGHT}; font-family: ${fontFamily || FALLBACK_FONT_FAMILY}; text-rendering: geometricPrecision; `
        // Очень слабое затемнение ЗА самим текстом (владелец: «любые элементы кроме самого глифа — очень слабое затемнение за ними»):
        // запекается в текстуру один раз, GPU ничего не стоит. Радиусы малы — край текстуры не обрезает гало заметно.
        + 'text-shadow: 0 0 5px rgba(0, 0, 0, .30), 0 0 2px rgba(0, 0, 0, .18); } '
        + `${body} * { margin: 0; } `
        + `${body} > * + * { margin-top: ${PARAGRAPH_GAP_PX}px; } `
        + `${body} > .${AVATAR_SPACER_CLASS} + * { margin-top: 0; } `
        + `${body} ul, ${body} ol { padding-left: 1.4em; } `
        + `${body} blockquote { padding-left: 10px; } `
        + `${body} q { color: ${quoteColor || FALLBACK_QUOTE_COLOR}; } `
        + `${body} em, ${body} i { color: ${emColor || FALLBACK_EM_COLOR}; } `
        // Как в родном style.css ST: курсив ВНУТРИ цитаты наследует цвет цитаты, цвет
        // `<font color>` не перебивается, а автокавычки `<q>` убраны (кавычки уже в тексте).
        + `${body} q em, ${body} q i, `
        + `${body} font[color] em, ${body} font[color] i, ${body} font[color] q { color: inherit; } `
        + `${body} q:before, ${body} q:after { content: ''; }`;
}

/**
 * Тема для своей раскладки текста (`libraries/shared/text-layout`, `cores/ui/chat-viewport/body-text-engine.js`) — те же числа и цвета, что в
 * CSS тела выше, одним объектом. `fontFamily` — шрифт СТРАНИЦЫ (веб-шрифт темы ST): canvas его видит, в отличие от SVG-растра.
 */
export function buildChatViewportTextTheme({ bodyColor, quoteColor, emColor, fontFamily } = {}) {
    const body = bodyColor || FALLBACK_BODY_COLOR;
    return {
        fontFamily: fontFamily || FALLBACK_FONT_FAMILY,
        fontSize: BODY_FONT_SIZE_PX,
        lineHeight: BODY_LINE_HEIGHT,
        blockGap: PARAGRAPH_GAP_PX,
        listIndentEm: 1.4,
        quoteIndent: 10,
        colors: { body, em: emColor || FALLBACK_EM_COLOR, quote: quoteColor || FALLBACK_QUOTE_COLOR, link: body },
    };
}
