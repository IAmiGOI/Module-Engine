/**
 * Сдвиг показанной строки RP Time на N минут — чистый разбор без модели.
 * Понимает `HH:MM` (24 ч) и `hh:mm AM/PM` (12 ч) в любом месте строки,
 * сохраняет всё остальное и обновляет период в скобках
 * `(Morning|Afternoon|Evening|Night)`, если он есть. Переход через полночь
 * переносит только время суток: дата/счётчик дня не меняются — это честное
 * ограничение минимального контракта, записанное в DESIGN.md.
 */

const TIME_RE = /(^|[^\d])(\d{1,2}):(\d{2})(?:\s*(AM|PM))?/i;
const PERIOD_RE = /\((Morning|Afternoon|Evening|Night)\)/i;

export function periodForHour(hour) {
    if (hour < 5) return 'Night';
    if (hour < 12) return 'Morning';
    if (hour < 17) return 'Afternoon';
    if (hour < 21) return 'Evening';
    return 'Night';
}

/**
 * @param {string} label  текущая строка времени
 * @param {number} minutes  на сколько минут сдвинуть (может быть отрицательным)
 * @returns {string|null}  новая строка или null, если времени в строке нет
 */
export function shiftTimeLabel(label, minutes = 0) {
    const text = String(label ?? '');
    const match = TIME_RE.exec(text);
    if (!match) return null;
    const prefix = match[1] ?? '';
    const hour = Number(match[2]);
    const minute = Number(match[3]);
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour > 23 || minute > 59) return null;
    const meridiem = String(match[4] ?? '').toUpperCase();
    const is12h = Boolean(meridiem);
    if (is12h && (hour < 1 || hour > 12)) return null;

    let absoluteHour = is12h ? (hour % 12) + (meridiem === 'PM' ? 12 : 0) : hour;
    const dayMinutes = 24 * 60;
    const shifted = ((absoluteHour * 60 + minute + Number(minutes)) % dayMinutes + dayMinutes) % dayMinutes;
    absoluteHour = Math.floor(shifted / 60);
    const shiftedMinute = shifted % 60;

    let rendered;
    if (is12h) {
        const suffix = absoluteHour >= 12 ? 'PM' : 'AM';
        const twelve = absoluteHour % 12 === 0 ? 12 : absoluteHour % 12;
        rendered = `${String(twelve).padStart(2, '0')}:${String(shiftedMinute).padStart(2, '0')} ${suffix}`;
    } else {
        rendered = `${String(absoluteHour).padStart(2, '0')}:${String(shiftedMinute).padStart(2, '0')}`;
    }

    const start = match.index + prefix.length;
    const end = start + match[0].length - prefix.length;
    let next = `${text.slice(0, start)}${rendered}${text.slice(end)}`;
    if (PERIOD_RE.test(next)) next = next.replace(PERIOD_RE, `(${periodForHour(absoluteHour)})`);
    return next;
}
