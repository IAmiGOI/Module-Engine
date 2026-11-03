/**
 * Guided random директора — чистая математика без сети, моделей и эмбеддингов.
 *
 * Замысел владельца (DIRECTOR-SPEC.md, часть 10): не D&D, никаких
 * характеристик и кубиков. Директор выбирает **уровень сложности** и
 * **уровень опыта** из двух коротких списков; вероятность берётся из
 * таблицы двух уровней. e5-small в оценке больше не участвует: именно она
 * смешивала длинные оговорки в середину и давала 0,5 почти на всё.
 *
 * Таблица — 6×6, порядок строк и столбцов ниже. Контрольные точки:
 * novice/hard ≈ 0.15, master/nearly impossible ≈ 0.10,
 * skilled/moderate ≈ 0.75.
 */

/** Сложность задачи, от пустяка до невозможного. Порядок — индекс строки таблицы. */
export const DIFFICULTY_LEVELS = Object.freeze(['trivial', 'easy', 'moderate', 'hard', 'very hard', 'nearly impossible']);

/** Опыт персонажа именно в этой задаче, от нуля до мастера. Порядок — индекс столбца таблицы. */
export const EXPERIENCE_LEVELS = Object.freeze(['none', 'novice', 'practised', 'skilled', 'expert', 'master']);

/**
 * Вероятность «сможет ли персонаж сделать задуманное».
 * Строка — опыт, столбец — сложность.
 */
export const PROBABILITY_TABLE = Object.freeze([
    // trivial easy moderate hard very hard nearly impossible
    [0.901, 0.664, 0.299, 0.084, 0.020, 0.004], // none
    [0.946, 0.791, 0.450, 0.150, 0.037, 0.008], // novice
    [0.971, 0.879, 0.610, 0.253, 0.068, 0.016], // practised
    [0.985, 0.933, 0.750, 0.393, 0.123, 0.029], // skilled
    [0.992, 0.964, 0.852, 0.554, 0.212, 0.055], // expert
    [0.996, 0.981, 0.917, 0.704, 0.340, 0.100], // master
]);

export const PROBABILITY_TABLE_NOTE = 'rows: experience none…master; columns: difficulty trivial…nearly impossible';

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

const normalize = value => String(value ?? '').trim().toLowerCase();
const difficultyIndex = value => DIFFICULTY_LEVELS.indexOf(normalize(value));
const experienceIndex = value => EXPERIENCE_LEVELS.indexOf(normalize(value));

export function isKnownDifficulty(value) {
    return difficultyIndex(value) >= 0;
}

export function isKnownExperience(value) {
    return experienceIndex(value) >= 0;
}

/** Отказ инструмента со списком допустимых уровней — без догадки. */
export function levelProblem({ difficulty, experience } = {}) {
    if (!isKnownDifficulty(difficulty)) {
        return `Unknown difficulty "${String(difficulty ?? '')}". Use one of: ${DIFFICULTY_LEVELS.join(', ')}.`;
    }
    if (!isKnownExperience(experience)) {
        return `Unknown experience "${String(experience ?? '')}". Use one of: ${EXPERIENCE_LEVELS.join(', ')}.`;
    }
    return '';
}

/** Вероятность по двум уровням. Неизвестный уровень — `null`, не середина шкалы. */
export function computeProbability(experience, difficulty) {
    const row = experienceIndex(experience);
    const column = difficultyIndex(difficulty);
    if (row < 0 || column < 0) return null;
    return PROBABILITY_TABLE[row][column];
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
 * Полная оценка: два уровня → вероятность → бросок → степень.
 * @returns {{ ok: true, … } | { ok: false, error: string }}
 */
export function assessAction({ character = '', action = '', difficulty = '', experience = '', why = '', seed } = {}) {
    const problem = levelProblem({ difficulty, experience });
    if (problem) return { ok: false, error: problem };
    const probability = computeProbability(experience, difficulty);
    const roll = Number.isFinite(seed) ? rollFromSeed(seed) : Math.random();
    const band = degreeFor(probability, roll);
    return {
        ok: true,
        character: String(character ?? '').trim(),
        action: String(action ?? '').trim(),
        difficulty: normalize(difficulty),
        experience: normalize(experience),
        why: String(why ?? '').trim(),
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
