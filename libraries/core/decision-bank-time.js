/**
 * Время на строках Great Bank — чистые правила, без модели и без хранения.
 *
 * Модель пишет факт и, если нужно, срок словами («an hour», «until dawn»,
 * «tomorrow»). Движок сам ставит строке метку RP-времени хода
 * `[2026-03-07 04:15]` и переводит срок в абсолютную метку
 * `[until 2026-03-07 06:00]`.
 *
 * Момент — одно целое, чтобы сроки сравнивались. Строка RP Time с датой
 * (`2026-03-07 …`, `Year 3, Month 2, Day 7, …`) даёт настоящую дату, и метка
 * печатается в той же форме `[2026-03-07 04:15]`. Строка без даты опирается
 * на счётчик RP-минут движка, и метка честно печатается счётчиком:
 * `[Day 7, 04:15]`.
 */

const DAY = 1440;

/** Времена суток — умолчание настройки: dawn 06:00, morning 08:00 и т. д. */
export const TIME_OF_DAY = Object.freeze({
    dawn: '06:00', morning: '08:00', noon: '12:00', afternoon: '13:00',
    evening: '18:00', night: '22:00', midnight: '00:00',
});

const MONTHS = Object.freeze({
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
    jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
});

const NUMBERS = Object.freeze({
    a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20,
});

const TIME_RE = /(\d{1,2}):(\d{2})(?:\s*(AM|PM))?/i;
const UNTIL_RE = /\[until\s+([^\]]+)\]/i;
const STAMP_RE = /^\s*\[([^\]]+)\]\s*/;

/** Настоящая дата живёт выше этой границы; счётчик RP-минут — ниже неё. */
const DATE_BASE = 999_999_999_360; // кратно суткам: base % DAY === 0

const pad = value => String(value).padStart(2, '0');

/** Дата → номер суток: год, месяц и день укладываются в разряды без переносов. */
function dayIndex(year, month, day) {
    return (year * 1000 + month * 40 + day);
}

function fromDayIndex(value) {
    const year = Math.floor(value / 1000);
    const rest = value - year * 1000;
    const month = Math.floor(rest / 40);
    return { year, month, day: rest - month * 40 };
}

function monthNumber(value) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 1 && numeric <= 12) return numeric;
    return MONTHS[String(value ?? '').toLowerCase()] ?? null;
}

function minutesIn(source) {
    const match = TIME_RE.exec(source);
    if (!match) return null;
    let hour = Number(match[1]);
    const minute = Number(match[2]);
    const meridiem = String(match[3] ?? '').toUpperCase();
    if (meridiem) hour = (hour % 12) + (meridiem === 'PM' ? 12 : 0);
    if (!Number.isFinite(hour) || hour > 23 || !Number.isFinite(minute) || minute > 59) return null;
    return hour * 60 + minute;
}

/** Дата в строке RP Time; нет даты — null (тогда моментом служит счётчик минут). */
function dateIn(source) {
    const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(source);
    if (iso) return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
    const full = /year\s*(\d+)[^a-z0-9]*month\s*([a-z]+|\d+)[^a-z0-9]*day\s*(\d+)/i.exec(source);
    if (full) {
        const month = monthNumber(full[2]);
        if (month) return { year: Number(full[1]), month, day: Number(full[3]) };
    }
    const natural = /(\d{4})\s+([A-Za-z]{3,})\s+(\d{1,2})\b/.exec(source);
    if (natural) {
        const month = monthNumber(natural[2]);
        if (month) return { year: Number(natural[1]), month, day: Number(natural[3]) };
    }
    return null;
}

/** Строка RP Time → { value, hasDate }. Без времени и без даты моменту взяться неоткуда. */
export function parseRpTime(label) {
    const source = String(label ?? '');
    const minutes = minutesIn(source);
    const date = dateIn(source);
    if (date) return { value: DATE_BASE + dayIndex(date.year, date.month, date.day) * DAY + (minutes ?? 0), hasDate: true, minutes: minutes ?? 0 };
    if (minutes === null) return null;
    return { value: minutes, hasDate: false, minutes };
}

/** Момент строки: из даты в строке RP Time, а без даты — из счётчика RP-минут движка. */
export function rpInstant(label, clockMinutes = 0) {
    const parsed = parseRpTime(label);
    if (parsed?.hasDate) return parsed.value;
    return Math.max(0, Number(clockMinutes) || 0);
}

/** Момент → текст метки: настоящая дата или счётчик дней. */
export function formatInstant(value) {
    const total = Math.round(Number(value) || 0);
    if (total >= DATE_BASE) {
        const rest = total - DATE_BASE;
        const days = Math.floor(rest / DAY);
        const minutes = rest - days * DAY;
        const date = fromDayIndex(days);
        const time = `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
        // Форма метки одна, как в замысле владельца: [2026-03-07 04:15].
        return `${String(date.year).padStart(4, '0')}-${pad(date.month)}-${pad(date.day)} ${time}`;
    }
    const days = Math.floor(total / DAY);
    const minutes = total - days * DAY;
    return `Day ${days}, ${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** Текст метки → момент; мусор — null. */
export function parseInstant(text) {
    const source = String(text ?? '').trim();
    const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/.exec(source);
    if (iso) return DATE_BASE + dayIndex(Number(iso[1]), Number(iso[2]), Number(iso[3])) * DAY + Number(iso[4]) * 60 + Number(iso[5]);
    const year = /^year\s*(\d+)\s*,?\s*month\s*(\d+)\s*,?\s*day\s*(\d+)\s*,?\s*(\d{1,2}):(\d{2})/i.exec(source);
    if (year) return DATE_BASE + dayIndex(Number(year[1]), Number(year[2]), Number(year[3])) * DAY + Number(year[4]) * 60 + Number(year[5]);
    const counter = /^day\s*#?\s*(\d+)\s*,?\s*(\d{1,2}):(\d{2})/i.exec(source);
    if (counter) return Number(counter[1]) * DAY + Number(counter[2]) * 60 + Number(counter[3]);
    const at = /^(\d{1,2}):(\d{2})/.exec(source);
    if (at) return Number(at[1]) * 60 + Number(at[2]);
    return null;
}

function stripClockWords(source) {
    return String(source ?? '')
        .toLowerCase()
        .replace(/^\s*(?:until|till|by|for|in|at|to|the|next)\s+/, '')
        .replace(/\b(a few|several|couple of|couple)\b/g, match => (/couple/.test(match) ? '2' : '3'))
        .replace(/^\s*(?:the|next)\s+/, '')
        .trim();
}

function numberOf(value) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    return NUMBERS[String(value ?? '').toLowerCase()] ?? null;
}

function unitMinutes(value) {
    const unit = String(value ?? '').toLowerCase();
    if (unit.startsWith('minute')) return 1;
    if (unit.startsWith('hour')) return 60;
    if (unit.startsWith('day')) return DAY;
    if (unit.startsWith('week')) return 7 * DAY;
    return null;
}

/** «an hour», «two days», «dawn», «tomorrow» → момент; не разобрано — null. */
export function deadlineFrom(nowValue, words, timeOfDay = TIME_OF_DAY) {
    const clean = stripClockWords(words);
    if (!clean) return null;
    const now = Number(nowValue) || 0;
    const duration = /^([a-z]+|\d+)\s*(minutes?|hours?|days?|weeks?)\b/.exec(clean);
    if (duration) {
        const amount = numberOf(duration[1]);
        const unit = unitMinutes(duration[2]);
        if (amount && unit) return Math.round(now + amount * unit);
    }
    const start = Math.floor(now / DAY) * DAY;
    if (/\btomorrow\b|\bnext day\b/.test(clean)) return start + DAY;
    for (const [word, at] of Object.entries(timeOfDay ?? TIME_OF_DAY)) {
        if (!new RegExp(`\\b${word}\\b`).test(clean)) continue;
        const minutes = clockMinutes(at);
        if (minutes === null) continue;
        const target = start + minutes;
        return target > now ? target : target + DAY;
    }
    return null;
}

/** `"06:00"` → минуты суток; строку настроек разбирает движок, а не модель. */
function clockMinutes(value) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return null;
    return hour * 60 + minute;
}

/** Тело строки без меток: по нему ищется `old` и считается «прошлое». */
export function lineBody(line) {
    return String(line ?? '')
        .replace(UNTIL_RE, ' ')
        .replace(STAMP_RE, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Строка с меткой хода и, если срок разобран, со сроком. */
export function stampLine(text, at, until = '') {
    const body = lineBody(text);
    if (!body) return '';
    return until ? `[${at}] ${body} [until ${until}]` : `[${at}] ${body}`;
}

/** Срок строки как момент; без срока — null. */
export function lineDeadline(line) {
    const match = UNTIL_RE.exec(String(line ?? ''));
    return match ? parseInstant(match[1]) : null;
}

/** Строка истекла к моменту `nowValue`. */
export function lineIsPast(line, nowValue) {
    const deadline = lineDeadline(line);
    return deadline !== null && deadline < Number(nowValue);
}
