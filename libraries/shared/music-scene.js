import { matchPlaces } from './places-match.js';

/**
 * Чистая часть «сцена → что спрашивать у музыкального сервера»: какие реплики идут в сцену, как смешиваются векторы реплик, как считаются слова мест и время суток. ОДИН код на ME и на
 * сервер (файл на сервере — байт-в-байт копия, это проверяет тест): симулятор владельца прогоняет чат тем же кодом, каким ME играет. Здесь нет ни шины, ни DOM, ни сети.
 */

/** Реплики сцены: последние `limit` не системных, непустые — по одной (свежие в конце). */
export function sceneMessages(messages, limit) {
    return (Array.isArray(messages) ? messages : [])
        .filter(message => !message?.isSystem)
        .slice(-Math.max(1, limit))
        .map(message => String(message?.text ?? ''))
        .filter(Boolean);
}

/** Имена участников сцены (героев и персоны пользователя) — их вычёркивают из текста перед эмбедингом: вектор несёт настроение, а не «Echidna». */
export function sceneNames(messages) {
    return [...new Set((Array.isArray(messages) ? messages : []).filter(message => !message?.isSystem).map(message => String(message?.name ?? '').trim()).filter(Boolean))];
}

/** Текст сцены: последние реплики (системные — мусор для атмосферы, выкидываем). */
export function buildSceneText(messages, limit) {
    return sceneMessages(messages, limit).join('\n').trim();
}

/**
 * Вектор сцены из векторов реплик: свежая реплика весит вдвое больше предыдущей (2^позиция), результат нормирован. Так длинное старое
 * сообщение с «военными» словами не перевешивает короткую свежую реплику и не тянет музыку не туда.
 */
export function blendSceneVectors(vectors) {
    const usable = vectors.map((vector, index) => ({ vector, weight: 2 ** index })).filter(item => Array.isArray(item.vector) && item.vector.length);
    if (!usable.length) return null;
    const dim = usable[0].vector.length;
    const sum = Array(dim).fill(0);
    for (const { vector, weight } of usable) if (vector.length === dim) vector.forEach((x, i) => { sum[i] += x * weight; });
    const norm = Math.sqrt(sum.reduce((total, x) => total + x * x, 0));
    return norm > 0 ? sum.map(x => x / norm) : null;
}

/** Вес реплик при счёте слов: самая свежая 3, прошлая 2, ещё прошлая 1. */
export const WORD_WEIGHTS = Object.freeze([3, 2, 1]);

/** Взвешенный счёт слов реестра (`index` из `buildIndex`) по очищенным репликам сцены: `{ id: счёт }`. */
export function weightedCounts(parts, index) {
    const counts = {};
    if (!index) return counts;
    const recent = parts.slice(-WORD_WEIGHTS.length);
    recent.forEach((part, offset) => {
        const weight = WORD_WEIGHTS[recent.length - 1 - offset];
        for (const [id, n] of Object.entries(matchPlaces(part, index))) counts[id] = (counts[id] ?? 0) + weight * n;
    });
    return counts;
}

/** Слот времени по словам: с наибольшим счётом; прежний слот держится, пока другой не набрал СТРОГО больше; слов нет — прежний. */
export function guessTimeSlotFrom(counts, last) {
    const entries = Object.entries(counts).filter(([, n]) => n > 0);
    if (!entries.length) return last;
    const top = entries.reduce((best, item) => (item[1] > best[1] ? item : best));
    if (last === null || last === undefined) return Number(top[0]);
    return top[1] > (counts[String(last)] ?? 0) ? Number(top[0]) : last;
}

/** Слот (0..7) по часу 0..23; иначе `null`. */
export const slotOfHour = hour => (Number.isInteger(hour) && hour >= 0 && hour <= 23 ? Math.floor(hour / 3) : null);

/** Час 0..23 из значения поля времени («14:30», «7.05», «19h00», «7:30 pm», «7 PM», «09:22 AM»); неразборчивое — `null`. */
export function parseClockHour(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const text = String(value);
    const clock = /(\d{1,2})\s*[:.h]\s*(\d{2})/.exec(text);
    const bare = clock ? null : /(\d{1,2})\s*([ap])\.?m\b/i.exec(text);
    const match = clock ?? bare;
    if (!match) return null;
    let hour = Number(match[1]);
    const marker = bare ? bare[2] : (/^\s*([ap])\.?m\b/i.exec(text.slice(match.index + match[0].length)) ?? [])[1];
    if (marker) {
        if (hour < 1 || hour > 12) return null;
        hour = (hour % 12) + (marker.toLowerCase() === 'p' ? 12 : 0);
    }
    return hour >= 0 && hour <= 23 ? hour : null;
}

const PERIOD_SLOTS = { morning: 2, afternoon: 4, evening: 6, night: 7 };

/** Слот по полю «период» RP Time (Morning/Afternoon/Evening/Night, без учёта регистра); иначе `null`. */
export const slotOfPeriod = value => (typeof value === 'string' ? PERIOD_SLOTS[value.trim().toLowerCase()] ?? null : null);

/** Слот времени из значений полей RP Time `{ time, period }`: сначала часы, потом период; иначе `null`. */
export const slotOfRpTime = fields => slotOfHour(parseClockHour(fields?.time)) ?? slotOfPeriod(fields?.period) ?? null;
