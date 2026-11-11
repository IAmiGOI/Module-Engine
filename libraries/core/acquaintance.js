/**
 * Знакомство с пользователем: сколько персонаж знает его по часам игры, сколько из этого времени они провели вместе,
 * прошлое до истории и вехи между ними. Движок считает минуты сам, а модели отдаёт только человеческие слова: флэш не
 * переводит «290 минут» в «почти весь день». Пороги широкие, чтобы фраза не прыгала от хода к ходу. Чистые функции.
 *
 * Запись в банке персонажа — `withUser`:
 *   { met: минуты часов игры при первой общей сцене | null, together: минуты вместе,
 *     knownSince: прошлое до истории словами Директора, before: сколько вместе до истории,
 *     milestones: [{ at: минуты | null, when: словами, what }] }
 */
const text = value => String(value ?? '').trim();
const HOUR = 60;
const DAY = 24 * HOUR;

export function normalizeWithUser(value) {
    const source = value && typeof value === 'object' ? value : {};
    const minutes = item => (Number.isFinite(Number(item)) && item !== null && item !== '' ? Number(item) : null);
    return {
        met: minutes(source.met),
        together: Math.max(0, Number(source.together) || 0),
        knownSince: text(source.knownSince),
        before: text(source.before),
        milestones: (Array.isArray(source.milestones) ? source.milestones : [])
            .filter(item => item && typeof item === 'object' && text(item.what))
            .map(item => ({ at: minutes(item.at), when: text(item.when), what: text(item.what) })),
    };
}

/** Длительность словами — грубо, как сказал бы человек. */
export function humanSpan(minutes) {
    const value = Math.max(0, Number(minutes) || 0);
    if (value < 10) return 'a few minutes';
    if (value < 45) return 'less than an hour';
    if (value < 100) return 'about an hour';
    if (value < 4 * HOUR) return 'a couple of hours';
    if (value < 14 * HOUR) return 'a few hours';
    if (value < 1.6 * DAY) return 'about a day';
    if (value < 5 * DAY) return 'a few days';
    if (value < 11 * DAY) return 'about a week';
    if (value < 24 * DAY) return 'a couple of weeks';
    if (value < 50 * DAY) return 'about a month';
    if (value < 150 * DAY) return 'a few months';
    if (value < 270 * DAY) return 'about half a year';
    if (value < 540 * DAY) return 'about a year';
    return 'several years';
}

/** Стадия знакомства — про то, насколько они знают друг друга, а не про то, как друг к другу относятся. */
export function acquaintanceStage(minutes) {
    const value = Math.max(0, Number(minutes) || 0);
    if (value < 20) return 'they have only just met';
    if (value < 14 * HOUR) return 'the first hours of knowing each other';
    if (value < 4 * DAY) return 'the first days of knowing each other';
    if (value < 24 * DAY) return 'still new to each other';
    if (value < 120 * DAY) return 'getting used to each other';
    if (value < 700 * DAY) return 'well acquainted';
    return 'long acquainted';
}

/** Доля времени вместе — словами; без знакомства в истории доли нет. */
export function togetherShare(together, known) {
    if (!(known > 0)) return '';
    const ratio = Math.min(1, Math.max(0, Number(together) || 0) / known);
    if (ratio >= 0.8) return 'almost all of that time together';
    if (ratio >= 0.4) return 'much of that time together';
    if (ratio >= 0.1) return 'only part of that time together';
    return 'hardly any of it together';
}

function milestoneLine(item, now) {
    if (item.at !== null && Number.isFinite(now)) {
        const ago = now - item.at;
        return `${item.what} (${ago < 10 ? 'just now' : `${humanSpan(ago)} ago`})`;
    }
    return item.when ? `${item.what} (${item.when})` : item.what;
}

/** Строка одного персонажа: знакомство, вместе, стадия, вехи. */
export function withUserLine(name, record, { now = 0, user = 'the user' } = {}) {
    const data = normalizeWithUser(record);
    const parts = [];
    const known = data.met === null ? null : Math.max(0, now - data.met);
    if (data.knownSince) {
        const before = data.before ? ` (before the story: ${data.before})` : '';
        const inStory = known === null ? '' : `; in the story so far ${humanSpan(known)}, ${togetherShare(data.together, known)}`;
        parts.push(`has known ${user} ${data.knownSince}${before}${inStory}`);
    } else if (known === null) {
        parts.push(`is meeting ${user} for the first time now`);
    } else {
        parts.push(`has known ${user} for ${humanSpan(known)}, ${togetherShare(data.together, known)} — ${acquaintanceStage(known)}`);
    }
    const milestones = data.milestones.map(item => milestoneLine(item, now));
    return `- ${name}: ${parts.join('')}.${milestones.length ? ` Milestones: ${milestones.join('; ')}.` : ' No milestones between them yet.'}`;
}

export const WITH_USER_HEADER = 'THEM AND {{user}} — how long each one here has known {{user}}, by the clock of the story, and what has happened between them. What they feel for {{user}} fits how long and how they have known each other, unless a milestone explains more:';

/** Блок резолверу — только те, кто в сцене, без самого пользователя. */
export function renderWithUser(characters, { now = 0, user = 'the user' } = {}) {
    const lines = (Array.isArray(characters) ? characters : [])
        .filter(character => text(character?.name))
        .map(character => withUserLine(text(character.name), character.withUser, { now, user }));
    if (!lines.length) return '';
    return `${WITH_USER_HEADER.replaceAll('{{user}}', user)}\n${lines.join('\n')}`;
}
