import { chunkPage, computeChunkPassage, rankBySimilarity, fuseMatches } from '../../libraries/core/web-semantic.js';

/** Сколько можно тратить на векторы кусков за один поиск (потом поиск идёт с тем, что успело посчитаться, а остальное досчитается в следующий раз). */
const EMBED_BUDGET_MS = 30000;
/** После сбоя эмбеддинга (модель не скачалась, нет WebGPU/WASM, телефон) не пробуем минуту: поиск идёт по словам, и это названо в ответе. */
const RETRY_AFTER_MS = 60000;

/**
 * Поиск по странице «слова + смысл» для действия `web.find`. Страница лежит в Сервисе (`stWebSearch.*`); здесь — куски, их векторы (локальный эмбеддинг через
 * Сервис `embedding.compute`) и слияние с поиском по словам. Векторы считаются лениво, при первом поиске по странице, и хранятся в памяти по странице: второй
 * запрос по той же странице почти бесплатен. Не получилось (модель недоступна) — не ошибка: ответ только по словам с пометкой `meaning: 'unavailable'`.
 */
export function createPageSearch({ callService, now = () => Date.now() }) {
    const pages = new Map(); // `${id}|${url}` → { chunks, vectors: Map<index, vector> }
    let unavailableUntil = 0;

    async function embedOne(text, kind) {
        const result = await callService('embedding.compute', { text, kind });
        if (!result.ok || !Array.isArray(result.value)) throw new Error(result.error?.message ?? 'No embedding.');
        return result.value;
    }

    async function search({ id, query }) {
        const lexical = await callService('stWebSearch.find', { id, query });
        if (!lexical.ok) return lexical;
        const text = await callService('stWebSearch.text', { id });
        if (!text.ok) return lexical;
        const { url, text: body, outline } = text.value;
        const key = `${id}|${url}`;
        if (!pages.has(key)) pages.set(key, { chunks: chunkPage(body, outline), vectors: new Map() });
        const page = pages.get(key);
        let meaning = 'used';
        let semantic = [];
        if (now() < unavailableUntil) meaning = 'unavailable';
        else {
            try {
                const queryVector = await embedOne(query, 'query');
                const started = now();
                for (const chunk of page.chunks) {
                    if (page.vectors.has(chunk.index)) continue;
                    if (now() - started > EMBED_BUDGET_MS) { meaning = 'partial'; break; }
                    page.vectors.set(chunk.index, await embedOne(computeChunkPassage(chunk), 'passage'));
                }
                semantic = rankBySimilarity(queryVector, page.vectors);
            } catch {
                unavailableUntil = now() + RETRY_AFTER_MS;
                meaning = 'unavailable';
            }
        }
        const matches = fuseMatches({ lexical: lexical.value.matches, semantic, chunks: page.chunks });
        return { ok: true, value: { id, url, matches, meaning } };
    }

    return { search };
}
