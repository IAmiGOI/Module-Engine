/**
 * Выбор трека по эмбединг-близости — чистая Библиотека без DOM, Шин и ST
 * (LIBRARIES.md: сначала Библиотека, потом всё остальное). Переработка
 * Alpha'вского `modules/music/selection.js`: там выбор был keyword-overlap
 * между ключами сцены и ключами трека, здесь — косинусная близость между
 * вектором сцены и вектором-«визиткой» трека (концепт согласован с
 * владельцем: классификация сцены LLM не нужна вовсе, ноль вызовов модели —
 * только локальный `embedding.compute` на смену сцены).
 *
 * Вход честно мал: трек обязан нести уже посчитанный и закэшированный
 * `vector` (пересчитывается Модулем при добавлении/правке описания), сцена —
 * один свежий вектор. Никакой этой библиотеке моделей не нужно.
 */

/** Ниже этой косинусной близости подбор не считается состоявшимся. Не «включи трек наугад», как в Alpha, а «продолжай играть то, что играет»: рваная смена на нерелевантный трек хуже, чем устоявшийся. */
const MIN_SIMILARITY = 0.55;
/** Насколько хуже лучшего должен быть счёт кандидата, чтобы он выпал из «кластера близких» и не попал во взвешенный выбор. */
const CLOSE_MARGIN = 0.04;

export const TRACK_SELECTION_DEFAULTS = Object.freeze({ minSimilarity: MIN_SIMILARITY, closeMargin: CLOSE_MARGIN });

/** Косинусная близость, устойчивая к мусору: пустой/неравный/нулевой вектор — 0, а не исключение (подбор не должен падать из-за одного битого трека). */
export function similarity(a, b) {
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

/** Взвешенный выбор `1/(playCount+1)` — ровно наследие Alpha (`selection.js`): никогда не играющий трек вдвое вероятнее сыгранного однажды, ротация сама выравнивается, но не становится детерминированной. `randomFn` инъектируется для тестов. */
export function pickWeighted(tracks, randomFn = Math.random) {
    if (!tracks.length) return null;
    if (tracks.length === 1) return tracks[0];
    const weights = tracks.map(track => 1 / ((track.playCount ?? 0) + 1));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let roll = randomFn() * total;
    for (let i = 0; i < tracks.length; i += 1) {
        roll -= weights[i];
        if (roll <= 0) return tracks[i];
    }
    return tracks[tracks.length - 1];
}

/**
 * Весь подбор. `tracks` — `{id, vector?, playCount?}[]`, `sceneVector` — свежий
 * вектор сцены. Порядок решения:
 *   1) треки без вектора не участвуют (их вектор ещё не посчитан — честно ждём,
 *      а не играем «что попало»);
 *   2) каждый, чей косинус ниже `minSimilarity`, выбывает — «ничего подходящего»;
 *   3) кластер близких: все в пределах `closeMargin` от лучшего счёта —
 *      различие внутри кластера для E5 слишком шумно, чтобы доверять ему как
 *      строгому порядку;
 *   4) внутри кластера — взвешенный выбор по playCount.
 * Возвращает `{ track, similarity }` победителя или `null` (пустая библиотека,
 * нет векторов, всё ниже порога) — `null` для вызывающего означает «не менять
 * играющий трек», а не «играть первый попавшийся».
 */
export function selectTrack({ tracks, sceneVector, minSimilarity = MIN_SIMILARITY, closeMargin = CLOSE_MARGIN, randomFn = Math.random } = {}) {
    const scored = (Array.isArray(tracks) ? tracks : [])
        .filter(track => Array.isArray(track?.vector) && track.vector.length > 0)
        .map(track => ({ track, score: similarity(sceneVector, track.vector) }))
        .filter(entry => entry.score >= minSimilarity);
    if (!scored.length) return null;
    const best = Math.max(...scored.map(entry => entry.score));
    const close = scored.filter(entry => entry.score >= best - closeMargin);
    const winner = pickWeighted(close.map(entry => entry.track), randomFn);
    return { track: winner, similarity: scored.find(entry => entry.track === winner)?.score ?? best };
}

/**
 * Смена трека оправдана, только если новый ЗНАЧИМО ближе к сцене, чем играющий:
 * та же логика «устоявшийся лучше рваного», что и порог выше, — колебание
 * косинуса в шуме модели не должно дёргать музыку каждое сообщение. Без
 * играющего трека играет любой прошедший порог.
 */
export function shouldSwitch({ currentSimilarity = null, candidateSimilarity, hysteresis = 0.05 } = {}) {
    if (currentSimilarity === null || currentSimilarity === undefined) return true;
    return candidateSimilarity >= currentSimilarity + hysteresis;
}
