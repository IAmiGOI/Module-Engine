import { CHROME_BREAKS_AFTER } from './break-table.js';

/**
 * Строчное содержимое блока → элементы для переноса строк: неразрывные куски (`unit`), пробелы (`space`), принудительные переносы (`br`) и
 * картинки (`img`).
 *
 * Два шага, как у браузера при `white-space: normal`:
 * 1. Свёртка пробелов: любая серия пробельных символов (включая переводы строк) → один пробел; пробел в начале строки (начало блока, после
 *    `<br>`) и перед `<br>` исчезает. Неразрывный пробел (U+00A0) не сворачивается и не даёт переноса.
 * 2. Места переноса: после пробела, а внутри слова — по таблице, снятой с Chrome (`break-table.js`, `canBreakBetween`): у него свои
 *    правила для ASCII, не совпадающие с учебным UAX #14. Сложные письменности (тайская и т.п.) и RTL сюда не доходят — их отсекает
 *    детектор поддержки в `parse.js`.
 *
 * Работает по графемам (`Intl.Segmenter`): составное эмодзи или буква с диакритикой никогда не разрываются.
 */

const COLLAPSIBLE = /[ \t\n\r\f]/;
const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

function splitGraphemes(text) {
    if (!segmenter) return Array.from(text);
    return Array.from(segmenter.segment(text), part => part.segment);
}

const GLUE = new Set(['\u00A0', '\u202F', '\u2060', '\uFEFF', '\u2007', '\u2011']);
const ZERO_WIDTH_SPACE = '\u200B';
const CJK_OPENING = new Set(['『', '（', '【', '〔', '〈', '《', '〘', '〚', '｛', '［', '｢']);
const CJK_CLOSING = new Set(['』', '）', '】', '〕', '〉', '》', '〙', '〛', '｝', '］', '，', '．', '！', '？', '：', '；', '｣', '・']);
const OTHER_QUOTES = new Set(['„', '‚', '‹', '›']);
const DASH_ALIASES = { '―': '—', '‒': '–' };
const IDEOGRAPHIC = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF01-\uFF60\uFFE0-\uFFE6]|[\u{20000}-\u{3FFFD}]/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const DIGIT = /^\p{Nd}/u;
const BREAKS_AFTER = new Map(Object.entries(CHROME_BREAKS_AFTER).map(([left, row]) => [left, new Set(Array.from(row))]));

/**
 * Графема → символ-представитель из таблицы Chrome (`break-table.js`): замеренные символы — сами собой, любая буква (латиница, кириллица,
 * с диакритикой) — `a`, цифра — `0`, иероглифы/кана/хангыль — `日`, эмодзи — `😀`, CJK-скобки и знаки — `「`/`」`.
 */
export function representativeOf(grapheme) {
    if (BREAKS_AFTER.has(grapheme)) return grapheme;
    const first = String.fromCodePoint(grapheme.codePointAt(0));
    if (BREAKS_AFTER.has(first) && first.length === grapheme.length) return first;
    if (DASH_ALIASES[first]) return DASH_ALIASES[first];
    if (OTHER_QUOTES.has(first)) return '“';
    if (CJK_OPENING.has(first)) return '「';
    if (CJK_CLOSING.has(first)) return '」';
    if (DIGIT.test(grapheme)) return '0';
    if (PICTOGRAPHIC.test(grapheme)) return '😀';
    if (IDEOGRAPHIC.test(grapheme)) return '日';
    return 'a';
}

/**
 * Можно ли перенести строку между двумя соседними НЕпробельными графемами. `beforePrev` — графема перед `prev` или `null`, если `prev`
 * начинает слово (после пробела/в начале строки). Единственное правило с контекстом (замерено): дефис в начале слова перед цифрой (`-5`)
 * переноса не даёт, а перед буквой (`-a`) — даёт, как и внутри слова.
 */
export function canBreakBetween(prev, next, beforePrev = null) {
    if (prev === ZERO_WIDTH_SPACE) return true;
    if (next === ZERO_WIDTH_SPACE || GLUE.has(prev) || GLUE.has(next)) return false;
    const left = representativeOf(prev);
    const right = representativeOf(next);
    if (left === '-' && beforePrev === null && DIGIT.test(right)) return false;
    return BREAKS_AFTER.get(left)?.has(right) ?? false;
}

/**
 * Шаг 1: свёртка пробелов по всему строчному содержимому блока. Возвращает плоский список ячеек: `{ g, style }` (графема или `' '`),
 * `{ br: true }`, `{ img }`.
 */
export function collapseInlines(inlines) {
    const cells = [];
    let atLineStart = true;
    let pendingSpace = null; // строчный элемент, где начался отложенный пробел: пишется, только если за ним последует содержимое строки
    for (const item of inlines) {
        if (item.t === 'br') {
            pendingSpace = null;
            cells.push({ br: true });
            atLineStart = true;
            continue;
        }
        if (item.t === 'img') {
            if (pendingSpace) cells.push({ g: ' ', style: pendingSpace.style, src: pendingSpace });
            pendingSpace = null;
            cells.push({ img: item });
            atLineStart = false;
            continue;
        }
        for (const grapheme of splitGraphemes(item.text)) {
            if (grapheme.length === 1 && COLLAPSIBLE.test(grapheme)) {
                if (!atLineStart && !pendingSpace) pendingSpace = item;
                continue;
            }
            if (pendingSpace) cells.push({ g: ' ', style: pendingSpace.style, src: pendingSpace });
            pendingSpace = null;
            cells.push({ g: grapheme, style: item.style, src: item });
            atLineStart = false;
        }
    }
    return cells;
}

/**
 * Шаг 2: ячейки → элементы переноса. У `unit` — `parts: [{ text, style, src }]` (`src` — исходный текстовый узел: браузер округляет ширину
 * строки по кускам-узлам, см. `line-breaker.js`) (слово может состоять из кусков разных стилей без пробела между
 * ними: `за<em>чем</em>`). Два `unit` подряд без `space` между ними — перенос между ними разрешён правилами (`canBreakBetween`).
 */
export function buildBreakItems(cells) {
    const items = [];
    let unit = null;
    let prev = null;
    let beforePrev = null;
    const closeUnit = () => { if (unit) items.push(unit); unit = null; };
    for (const cell of cells) {
        if (cell.br) { closeUnit(); items.push({ k: 'br' }); prev = beforePrev = null; continue; }
        if (cell.img) { closeUnit(); items.push({ k: 'img', img: cell.img }); prev = beforePrev = null; continue; }
        if (cell.g === ' ') { closeUnit(); items.push({ k: 'space', style: cell.style, src: cell.src }); prev = beforePrev = null; continue; }
        if (unit && prev !== null && canBreakBetween(prev, cell.g, beforePrev)) closeUnit();
        if (!unit) unit = { k: 'unit', parts: [] };
        const last = unit.parts[unit.parts.length - 1];
        if (last && last.src === cell.src) last.text += cell.g;
        else unit.parts.push({ text: cell.g, style: cell.style, src: cell.src });
        beforePrev = prev;
        prev = cell.g;
    }
    closeUnit();
    return items;
}

export function computeBreakItems(inlines) {
    return buildBreakItems(collapseInlines(inlines));
}
