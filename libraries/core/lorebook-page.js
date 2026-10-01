/**
 * Лорбук как «страница» для краулера гида: книга может быть огромной (сотни записей, сотни тысяч знаков), и в контекст целиком она не попадает. Здесь она превращается в обычный
 * текст страницы, где КАЖДАЯ ЗАПИСЬ — раздел с заголовком `## #uid Название [ключи…]`, а дальше её читают теми же средствами, что и веб-страницы (оглавление, раздел по номеру,
 * срез, поиск по словам и по смыслу — cores/guide/web-actions.js). Номер записи (`#uid`) остаётся в заголовке: по нему она потом правит или удаляет запись.
 * Чистые функции, без Шины.
 */

/** Страница книги может быть больше обычной веб-страницы: в хранилище её кладут с этим пределом. */
export const BOOK_PAGE_MAX_CHARS = 2000000;
/** В ответ на открытие в оглавление попадают только первые записи — остальные находятся поиском; иначе оглавление огромной книги само съело бы контекст. */
export const OUTLINE_SHOWN = 40;

const asList = value => (Array.isArray(value) ? value : []).map(item => String(item ?? '').trim()).filter(Boolean);

/** Заголовок записи: `#12 Old Mill [mill, miller | also: river] [always on] [off]`. Скобки в названии убираются: заголовок — одна строка. */
export function entryHeading(entry) {
    const title = String(entry?.comment ?? '').replace(/[\r\n]+/g, ' ').trim() || asList(entry?.key)[0] || 'untitled';
    const keys = asList(entry?.key);
    const secondary = asList(entry?.keysecondary);
    const keyPart = keys.length || secondary.length ? ` [${keys.join(', ')}${secondary.length ? ` | also: ${secondary.join(', ')}` : ''}]` : '';
    return `## #${entry?.uid} ${title}${keyPart}${entry?.constant ? ' [always on]' : ''}${entry?.disable ? ' [off]' : ''}`;
}

/** Текст страницы книги: записи по порядку номеров, у каждой — заголовок и содержимое. Пустая книга — одна пояснительная строка. */
export function renderBookPage(name, entries) {
    const list = [...(entries ?? [])].sort((a, b) => Number(a?.uid) - Number(b?.uid));
    if (!list.length) return `Lorebook “${name}” has no entries.`;
    const head = `Lorebook “${name}” — ${list.length} entr${list.length === 1 ? 'y' : 'ies'}. Each section is one entry: its number, title, [keys that trigger it].`;
    return `${head}\n\n${list.map(entry => `${entryHeading(entry)}\n${String(entry?.content ?? '').trim()}`).join('\n\n')}`;
}

/** Книги, которые видит движок, и сколько в каждой записей: `[{ book, count }]` по первой встрече. */
export function countByBook(entries) {
    const counts = new Map();
    for (const entry of entries ?? []) counts.set(entry.book, (counts.get(entry.book) ?? 0) + 1);
    return [...counts].map(([book, count]) => ({ book, count }));
}

/** Оглавление для ответа гиду: первые OUTLINE_SHOWN разделов и сколько осталось. */
export function describeOutline(outline) {
    const shown = outline.slice(0, OUTLINE_SHOWN).map(item => `${item.number}. ${item.title} (${item.chars} characters)`).join('\n');
    const rest = outline.length - OUTLINE_SHOWN;
    return rest > 0 ? `${shown}\n…and ${rest} more entries: find them with web.find (by words or by meaning) instead of reading the list.` : shown;
}
