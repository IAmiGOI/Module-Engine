/**
 * Guided random директора — чистая математика без сети и моделей.
 *
 * Замысел владельца (DIRECTOR-SPEC.md): не D&D, никаких характеристик и
 * кубиков. Директор описывает сложность и опыт **словами**, e5-small
 * проецирует их на шкалы по близости к опорным фразам, движок превращает
 * разницу в вероятность, сам бросает кость и по полосе выбирает слова
 * степени для Push.
 *
 * Здесь намеренно нет эмбеддингов: сюда передаётся функция близости (или
 * векторы считает вызывающий). Поэтому формула проверяется без модели, а
 * e5-small подключается в e2 через `services/embedding.js`.
 */

/** Опорные фразы сложности: от «trivial» до «impossible», значение 0..1. */
export const DIFFICULTY_ANCHORS = Object.freeze([
    { value: 0.0, phrases: ['trivial', 'effortless', 'a child could do it', 'no challenge at all'] },
    { value: 0.15, phrases: ['very easy', 'simple', 'routine', 'almost no risk'] },
    { value: 0.35, phrases: ['easy', 'manageable', 'a familiar task'] },
    { value: 0.5, phrases: ['moderate', 'challenging', 'demanding', 'requiring care'] },
    { value: 0.7, phrases: ['hard', 'difficult', 'tough', 'against the odds'] },
    { value: 0.85, phrases: ['very hard', 'formidable', 'near impossible', 'almost beyond reach'] },
    { value: 1.0, phrases: ['impossible', 'beyond any skill', 'cannot be done'] },
]);

/** Опорные фразы опыта: от «novice» до «master», значение 0..1. */
export const EXPERIENCE_ANCHORS = Object.freeze([
    { value: 0.0, phrases: ['novice', 'beginner', 'untrained', 'no experience'] },
    { value: 0.2, phrases: ['basic', 'amateur', 'a little practice'] },
    { value: 0.4, phrases: ['competent', 'some experience', 'can handle it'] },
    { value: 0.6, phrases: ['skilled', 'experienced', 'practised'] },
    { value: 0.8, phrases: ['expert', 'veteran', 'highly trained'] },
    { value: 1.0, phrases: ['master', 'legendary', 'unmatched'] },
]);

/**
 * Полосы степени. `margin = probability - roll` — насколько бросок оказался
 * ниже шанса. Слова уходят в Push как есть: прозаик не решает исход, он
 * только пишет, насколько чисто персонаж сделал задуманное.
 */
export const DEGREE_BANDS = Object.freeze([
    { id: 'flawless', min: 0.45, words: 'flawlessly, exactly as intended' },
    { id: 'clean', min: 0.2, words: 'cleanly, without a hitch' },
    { id: 'barely', min: 0, words: 'barely, with visible effort' },
    { id: 'clumsy', min: -0.2, words: 'clumsily, with a mistake' },
    { id: 'botched', min: -Infinity, words: 'badly botched' },
]);

/** Насколько круто разница «опыт − сложность» переходит в вероятность. 4 ≈ 0.88 на +0.5 и 0.12 на −0.5. */
export const PROBABILITY_STEEPNESS = 4;

const STOP_WORDS = new Set(['a', 'an', 'the', 'of', 'to', 'is', 'it', 'and', 'or', 'with', 'at', 'in', 'on', 'for', 'very', 'no', 'not', 'all']);

function words(text) {
    return String(text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(word => word && !STOP_WORDS.has(word));
}

/**
 * Запасная близость без эмбеддингов: пересечение слов (Jaccard) плюс бонус за
 * вхождение целой фразы. Нужна и в тестах, и как честный фоллбэк, если
 * локальная модель недоступна.
 */
export function lexicalSimilarity(a, b) {
    const left = words(a);
    const right = words(b);
    if (!left.length || !right.length) return 0;
    const set = new Set(right);
    const shared = left.filter(word => set.has(word)).length;
    const jaccard = shared / new Set([...left, ...right]).size;
    const phraseBonus = String(b ?? '').toLowerCase().includes(String(a ?? '').toLowerCase()) && String(a ?? '').trim() ? 0.4 : 0;
    return Math.min(1, jaccard + phraseBonus);
}

/** Мягкий максимум: вес опоры растёт с близостью, но не схлопывается в одну. */
function softmaxWeights(scores, temperature = 0.12) {
    const max = Math.max(...scores);
    const exp = scores.map(score => Math.exp((score - max) / temperature));
    const total = exp.reduce((sum, value) => sum + value, 0) || 1;
    return exp.map(value => value / total);
}

/**
 * Слово директора → значение шкалы. `similarity(text, anchorPhrase)`.
 * Если ни одна опора не похожа (максимум ниже `floor`), возвращается
 * середина шкалы: молчаливая крайность здесь хуже нейтральности.
 */
export function projectPhrase(text, anchors = DIFFICULTY_ANCHORS, { similarity = lexicalSimilarity, floor = 0.08 } = {}) {
    const clean = String(text ?? '').trim();
    if (!clean) return 0.5;
    const scored = anchors.map(anchor => ({
        value: anchor.value,
        score: Math.max(...anchor.phrases.map(phrase => similarity(clean, phrase))),
    }));
    const best = Math.max(...scored.map(item => item.score));
    if (best < floor) return 0.5;
    const weights = softmaxWeights(scored.map(item => item.score));
    return scored.reduce((sum, item, index) => sum + item.value * weights[index], 0);
}

/**
 * Сложность переводится в «абсолютную» шкалу: «trivial» лежит ниже любого
 * опыта (эффективная −0.5), «moderate» — между новичком и мастером (0.5),
 * «impossible» — выше мастера (1.5). Без этого равные концы обеих шкал
 * взаимно гасились бы, и новичок на пустяке получал бы те же 50 %, что и
 * мастер на невозможном. Опыт остаётся 0..1.
 */
export function effectiveDifficulty(difficulty) {
    return Number(difficulty) * 2 - 0.5;
}

/** Логистика: при равных опыте и сложности — ровно 0.5. */
export function computeProbability(experience, difficulty, steepness = PROBABILITY_STEEPNESS) {
    const gap = Number(experience) - effectiveDifficulty(difficulty);
    return 1 / (1 + Math.exp(-steepness * gap));
}

/** Детерминированный бросок для тестов: mulberry32, seed → [0,1). */
export function rollFromSeed(seed) {
    let state = (Number(seed) >>> 0) || 0x9e3779b9;
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Полоса степени по `probability - roll`. */
export function degreeFor(probability, roll) {
    const margin = Number(probability) - Number(roll);
    return DEGREE_BANDS.find(band => margin >= band.min) ?? DEGREE_BANDS.at(-1);
}

/**
 * Полная оценка: слова → шкалы → вероятность → бросок → степень.
 * `embed` (необязательно) — `{ similarity }` на основе e5-small; без неё
 * работает лексический фоллбэк.
 */
export function assessAction({ character = '', action = '', difficulty = '', experience = '', seed, similarity = lexicalSimilarity, steepness = PROBABILITY_STEEPNESS } = {}) {
    const difficultyValue = projectPhrase(difficulty, DIFFICULTY_ANCHORS, { similarity });
    const experienceValue = projectPhrase(experience, EXPERIENCE_ANCHORS, { similarity });
    const probability = computeProbability(experienceValue, difficultyValue, steepness);
    const roll = Number.isFinite(seed) ? rollFromSeed(seed) : Math.random();
    const band = degreeFor(probability, roll);
    return {
        character: String(character ?? '').trim(),
        action: String(action ?? '').trim(),
        difficultyValue: round(difficultyValue),
        difficultyEffective: round(effectiveDifficulty(difficultyValue)),
        experienceValue: round(experienceValue),
        probability: round(probability),
        roll: round(roll),
        margin: round(probability - roll),
        degree: band.id,
        words: band.words,
    };
}

function round(value) {
    return Math.round(Number(value) * 1000) / 1000;
}
