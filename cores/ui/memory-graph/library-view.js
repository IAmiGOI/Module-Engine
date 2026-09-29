/**
 * Вкладка «Library» окна графа (MEMORY_GRAPH_TYPES_PLAN.md, этап 9) — чистая модель: вкладки, поиск, сортировка, карточки.
 * Без DOM и вызовов Ядра.
 */

export const TABS = Object.freeze(['graph', 'library']);
export const SORTS = Object.freeze(['date', 'name', 'size']);

/** Неизвестное значение (например, из старого состояния окна) — вкладка Graph. */
export const normalizeTab = value => (TABS.includes(value) ? value : 'graph');

/** Записи библиотеки после поиска по имени (без учёта регистра, ещё и по имени персонажа) и сортировки: date — новые первыми, name — по алфавиту, size — большие первыми. */
export function filterAndSort(entries, { query = '', sort = 'date' } = {}) {
    const needle = String(query).trim().toLowerCase();
    const matches = needle
        ? entries.filter(entry => `${entry.name} ${entry.source?.characterName ?? ''}`.toLowerCase().includes(needle))
        : [...entries];
    const by = {
        date: (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
        name: (a, b) => String(a.name).localeCompare(String(b.name)),
        size: (a, b) => (b.size ?? 0) - (a.size ?? 0),
    };
    return matches.sort(by[sort] ?? by.date);
}

export function formatSize(bytes) {
    if (!Number.isFinite(bytes)) return '—';
    return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const formatDate = timestamp => (Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : '—');

/** Всё, что нужно карточке для показа. */
export function cardModel(entry) {
    const counts = entry.counts ?? {};
    return {
        id: entry.id,
        name: entry.name,
        thumbnail: entry.thumbnail ?? null,
        modeLabel: entry.mode === 'structured' ? 'Structured' : 'Legacy',
        countsText: `${counts.nodes ?? 0} nodes · ${counts.regions ?? 0} regions · ${counts.cores ?? 0} core`,
        datesText: `saved ${formatDate(entry.savedAt)}${entry.updatedAt && entry.updatedAt !== entry.savedAt ? `, updated ${formatDate(entry.updatedAt)}` : ''}`,
        fromText: entry.source?.characterName ? `from: ${entry.source.characterName}` : '',
        sizeText: formatSize(entry.size),
    };
}
