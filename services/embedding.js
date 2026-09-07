import { embed, cosineSimilarity } from '../libraries/core/embedding.js';

/**
 * Сервис локального эмбединга — тонкая обёртка над Библиотекой
 * ([libraries/core/embedding.js](../libraries/core/embedding.js)) на Шине
 * сервисов, тот же разрез, что у DOM/HTTP: Ядро (`core.memoryGraph`) само
 * никогда не трогает `@huggingface/transformers` напрямую.
 *
 * **Честная оговорка, не молчаливое допущение.** В отличие от
 * [http.js](http.js), этот Сервис НЕ проксирует сетевой доступ через
 * `http.request`/Гейт сети (ARCHITECTURE.md's "весь выход в интернет —
 * только через `http.request`") — технически не может: `@huggingface/transformers`
 * сама делает `fetch()` на закачку весов модели внутри своего кода, минуя
 * любую нашу обёртку. Регистрируется с `networkAccess: true` при сборке
 * (тот же явный флаг, что у `core.models.internal`/`core.selfUpdate`) —
 * это ЗАЯВЛЕННОЕ исключение из общего правила, а не дыра в нём: сама
 * закачка весов физически не может пройти через наш Гейт, раз её делает
 * сторонняя библиотека, а не наш код.
 */
export function registerEmbeddingService(bus) {
    const unregisters = [
        bus.register('embedding.compute', params => embed(params?.text, { kind: params?.kind }), { loadMetric: () => 1 }),
        bus.register('embedding.similarity', params => cosineSimilarity(params?.a, params?.b), { loadMetric: () => 0 }),
    ];
    return () => { for (const unregister of unregisters) unregister(); };
}
