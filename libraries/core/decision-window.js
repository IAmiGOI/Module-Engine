/**
 * Плавающее окно директора — чистые правила: сжатая запись цикла, счётчик,
 * деление окна при переключении и рендер замороженной истории. Ни моделей,
 * ни хранения: состояние приходит и уходит значением.
 *
 * Замысел — `DIRECTOR-SPEC.md`, раздел «Два окна». Ход больше не сжимается
 * целиком: в окно ложится каждый цикл (сообщение пользователя → цикл
 * директора → ответ писателя) отдельной записью, только дописывается.
 */

import { estimateTokens } from './token-estimate.js';
import { callChanges, oneLine } from './decision-turn-digest.js';

export const WINDOW_TURNS = 50;
export const WINDOW_DROP_SHARE = 0.6;
export const FROZEN_HEADER = 'PREVIOUS WINDOWS (summaries):';
export const WINDOW_KINDS = Object.freeze(['turn', 'passive', 'message', 'fact', 'correction']);

const text = value => String(value ?? '').trim();
const keyOf = value => text(value).toLowerCase();

/** Окно с диска — безопасная форма; мусор не должен ломать контекст. */
export function normalizeWindow(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const entries = (Array.isArray(source.entries) ? source.entries : [])
        .filter(entry => entry && typeof entry === 'object' && text(entry.text))
        .map(entry => ({
            key: text(entry.key) || `entry_${Number(entry.at) || 0}`,
            kind: WINDOW_KINDS.includes(entry.kind) ? entry.kind : 'fact',
            turn: Number.isFinite(Number(entry.turn)) ? Number(entry.turn) : null,
            at: Number(entry.at) || 0,
            text: text(entry.text),
            tokens: Number(entry.tokens) || estimateTokens(entry.text),
            runIds: Array.isArray(entry.runIds) ? entry.runIds.map(text).filter(Boolean) : [],
        }));
    return {
        entries,
        lastSwitchAt: Number(source.lastSwitchAt) || 0,
        createdAt: Number(source.createdAt) || 0,
    };
}

/** Сколько циклов хода набралось — пассивные записи и факты счётчик не двигают. */
export function windowTurnCount(entries) {
    return (Array.isArray(entries) ? entries : []).filter(entry => entry?.kind === 'turn').length;
}

/**
 * Деление окна: отбрасывается `share` старейших циклов хода (при 50 и 0.6 —
 * ровно 30, остаются 20). Пассивные записи и факты уходят вместе с циклом,
 * к которому относятся. Меньше двух циклов не делим.
 */
export function splitWindow(entries, { share = WINDOW_DROP_SHARE } = {}) {
    const list = Array.isArray(entries) ? entries : [];
    const turns = list.filter(entry => entry?.kind === 'turn');
    if (turns.length < 2) return { dropped: [], kept: list.slice() };
    const amount = Math.max(1, Math.min(turns.length - 1, Math.floor(turns.length * Number(share))));
    const cutoff = Number(turns[amount - 1].turn);
    const belongsToDropped = entry => Number.isFinite(Number(entry?.turn)) && Number(entry.turn) <= cutoff;
    return {
        dropped: list.filter(belongsToDropped),
        kept: list.filter(entry => !belongsToDropped(entry)),
    };
}

/** Сжатая запись цикла: пользователь и ответ писателя целиком, от директора — Push, комментарии и изменения. */
export function buildCycleDigest(cycle, { kind = 'turn', turn = null, userText = '', writerText = '', index = 0, now = () => Date.now() } = {}) {
    const cycles = cycle && typeof cycle === 'object' ? cycle : {};
    const number = Number.isFinite(Number(turn)) ? Number(turn)
        : Number.isFinite(Number(cycles.turn)) ? Number(cycles.turn) : index + 1;
    const clock = Number.isFinite(Number(cycles.clockMinutes)) ? ` — RP time: ${Number(cycles.clockMinutes)} min` : '';
    const place = text(cycles.form?.meta?.place ?? cycles.form?.scene?.place);
    const lines = [];

    if (kind === 'turn') lines.push(`TURN ${number} (compressed)${clock}${place ? ` — place: ${place}` : ''}`);
    else if (kind === 'passive') lines.push(`PASSIVE CYCLE (compressed)${clock}`);
    else if (kind === 'message') lines.push(`MESSAGE TO THE DIRECTOR (compressed)${clock}`);
    else lines.push(`FACT${clock}`);

    if (text(userText)) lines.push(`User: ${text(userText)}`);
    if (cycles.message?.text) lines.push(`User: ${text(cycles.message.text)}`);
    if (text(cycles.push)) lines.push('PUSH:', text(cycles.push));

    for (const call of Array.isArray(cycles.toolCalls) ? cycles.toolCalls : []) {
        const name = text(call?.name);
        if (!name || name.startsWith('__')) continue;
        lines.push(`${name}: ${oneLine(call?.comment, 300) || '(no comment)'}`);
    }

    const changes = (Array.isArray(cycles.toolCalls) ? cycles.toolCalls : []).flatMap(callChanges);
    if (changes.length) lines.push('CHANGES:', ...changes);

    if (['message', 'passive'].includes(kind)) {
        for (const message of Array.isArray(cycles.messages) ? cycles.messages : []) {
            if (message?.role === 'assistant' && text(message?.content)) lines.push(`Director: ${text(message.content)}`);
        }
    }

    if (text(writerText)) lines.push(`Writer: ${text(writerText)}`);

    const report = text(cycles.wake?.report ?? (cycles.wake?.type === 'researcher' ? cycles.wake?.detail : ''));
    if (report) lines.push(`${oneLine(report, 400)} … (the full report is in the archive)`);
    if (text(cycles.wake?.detail) && !report) lines.push(`Wake: ${oneLine(cycles.wake.detail, 300)}`);

    for (const warning of Array.isArray(cycles.warnings) ? cycles.warnings : []) lines.push(`Warning: ${oneLine(warning, 300)}`);

    const body = lines.filter(Boolean).join('\n');
    const at = Number(cycles.at) || now();
    return {
        key: text(cycles.id) || `cycle_${number}_${at}`,
        kind,
        turn: kind === 'turn' ? number : (Number.isFinite(Number(cycles.turn)) ? Number(cycles.turn) : number),
        at,
        runIds: text(cycles.runId) ? [text(cycles.runId)] : [],
        text: body,
        tokens: estimateTokens(body),
    };
}

/** Строка-факт окна: план частого персонажа, новый персонаж, смена уровня или ростера. */
export function buildFact(textBody, { turn = null, at = 0, key = '' } = {}) {
    const body = text(textBody);
    return {
        key: text(key) || `fact_${Number(at) || 0}_${Math.random().toString(36).slice(2, 8)}`,
        kind: 'fact',
        turn: Number.isFinite(Number(turn)) ? Number(turn) : null,
        at: Number(at) || 0,
        text: body,
        tokens: estimateTokens(body),
        runIds: [],
    };
}

export function buildCorrection(textBody, { turn = null, at = 0, key = '' } = {}) {
    const body = text(textBody);
    return {
        key: text(key) || `correction_${Number(at) || 0}_${Math.random().toString(36).slice(2, 8)}`,
        kind: 'correction',
        turn: Number.isFinite(Number(turn)) ? Number(turn) : null,
        at: Number(at) || 0,
        text: body,
        tokens: estimateTokens(body),
        runIds: [],
    };
}

/** Замороженная история: по сообщению на сводку, только дописывается. */
export function frozenWindowMessages(records) {
    const list = (Array.isArray(records) ? records : []).filter(record => text(record?.text));
    return list.length
        ? [{ role: 'system', content: FROZEN_HEADER }, ...list.map(record => ({ role: 'system', content: text(record.text) }))]
        : [];
}

export function renderFrozenWindows(records) {
    const body = (Array.isArray(records) ? records : []).map(record => text(record?.text)).filter(Boolean).join('\n\n');
    return body ? `${FROZEN_HEADER}\n\n${body}` : '';
}

/** Окно: по сообщению на запись, чтобы новая запись не меняла предыдущие байты. */
export function windowMessages(entries) {
    return (Array.isArray(entries) ? entries : [])
        .map(entry => ({ role: 'system', content: text(entry?.text) }))
        .filter(message => message.content);
}

export function renderWindow(entries) {
    return (Array.isArray(entries) ? entries : []).map(entry => text(entry?.text)).filter(Boolean).join('\n\n');
}

/** Граница окна: снимок блоков 4, 6, 7 и 8. Меняется только при переключении. */
export function createBoundary({ roster = [], libraryText = '', plansText = '', activeBanksText = '', at = 0 } = {}) {
    return {
        at: Number(at) || 0,
        roster: (Array.isArray(roster) ? roster : []).map(text).filter(Boolean),
        libraryText: text(libraryText),
        plansText: text(plansText),
        activeBanksText: text(activeBanksText),
    };
}

export function normalizeBoundary(value) {
    return value && typeof value === 'object' ? createBoundary(value) : null;
}

/** Сводка прошлого окна: только дописывается; запасной путь помечается `fallback`. */
export function buildFrozenRecord({ text: body, reason = '', arc = '', at = 0, key = '', fallback = false } = {}) {
    const content = text(body);
    return {
        key: text(key) || `window_${Number(at) || 0}`,
        at: Number(at) || 0,
        reason: text(reason),
        arc: text(arc),
        fallback: Boolean(fallback),
        text: content,
        tokens: estimateTokens(content),
    };
}

/** Запись окна по имени персонажа и библиотеке: факт для уровней 1 и 3 (частые персонажи). */
export function isFrequentCharacter(library, name) {
    const record = Object.values(library && typeof library === 'object' && !Array.isArray(library) ? library : {})
        .find(item => keyOf(item?.name) === keyOf(name));
    return Boolean(record) && [1, 3].includes(Number(record.level));
}
