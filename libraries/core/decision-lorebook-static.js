import { estimateTokens } from './token-estimate.js';
import { lorebookEntryHash } from './decision-banks.js';
import { directorLorebookSelection, renderDirectorLorebook, renderLorebookEntries } from './decision-lorebook.js';

/**
 * Статичный лорбук директора. Текст книги снимается один раз (снимок) и стоит в неизменном начале контекста —
 * кеш префикса на нём не обрывается. Граф памяти и пользователь постоянно дописывают и правят записи: такие
 * изменения идут отдельным блоком в изменяемой части контекста (после ходов), а не переписывают начало. Когда
 * блок изменений вырос больше `refreshTokens`, снимок пересобирается один раз — осознанный однократный промах кеша.
 *
 * Чистая Библиотека: записи и снимок приходят снаружи, наружу — текст начала, текст изменений и новый снимок.
 */

export const LOREBOOK_REFRESH_TOKENS = 3000;

const keyOf = entry => `${String(entry?.book ?? '').trim() || 'Lorebook'}:${String(entry?.uid ?? '').trim()}`;
const titleOf = entry => String(entry?.comment ?? '').trim() || `Entry ${entry?.uid}`;

function takeSnapshot(selection) {
    return {
        text: renderDirectorLorebook(selection),
        hashes: Object.fromEntries(selection.included.map(entry => [keyOf(entry), lorebookEntryHash(entry)])),
        titles: Object.fromEntries(selection.included.map(entry => [keyOf(entry), titleOf(entry)])),
        large: selection.large,
    };
}

function renderChanges({ changed, removed }) {
    if (!changed.length && !removed.length) return '';
    const parts = ['LOREBOOK CHANGES (newer than THE LOREBOOK above; where they differ, these are true):'];
    if (changed.length) parts.push(renderLorebookEntries(changed));
    if (removed.length) parts.push(`Removed entries: ${removed.join('; ')}.`);
    return parts.join('\n\n');
}

/**
 * @param {object|null} snapshot  сохранённый снимок или null
 * @returns {{ head: string, changes: string, snapshot: object, refreshed: boolean }}
 */
export function staticDirectorLorebook(snapshot, entries, { marks = null, smallTokens, refreshTokens = LOREBOOK_REFRESH_TOKENS } = {}) {
    const selection = directorLorebookSelection(entries, { marks, ...(smallTokens ? { smallTokens } : {}) });
    const valid = snapshot && typeof snapshot.text === 'string' && snapshot.hashes && typeof snapshot.hashes === 'object';
    if (!valid || Boolean(snapshot.large) !== selection.large) {
        const fresh = takeSnapshot(selection);
        return { head: fresh.text, changes: '', snapshot: fresh, refreshed: true };
    }
    const current = new Map(selection.included.map(entry => [keyOf(entry), entry]));
    const changed = selection.included.filter(entry => snapshot.hashes[keyOf(entry)] !== lorebookEntryHash(entry));
    const removed = Object.keys(snapshot.hashes).filter(key => !current.has(key)).map(key => snapshot.titles?.[key] || key);
    const changes = renderChanges({ changed, removed });
    if (changes && estimateTokens(changes) > Number(refreshTokens)) {
        const fresh = takeSnapshot(selection);
        return { head: fresh.text, changes: '', snapshot: fresh, refreshed: true };
    }
    return { head: snapshot.text, changes, snapshot, refreshed: false };
}
