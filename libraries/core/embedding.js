/**
 * Локальный эмбединг текста — прямо в браузере через `@huggingface/transformers`
 * (ONNX + WASM/WebGPU, без сервера, без llama.cpp — см. MEMORY_GRAPH.md за
 * полным разбором альтернатив). Ни DOM, ни Шины здесь нет — чистая обёртка
 * над одной внешней библиотекой, тот же принцип, что у `macro-language.js`.
 *
 * Модель — `Xenova/multilingual-e5-small` (ONNX-порт `intfloat/multilingual-e5-small`,
 * MEMORY_GRAPH.md — сравнение с альтернативами и почему не Qwen3-Embedding).
 * E5-семейство асимметрично: документ и запрос эмбедятся РАЗНЫМИ префиксами
 * (`passage: `/`query: `) — это часть самого протокола модели, не наша
 * прихоть (см. `intfloat/multilingual-e5-small` card). Без префикса модель
 * всё равно посчитает что-то, но хуже по обученному ей же протоколу.
 *
 * `pipeline` создаётся ЛЕНИВО и ОДИН РАЗ (модуль держит промис, не результат
 * — конкурентные первые вызовы не запускают закачку весов дважды). CDN, не
 * npm — тот же приём, что и у всего остального кода этого проекта (ни
 * бандлера, ни `node_modules` тут нет).
 */

const MODEL_ID = 'Xenova/multilingual-e5-small';
const TRANSFORMERS_CDN_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6';
/** Реальный max_seq_length модели (проверено по офиц. карточке, не по общим сведениям о семействе E5 — см. MEMORY_GRAPH.md). Символы, не токены — грубая, но безопасная в обе стороны отсечка (токенизатор всё равно сам обрежет остаток, это только чтобы не гонять WASM на мегабайтном тексте зря). */
const MAX_CHARS = 512 * 4;

let extractorPromise = null;

/** Подменяемо тестами — реальный импорт бьёт только по этой функции, а не размазан по файлу. */
export async function loadTransformersModule(importer = () => import(/* webpackIgnore: true */ TRANSFORMERS_CDN_URL)) {
    return importer();
}

async function getExtractor({ importer } = {}) {
    if (!extractorPromise) {
        extractorPromise = loadTransformersModule(importer).then(({ pipeline }) => pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' }));
    }
    return extractorPromise;
}

/** Сброс кэша — только для тестов (подсунуть другой `importer`/фейковый extractor заново). */
export function resetEmbeddingCache() {
    extractorPromise = null;
}

function truncate(text) {
    const clean = String(text ?? '').trim();
    return clean.length > MAX_CHARS ? clean.slice(0, MAX_CHARS) : clean;
}

/**
 * `kind: 'passage'` — то, что ложится в граф (контент ноды). `kind: 'query'`
 * — то, чем граф опрашивают (новый кусок разговора при отборе региона/маяков).
 * Разные префиксы — часть протокола E5, не опционально.
 */
export async function embed(text, { kind = 'passage', importer } = {}) {
    const prefix = kind === 'query' ? 'query: ' : 'passage: ';
    const extractor = await getExtractor({ importer });
    const output = await extractor(prefix + truncate(text), { pooling: 'mean', normalize: true });
    return Array.from(output.data ?? output);
}

/** Косинусное сходство — оба вектора уже нормализованы (`normalize: true` выше), поэтому это просто скалярное произведение; считается честно на случай, если вектор пришёл откуда-то ещё (тест, кэш) без гарантии нормализации. */
export function cosineSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i += 1) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
