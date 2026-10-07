/**
 * Выравнивание «регистров»: сцена и теги живут в разных областях пространства эмбедингов. Теги — абстрактные описания настроения, сцены — ролевая проза; даже без всякого
 * смысла «средняя сцена» стоит от «среднего тега» далеко (на данных владельца: 0.45 по длине вектора), и теги, случайно ближайшие к общему стилю прозы, выигрывают на любой
 * сцене («хабы»: одна группа брала четверть всех сцен). Лечится простейшим образом: из вектора сцены вычитается разница средних (средняя сцена − средний тег), результат
 * нормируется. Метки не нужны — только сами эталонные сцены и теги; на 552 сценах владельца доля побед главного «хаба» упала с 26% до 8–11%, остальные метрики выросли.
 *
 * Сдвигаются вектор сцены и ЭТАЛОНЫ (они тоже сцены); теги, «когда не включать» и шаги паттернов остаются как есть — они из мира тегов.
 */

export const ALIGN_DEFAULTS = Object.freeze({ strength: 1, minScenes: 12, minTags: 2 });

const mean = vectors => {
    const out = new Array(vectors[0].length).fill(0);
    for (const vector of vectors) for (let i = 0; i < out.length; i += 1) out[i] += vector[i] / vectors.length;
    return out;
};
const normalized = vector => { const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0)); return norm > 1e-12 ? vector.map(x => x / norm) : vector; };
const usable = (vectors, dim) => (Array.isArray(vectors) ? vectors : []).filter(vector => Array.isArray(vector) && vector.length === dim);

/**
 * `{ gap, strength, scenes, tags }` или `null` (мало данных или сила 0 — тогда всё работает как прежде).
 * `sceneVectors` — эталонные сцены раздела, `tagVectors` — векторы тегов (групп; в разделе «по трекам» — треков).
 */
export function estimateAlignment({ sceneVectors, tagVectors, strength = ALIGN_DEFAULTS.strength, minScenes = ALIGN_DEFAULTS.minScenes, minTags = ALIGN_DEFAULTS.minTags }) {
    const dim = (tagVectors ?? []).find(vector => Array.isArray(vector))?.length ?? 0;
    const scenes = usable(sceneVectors, dim), tags = usable(tagVectors, dim);
    if (!dim || scenes.length < minScenes || tags.length < minTags || !(strength > 0)) return null;
    const sceneMean = mean(scenes), tagMean = mean(tags);
    return { gap: sceneMean.map((x, i) => x - tagMean[i]), strength, scenes: scenes.length, tags: tags.length };
}

/** Вектор сцены (или эталона) после выравнивания; без выравнивания или при чужой длине — как был. */
export function shiftScene(vector, alignment) {
    if (!alignment || !Array.isArray(vector) || vector.length !== alignment.gap.length) return vector;
    return normalized(vector.map((x, i) => x - alignment.strength * alignment.gap[i]));
}

/** Эталоны группа → векторы, сдвинутые так же, как сцена. */
export function shiftPrototypes(prototypes, alignment) {
    if (!alignment || !prototypes) return prototypes;
    return new Map([...prototypes].map(([key, list]) => [key, list.map(vector => shiftScene(vector, alignment))]));
}
