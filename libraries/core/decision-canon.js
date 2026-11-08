/**
 * Canon — сохранённый итог подготовки: Creation, Great Bank и записи банков
 * (исходные card.md). Чистые правила ключа и безопасной формы; хранение и
 * применение — в `cores/decision/canon.js`. Ключ — набор лорбуков и карточек:
 * новый чат с тем же набором видит готовый Canon и не строит мир заново.
 */

const text = value => String(value ?? '').trim();
const uniqueSorted = list => [...new Set((Array.isArray(list) ? list : []).map(text).filter(Boolean))].sort();

/** Ключ набора: книги лорбука и карточки чата, без регистра и порядка. */
export function canonKey({ books = [], cards = [] } = {}) {
    const bookPart = uniqueSorted(books);
    const cardPart = uniqueSorted(cards).map(name => name.toLowerCase());
    if (!bookPart.length && !cardPart.length) return '';
    return `books:${bookPart.join('|')}::cards:${cardPart.join('|')}`;
}

export function canonSummary(value) {
    const canon = value && typeof value === 'object' ? value : {};
    return {
        id: text(canon.id),
        name: text(canon.name),
        createdAt: Number(canon.createdAt) || 0,
        characters: Object.keys(canon.great && typeof canon.great === 'object' ? canon.great : {}).length,
        banks: Object.keys(canon.banks && typeof canon.banks === 'object' ? canon.banks : {}).length,
    };
}

/** Один Canon из хранилища: имя обязательно, остальное — объекты. */
export function normalizeCanon(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const name = text(source.name);
    if (!name) return null;
    return {
        id: text(source.id) || `canon_${Number(source.createdAt) || 0}_${name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-')}`,
        name,
        createdAt: Number(source.createdAt) || 0,
        creation: source.creation && typeof source.creation === 'object' && !Array.isArray(source.creation) ? source.creation : {},
        great: source.great && typeof source.great === 'object' && !Array.isArray(source.great) ? source.great : {},
        banks: source.banks && typeof source.banks === 'object' && !Array.isArray(source.banks) ? source.banks : {},
    };
}

export function normalizeCanons(value) {
    return (Array.isArray(value) ? value : [])
        .map(normalizeCanon)
        .filter(Boolean)
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
