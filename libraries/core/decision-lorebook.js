import { estimateTokens } from './token-estimate.js';
import { entryHeading } from './lorebook-page.js';
import { characterLorebookEntries } from './decision-banks.js';

/**
 * Лорбук директора: маленькая книга едет в стабильную часть контекста
 * целиком, большая — только постоянными записями плюс инструмент поиска.
 * Прозаик получает лорбук так же: маленькую книгу целиком, большую —
 * постоянными записями и записями, чьи ключи встретились в его окне истории
 * (инструментов у прозаика нет).
 *
 * Записи-персонажи (раздел `-- CHARACTERS --`) — это карточки персонажей: они
 * стали дата-банками и из текста лорбука убираются у обоих, чтобы персонаж не
 * шёл дважды (решение владельца: «карточки персонажей не дублируются»).
 *
 * Это чистая Библиотека: записи уже прочитаны Ядром лорбука, здесь только
 * выбор и текст.
 */

/** Порог «маленькой книги» — примерно 4 тыс. токенов на все подключённые книги. */
export const LOREBOOK_SMALL_TOKENS = 4000;

const text = value => String(value ?? '').trim();
function renderEntry(entry, { book = '' } = {}) {
    const heading = entryHeading(entry);
    const label = book ? `${heading} (${book})` : heading;
    return `${label}\n${text(entry.content)}`;
}

function renderEntries(entries) {
    const byBook = new Map();
    for (const entry of entries) {
        const book = text(entry?.book) || 'Lorebook';
        if (!byBook.has(book)) byBook.set(book, []);
        byBook.get(book).push(entry);
    }
    return [...byBook.entries()].map(([book, list]) => `### Book: ${book}\n\n${list.map(entry => renderEntry(entry, { book })).join('\n\n')}`).join('\n\n');
}

/**
 * @returns {{ text: string, large: boolean, entries: number, constants: number }}
 */
/** Записи лорбука без записей-персонажей: те уже едут дата-банками. */
export function withoutCharacterEntries(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const characters = new Set(characterLorebookEntries(list).map(entry => `${text(entry.book)}:${text(entry.uid)}`));
    return list.filter(entry => !characters.has(`${text(entry?.book) || 'Lorebook'}:${text(entry?.uid)}`));
}

export function buildLorebookContext(entries, { smallTokens = LOREBOOK_SMALL_TOKENS } = {}) {
    const active = withoutCharacterEntries(entries).filter(entry => entry && !entry.disable && text(entry.content));
    if (!active.length) return { text: '', large: false, entries: 0, constants: 0 };
    const total = active.reduce((sum, entry) => sum + estimateTokens(renderEntry(entry)), 0);
    if (total <= Number(smallTokens)) {
        return { text: `THE LOREBOOK (connected books; always true in this world):\n\n${renderEntries(active)}`, large: false, entries: active.length, constants: active.filter(entry => entry.constant).length };
    }
    const constants = active.filter(entry => entry.constant);
    const body = constants.length
        ? renderEntries(constants)
        : 'No always-on entries. Search the connected books with the lorebook tool.';
    return {
        text: `THE LOREBOOK (large; only always-on entries are here — search the rest with the lorebook tool):\n\n${body}`,
        large: true,
        entries: active.length,
        constants: constants.length,
    };
}

const keysOf = entry => [entry?.key, entry?.keys].flatMap(value => (Array.isArray(value) ? value : String(value ?? '').split(','))).map(text).filter(Boolean);

/** Ключ записи встретился в тексте (без учёта регистра). Регулярные выражения ST вида `/…/` не разбираются — такой ключ ищется как текст. */
export function entryMatches(entry, haystack) {
    const lower = String(haystack ?? '').toLowerCase();
    return keysOf(entry).some(key => lower.includes(key.toLowerCase()));
}

/**
 * Лорбук прозаика. `scanText` — его окно истории и Push: по ним срабатывают ключи записей большой книги.
 * @returns {{ text: string, large: boolean, entries: number }}
 */
export function buildWriterLorebook(entries, { scanText = '', smallTokens = LOREBOOK_SMALL_TOKENS } = {}) {
    const active = withoutCharacterEntries(entries).filter(entry => entry && !entry.disable && text(entry.content));
    if (!active.length) return { text: '', large: false, entries: 0 };
    const total = active.reduce((sum, entry) => sum + estimateTokens(renderEntry(entry)), 0);
    if (total <= Number(smallTokens)) return { text: `THE LOREBOOK (always true in this world):\n\n${renderEntries(active)}`, large: false, entries: active.length };
    const picked = active.filter(entry => entry.constant || entryMatches(entry, scanText));
    if (!picked.length) return { text: '', large: true, entries: 0 };
    return { text: `THE LOREBOOK (entries relevant to the scene; always true in this world):\n\n${renderEntries(picked)}`, large: true, entries: picked.length };
}
