/**
 * Вектор тега на сервере — ТОЧНАЯ копия того, что делает ME (`libraries/core/embedding.js`, `kind: 'passage'`): та же модель `Xenova/multilingual-e5-small`,
 * q8, префикс `passage: `, mean pooling, normalize, обрезка до 2048 символов. Векторы сравнимы с вектором сцены ME только при полном совпадении — менять здесь
 * что-либо можно лишь вместе с ME (и поднять `model` в ответе, иначе ME отбросит каталог).
 */

export const MODEL_ID = 'Xenova/multilingual-e5-small';
export const DIM = 384;
const MAX_CHARS = 512 * 4;
const ROUND = 10000;   // 4 знака хватает косинусу; каталог в 3 раза легче

let extractorPromise = null;

async function getExtractor(cacheDir) {
    if (!extractorPromise) {
        extractorPromise = import('@huggingface/transformers').then(({ pipeline, env }) => {
            if (cacheDir) env.cacheDir = cacheDir;
            return pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' });
        });
    }
    return extractorPromise;
}

/** Текст тега → вектор из 384 чисел (округлён). */
export async function embedPassage(text, { cacheDir } = {}) {
    const clean = String(text ?? '').trim().slice(0, MAX_CHARS);
    const extractor = await getExtractor(cacheDir);
    const output = await extractor(`passage: ${clean}`, { pooling: 'mean', normalize: true });
    return Array.from(output.data ?? output, x => Math.round(x * ROUND) / ROUND);
}
