/**
 * Размещение новой ноды по НАСТОЯЩЕМУ косинусу к центрам регионов — MEMORY_GRAPH_FIX_PLAN.md, Этап 3 (ROADMAP
 * 5.107в). Раньше каскад решал по ДОЛЯМ softmax через все 15 регионов сразу (`computeRegionLogits`) — у реальных
 * эмбедингов (E5) сходства ко ВСЕМ регионам близки друг к другу (~0.85–0.95), доли получались почти равными, и
 * порог отрыва 1.5× почти никогда не брался — новая нода уходила в накопитель, даже когда один регион был явно
 * похожим по смыслу. Здесь — прямое сравнение с центрами, без долей: похоже — размещаем, не похоже, но выбирать
 * не из чего — тоже размещаем (в лучший), накопитель больше не первая реакция на "не идеально уверен".
 */

import { cosineSimilarity } from '../../libraries/core/embedding.js';

/**
 * `anchors` — регионы, у которых УЖЕ есть центр (`[{ sector, ring, embedding }]`); регионы без центра не участвуют
 * вовсе — сравнивать не с чем. Пустой список — `null`, решение "куда без единого ориентира" не этой функции.
 * `confident` — оба условия разом: сходство с лучшим ДОСТАТОЧНО ВЫСОКОЕ само по себе (`minSimilarity`) И лучший
 * region заметно впереди второго места (`minMargin`) — "лучший из плохих" не считается уверенным даже с отрывом.
 */
export function pickRegionBySimilarity(embedding, anchors, { minSimilarity = 0.8, minMargin = 0.02 } = {}) {
    if (!anchors.length) return null;
    const scored = anchors
        .map(anchor => ({ region: { sector: anchor.sector, ring: anchor.ring }, similarity: cosineSimilarity(embedding, anchor.embedding) }))
        .sort((a, b) => b.similarity - a.similarity);
    const [best, second] = scored;
    // Второго места нет (единственный анкер) — сравнивать не с чем, отрыв заведомо максимальный: решает только
    // `minSimilarity` сама по себе. `-1` — худший теоретически возможный косинус, не произвольное число.
    const margin = best.similarity - (second?.similarity ?? -1);
    return { region: best.region, similarity: best.similarity, margin, confident: best.similarity >= minSimilarity && margin >= minMargin };
}
