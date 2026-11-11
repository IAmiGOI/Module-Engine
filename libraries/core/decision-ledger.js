/**
 * Ведомость (Ledger) — чистые правила, без модели и хранения.
 *
 * Движок собирает её сам из полей шаблона, а не модель: по каждому ходу и
 * персонажу — что хотел (по Указу и карте), какое было противоречие и чем
 * кончилось (из «после хода»). Читатель — Советник (фаза 3); видно в журнале
 * директора.
 */

const text = value => String(value ?? '').trim();
const keyOf = value => text(value).toLowerCase();

/** Сколько строк хранится: Ведомость растёт, но старые нужны и Советнику, и разбору. */
export const LEDGER_LIMIT = 400;

export const CONFLICT_SCALE = Object.freeze(['none', 'minor', 'strong']);

/** Одна строка Ведомости на персонажа за ход. */
export function buildLedgerRows({ turn = null, at = 0, form = null, outcome = [], writerText = '', wantedOf = () => '' } = {}) {
    const characters = Array.isArray(form?.characters) ? form.characters : [];
    const results = new Map((Array.isArray(outcome) ? outcome : []).map(item => [keyOf(item?.character), text(item?.result)]));
    const rows = [];
    for (const character of characters) {
        const name = text(character?.name);
        if (!name) continue;
        // Idle-персонаж ничего не хотел в этом ходу: в Ведомость он не попадает.
        if (character?.idle === true) continue;
        const conflict = character?.conflict && typeof character.conflict === 'object'
            ? { level: CONFLICT_SCALE.includes(text(character.conflict.level)) ? text(character.conflict.level) : 'none', why: text(character.conflict.why) }
            : { level: 'none', why: '' };
        rows.push({
            turn: Number.isFinite(Number(turn)) ? Number(turn) : null,
            at: Number(at) || 0,
            character: name,
            // «Хотел» — по Указу (строка «Today:»), его берёт движок, а не резолвер: иначе «хотел» всегда равнялось «сделал».
            wanted: text(wantedOf(name)) || text(character.decreeWants),
            did: text(character.does),
            conflict,
            result: results.get(keyOf(name)) ?? '',
            // Ответ писателя — то, по чему пишется исход: храним начало, чтобы строка не росла в бесконечность.
            page: text(writerText).slice(0, 300),
        });
    }
    return rows;
}

/** Строки → журнал: дописываем в конец и держим последние `limit`. */
export function appendLedger(ledger, rows, { limit = LEDGER_LIMIT } = {}) {
    const list = Array.isArray(ledger) ? ledger : [];
    const next = [...list, ...(Array.isArray(rows) ? rows : [])];
    return next.length > limit ? next.slice(next.length - limit) : next;
}

/** Мусор из хранилища — безопасная форма. */
export function normalizeLedger(value) {
    return (Array.isArray(value) ? value : [])
        .filter(row => row && typeof row === 'object' && text(row.character))
        .map(row => ({
            turn: Number.isFinite(Number(row.turn)) ? Number(row.turn) : null,
            at: Number(row.at) || 0,
            character: text(row.character),
            wanted: text(row.wanted),
            did: text(row.did),
            conflict: row.conflict && typeof row.conflict === 'object'
                ? { level: CONFLICT_SCALE.includes(text(row.conflict.level)) ? text(row.conflict.level) : 'none', why: text(row.conflict.why) }
                : { level: 'none', why: '' },
            result: text(row.result),
            page: text(row.page),
            // Когда Советник разобрал строку: 0 — ещё не читал.
            reviewedAt: Number(row.reviewedAt) || 0,
        }));
}

/** Строки для журнала директора: по одной на персонажа, последние сверху не нужны — порядок ходов. */
export function ledgerLines(rows) {
    return (Array.isArray(rows) ? rows : []).map(row => {
        const head = `T${row.turn ?? '?'} ${row.character}`;
        const level = row?.conflict?.level;
        const conflict = !level || level === 'none' ? '' : ` [${level}${row.conflict.why ? `: ${row.conflict.why}` : ''}]`;
        const result = row.result ? ` → ${row.result}` : '';
        return `- ${head}: ${row.wanted || row.did || '(nothing)'}${conflict}${result}`;
    });
}

export function renderLedger(rows, { limit = 60 } = {}) {
    const list = (Array.isArray(rows) ? rows : []).slice(-Math.max(1, Number(limit) || 60));
    if (!list.length) return '';
    return `LEDGER (what each character wanted, what stood against it, and how it ended):\n\n${ledgerLines(list).join('\n')}`;
}

/** Telegram — только из закрытого списка поводов. */
export function isClosedTelegram(value) {
    const clean = text(value).toLowerCase();
    if (!clean) return false;
    return ['death', 'died', 'dead', 'killed', 'irreversible', 'lost for good', 'betray', 'reveal', 'attack', 'leaves the story', 'gone for good', 'умер', 'смерть', 'предал', 'раскрыл'].some(word => clean.includes(word));
}
