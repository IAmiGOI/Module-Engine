/**
 * «Черновик закончен» — маленькая модель, которую движок учит на самих
 * сообщениях игрока. Чистые функции: ни DOM, ни сети, ни хранения. Решение
 * «стрелять сейчас или подождать» принимает ядро, а здесь только признаки,
 * логистическая регрессия и один шаг SGD.
 *
 * Почему признаки именно такие: длина сравнивается с ОБЫЧНОЙ длиной его
 * отправленных сообщений (а не с абсолютным числом символов), пауза — с его
 * обычными паузами внутри набора, а конец текста говорит сам за себя. Игрок,
 * который пишет длинно, сам перестаёт получать выстрелы на коротких
 * промежуточных паузах: медиана длины растёт — `lengthRatio` падает.
 */

export const HISTORY_LENGTH_LIMIT = 50;
export const HISTORY_PAUSE_LIMIT = 200;

/** Пока истории нет: обычное сообщение и обычная пауза — разумные стартовые оценки. */
export const DEFAULT_SENT_LENGTH = 120;
export const DEFAULT_PAUSE_MS = 900;
/** Пауза в секундах — с потолком, иначе один долгий перерыв перевешивает всё остальное. */
export const PAUSE_CAP_MS = 15000;

const ENDING = /[.!?…"”*)]$/;
const QUOTES = /["“”«»]/g;
const STARS = /\*/g;

const FEATURE_KEYS = Object.freeze(['lengthRatio', 'ends', 'pauseRatio', 'pauseSeconds', 'unclosed']);

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function median(values) {
    const list = (Array.isArray(values) ? values : []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!list.length) return 0;
    const middle = Math.floor(list.length / 2);
    return list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2;
}

/** Пустая история: последние длины отправленных сообщений и паузы внутри набора. */
export function emptyHistory() {
    return { lengths: [], pauses: [] };
}

export function rememberSentLength(history, length) {
    const source = history && typeof history === 'object' ? history : emptyHistory();
    const value = Number(length);
    if (!Number.isFinite(value) || value <= 0) return { ...source, lengths: [...(source.lengths ?? [])] };
    // Держим только хвост: старая манера письма не должна весить вечно.
    return { ...source, lengths: [...(source.lengths ?? []), value].slice(-HISTORY_LENGTH_LIMIT) };
}

export function rememberPause(history, pauseMs) {
    const source = history && typeof history === 'object' ? history : emptyHistory();
    const value = Number(pauseMs);
    if (!Number.isFinite(value) || value <= 0) return { ...source, pauses: [...(source.pauses ?? [])] };
    return { ...source, pauses: [...(source.pauses ?? []), value].slice(-HISTORY_PAUSE_LIMIT) };
}

/** Текст кончается знаком конца — точка, восклицание, вопрос, многоточие, кавычка, звёздочка, скобка. */
export function endsWithEnding(text) {
    return ENDING.test(String(text ?? '').trim());
}

/** Незакрытая кавычка или звёздочка: игрок, скорее всего, ещё пишет. */
export function unclosedQuoteOrStar(text) {
    const value = String(text ?? '');
    return (value.match(QUOTES) ?? []).length % 2 === 1 || (value.match(STARS) ?? []).length % 2 === 1;
}

/**
 * Вектор признаков черновика на паузе. Все числа безразмерные, кроме
 * `pauseSeconds`, — так веса не зависят от длины конкретного сообщения.
 */
export function draftFeatures({ draft = '', pauseMs = 0, history = null } = {}) {
    const text = String(draft ?? '');
    const trimmed = text.trim();
    const source = history && typeof history === 'object' ? history : emptyHistory();
    const sentMedian = median(source.lengths) || DEFAULT_SENT_LENGTH;
    const pauseMedian = median(source.pauses) || DEFAULT_PAUSE_MS;
    const pause = Math.max(0, Number(pauseMs) || 0);
    return {
        // log-масштаб: разница «в два раза длиннее» весит одинаково на любой длине.
        lengthRatio: Math.log2(1 + trimmed.length) - Math.log2(1 + sentMedian),
        ends: endsWithEnding(trimmed) ? 1 : 0,
        pauseRatio: Math.log2(1 + pause) - Math.log2(1 + pauseMedian),
        pauseSeconds: Math.min(pause, PAUSE_CAP_MS) / 1000,
        unclosed: unclosedQuoteOrStar(text) ? 1 : 0,
    };
}

/**
 * Начальные веса: стрелять на паузе ≥ 2,5 с, длине ≥ 0,6 обычной и знаке
 * конца. Незакрытая кавычка/звёздочка гасит выстрел почти всегда.
 */
export function defaultWeights() {
    return { bias: -1.1, lengthRatio: 1.4, ends: 1.8, pauseRatio: 1.6, pauseSeconds: 0.5, unclosed: -2.2 };
}

export function predictReady(weights, features) {
    const w = { ...defaultWeights(), ...(weights && typeof weights === 'object' ? weights : {}) };
    const f = features && typeof features === 'object' ? features : {};
    const z = FEATURE_KEYS.reduce((sum, key) => sum + (Number(w[key]) || 0) * (Number(f[key]) || 0), Number(w.bias) || 0);
    return 1 / (1 + Math.exp(-clamp(z, -30, 30)));
}

/** Один шаг SGD: `label` — 1, если черновик ушёл ровно таким, 0 — если игрок дописал. */
export function learnReady(weights, features, label, { rate = 0.1 } = {}) {
    const current = { ...defaultWeights(), ...(weights && typeof weights === 'object' ? weights : {}) };
    const f = features && typeof features === 'object' ? features : {};
    const error = (label ? 1 : 0) - predictReady(current, f);
    const step = clamp(Number(rate) || 0, 0, 1) * error;
    const next = { ...current };
    for (const key of FEATURE_KEYS) next[key] = clamp((Number(current[key]) || 0) + step * (Number(f[key]) || 0), -10, 10);
    next.bias = clamp((Number(current.bias) || 0) + step, -10, 10);
    return next;
}
