/**
 * Дата-банки персонажей — чистые правила: ключ источника, хеш, размерная
 * полоса, форма готового банка и текст источника для субагента. Ни сети, ни
 * хранения: этим занимается Ядро решений.
 */

/** `key` — главный персонаж карточки и уровни библиотеки 1–2; остальные — `minor`. */
export function bankSizeBand({ level = null, isMain = false } = {}) {
    const value = Number(level);
    return isMain || (Number.isFinite(value) && value >= 1 && value <= 2) ? 'key' : 'minor';
}
