/**
 * Советник (Counsellor) — чистые правила, без модели и хранения.
 *
 * Читает Ведомость резолвера, отсекает лишнее и решает, когда Указа больше не
 * хватает: Petition директору, Prayer Богу. Здесь же очереди, короткая
 * переписка с пользователем и расписание пробуждений (каждые N ходов и конец
 * RP-дня).
 */

const text = value => String(value ?? '').trim();
const keyOf = value => text(value).toLowerCase();

export const COUNSELLOR_QUEUE_LIMIT = 200;
export const COUNSELLOR_CHAT_LIMIT = 12;
export const PROMOTE_LEVELS = Object.freeze(['main', 'side', 'temporary', 'mass']);
export const PETITION_STATUS = Object.freeze(['queued', 'delivered', 'read']);
export const QUEUE_STATUS = Object.freeze(['queued', 'delivered', 'read']);

const IMPORTANCE_WORDS = Object.freeze({
    'main cast': 'main', main: 'main',
    'side character': 'side', side: 'side',
    'temporary character': 'temporary', temporary: 'temporary',
    'npc/mass': 'mass', npc: 'mass', mass: 'mass',
});

/** RP-день монотонных минут: полночь — граница. */
export function dayOf(minutes) {
    return Math.floor(Math.max(0, Number(minutes) || 0) / 1440);
}

/** Переход через полночь: сохранённый день был, новый больше. */
export function dayChanged(previous, next) {
    if (previous === null || previous === undefined || previous === '') return false;
    if (next === null || next === undefined || next === '') return false;
    const before = Number(previous);
    const after = Number(next);
    if (!Number.isFinite(before) || !Number.isFinite(after)) return false;
    return after > before;
}

/**
 * Пора будить Советника: конец дня важнее счётчика ходов. `turn` и `lastTurn`
 * — номера ходов; `everyTurns` — настройка (1…50).
 */
export function shouldReview({ turn = 0, lastTurn = 0, everyTurns = 3, dayEnded = false } = {}) {
    if (dayEnded) return 'day';
    const every = Math.max(1, Math.round(Number(everyTurns) || 3));
    return Number(turn) - Number(lastTurn) >= every ? 'review' : null;
}

/** Строки Ведомости, которых Советник ещё не видел. */
export function unreviewedRows(ledger) {
    return (Array.isArray(ledger) ? ledger : []).filter(row => row && typeof row === 'object' && !Number(row.reviewedAt));
}

/** Пометить разобранные строки: дальше они в контекст не попадают. */
export function markReviewed(ledger, { at = 0 } = {}) {
    let count = 0;
    const next = (Array.isArray(ledger) ? ledger : []).map(row => {
        if (!row || typeof row !== 'object' || Number(row.reviewedAt)) return row;
        count += 1;
        return { ...row, reviewedAt: Number(at) || 0 };
    });
    return { ledger: next, count };
}

/**
 * Сильное противоречие два хода подряд — всегда повод. Возвращает имена:
 * строка была strong и в прошлой строке того же персонажа.
 */
export function strongStreaks(ledger) {
    const last = new Map();
    const names = new Set();
    for (const row of Array.isArray(ledger) ? ledger : []) {
        const name = text(row?.character);
        if (!name) continue;
        const key = keyOf(name);
        const strong = text(row?.conflict?.level) === 'strong';
        const previous = last.get(key);
        if (strong && previous?.strong) names.add(previous.name);
        last.set(key, { name, strong, turn: Number(row?.turn) || null });
    }
    return [...names];
}

/** Уровень в словах или коде → код; неизвестное — null. */
export function normalizeImportanceWord(value) {
    const clean = text(value).toLowerCase();
    return IMPORTANCE_WORDS[clean] ?? null;
}

/** `promote` — новый уровень с причиной; строка без причины не принимается. */
export function normalizePromotion(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const level = normalizeImportanceWord(value.level);
    const reason = text(value.reason);
    if (!level || !reason) return null;
    return { level, reason };
}

/** Одна Petition: суть проблемы и слабо сжатый отрывок Ведомости. */
export function makePetition({ character, problem, excerpt, promote = null, turn = null, at = 0, day = false, status = 'queued' } = {}) {
    const name = text(character);
    const body = text(problem);
    if (!name || !body) return null;
    return {
        id: `pet_${Number(at) || 0}_${Math.random().toString(36).slice(2, 8)}`,
        at: Number(at) || 0,
        turn: Number.isFinite(Number(turn)) ? Number(turn) : null,
        character: name,
        problem: body,
        excerpt: text(excerpt),
        promote: normalizePromotion(promote),
        day: Boolean(day),
        prepareNewDay: Boolean(day),
        status: PETITION_STATUS.includes(text(status)) ? text(status) : 'queued',
        to: 'director',
    };
}

export function normalizePetitions(value) {
    return (Array.isArray(value) ? value : [])
        .filter(item => item && typeof item === 'object' && text(item.character) && text(item.problem))
        .map(item => ({
            id: text(item.id) || `pet_${Number(item.at) || 0}`,
            at: Number(item.at) || 0,
            turn: Number.isFinite(Number(item.turn)) ? Number(item.turn) : null,
            character: text(item.character),
            problem: text(item.problem),
            excerpt: text(item.excerpt),
            promote: normalizePromotion(item.promote),
            day: Boolean(item.day),
            prepareNewDay: Boolean(item.prepareNewDay ?? item.day),
            status: PETITION_STATUS.includes(text(item.status)) ? text(item.status) : 'queued',
            to: 'director',
        }));
}

/** Очередь только дописывается; старые записи выпадают первыми. */
export function appendPetitions(entries, list, { limit = COUNSELLOR_QUEUE_LIMIT } = {}) {
    const base = normalizePetitions(entries);
    const added = (Array.isArray(list) ? list : []).map(item => normalizePetitions([item])[0]).filter(Boolean);
    const next = [...base, ...added];
    return next.length > limit ? next.slice(next.length - limit) : next;
}

/** Молитва идёт в очередь Богу (`prayer` резолвера — та же очередь). */
export function normalizePrayers(value) {
    return (Array.isArray(value) ? value : [])
        .filter(item => item && typeof item === 'object' && text(item.text))
        .map(item => ({
            id: text(item.id) || `prayer_${Number(item.at) || 0}`,
            at: Number(item.at) || 0,
            turn: Number.isFinite(Number(item.turn)) ? Number(item.turn) : null,
            text: text(item.text),
            source: text(item.source) || 'resolver',
            status: QUEUE_STATUS.includes(text(item.status)) ? text(item.status) : 'queued',
        }));
}

export function appendPrayers(entries, list, { limit = COUNSELLOR_QUEUE_LIMIT } = {}) {
    const base = normalizePrayers(entries);
    const added = (Array.isArray(list) ? list : []).map(item => normalizePrayers([item])[0]).filter(Boolean);
    const next = [...base, ...added];
    return next.length > limit ? next.slice(next.length - limit) : next;
}

/**
 * В конце дня Petition обязателен по каждому персонажу с Указом. Движок сам
 * дописывает недостающие — день не пропускается молча.
 * @returns {{ petitions: object[], added: string[] }}
 */
export function ensureDayPetitions({ entries = [], characters = [], rows = [], turn = null, at = 0, petitioned = [] } = {}) {
    const queued = normalizePetitions(entries);
    const done = new Set((Array.isArray(petitioned) ? petitioned : []).map(keyOf));
    // Уже лежащая дневная Petition этого же хода — не дубль: модель её написала.
    for (const item of queued) {
        if (item.day && item.turn !== null && item.turn === Number(turn)) done.add(keyOf(item.character));
    }
    const added = [];
    for (const name of Array.isArray(characters) ? characters : []) {
        const clean = text(name);
        if (!clean || done.has(keyOf(clean))) continue;
        const own = (Array.isArray(rows) ? rows : []).filter(row => keyOf(row?.character) === keyOf(clean));
        const excerpt = own.map(row => {
            const head = `T${row.turn ?? '?'} ${clean}: ${text(row.wanted) || text(row.did) || '(nothing)'}`;
            const conflict = row?.conflict?.level && row.conflict.level !== 'none'
                ? ` [${row.conflict.level}${row.conflict.why ? `: ${row.conflict.why}` : ''}]` : '';
            const result = text(row?.result) ? ` → ${text(row.result)}` : '';
            return `- ${head}${conflict}${result}`;
        }).join('\n');
        const petition = makePetition({
            character: clean,
            problem: own.length
                ? 'The day is over and the Decree has not been renewed for this character: take what the day left them with and prepare the next one.'
                : 'The day is over. No Ledger rows came for this character; the Decree still needs a new day.',
            excerpt: excerpt || `(no Ledger rows for ${clean} this day)`,
            turn, at, day: true,
        });
        if (petition) added.push(petition);
    }
    return { petitions: appendPetitions(entries, added), added };
}

/** Имена персонажей, у которых заполнен хотя бы один из пяти полей Указа. */
export function decreeNames(state) {
    return Object.values(state && typeof state === 'object' && !Array.isArray(state) ? state : {})
        .filter(character => character && typeof character === 'object' && [1, 2, 3, 4, 5]
            .some(no => (Array.isArray(character.decree?.[no]) ? character.decree[no] : []).some(line => text(line))))
        .map(character => text(character.name))
        .filter(Boolean);
}

/** Очереди простыми строками — для контекста и для журнала. */
export function renderQueues({ petitions = [], prayers = [] } = {}) {
    const petitionLines = normalizePetitions(petitions).map(item => {
        const promote = item.promote ? ` [promote → ${item.promote.level}: ${item.promote.reason}]` : '';
        const day = item.prepareNewDay ? ' [prepare the new day]' : '';
        return `- ${item.character} (${item.status}): ${item.problem}${promote}${day}`;
    });
    const prayerLines = normalizePrayers(prayers).map(item => `- (${item.status}) ${item.text}`);
    return [
        `PETITIONS (to the Director):\n${petitionLines.length ? petitionLines.join('\n') : '- none'}`,
        `PRAYERS (to God):\n${prayerLines.length ? prayerLines.join('\n') : '- none'}`,
    ].join('\n\n');
}

/** Короткая переписка с пользователем — только она, без истории чата. */
export function appendConversation(messages, entry, { limit = COUNSELLOR_CHAT_LIMIT } = {}) {
    const body = text(entry?.text);
    if (!body) return normalizeConversation(messages);
    const next = [...normalizeConversation(messages), {
        role: entry?.role === 'counsellor' ? 'counsellor' : 'user',
        text: body,
        at: Number(entry?.at) || 0,
    }];
    return next.length > limit ? next.slice(next.length - limit) : next;
}

export function normalizeConversation(value) {
    return (Array.isArray(value) ? value : [])
        .filter(item => item && typeof item === 'object' && text(item.text))
        .map(item => ({ role: item.role === 'counsellor' ? 'counsellor' : 'user', text: text(item.text), at: Number(item.at) || 0 }));
}

export function renderConversation(messages) {
    const lines = normalizeConversation(messages).map(item => `${item.role === 'counsellor' ? 'Counsellor' : 'User'}: ${item.text}`);
    return lines.length ? lines.join('\n') : '(nothing said yet)';
}

/** Сводка очередей для заголовка записи журнала. */
export function queueSummary({ petitions = [], prayers = [] } = {}) {
    const p = normalizePetitions(petitions).filter(item => item.status === 'queued');
    const r = normalizePrayers(prayers).filter(item => item.status === 'queued');
    return {
        petitions: p.map(item => ({ character: item.character, status: item.status, day: item.prepareNewDay })),
        prayers: r.map(item => ({ text: item.text.slice(0, 120), status: item.status })),
    };
}
