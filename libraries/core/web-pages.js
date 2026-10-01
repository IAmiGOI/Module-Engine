/**
 * Страницы, которые гид «открывает» целиком в бэкенде, а в контекст берёт кусками: оглавление, нужный раздел, поиск по тексту. Чистые функции — разбор текста
 * на разделы, срез, поиск — и маленькое хранилище открытых страниц (последние несколько, дальше вытесняются самые давние). Сеть и ST сюда не заходят:
 * страницы кладёт Сервис (`services/st-web-search.js`).
 *
 * Страница хранится читаемым текстом, где заголовки стоят отдельными строками `## Название` (их ставит `computeReadableText` из web-text.js).
 */

export const PAGE_STORE_LIMIT = 8;
export const PAGE_MAX_CHARS = 300000;
export const VIEW_DEFAULT_CHARS = 3000;
export const VIEW_MAX_CHARS = 8000;
export const OVERVIEW_HEAD_CHARS = 600;
const FIND_LIMIT = 8;
const FIND_CONTEXT_CHARS = 220;

/** Служебные слова не ищутся: «how does she behave in a fight» иначе находил бы любой абзац со словом «she». */
const STOP_WORDS = new Set('a an and are as at be but by for from has have how her him his in is it its of on or she that the their them they this to was were what when where which who why with'.split(' '));

const HEADING_LINE = /^## (.+)$/gm;

/** Разделы страницы: `[{ number, title, offset, chars }]` (offset — начало заголовка; текст до первого заголовка — раздел «Beginning»). */
export function computeOutline(text) {
    const source = String(text ?? '');
    const heads = [...source.matchAll(HEADING_LINE)].map(match => ({ title: match[1].trim(), offset: match.index }));
    if (!heads.length || heads[0].offset > 0) heads.unshift({ title: 'Beginning', offset: 0 });
    return heads.map((head, index) => ({ number: index + 1, title: head.title, offset: head.offset, chars: (heads[index + 1]?.offset ?? source.length) - head.offset }));
}

/** Срез текста: `offset` и `chars` ограничены; `next` — откуда читать дальше (`null` — это конец страницы). */
export function sliceText(text, { offset = 0, chars = VIEW_DEFAULT_CHARS } = {}) {
    const source = String(text ?? '');
    const from = Math.min(Math.max(Math.floor(Number(offset)) || 0, 0), source.length);
    const length = Math.min(Math.max(Math.floor(Number(chars)) || VIEW_DEFAULT_CHARS, 200), VIEW_MAX_CHARS);
    const to = Math.min(source.length, from + length);
    return { text: source.slice(from, to), from, to, total: source.length, next: to < source.length ? to : null };
}

/** Раздел по номеру из оглавления или по части названия (без учёта регистра); не найден — `null`. */
export function pickSection(outline, section) {
    if (section === undefined || section === null || section === '') return null;
    const number = Number(section);
    if (Number.isInteger(number) && String(section).trim() === String(number)) return outline.find(item => item.number === number) ?? null;
    const needle = String(section).trim().toLowerCase();
    return outline.find(item => item.title.toLowerCase() === needle) ?? outline.find(item => item.title.toLowerCase().includes(needle)) ?? null;
}

/**
 * Поиск по тексту страницы. Слова запроса ищутся без учёта регистра; результат — места, где рядом (в окне ~300 знаков) нашлось больше всего РАЗНЫХ слов,
 * без наложений, лучшие первыми: `[{ offset, score, snippet, section }]`.
 */
export function findInText(text, query, outline = []) {
    const source = String(text ?? '');
    const lower = source.toLowerCase();
    const terms = [...new Set(String(query ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(term => term.length > 1 && !STOP_WORDS.has(term)))];
    if (!terms.length) return [];
    const hits = [];
    for (const term of terms) for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + term.length)) hits.push({ at, term });
    hits.sort((a, b) => a.at - b.at);
    const scored = hits.map(hit => {
        const near = new Set(hits.filter(other => Math.abs(other.at - hit.at) <= 150).map(other => other.term));
        return { offset: hit.at, score: near.size };
    });
    scored.sort((a, b) => b.score - a.score || a.offset - b.offset);
    const chosen = [];
    for (const item of scored) {
        if (chosen.length >= FIND_LIMIT) break;
        if (chosen.some(other => Math.abs(other.offset - item.offset) < FIND_CONTEXT_CHARS)) continue;
        chosen.push(item);
    }
    return chosen.map(item => {
        const start = Math.max(0, item.offset - FIND_CONTEXT_CHARS / 2);
        const section = [...outline].reverse().find(entry => entry.offset <= item.offset);
        return { offset: item.offset, score: item.score, snippet: source.slice(start, start + FIND_CONTEXT_CHARS).replace(/\s+/g, ' ').trim(), section: section ? `${section.number}. ${section.title}` : '' };
    });
}

/** Хранилище открытых страниц: `open` кладёт страницу (то же `url` — заменяет прежнюю), `get` достаёт по id; больше `limit` — самая давняя вытесняется. */
export function createPageStore({ limit = PAGE_STORE_LIMIT } = {}) {
    const pages = new Map();
    let counter = 0;
    return {
        open({ url, text }) {
            for (const [id, page] of pages) if (page.url === url) pages.delete(id);
            counter += 1;
            const id = `p${counter}`;
            const body = String(text ?? '').slice(0, PAGE_MAX_CHARS);
            pages.set(id, { id, url, text: body, outline: computeOutline(body) });
            while (pages.size > limit) pages.delete(pages.keys().next().value);
            return pages.get(id);
        },
        get: id => pages.get(String(id ?? '')) ?? null,
        list: () => [...pages.values()].map(({ id, url, text }) => ({ id, url, chars: text.length })),
    };
}
