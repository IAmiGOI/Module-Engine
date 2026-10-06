import { cosineSimilarity } from '../../libraries/core/embedding.js';

/**
 * Формирование регионов из нод, которые тематически держатся вместе — чистые функции (граф не трогают).
 *
 * Регион — тема. Граф без бутстрапа из лорбука начинает с ОДНОГО региона, и новому неоткуда взяться: рождение региона вокруг Core
 * (`region-birth.js`) сравнивает с уже существующими центрами и требует их минимум 4. Здесь наоборот — смотрим ВНУТРЬ региона и
 * ищем в нём устойчивые темы: средняя связность (average linkage) по косинусу эмбедингов. Абсолютные пороги косинуса для E5 не
 * работают (сходства сжаты в узкую полосу, ~0.75–0.95), поэтому порог — относительный: слияние идёт, пока средняя связность пары
 * групп не ниже `mean + mergeZ·σ` по всем парам нод региона.
 *
 * Выделяются только группы, которые держатся ПО-НАСТОЯЩЕМУ: не меньше `minCluster` нод, средняя связность внутри группы не ниже
 * порога слияния и заметно выше связности её нод с остальным регионом. Самая большая группа остаётся «домом» региона (там же
 * остаются Core и всё, что ни к какой теме не прибилось), остальные получают свои регионы.
 */

export const SPLIT_DEFAULTS = Object.freeze({ minNodes: 8, minCluster: 3, mergeZ: 0.5, maxNewRegions: 3 });

/** Центр группы: самая важная нода, при равенстве — самая «средняя» по сходству с остальными группы, затем id. */
function pickClusterCenter(group, similarity) {
    const meanSimilarity = member => group.reduce((sum, other) => (other === member ? sum : sum + similarity(member, other)), 0) / Math.max(1, group.length - 1);
    return [...group].sort((a, b) => (b.node.importance ?? 0) - (a.node.importance ?? 0) || meanSimilarity(b) - meanSimilarity(a) || String(a.node.id).localeCompare(String(b.node.id)))[0];
}

/**
 * `nodes` — кандидаты в группы (обычные ноды региона: не Core, не события, с эмбедингом): `[{ id, embedding, importance? }]`.
 * Возвращает `{ clusters: [{ ids, centerId, cohesion }], threshold }` — только группы, которые должны уйти в НОВЫЕ регионы
 * (лучшие по связности первыми, не больше `maxNewRegions`); пустой список — регион делить не на что.
 */
export function planRegionSplit(nodes, { minNodes = SPLIT_DEFAULTS.minNodes, minCluster = SPLIT_DEFAULTS.minCluster, mergeZ = SPLIT_DEFAULTS.mergeZ, maxNewRegions = SPLIT_DEFAULTS.maxNewRegions } = {}) {
    const members = nodes.filter(node => Array.isArray(node.embedding) && node.embedding.length).map(node => ({ node })).sort((a, b) => String(a.node.id).localeCompare(String(b.node.id)));
    if (members.length < minNodes || maxNewRegions < 1) return { clusters: [], threshold: null };

    const count = members.length;
    const sims = members.map(() => new Float64Array(count));
    const all = [];
    for (let i = 0; i < count; i += 1) for (let j = i + 1; j < count; j += 1) {
        const value = cosineSimilarity(members[i].node.embedding, members[j].node.embedding);
        sims[i][j] = value; sims[j][i] = value;
        all.push(value);
    }
    const mean = all.reduce((sum, value) => sum + value, 0) / all.length;
    const std = Math.sqrt(all.reduce((sum, value) => sum + (value - mean) ** 2, 0) / all.length);
    if (std < 1e-9) return { clusters: [], threshold: null }; // все ноды одинаково далеки/близки — тем нет
    const threshold = mean + mergeZ * std;

    let groups = members.map((_, i) => [i]);
    const link = (a, b) => { let sum = 0; for (const i of a) for (const j of b) sum += sims[i][j]; return sum / (a.length * b.length); };
    for (;;) {
        let best = -Infinity, bi = -1, bj = -1;
        for (let i = 0; i < groups.length; i += 1) for (let j = i + 1; j < groups.length; j += 1) {
            const value = link(groups[i], groups[j]);
            if (value > best) { best = value; bi = i; bj = j; }
        }
        if (best < threshold) break;
        const merged = [...groups[bi], ...groups[bj]];
        groups = groups.filter((_, k) => k !== bi && k !== bj);
        groups.push(merged);
    }

    const intra = group => { if (group.length < 2) return 0; let sum = 0, pairs = 0; for (let a = 0; a < group.length; a += 1) for (let b = a + 1; b < group.length; b += 1) { sum += sims[group[a]][group[b]]; pairs += 1; } return sum / pairs; };
    const large = groups.filter(group => group.length >= minCluster).sort((a, b) => b.length - a.length || a[0] - b[0]);
    if (large.length < 2) return { clusters: [], threshold }; // одна тема — делить нечего
    const leaving = large.slice(1)
        .map(group => ({ group, cohesion: intra(group) }))
        .filter(item => item.cohesion >= threshold)
        .sort((a, b) => b.cohesion - a.cohesion || a.group[0] - b.group[0])
        .slice(0, maxNewRegions);

    const similarity = (a, b) => sims[members.indexOf(a)][members.indexOf(b)];
    const clusters = leaving.map(({ group, cohesion }) => {
        const people = group.map(i => members[i]);
        return { ids: people.map(item => item.node.id), centerId: pickClusterCenter(people, similarity).node.id, cohesion };
    });
    return { clusters, threshold };
}
