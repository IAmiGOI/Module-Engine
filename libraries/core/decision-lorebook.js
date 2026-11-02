import { estimateTokens } from './token-estimate.js';
import { entryHeading } from './lorebook-page.js';

/**
 * Лорбук директора: маленькая книга едет в стабильную часть контекста
 * целиком, большая — только постоянными записями плюс инструмент поиска.
 * Прозаик лорбук не видит вовсе.
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
export function buildLorebookContext(entries, { smallTokens = LOREBOOK_SMALL_TOKENS } = {}) {
    const active = (Array.isArray(entries) ? entries : []).filter(entry => entry && !entry.disable && text(entry.content));
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
