import { deadlineFrom } from './decision-bank-time.js';

/**
 * Длительность сцены словами — чистые правила, без модели. Модели плохо
 * считают, поэтому резолвер называет шкалу, а минуты считает движок.
 *
 * Шкала владельца: a moment / a few minutes / a quarter hour / half an hour /
 * an hour / a few hours / until dawn|morning|noon|evening|night / until
 * tomorrow. «until …» считается от текущего момента RP-времени; времена
 * суток берутся из настройки (та же, что у сроков Great Bank).
 */

/** Шкала ровно в том виде, в каком её пишет резолвер. */
export const DURATION_SCALE = Object.freeze([
    'a moment', 'a few minutes', 'a quarter hour', 'half an hour',
    'an hour', 'a few hours',
    'until dawn', 'until morning', 'until noon', 'until evening', 'until night',
    'until tomorrow',
]);

const FIXED = Object.freeze({
    'a moment': 1,
    moment: 1,
    instantly: 1,
    'a few minutes': 5,
    'few minutes': 5,
    minutes: 5,
    'a quarter hour': 15,
    'quarter of an hour': 15,
    'a quarter of an hour': 15,
    'half an hour': 30,
    'a half hour': 30,
    'an hour': 60,
    'one hour': 60,
    hour: 60,
    'a few hours': 180,
    'few hours': 180,
    hours: 180,
    'a couple of hours': 120,
});

const MAX_MINUTES = 1440;

const clean = value => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Длительность словами → минуты. Не разобрано — `null`: вызывающий сам решает,
 * что поставить и о чём предупредить.
 * @param {string} value  шкала словами
 * @param {{ nowValue?: number, timeOfDay?: object }} options  текущий момент RP-времени
 */
export function durationMinutes(value, { nowValue = null, timeOfDay = null } = {}) {
    const words = clean(value);
    if (!words) return null;
    if (Object.prototype.hasOwnProperty.call(FIXED, words)) return FIXED[words];
    if (!/^until\b/.test(words)) return null;
    if (nowValue === null || !Number.isFinite(Number(nowValue))) return null;
    const deadline = deadlineFrom(Number(nowValue), words, timeOfDay ?? undefined);
    if (deadline === null) return null;
    const minutes = Math.round(deadline - Number(nowValue));
    if (!Number.isFinite(minutes) || minutes < 0) return null;
    return Math.min(MAX_MINUTES, minutes);
}

/** Минуты по умолчанию, когда шкала не разобрана: короткая сцена, а не пустой ход. */
export const DEFAULT_DURATION = 'a few minutes';

export function clampMinutes(minutes) {
    const value = Number(minutes);
    if (!Number.isFinite(value) || value < 0) return 0;
    return Math.min(MAX_MINUTES, value);
}
