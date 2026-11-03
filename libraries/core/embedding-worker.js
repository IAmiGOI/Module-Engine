/**
 * Воркер эмбеддинга: `@huggingface/transformers` (ONNX + WASM) считает векторы здесь, а не на странице —
 * в главном потоке каждый расчёт блокировал интерфейс, и при поиске по смыслу (десятки кусков страницы,
 * несколько сборщиков банков сразу) страница подвисала. Модель и адрес библиотеки приходят в сообщении,
 * чтобы не держать их в двух местах (`embedding.js`).
 */
let extractor = null;

self.onmessage = async event => {
    const { id, text, kind, model, cdn } = event.data ?? {};
    try {
        if (!extractor) extractor = import(cdn).then(({ pipeline }) => pipeline('feature-extraction', model, { dtype: 'q8' }));
        const run = await extractor;
        const prefix = kind === 'query' ? 'query: ' : 'passage: ';
        const output = await run(prefix + String(text ?? ''), { pooling: 'mean', normalize: true });
        self.postMessage({ id, vector: Array.from(output.data ?? output) });
    } catch (error) {
        extractor = null;
        self.postMessage({ id, error: String(error?.message ?? error) });
    }
};
