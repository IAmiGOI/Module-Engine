/**
 * Поиск по смыслу на странице: чистые функции. Страница режется на куски (по абзацам, начало раздела — всегда начало куска), куски и запрос превращаются в
 * векторы (это делает Сервис эмбеддинга, не здесь), ближайшие по смыслу куски сливаются с совпадениями по словам (`web-pages.js`, `findInText`) в один список:
 * слова точно ловят имена и числа, смысл — пересказ («ярость в бою» ↔ «атакует и не отступает»).
 */

export const CHUNK_TARGET_CHARS = 700;
export const CHUNK_MAX_CHARS = 1000;
export const MAX_CHUNKS = 150;
/** Чат — страница из сотен сообщений: смысловой индекс его кусков длиннее обычной страницы (векторы считаются лениво и дописываются от поиска к поиску). */
export const CHAT_MAX_CHUNKS = 2000;
const RESULT_LIMIT = 8;
const SNIPPET_CHARS = 260;
/**
 * E5 даёт близкие числа любому тексту (на живой странице весь разброс уложился в 0,78–0,84), поэтому порог не абсолютный: в счёт идут куски не дальше
 * `RANK_MARGIN` от лучшего и не ниже `RANK_MINIMUM`, не больше RESULT_LIMIT.
 */
export const RANK_MARGIN = 0.04;
export const RANK_MINIMUM = 0.7;
/** Разделы, которые только повторяют остальное (оглавление, ссылки): в векторы не идут, словами их по-прежнему видно. */
const SKIPPED_SECTIONS = /^(contents|references|external links|image gallery|gallery|navigation)$/i;
const RRF_K = 60;

/**
 * Куски страницы: `[{ index, offset, end, section: '2. Appearance', sectionTitle, text }]`. Абзац — строка текста; раздел начинается с новой строки `## …`, и кусок не переходит границу раздела.
 * Больше `maxChunks` (по умолчанию MAX_CHUNKS) не делаем (остальное не в смысловом поиске, но слова его по-прежнему находят).
 */
export function chunkPage(text, outline = [], { maxChunks = MAX_CHUNKS } = {}) {
    const source = String(text ?? '');
    const sectionAt = offset => [...outline].reverse().find(entry => entry.offset <= offset) ?? null;
    const starts = new Set(outline.map(item => item.offset));
    const chunks = [];
    let current = null;
    const close = () => { const item = current ? sectionAt(current.offset) : null; if (current && current.text.trim() && !SKIPPED_SECTIONS.test(item?.title ?? '')) { chunks.push({ index: chunks.length, offset: current.offset, end: current.end, section: item ? `${item.number}. ${item.title}` : '', sectionTitle: item?.title ?? '', text: current.text.trim() }); } current = null; };
    let offset = 0;
    for (const line of source.split('\n')) {
        const lineEnd = offset + line.length;
        if (starts.has(offset) || (current && current.text.length + line.length > CHUNK_MAX_CHARS) || (current && current.text.length >= CHUNK_TARGET_CHARS)) close();
        if (!current) current = { offset, end: lineEnd, text: '' };
        current.text += `${current.text ? '\n' : ''}${line}`;
        current.end = lineEnd;
        offset = lineEnd + 1;
        if (chunks.length >= maxChunks) break;
    }
    close();
    return chunks.slice(0, maxChunks);
}

/** Текст куска для эмбеддинга: название раздела помогает смыслу («Personality: She is…»). */
export const computeChunkPassage = chunk => (chunk.sectionTitle ? `${chunk.sectionTitle}: ${chunk.text}` : chunk.text);

/** Скалярное произведение нормализованных векторов (так возвращает эмбеддинг) = косинус. */
export function computeSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
    let dot = 0;
    for (let index = 0; index < a.length; index += 1) dot += a[index] * b[index];
    return dot;
}

/** Куски, ближайшие к запросу: `[{ index, score }]`, лучшие первыми (`vectors`: Map индекс → вектор; куски без вектора пропускаются). */
export function rankBySimilarity(queryVector, vectors, { margin = RANK_MARGIN, minimum = RANK_MINIMUM, limit = RESULT_LIMIT } = {}) {
    const scored = [...vectors.entries()].map(([index, vector]) => ({ index, score: computeSimilarity(queryVector, vector) })).sort((a, b) => b.score - a.score);
    if (!scored.length) return [];
    const bar = Math.max(scored[0].score - margin, minimum);
    return scored.filter(item => item.score >= bar).slice(0, limit);
}

/**
 * Слияние двух списков (по словам и по смыслу) взаимным рангом (RRF): кусок, который нашёлся обоими способами, поднимается. Результат —
 * `[{ offset, section, snippet, via: 'words' | 'meaning' | 'both' }]`, лучшие первыми; `lexical` — совпадения `findInText`, `semantic` — `rankBySimilarity`.
 */
export function fuseMatches({ lexical = [], semantic = [], chunks, limit = RESULT_LIMIT }) {
    const chunkAt = offset => chunks.find(chunk => offset >= chunk.offset && offset <= chunk.end) ?? null;
    const scored = new Map();
    const add = (key, rank, via, base) => {
        const entry = scored.get(key) ?? { ...base, score: 0, via: new Set() };
        entry.score += 1 / (RRF_K + rank);
        entry.via.add(via);
        scored.set(key, entry);
    };
    lexical.forEach((match, rank) => {
        const chunk = chunkAt(match.offset);
        add(chunk ? `c${chunk.index}` : `o${match.offset}`, rank, 'words', { offset: match.offset, section: match.section, snippet: match.snippet });
    });
    semantic.forEach((hit, rank) => {
        const chunk = chunks[hit.index];
        if (chunk) add(`c${chunk.index}`, rank, 'meaning', { offset: chunk.offset, section: chunk.section, snippet: chunk.text.replace(/\s+/g, ' ').slice(0, SNIPPET_CHARS) });
    });
    return [...scored.values()].sort((a, b) => b.score - a.score).slice(0, limit)
        .map(({ offset, section, snippet, via }) => ({ offset, section, snippet, via: via.size === 2 ? 'both' : [...via][0] }));
}
