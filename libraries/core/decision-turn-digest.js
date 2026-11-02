/**
 * Ход директора и его представления. Ход — все циклы от цикла с событием
 * начала хода до следующего такого цикла. Здесь только чистые функции:
 * группировка лога, полный текст хода и сжатая часть префикса.
 */

import { estimateTokens } from './token-estimate.js';

export const TURN_EVENTS = Object.freeze(['turn', 'regenerate', 'swipe']);
export const FULL_TURNS = 2;

const text = value => String(value ?? '').trim();

function oneLine(value, limit = 200) {
    const clean = text(value).replace(/\s+/g, ' ');
    if (!clean) return '';
    return clean.length > limit ? `${clean.slice(0, Math.max(1, limit - 1))}…` : clean;
}

function quoted(value, limit = 200) {
    const clean = oneLine(value, limit);
    return clean ? `"${clean}"` : '""';
}

function turnKey(turn) {
    return String(turn?.cycles?.[0]?.id ?? `turn_${turn?.at ?? ''}`);
}

function callChanges(call) {
    const name = text(call?.name);
    if (!name || name.startsWith('__') || call?.error) return [];
    const args = call?.args && typeof call.args === 'object' ? call.args : {};
    const result = call?.result && typeof call.result === 'object' ? call.result : {};
    if (result.ok === false) return [];
    if (name === 'update_roster') {
        const add = (Array.isArray(args.add) ? args.add : []).map(entry => text(entry?.name)).filter(Boolean);
        const remove = (Array.isArray(args.remove) ? args.remove : []).map(text).filter(Boolean);
        const parts = [];
        if (add.length) parts.push(`+ ${add.join(', ')}`);
        if (remove.length) parts.push(`− ${remove.join(', ')}`);
        return parts.length ? [`update_roster: ${parts.join(', ')}`] : [];
    }
    if (name === 'character_note') {
        const character = text(args.character);
        const op = text(args.op) || 'set';
        if (op === 'remove') return [`character_note ${character}: − ${text(args.id)}`];
        return [`character_note ${character}: ${op === 'add' ? '+ ' : ''}${quoted(args.text || args.title)}`];
    }
    if (name === 'set_character_plan') return [`set_character_plan ${text(args.character)}: ${quoted(args.summary)}`];
    if (name === 'assess') {
        const probability = Number(result.probability);
        const degree = text(result.degree) || text(result.words);
        return [`assess ${text(args.character)}: ${Number.isFinite(probability) ? probability.toFixed(2) : '?'}${degree ? ` → ${degree}` : ''}`];
    }
    if (name === 'memory') {
        return args.op === 'write' ? [`memory write${args.important === true ? ' (important)' : ''}: ${oneLine(args.text)}`] : [];
    }
    if (name === 'set_plan') return [`set_plan: ${quoted(args.direction)}`];
    if (name === 'arc') {
        const label = text(args.title) || text(args.id);
        return [`arc ${text(args.op)}${label ? `: ${label}` : ''}`];
    }
    if (name === 'set_character_level') return [`set_character_level ${text(args.character)}: ${text(args.level)}`];
    if (name === 'resolve_character_plan') return [`resolve_character_plan ${text(args.character)}: ${oneLine(args.result)}`];
    if (name === 'recall_name') {
        const full = text(result.full) || [text(result.name), text(result.surname)].filter(Boolean).join(' ');
        return full ? [`recall_name: ${full}`] : [];
    }
    if (name === 'character_bank') return args.op === 'read' ? [] : [`character_bank ${text(args.op)}: ${text(args.character)}`];
    if (name === 'spawn_researcher') return [`spawn_researcher: ${oneLine(args.task)}`];
    return [];
}

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

/** Каждый ход — отдельным сообщением: дописывание нового не меняет предыдущие. */
export function fullTurnMessages(turns) {
    return (Array.isArray(turns) ? turns : [])
        .map(turn => ({ role: 'system', content: renderTurn(turn) }))
        .filter(message => message.content);
}

/** Сжатая часть префикса: только уже дописанные записи, порядок не меняется. */
export function renderCompressedDigests(records) {
    const body = (Array.isArray(records) ? records : []).map(record => text(record?.text)).filter(Boolean).join('\n\n');
    return body ? `EARLIER TURNS (compressed):\n\n${body}` : '';
}

/** По сообщению на запись: новая запись дописывается, прежние байт в байт те же. */
export function compressedDigestMessages(records) {
    const list = (Array.isArray(records) ? records : [])
        .map(record => ({ role: 'system', content: text(record?.text) }))
        .filter(message => message.content);
    return list.length ? [{ role: 'system', content: 'EARLIER TURNS (compressed):' }, ...list] : [];
}

/**
 * Ход → одна сжатая запись. Без модели: Push, комментарии к вызовам, строки
 * изменений записывающих инструментов, сообщения владельца и ответы, отчёт
 * субагента и предупреждения. Результаты чтения и thinking не входят.
 */
export function buildTurnDigest(turn, { index = 0, now = () => Date.now() } = {}) {
    const cycles = Array.isArray(turn?.cycles) ? turn.cycles : [];
    const number = cycleNumber(cycles) ?? index + 1;
    const lines = [header(turn, 'compressed')];

    const pushes = cycles.map(cycle => text(cycle?.push)).filter(Boolean);
    if (pushes.length) lines.push('PUSH:', ...pushes);

    for (const cycle of cycles) {
        if (cycle?.message?.text) lines.push(`User: ${text(cycle.message.text)}`);
        if (cycle?.event !== 'message' && !cycle?.message) continue;
        for (const message of Array.isArray(cycle?.messages) ? cycle.messages : []) {
            if (message?.role === 'assistant' && text(message?.content)) lines.push(`Director: ${text(message.content)}`);
        }
    }

    for (const cycle of cycles) {
        for (const call of Array.isArray(cycle?.toolCalls) ? cycle.toolCalls : []) {
            const name = text(call?.name);
            if (!name || name.startsWith('__')) continue;
            lines.push(`${name}: ${oneLine(call?.comment, 300) || '(no comment)'}`);
        }
    }

    const changes = cycles.flatMap(cycle => (Array.isArray(cycle?.toolCalls) ? cycle.toolCalls : []).flatMap(callChanges));
    if (changes.length) lines.push('CHANGES:', ...changes);

    for (const cycle of cycles) {
        if (cycle?.wake?.type !== 'researcher' && !cycle?.wake?.report) continue;
        const task = text(cycle.wake.task);
        const report = text(cycle.wake.report ?? cycle.wake.detail);
        lines.push(`Researcher task: ${oneLine(task, 200) || '(no task)'}`);
        lines.push(`${oneLine(report, 300)} … (the full report is in the archive)`);
    }

    for (const cycle of cycles) {
        for (const warning of Array.isArray(cycle?.warnings) ? cycle.warnings : []) lines.push(`Warning: ${oneLine(warning, 300)}`);
    }

    const body = lines.filter(Boolean).join('\n');
    const runIds = [...new Set(cycles.map(cycle => text(cycle?.runId)).filter(Boolean))];
    return {
        key: turnKey(turn),
        turn: number,
        at: cycles[0]?.at ?? now(),
        runIds,
        text: body,
        tokens: estimateTokens(body),
    };
}

export function digestTokens(records) {
    return (Array.isArray(records) ? records : []).reduce((sum, record) => sum + (Number(record?.tokens) || estimateTokens(record?.text)), 0);
}
