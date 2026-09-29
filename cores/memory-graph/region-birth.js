import { cosineSimilarity } from '../../libraries/core/embedding.js';

/**
 * Рождение региона вокруг нового Core (MEMORY_GRAPH_TYPES_PLAN.md, этап 5) — чистые функции.
 * Абсолютные пороги косинуса для E5 не работают (сходства сжаты в узкую полосу), поэтому «далеко от всех центров» решается
 * ОТНОСИТЕЛЬНО самого графа: у обычных нод есть типичное сходство с ближайшим центром (`referenceBest`); Core, чьё лучшее
 * сходство заметно ниже типичного (на `seedZ` стандартных отклонений), не вписывается ни в одну тему и засевает свою.
 */

export const MIN_CENTERS_TO_SEED = 4; // меньше центров — сравнивать не с чем, регион не засеваем

/** Лучшее сходство эмбединга с центрами `[{ embedding }]`; `null`, если центров нет. */
export function bestCenterSimilarity(embedding, anchors) {
    if (!embedding || !anchors.length) return null;
    return Math.max(...anchors.map(anchor => cosineSimilarity(embedding, anchor.embedding)));
}

/**
 * Засевать ли новый регион. `referenceBest` — лучшие сходства с центрами у остальных нод графа (числа). Мало данных
 * (центров < 4 или образцов < 4) — нет. Нулевой разброс — порога нет, не засеваем.
 */
export function shouldSeedRegion(embedding, anchors, referenceBest, { seedZ = 1.0 } = {}) {
    if (anchors.length < MIN_CENTERS_TO_SEED || referenceBest.length < MIN_CENTERS_TO_SEED) return false;
    const best = bestCenterSimilarity(embedding, anchors);
    if (best === null) return false;
    const mean = referenceBest.reduce((sum, value) => sum + value, 0) / referenceBest.length;
    const std = Math.sqrt(referenceBest.reduce((sum, value) => sum + (value - mean) ** 2, 0) / referenceBest.length);
    if (std < 1e-9) return false;
    return best < mean - seedZ * std;
}

/** Уникальный ключ региона `region:<slug метки>`; при коллизии `-2`, `-3`… */
export function regionKeyForLabel(label, takenKeys) {
    const slug = String(label ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'core';
    const taken = new Set(takenKeys);
    let key = `region:${slug}`;
    for (let suffix = 2; taken.has(key); suffix += 1) key = `region:${slug}-${suffix}`;
    return key;
}
