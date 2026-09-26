/**
 * Цвет из атрибута `color` у `<font>` — по правилам «разбора устаревшего значения цвета» HTML: значение БЕЗ `#` (ST пишет `<font color="a635a7">`) браузер читает как
 * `#a635a7`, а как CSS-цвет `a635a7` недействителен (холст молча оставляет прежний цвет — текст оставался бы белым). Возвращает CSS-цвет или `null` (недействителен —
 * браузер атрибут игнорирует).
 *
 * Имена цветов (`red`, `rebeccapurple`…) отдаются как есть: таблицы имён здесь нет, их разрешает сам холст. Всё остальное — по алгоритму: убрать ведущий `#`, не-hex
 * символы заменить нулями, дополнить нулями до кратности трём, разделить на три компоненты, если длиннее 8 — срезать с начала, пока не станет 8, потом, пока
 * все три начинаются с `00` и длиннее 2, срезать эти нули; взять по два символа.
 */
export function legacyColor(value) {
    let text = String(value ?? '').trim();
    if (!text || text.toLowerCase() === 'transparent') return null;
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(text)) return text;   // уже действительный CSS-цвет
    if (/^[a-z]+$/i.test(text) && !/^[a-f]{3}$|^[a-f]{6}$/i.test(text)) return text;   // имя цвета — разрешит холст
    text = [...text.slice(0, 128)].map(char => (char.codePointAt(0) > 0xFFFF ? '00' : char)).join('');
    if (text.startsWith('#')) text = text.slice(1);
    text = text.replace(/[^0-9a-f]/gi, '0');
    while (text.length === 0 || text.length % 3 !== 0) text += '0';
    let size = text.length / 3;
    let parts = [text.slice(0, size), text.slice(size, 2 * size), text.slice(2 * size)];
    if (size > 8) { parts = parts.map(part => part.slice(size - 8)); size = 8; }
    while (size > 2 && parts.every(part => part.startsWith('0'))) { parts = parts.map(part => part.slice(1)); size -= 1; }
    return `#${parts.map(part => part.slice(0, 2).padStart(2, '0')).join('').toLowerCase()}`;
}
