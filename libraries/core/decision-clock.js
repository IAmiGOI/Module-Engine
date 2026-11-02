/**
 * Монотонные RP-минуты для планов персонажей. Сам по себе RP Time хранит
 * строку; планам нужен сравниваемый счётчик. Разбираем из строки день и
 * время, дальше двигаем только числом — модель для этого не нужна.
 *
 * Ограничение честное: если в строке нет ни дня, ни времени, опорной точки
 * нет и часы начинаются с нуля. Месяц/год не разбираются — для «3–12 часов»
 * и «несколько дней» это не нужно.
 */

export function parseClock(label) {
    const text = String(label ?? '');
    const dayMatch = /(?:day|день)\s*#?\s*(\d+)/i.exec(text);
    const timeMatch = /(\d{1,2}):(\d{2})(?:\s*(AM|PM))?/i.exec(text);
    if (!timeMatch) return null;
    let hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2]);
    const meridiem = String(timeMatch[3] ?? '').toUpperCase();
    if (meridiem) hour = (hour % 12) + (meridiem === 'PM' ? 12 : 0);
    if (!Number.isFinite(hour) || hour > 23 || !Number.isFinite(minute) || minute > 59) return null;
    const day = dayMatch ? Number(dayMatch[1]) : 0;
    return { minutes: day * 1440 + hour * 60 + minute, day, hour, minute };
}

export function advanceClock(clock, minutes, { now = () => Date.now() } = {}) {
    const base = Number.isFinite(clock?.minutes) ? Number(clock.minutes) : 0;
    return { minutes: base + (Number(minutes) || 0), updatedAt: now() };
}

export function clockFromLabel(label, { now = () => Date.now() } = {}) {
    const parsed = parseClock(label);
    return parsed ? { minutes: parsed.minutes, updatedAt: now() } : null;
}

export function formatDuration(minutes) {
    const value = Math.max(0, Math.round(Number(minutes) || 0));
    if (value < 60) return `${value} min`;
    const hours = Math.floor(value / 60);
    const rest = value % 60;
    if (hours < 24) return `${hours} h${rest ? ` ${rest} min` : ''}`;
    return `${Math.floor(hours / 24)} d${hours % 24 ? ` ${hours % 24} h` : ''}`;
}
