/**
 * Чистка текста сцены ПЕРЕД эмбедингом для музыки. Вектор сцены должен нести настроение, а не конкретную историю: имена героев, разметка и служебные хвосты тянут
 * его к «стилю этого чата» (из-за этого одни группы выигрывают на любой сцене — «хабы»). Только детерминированные правила, без моделей.
 *
 * ВАЖНО: тот же файл лежит в проекте музыкального сервера (`Server/music-server/app/scene-text.js`) — эталонные сцены чистятся ИМ ЖЕ, иначе сцена и словарь окажутся в разных
 * «регистрах». Файлы должны совпадать побайтно (проверяет `Server/music-server/tests/scene-text-parity.test.js`).
 */

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MIN_NAME_LENGTH = 2;

/** Имена к вычёркиванию: разные регистры/повторы схлопываются, слишком короткие (случайные слова) отбрасываются. Длинные идут первыми — «Anna Maria» раньше «Anna». */
export function normalizeNames(names) {
    const seen = new Map();
    for (const raw of Array.isArray(names) ? names : []) {
        const name = String(raw ?? '').trim();
        if (name.length >= MIN_NAME_LENGTH && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
    }
    return [...seen.values()].sort((a, b) => b.length - a.length);
}

/** Слова-заглавные, которые не имена. */
const NOT_NAMES = new Set(['I', 'The', 'A', 'An', 'And', 'But', 'Or', 'So', 'If', 'It', 'Its', 'He', 'She', 'They', 'We', 'You', 'Her', 'His', 'Hers', 'Him', 'Their', 'Them', 'Your', 'Yours', 'My', 'Mine', 'Our', 'Ours', 'Us', 'Me', 'Its', 'This', 'That', 'There', 'Then', 'What', 'When', 'Where', 'Who', 'Why', 'How', 'Yes', 'No', 'Not', 'Oh', 'Well', 'Mr', 'Mrs', 'Ms', 'Dr', 'God', 'Lord', 'Sir', 'Miss', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December', 'OOC', 'OCC']);

/**
 * Имена, которых никто не назвал (старые эталонные сцены не знают своих участников): заглавные слова, которые встречаются в СЕРЕДИНЕ предложения и в заметной доле
 * сцен. Консервативно: лучше пропустить имя, чем вычеркнуть обычное слово.
 */
export function guessNames(texts, { minShare = 0.03, minCount = 4 } = {}) {
    const list = (Array.isArray(texts) ? texts : []).map(text => String(text ?? ''));
    const counts = new Map();
    for (const text of list) {
        const inText = new Set();
        for (const match of text.matchAll(/(?<=[a-z,;:"“”'’)\]—-]\s)([A-Z][a-z]{2,})\b/g)) if (!NOT_NAMES.has(match[1])) inText.add(match[1]);
        for (const word of inText) counts.set(word, (counts.get(word) ?? 0) + 1);
    }
    const needed = Math.max(minCount, Math.ceil(list.length * minShare));
    return normalizeNames([...counts].filter(([, count]) => count >= needed).map(([word]) => word));
}

/**
 * `names` — участники чата (имена героев и персоны пользователя): вычёркиваются целыми словами, с «'s» (Anna's → пусто). Убираются: макросы {{user}}/{{char}}, HTML-теги,
 * ссылки, блоки кода, OOC-вставки в скобках, разметка *_~`# и «рамки» из звёздочек вокруг действий; пробелы и повторы знаков схлопываются.
 */
export function cleanSceneText(text, { names = [] } = {}) {
    let out = String(text ?? '');
    out = out.replace(/```[\s\S]*?```/g, ' ').replace(/<[^>]{1,200}>/g, ' ').replace(/https?:\/\/\S+/gi, ' ').replace(/\{\{[^}]{1,40}\}\}/g, ' ');
    out = out.replace(/\(\s*(?:OOC|OCC)\b[^)]*\)/gi, ' ').replace(/\[\s*(?:OOC|OCC)\b[^\]]*\]/gi, ' ');
    for (const name of normalizeNames(names)) out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(name)}(?:['’]s)?(?![\\p{L}\\p{N}_])`, 'giu'), ' ');
    out = out.replace(/[*_~`#>]+/g, ' ').replace(/([!?.,;:…])\1{2,}/g, '$1$1').replace(/\s+([,.;:!?…])/g, '$1').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n');
    return out.trim();
}
