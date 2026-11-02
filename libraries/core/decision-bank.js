import { estimateTokens } from './pm-tokens.js';

/**
 * Банк памяти — записи о результатах планов. Привязаны к персонажу и плану;
 * `important` не сжимаются никогда. Здесь только форма и подсчёт; чтение
 * директором — инструментом `memory`, сжатие — отдельной моделью в e5.
 */

const key = value => String(value ?? '').trim().toLowerCase();

export function emptyBank() {
    return {};
}

export function recordsFor(bank, character) {
    const found = bank?.[key(character)];
    return Array.isArray(found) ? found : [];
}

export function addRecord(bank, { character, planId = null, text, important = false, now = Date.now(), rid = Math.random } = {}) {
    const name = key(character);
    const body = String(text ?? '').trim();
    if (!name) return { ok: false, error: 'A memory record needs a character.' };
    if (!body) return { ok: false, error: 'A memory record needs text.' };
    const record = {
        id: `mem_${now.toString(36)}_${rid().toString(36).slice(2, 8)}`,
        planId: planId ? String(planId) : null,
        at: now,
        text: body,
        important: Boolean(important),
        tokens: estimateTokens(body),
    };
    const next = { ...(bank ?? {}) };
    next[name] = [...recordsFor(bank, character), record];
    return { ok: true, bank: next, record };
}

/** Сколько токенов занимает раздел одного персонажа. */
export function bankTokens(bank, character) {
    return recordsFor(bank, character).reduce((sum, record) => sum + (Number(record.tokens) || estimateTokens(record.text)), 0);
}

/** Простой поиск по тексту — без модели; e5 может добавить векторный. */
export function searchRecords(bank, { character, query, limit = 10 } = {}) {
    const pool = character ? recordsFor(bank, character) : Object.values(bank ?? {}).flat();
    const needle = String(query ?? '').trim().toLowerCase();
    const found = needle ? pool.filter(record => String(record.text ?? '').toLowerCase().includes(needle)) : pool;
    return found.slice(-Math.max(1, Number(limit) || 10));
}

export function bankIndex(bank) {
    const entries = Object.entries(bank ?? {}).map(([character, records]) => {
        const list = Array.isArray(records) ? records : [];
        const latest = list.at(-1);
        return `- ${character}: ${list.length} record${list.length === 1 ? '' : 's'}${latest ? `; latest: ${String(latest.text).slice(0, 120)}` : ''}`;
    });
    return entries.length ? `MEMORY BANK (query it with the "memory" tool; only the index is here):\n\n${entries.join('\n')}` : '';
}
