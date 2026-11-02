/**
 * Ход директора и его представления. Ход — все циклы от цикла с событием
 * начала хода до следующего такого цикла. Здесь только чистые функции:
 * группировка лога, полный текст хода и сжатая часть префикса.
 */

export const TURN_EVENTS = Object.freeze(['turn', 'regenerate', 'swipe']);
export const FULL_TURNS = 2;

const text = value => String(value ?? '').trim();

export function isTurnStart(cycle) {
    return TURN_EVENTS.includes(String(cycle?.event ?? ''));
}

/** Лог → ходы. Первый цикл до любого события начала хода тоже образует ход. */
export function groupTurns(cycles) {
    const turns = [];
    let current = null;
    for (const cycle of Array.isArray(cycles) ? cycles : []) {
        if (!current || isTurnStart(cycle)) {
            current = { cycles: [], event: text(cycle?.event), at: cycle?.at ?? null };
            turns.push(current);
        }
        current.cycles.push(cycle);
    }
    return turns;
}

/** Два последних хода — окно, внутри которого циклы остаются полными. */
export function fullTurns(cycles, keep = FULL_TURNS) {
    return groupTurns(cycles).slice(-Math.max(1, Number(keep) || FULL_TURNS));
}

function cycleNumber(cycles) {
    const found = (Array.isArray(cycles) ? cycles : []).find(cycle => Number.isFinite(Number(cycle?.turn)));
    return found ? Number(found.turn) : null;
}

function header(turn, mark) {
    const cycles = turn?.cycles ?? [];
    const number = cycleNumber(cycles);
    const clock = cycles.find(cycle => Number.isFinite(Number(cycle?.clockMinutes)))?.clockMinutes;
    const place = cycles.map(cycle => text(cycle?.form?.meta?.place ?? cycle?.form?.scene?.place)).find(Boolean);
    const parts = [`TURN ${number ?? '?'}${mark ? ` (${mark})` : ''}`];
    if (Number.isFinite(Number(clock))) parts.push(`RP time: ${Number(clock)} min`);
    if (place) parts.push(`place: ${place}`);
    return parts.join(' — ');
}

function callLines(call) {
    const name = text(call?.name);
    if (!name || name.startsWith('__')) return [];
    const lines = [`call ${name}: ${text(call?.comment) || '(no comment)'}`];
    lines.push(`args: ${JSON.stringify(call?.args ?? {})}`);
    if (call?.error) lines.push(`error: ${text(call.error)}`);
    else if (call?.result !== null && call?.result !== undefined) lines.push(`result: ${JSON.stringify(call.result)}`);
    return lines;
}

/** Полный ход: все циклы, thinking, вызовы, результаты, формы, Push, предупреждения. */
export function renderTurn(turn, mark = 'full') {
    const cycles = Array.isArray(turn?.cycles) ? turn.cycles : [];
    if (!cycles.length) return '';
    const lines = [header(turn, mark)];
    for (const cycle of cycles) {
        const event = text(cycle?.event) || 'turn';
        const clock = Number.isFinite(Number(cycle?.clockMinutes)) ? ` — RP time: ${Number(cycle.clockMinutes)} min` : '';
        lines.push(`-- cycle: ${event}${clock}`);
        if (cycle?.message?.text) lines.push(`user message: ${text(cycle.message.text)}`);
        for (const message of Array.isArray(cycle?.messages) ? cycle.messages : []) {
            const content = text(message?.content);
            if (content) lines.push(`${text(message?.role) || 'assistant'}: ${content}`);
        }
        for (const call of Array.isArray(cycle?.toolCalls) ? cycle.toolCalls : []) lines.push(...callLines(call));
        if (cycle?.form) lines.push(`form: ${JSON.stringify(cycle.form)}`);
        if (text(cycle?.push)) lines.push(`push:\n${text(cycle.push)}`);
        if (text(cycle?.thinking)) lines.push(`thinking:\n${text(cycle.thinking)}`);
        for (const warning of Array.isArray(cycle?.warnings) ? cycle.warnings : []) lines.push(`warning: ${text(warning)}`);
    }
    return lines.join('\n');
}

export function renderFullTurns(turns) {
    return (Array.isArray(turns) ? turns : []).map(turn => renderTurn(turn)).filter(Boolean).join('\n\n');
}

/** Сжатая часть префикса: только уже дописанные записи, порядок не меняется. */
export function renderCompressedDigests(records) {
    const body = (Array.isArray(records) ? records : []).map(record => text(record?.text)).filter(Boolean).join('\n\n');
    return body ? `EARLIER TURNS (compressed):\n\n${body}` : '';
}
