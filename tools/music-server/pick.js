/**
 * Выбор трека на сервере: ME присылает вектор сцены, сервер сам решает — играть другой трек, оставить текущий или промолчать. Это та же логика, что была у ME
 * (`libraries/core/track-selection.js`: косинус → порог → кластер близких → взвешенный выбор `1/(играно+1)` → гистерезис), только теперь её единственный владелец — сервер.
 * Чистые функции без сети и диска; случайность подаётся снаружи (для тестов).
 */

export const PICK_DEFAULTS = Object.freeze({ minSimilarity: 0.55, switchMargin: 0.05, closeMargin: 0.04 });

export function similarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i += 1) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return normA === 0 || normB === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Взвешенный выбор: ни разу не игравший трек вдвое вероятнее сыгранного однажды. */
export function pickWeighted(items, plays, randomFn = Math.random) {
    if (!items.length) return null;
    const weights = items.map(item => 1 / ((plays.get(item.id) ?? 0) + 1));
    let roll = randomFn() * weights.reduce((sum, weight) => sum + weight, 0);
    for (let i = 0; i < items.length; i += 1) {
        roll -= weights[i];
        if (roll <= 0) return items[i];
    }
    return items[items.length - 1];
}

const clamp = (value, min, max, fallback) => (Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback);
export const validVector = (vector, dim) => Array.isArray(vector) && vector.length === dim && vector.every(Number.isFinite);

/**
 * `items` — играющие треки раздела `{ id, ext, vector, group? }` (в групповом разделе вектор — группы).
 * Ответ: `{ action: 'play', id, ext, similarity }` | `{ action: 'keep' }` (оставить играющее) | `{ action: 'none' }` (ничего не подходит, играющее продолжается).
 *  - `ended` — трек доиграл: другой трек той же группы (в разделе без групп и в группе из одного трека — тот же), вектор не нужен;
 *  - `force` — кнопка «следующий»: порог и гистерезис не действуют, берётся лучшее из имеющегося.
 */
export function pickTrack({ items, vector, dim, currentId = null, ended = false, force = false, minSimilarity, switchMargin, plays = new Map(), randomFn = Math.random }) {
    const current = items.find(item => item.id === currentId) ?? null;
    const asPlay = (item, score = null) => ({ action: 'play', id: item.id, ext: item.ext, similarity: score });

    if (ended) {
        if (!current) return { action: 'none' };
        const siblings = current.group ? items.filter(item => item.group === current.group && item.id !== current.id) : [];
        return asPlay(pickWeighted(siblings, plays, randomFn) ?? current);
    }
    if (!validVector(vector, dim)) return { action: 'none', reason: 'bad vector' };

    const floor = force ? -1 : clamp(minSimilarity, 0, 1, PICK_DEFAULTS.minSimilarity);
    const margin = clamp(switchMargin, 0, 0.5, PICK_DEFAULTS.switchMargin);
    const scored = items.map(item => ({ item, score: similarity(vector, item.vector) })).filter(entry => entry.score >= floor);
    if (!scored.length) return { action: 'none' };

    const best = Math.max(...scored.map(entry => entry.score));
    const cluster = scored.filter(entry => best - entry.score <= PICK_DEFAULTS.closeMargin);
    const chosen = pickWeighted(cluster.map(entry => entry.item), plays, randomFn);
    const score = cluster.find(entry => entry.item === chosen).score;

    if (!force && current) {
        if (chosen.id === current.id) return { action: 'keep' };
        // Кандидат должен быть ЗАМЕТНО лучше играющего — шум косинуса не дёргает музыку на каждой реплике.
        if (score - similarity(vector, current.vector) < margin) return { action: 'keep' };
    }
    return asPlay(chosen, score);
}
