import { cosineSimilarity } from '../../libraries/core/embedding.js';

/**
 * Выбор маяков ретрива и решение «держать закреплённый блок или сменить» — вторая версия (ROADMAP 5.109).
 *
 * Почему переписано (жалоба владельца: «маяки очень статичные, хотя я упоминал разные вещи из большого WI»). В первой версии:
 * - счёт кандидата был `сходство + log(1 + вес)`, а у защищённых нод (центры/под-центры регионов) вес `Infinity`. После бутстрапа
 *   из большого лорбука защищённых нод — десятки, все с `Infinity`, сортировка считает их равными и оставляет порядок создания:
 *   маяками ВСЕГДА были первые пять центров бутстрапа, о чём бы ни шла сцена;
 * - закреплённый блок менялся, только если сумма `(cos+1)/2` свежего набора больше закреплённой в 1.15 раза. У E5 это ~0.9–0.97
 *   на ноду: сумма пяти ~4.7, нужно > 5.4 при максимуме 5.0 — замена была НЕВОЗМОЖНА, первый ретрив чата закреплялся навсегда;
 * - сходства у E5 сжаты в полосу ~0.07, а `log(1 + вес)` — до ~2.5: вес перебивал смысл и без `Infinity`.
 *
 * Теперь: смысл первым — сходство нормируется ВНУТРИ кандидатов (`z`), вес и защищённость — ограниченные бонусы; имя ноды,
 * прямо встреченное в последних сообщениях, — сильный бонус (E5 плохо различает имена); маяк — только выше порога; почти-дубли
 * не занимают два места. Закрепление решается по СРЕДНЕМУ косинусу (разница, а не отношение) и живёт не дольше N ходов.
 */

export const BEACON_TUNING = Object.freeze({
    weightBonus: 0.3,      // максимум бонуса за вес (ранг веса среди кандидатов 0..1 × это число), в единицах σ сходства
    coreBonus: 0.2,        // Core (центры/под-центры/закреплённые) — небольшой постоянный бонус вместо прежней бесконечности
    nameBonus: 1.5,        // имя ноды встречено в последних сообщениях
    minScore: 0.5,         // маяк — только нода с итоговым счётом выше (≈ на полсигмы релевантнее среднего кандидата)
    duplicateCosine: 0.97, // два маяка настолько похожи — второй не берётся
    smallPool: 4,          // кандидатов меньше — нормировать нечего, порядок по сырому сходству без порога
});

/** Разница СРЕДНЕГО косинуса свежего набора над закреплённым, нужная для смены (было отношение сумм, при котором смена была невозможна). */
export const RETRIEVAL_STABILITY_DELTAS = Object.freeze({ often: 0.005, balanced: 0.015, sticky: 0.04 });

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Встречается ли метка ноды в тексте как отдельное слово/фраза (без учёта регистра). Короче 3 букв — не считается: «Al» совпал бы со всем подряд. */
export function labelMentioned(label, text) {
    const clean = String(label ?? '').trim();
    if (clean.length < 3 || !text) return false;
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(clean)}($|[^\\p{L}\\p{N}])`, 'iu').test(text);
}

/**
 * Маяки для текущего контекста. `candidates` — ноды `{ id, label, embedding, protectedNode }`, `weightOf(node)` → числовой вес
 * (как у вытеснения; `Infinity` у защищённых допустим — здесь он превращается в ранг, не в счёт). Возвращает
 * `[{ id, score, similarity, reason }]`, лучший первым; пусто — ни одна нода не прошла порог, блок лучше не вставлять вовсе.
 */
export function selectBeacons(candidates, contextEmbedding, { count = 5, queryText = '', weightOf = () => 0, tuning = BEACON_TUNING } = {}) {
    const pool = (candidates ?? []).filter(node => Array.isArray(node.embedding) && node.embedding.length);
    if (!pool.length || !contextEmbedding) return [];
    const sims = pool.map(node => cosineSimilarity(contextEmbedding, node.embedding));
    const mean = sims.reduce((sum, value) => sum + value, 0) / sims.length;
    const std = Math.sqrt(sims.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sims.length);
    const small = pool.length < tuning.smallPool || std < 1e-6;

    // Ранг веса 0..1 — бесконечный вес защищённых становится просто «самым тяжёлым», а не победой над всем.
    const weights = pool.map(node => (node.protectedNode ? Infinity : Number(weightOf(node)) || 0));
    const order = weights.map((weight, index) => ({ weight, index })).sort((a, b) => (a.weight === b.weight ? 0 : a.weight < b.weight ? -1 : 1));
    const rank = new Array(pool.length);
    order.forEach((entry, position) => { rank[entry.index] = pool.length > 1 ? position / (pool.length - 1) : 1; });

    const scored = pool.map((node, index) => {
        const named = labelMentioned(node.label, queryText);
        const relevance = small ? sims[index] : (sims[index] - mean) / std;
        const score = relevance + tuning.weightBonus * rank[index] + (node.protectedNode ? tuning.coreBonus : 0) + (named ? tuning.nameBonus : 0);
        return { node, id: node.id, score, similarity: sims[index], reason: named ? 'name' : 'meaning' };
    }).sort((a, b) => b.score - a.score);

    const picked = [];
    for (const entry of scored) {
        if (picked.length >= count) break;
        if (!small && entry.score < tuning.minScore && entry.reason !== 'name') continue;
        if (picked.some(other => cosineSimilarity(other.node.embedding, entry.node.embedding) >= tuning.duplicateCosine)) continue;
        picked.push(entry);
    }
    return picked.map(({ id, score, similarity, reason }) => ({ id, score, similarity, reason }));
}

/** Средний косинус набора к контексту; `null`, если хоть одной ноды уже нет (набор недействителен целиком). */
export function meanSetSimilarity(ids, nodesById, contextEmbedding) {
    if (!ids?.length) return null;
    let total = 0;
    for (const id of ids) {
        const node = nodesById[id];
        if (!node?.embedding) return null;
        total += cosineSimilarity(contextEmbedding, node.embedding);
    }
    return total / ids.length;
}

/**
 * Держать закреплённый блок (кэш провайдера) или сменить на свежий. Сменить, если: закреплённого нет или он недействителен;
 * он старше `maxAgeTurns` ходов (или часы ушли назад — перезагрузка страницы); свежий набор в среднем ближе к сцене на
 * `RETRIEVAL_STABILITY_DELTAS[stability]`. Одинаковые наборы не меняются никогда — менять нечего.
 */
export function shouldRefreshSticky({ sticky, freshIds, nodesById, contextEmbedding, stability = 'balanced', turn = 0, maxAgeTurns = 12 }) {
    if (!sticky?.beaconIds?.length) return true;
    const same = sticky.beaconIds.length === freshIds.length && freshIds.every(id => sticky.beaconIds.includes(id));
    if (same) return false;
    const stickyMean = meanSetSimilarity(sticky.beaconIds, nodesById, contextEmbedding);
    if (stickyMean === null) return true;
    const age = Number.isFinite(sticky.turn) ? turn - sticky.turn : Infinity;
    if (age < 0 || age >= maxAgeTurns) return true;
    const freshMean = meanSetSimilarity(freshIds, nodesById, contextEmbedding) ?? -Infinity;
    const delta = RETRIEVAL_STABILITY_DELTAS[stability] ?? RETRIEVAL_STABILITY_DELTAS.balanced;
    return freshMean - stickyMean > delta;
}

/** Текст запроса ретрива: последние `count` несистемных сообщений — одна реплика пользователя («ладно, идём») почти не несёт смысла. */
export function recentQueryText(chat, count = 3) {
    if (!Array.isArray(chat)) return '';
    return chat.filter(message => message && !message.is_system).slice(-count)
        .map(message => String(message.mes ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

/**
 * Маршрут между маяками — ДЕРЕВО, а не цепочка по порядку счёта (ROADMAP 5.109а). Пока маяками всегда были центры регионов
 * (связанные бэкбоном), цепочка 1→2→3 всегда складывалась в сплошной путь; теперь маяки — обычные ноды, у многих нет рёбер вовсе,
 * и цепочка рвалась: вместо пути — несколько разрозненных точек. Два исправления:
 * - **неявная связь «входит в регион»** (`in-region`): любая нода может пройти к центру своего региона (и обратно), даже без
 *   явного ребра — принадлежность региону и есть смысловая связь, по ней факт и относится к теме;
 * - **дерево по Приму**: к уже соединённой части по очереди присоединяется ближайший (в шагах) ещё не соединённый маяк —
 *   от ЛЮБОЙ уже вошедшей ноды, включая промежуточные. Недостижимый за `maxHops` маяк — `standalone`, как раньше.
 * `centerOf(id)` → id центра региона ноды (или `null`). Возвращает `{ segments, standalone }` — тот же вид, что у старого
 * `buildBeaconRoute`; сегменты идут путями подряд (каждый путь — от уже соединённой ноды к новому маяку).
 */
export function buildBeaconTree(nodesById, beaconIds, { maxHops = 6, centerOf = () => null } = {}) {
    const ids = [...new Set(beaconIds)].filter(id => nodesById[id]);
    if (ids.length < 2) return { segments: [], standalone: ids };
    const neighbours = id => {
        const out = (nodesById[id]?.edges ?? []).filter(edge => nodesById[edge.to]).map(edge => ({ to: edge.to, type: edge.type }));
        const center = centerOf(id);
        if (center && center !== id && nodesById[center] && !out.some(edge => edge.to === center)) out.push({ to: center, type: 'in-region' });
        return out;
    };
    // Обратные неявные связи центр → его ноды: считаются по требованию из всех нод (их немного, граф — сотни нод).
    const members = new Map();
    for (const id of Object.keys(nodesById)) {
        const center = centerOf(id);
        if (center && center !== id) { if (!members.has(center)) members.set(center, []); members.get(center).push(id); }
    }
    const allNeighbours = id => {
        const out = neighbours(id);
        for (const member of members.get(id) ?? []) if (!out.some(edge => edge.to === member)) out.push({ to: member, type: 'in-region' });
        return out;
    };

    const connected = new Set([ids[0]]);
    const remaining = new Set(ids.slice(1));
    const segments = [];
    while (remaining.size) {
        // BFS сразу от всей соединённой части — ближайший ещё не соединённый маяк.
        const previous = new Map();
        let frontier = [...connected];
        const seen = new Set(connected);
        let found = null;
        for (let hop = 0; hop < maxHops && frontier.length && !found; hop += 1) {
            const next = [];
            for (const id of frontier) {
                for (const edge of allNeighbours(id)) {
                    if (seen.has(edge.to)) continue;
                    seen.add(edge.to);
                    previous.set(edge.to, { from: id, type: edge.type });
                    if (remaining.has(edge.to)) { found = edge.to; break; }
                    next.push(edge.to);
                }
                if (found) break;
            }
            frontier = next;
        }
        if (!found) break;
        const path = [];
        for (let at = found; previous.has(at); at = previous.get(at).from) {
            path.unshift({ from: previous.get(at).from, to: at, type: previous.get(at).type });
            if (connected.has(previous.get(at).from)) break;
        }
        for (const step of path) { connected.add(step.to); remaining.delete(step.to); }
        segments.push(...path);
    }
    return { segments, standalone: [...remaining] };
}
