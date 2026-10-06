/**
 * Игровое время из RP Time (`modules/time`) — чистые функции. Модуль отдаёт снимок полей (`{ year, month, day, time, period }`
 * в зависимости от пресета: «full-date», «day-counter», «natural-date-12h», «clock-only»), а не число, поэтому сам по себе снимок
 * нельзя ни сравнить, ни отсортировать. Здесь он превращается в сравнимый ключ и в короткую подпись.
 */

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

const toInt = value => {
    const match = String(value ?? '').match(/-?\d+/);
    return match ? Number(match[0]) : null;
};

function monthNumber(value) {
    const number = toInt(value);
    if (number !== null) return number;
    const word = String(value ?? '').trim().toLowerCase();
    const index = MONTHS.findIndex(name => word && (name === word || name.slice(0, 3) === word.slice(0, 3)));
    return index >= 0 ? index + 1 : null;
}

/** Минуты от полуночи из «HH:MM» или «hh:MM AM/PM»; `null`, если время не разобрать. */
function minutesOf(value) {
    const match = String(value ?? '').match(/(\d{1,2})\s*[:.]\s*(\d{2})\s*([AaPp][Mm])?/);
    if (!match) return null;
    let hours = Number(match[1]);
    const minutes = Number(match[2]);
    const suffix = match[3]?.toLowerCase();
    if (suffix === 'pm' && hours < 12) hours += 12;
    if (suffix === 'am' && hours === 12) hours = 0;
    return hours * 60 + minutes;
}

/**
 * Сравнимое число из игрового времени: больше — позже. Число проходит как есть; снимок полей разбирается по полям года, месяца
 * (номер или английское название), дня и времени; неразобранные поля считаются нулём, но хотя бы одно должно разобраться.
 * Не разобралось ничего — `null` (тогда вызывающий падает на порядок создания).
 */
export function gameTimeKey(snapshot) {
    if (Number.isFinite(snapshot)) return snapshot;
    if (!snapshot || typeof snapshot !== 'object') return null;
    const year = toInt(snapshot.year);
    const month = monthNumber(snapshot.month);
    const day = toInt(snapshot.day);
    const minutes = minutesOf(snapshot.time);
    if (year === null && month === null && day === null && minutes === null) return null;
    return (((year ?? 0) * 13 + (month ?? 0)) * 32 + (day ?? 0)) * 1440 + (minutes ?? 0);
}

/** Короткая подпись для промпта: значения полей по порядку, «2026 March 5 09:20 AM (Morning)»; `null`, если подписывать нечем. */
export function gameTimeLabel(snapshot) {
    if (typeof snapshot === 'string') return snapshot.trim() || null;
    if (Number.isFinite(snapshot)) return String(snapshot);
    if (!snapshot || typeof snapshot !== 'object') return null;
    const get = name => String(snapshot[name] ?? '').trim();
    const main = ['year', 'month', 'day', 'time'].map(get).filter(Boolean).join(' ');
    const period = get('period');
    const label = [main, period ? `(${period})` : ''].filter(Boolean).join(' ');
    return label || null;
}
