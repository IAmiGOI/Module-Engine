/**
 * Чистая модель ленты директора: записи лога и события хода → строки окна.
 * Без DOM и без чтения хранилища — поэтому проверяется в Node. Каждый вид
 * строки (пробуждение, thinking, вызов, assess, форма, Push, отчёт,
 * предупреждение, расходы, сообщение) строится здесь один раз, а окно только
 * рисует готовое.
 */

import { afterTurnRows, counsellorRows, queueRow } from './decision-feed-rows.js';

const TURN_EVENTS = new Set(['turn', 'regenerate', 'swipe']);
const PASSIVE_EVENTS = new Set(['time', 'researcher', 'typing', 'message', 'counsellor', 'counsellor_day', 'decree', 'retry', 'warning']);
const EVENT_LABELS = {
    turn: 'A new turn has started', regenerate: 'Regenerate requested', swipe: 'Swipe requested',
    time: 'The clock moved', researcher: 'A researcher reported', typing: 'The user is typing',
    message: 'A message to the Counsellor', settings: 'Game settings changed',
    counsellor: 'The Counsellor read the Ledger', counsellor_day: 'The Counsellor closes the RP day',
    decree: 'The Director issues a Decree', retry: 'A retry in the background', warning: 'A warning',
};

const text = value => String(value ?? '').trim();
const callId = (call, index) => `call_${index}_${text(call?.name)}`;

export function describeWake(cycle) {
    const label = text(cycle?.wake?.label) || EVENT_LABELS[cycle?.event] || `The director woke up: ${cycle?.event ?? 'unknown'}`;
    const detail = text(cycle?.wake?.detail);
    return { label, detail };
}

function assessRow(call, args, index) {
    const result = call?.result && typeof call.result === 'object' ? call.result : {};
    return {
        kind: 'assess', id: callId(call, index), name: 'assess', comment: text(call?.comment) || text(args.comment),
        character: text(result.character ?? args.character), action: text(result.action ?? args.action),
        difficulty: text(args.difficulty), effective: text(result.difficultyEffective), shift: Number(result.difficultyShift) || 0,
        experience: text(args.experience),
        probability: result.probability ?? null, roll: result.roll ?? null,
        degree: text(result.degree), words: text(result.words), error: call?.error ?? null, pending: false,
    };
}

export function toolRow(call, index = 0) {
    const args = call?.args && typeof call.args === 'object' ? call.args : {};
    const comment = text(call?.comment) || text(args.comment);
    if (call?.name === 'assess' && call?.result && typeof call.result === 'object' && call.result.ok) return assessRow(call, args, index);
    return {
        kind: 'call', id: callId(call, index), name: text(call?.name), comment, args,
        result: call?.result ?? null, error: call?.error ?? null, durationMs: call?.durationMs ?? null, pending: false,
    };
}

export function formRow(form) {
    const characters = (Array.isArray(form?.characters) ? form.characters : []).map(character => ({
        name: text(character?.name), decision: text(character?.decision), action: text(character?.action), outcome: text(character?.outcome),
    }));
    return {
        kind: 'form', id: 'form', characters,
        place: text(form?.meta?.place) || text(form?.scene?.place), timeBefore: text(form?.meta?.timeBefore),
        timeAfter: text(form?.meta?.timeAfter), minutes: form?.scene?.minutes ?? null,
        resolution: text(form?.resolution), userResult: text(form?.userResult),
    };
}

function odds(value) {
    return Number.isFinite(Number(value)) ? `${Math.round(Number(value) * 100)}%` : '—';
}

function writerCheckRow(payload) {
    return {
        kind: 'writer_check', id: `writer_check_${text(payload.attempt)}_${text(payload.phase)}_${payload.at ?? ''}`,
        attempt: payload.attempt ?? null, phase: text(payload.phase), aborted: Boolean(payload.aborted),
        skipped: Boolean(payload.skipped), exhausted: Boolean(payload.exhausted), error: text(payload.error),
        quote: text(payload.quote), reasons: text(payload.reasons),
        probabilities: payload.probabilities && typeof payload.probabilities === 'object' ? payload.probabilities : {},
        violated: Array.isArray(payload.violated) ? payload.violated.map(text).filter(Boolean) : [],
    };
}

function formCheckRow(payload) {
    return {
        kind: 'form_check', id: `form_check_${payload.at ?? Date.now()}_${stateId(payload)}`,
        refused: Boolean(payload.refused), name: text(payload.name), chance: payload.chance ?? null,
        quote: text(payload.quote), skipped: Boolean(payload.skipped),
        probabilities: payload.probabilities && typeof payload.probabilities === 'object' ? payload.probabilities : {},
        warnings: Array.isArray(payload.warnings) ? payload.warnings.map(text).filter(Boolean) : [],
    };
}
let formRowCounter = 0;
function stateId(payload) { formRowCounter += 1; return `${payload.name ?? 'form'}_${formRowCounter}`; }

function appendToCycle(state, runId, row) {
    const index = state.cycles.map(entry => entry.runId).lastIndexOf(runId);
    if (index < 0) return state;
    const cycles = state.cycles.map((entry, at) => (at === index ? upsertRow(entry, row) : entry));
    return { ...state, cycles };
}

function usageRow(cycle) {
    const usage = cycle?.usage && typeof cycle.usage === 'object' ? cycle.usage : null;
    const durationMs = Number(cycle?.durationMs) || null;
    if (!usage && !durationMs) return null;
    return {
        kind: 'usage', id: 'usage', prompt: Number(usage?.prompt) || 0, completion: Number(usage?.completion) || 0,
        cached: Number(usage?.cached) || 0, total: Number(usage?.total) || 0, durationMs,
    };
}

function answerRows(cycle) {
    return (Array.isArray(cycle?.messages) ? cycle.messages : [])
        .filter(message => message?.role === 'assistant' && text(message?.content))
        .map((message, index) => ({ kind: 'answer', id: `answer_${index}`, text: text(message.content) }));
}

/** Запись лога → одна секция ленты со строками в порядке работы директора. */
export function buildCycleEntry(cycle) {
    const wake = describeWake(cycle);
    const rows = [];
    if (cycle?.message?.text) {
        rows.push({
            kind: cycle?.event === 'settings' ? 'settings' : 'message', id: 'message',
            text: text(cycle.message.text), at: cycle.message.at ?? cycle.at,
        });
    }
    if (text(cycle?.thinking)) rows.push({ kind: 'thinking', id: 'thinking', text: text(cycle.thinking) });
    for (const [index, call] of (Array.isArray(cycle?.toolCalls) ? cycle.toolCalls : []).entries()) rows.push(toolRow(call, index));
    if (cycle?.form) rows.push(formRow(cycle.form));
    for (const [index, call] of (Array.isArray(cycle?.toolCalls) ? cycle.toolCalls : []).entries()) {
        rows.push(...afterTurnRows(call, index));
        rows.push(...counsellorRows(call, index));
    }
    const queues = queueRow(cycle?.wake?.queues);
    if (queues) rows.push(queues);
    if (text(cycle?.push)) rows.push({ kind: 'push', id: 'push', text: text(cycle.push) });
    if (cycle?.wake?.report || (cycle?.wake?.type === 'researcher' && text(cycle?.wake?.detail))) {
        rows.push({ kind: 'report', id: 'report', task: text(cycle.wake.task), text: text(cycle.wake.report ?? cycle.wake.detail) });
    }
    for (const [index, warning] of (Array.isArray(cycle?.warnings) ? cycle.warnings : []).entries()) rows.push({ kind: 'warning', id: `warning_${index}`, text: text(warning) });
    rows.push(...answerRows(cycle));
    const usage = usageRow(cycle);
    if (usage) rows.push(usage);
    return {
        id: text(cycle?.id) || `cycle_${cycle?.at}`, kind: 'cycle', runId: text(cycle?.runId), event: text(cycle?.event),
        at: cycle?.at ?? null, title: wake.label, detail: wake.detail, turn: cycle?.turn ?? null,
        clockMinutes: cycle?.clockMinutes ?? null, rejected: Boolean(cycle?.rejected), running: false, waiting: false,
        rows, tokens: Number(cycle?.tokens) || 0,
    };
}

function liveEntry(payload) {
    const wake = describeWake(payload);
    return {
        id: `live_${text(payload?.runId)}`, kind: 'cycle', runId: text(payload?.runId), event: text(payload?.event),
        at: payload?.at ?? null, title: wake.label, detail: wake.detail, turn: payload?.turn ?? null,
        clockMinutes: payload?.clockMinutes ?? null, rejected: false, running: true, waiting: false,
        waitingSince: null, rows: [], tokens: 0,
    };
}

export function createFeedState({ cycles = [], archive = [], live = {} } = {}) {
    const built = cycles.map(buildCycleEntry);
    // Идущие циклы переживают перезагрузку журнала, кроме тех, что уже в нём есть (успели закончиться).
    const done = new Set(built.map(entry => entry.runId).filter(Boolean));
    const running = Object.fromEntries(Object.entries(live ?? {}).filter(([runId]) => !done.has(runId)));
    return { cycles: built, archive: archive.map(buildCycleEntry), live: running };
}

function withLive(state, runId, update, create = false) {
    // Цикл, начавшийся до того, как окно его увидело (bootstrap при открытии чата, обновление окна), заводится по первому событию:
    // иначе все его шаги молча терялись.
    const entry = state.live[runId] ?? (create && runId ? { ...liveEntry({ runId, event: 'running', wake: { label: 'The director is working' } }), at: Date.now() } : null);
    if (!entry) return state;
    const next = update(entry);
    if (next === entry) return state;
    return { ...state, live: { ...state.live, [runId]: next } };
}

function upsertRow(entry, row) {
    const index = entry.rows.findIndex(item => item.id === row.id);
    if (index < 0) return { ...entry, rows: [...entry.rows, row] };
    const rows = [...entry.rows];
    rows[index] = row;
    return { ...entry, rows };
}

/** Новое событие дописывает строку в живой цикл; прошлые секции не перестраиваются. */
export function applyFeedEvent(state, event, payload = {}) {
    const runId = text(payload?.runId);
    if (event === 'decision.cycle.started') return { ...state, live: { ...state.live, [runId]: liveEntry(payload) } };
    if (event === 'decision.cycle.step') {
        return withLive(state, runId, entry => (payload.phase === 'waiting'
            ? { ...entry, waiting: true, waitingSince: payload.at ?? Date.now() }
            : { ...entry, waiting: false }), true);
    }
    if (event === 'decision.cycle.thinking') {
        // Мысли — кусками по шагам, на своём месте между вызовами: кусок начинается там, где кончился прошлый.
        return withLive(state, runId, entry => {
            const full = String(payload.text ?? '');
            const part = text(full.slice(entry.thinkingOffset ?? 0));
            if (!part) return { ...entry, thinkingLength: full.length };
            return { ...upsertRow(entry, { kind: 'thinking', id: `thinking_${entry.thinkingPart ?? 0}`, text: part }), thinkingLength: full.length };
        }, true);
    }
    if (event === 'decision.cycle.answer') {
        return withLive(state, runId, entry => upsertRow(entry, { kind: 'answer', id: 'answer', text: text(payload.text) }), true);
    }
    if (event === 'decision.tool.called') {
        return withLive(state, runId, entry => {
            const row = toolRow({ name: payload.name, args: payload.args, comment: payload.comment });
            const next = upsertRow(entry, { ...row, id: `pending_${payload.id || payload.name}_${entry.rows.length}`, pending: true });
            // Следующие мысли — новым куском после этого вызова.
            const hasPart = entry.rows.some(item => item.id === `thinking_${entry.thinkingPart ?? 0}`);
            return hasPart ? { ...next, thinkingPart: (entry.thinkingPart ?? 0) + 1, thinkingOffset: entry.thinkingLength ?? 0 } : next;
        }, true);
    }
    if (event === 'decision.tool.result') {
        return withLive(state, runId, entry => {
            const index = [...entry.rows].reverse().findIndex(item => item.pending && item.name === payload.name);
            if (index < 0) return entry;
            const at = entry.rows.length - 1 - index;
            const previous = entry.rows[at];
            const call = { name: payload.name, args: previous.args, comment: previous.comment, result: payload.result, error: payload.error, durationMs: payload.durationMs };
            const rows = [...entry.rows];
            rows[at] = { ...toolRow(call, at), id: previous.id, pending: false };
            return { ...entry, rows };
        }, true);
    }
    if (event === 'decision.cycle.form') {
        return withLive(state, runId, entry => {
            const next = upsertRow(entry, formRow(payload.form));
            return payload.push ? upsertRow(next, { kind: 'push', id: 'push', text: text(payload.push) }) : next;
        }, true);
    }
    if (event === 'decision.cycle.finished') {
        const entry = payload.cycle ? buildCycleEntry(payload.cycle) : null;
        if (!entry) return state;
        const live = { ...state.live };
        delete live[runId];
        const index = state.cycles.findIndex(item => item.id === entry.id);
        const cycles = index < 0 ? [...state.cycles, entry] : state.cycles.map((item, at) => (at === index ? entry : item));
        return { ...state, live, cycles };
    }
    if (event === 'decision.message.added') {
        const entry = payload.record ? buildCycleEntry(payload.record) : null;
        if (!entry) return state;
        return { ...state, cycles: [...state.cycles, entry] };
    }
    if (event === 'decision.cycle.failed') {
        const message = text(payload.message) || 'The cycle failed.';
        if (state.live[runId]) return withLive(state, runId, entry => upsertRow(entry, { kind: 'warning', id: 'failed', text: message }));
        // Ошибка настройки случается ДО первого шага — живого цикла ещё нет,
        // но в ленте она обязана быть видна.
        const entry = {
            id: `failed_${runId}`, kind: 'cycle', runId, event: 'failed', at: payload.at ?? Date.now(),
            title: 'The cycle failed', detail: '', turn: null, clockMinutes: null, rejected: false,
            running: false, waiting: false, rows: [{ kind: 'warning', id: 'failed', text: message }], tokens: 0,
        };
        const index = state.cycles.findIndex(item => item.id === entry.id);
        const cycles = index < 0 ? [...state.cycles, entry] : state.cycles.map((item, at) => (at === index ? entry : item));
        return { ...state, cycles };
    }
    if (event === 'decision.writer.check') {
        const row = writerCheckRow(payload);
        if (state.live[runId]) return withLive(state, runId, entry => upsertRow(entry, row));
        return appendToCycle(state, runId, row);
    }
    if (event === 'decision.form.check') {
        const row = formCheckRow(payload);
        if (state.live[runId]) return withLive(state, runId, entry => upsertRow(entry, row));
        return appendToCycle(state, runId, row);
    }
    if (event === 'decision.cycle.ended') return withLive(state, runId, entry => ({ ...entry, running: false, waiting: false }));
    return state;
}

function entryText(entry) {
    const parts = [entry.title, entry.detail];
    for (const row of entry.rows) {
        parts.push(row.text, row.comment, row.name, row.character, row.action, row.difficulty, row.effective, row.experience, row.words, row.resolution, row.task, row.problem, row.excerpt, row.reason);
        if (row.kind === 'form') parts.push(row.userResult, row.place, ...row.characters.flatMap(character => [character.name, character.decision, character.action, character.outcome]));
        if (row.kind === 'call') parts.push(JSON.stringify(row.args ?? {}), JSON.stringify(row.result ?? null));
        if (row.kind === 'writer_check' || row.kind === 'form_check') parts.push(JSON.stringify(row.probabilities ?? {}), row.quote, row.reasons, row.name);
        if (row.kind === 'queues') parts.push(...row.petitions.flatMap(item => [item.character, item.status]), ...row.prayers.flatMap(item => [item.text, item.status]));
    }
    return parts.filter(Boolean).join('\n').toLowerCase();
}

/** Простые фильтры и поиск: окно не прячет данные, а только выбирает секции. */
export function filterFeed(state, { showThinking = true, onlyTurns = false, onlyPassive = false, showUsage = true, showRolls = true, search = '' } = {}) {
    const query = text(search).toLowerCase();
    const keep = entry => {
        if (onlyTurns && !TURN_EVENTS.has(entry.event)) return false;
        if (onlyPassive && !PASSIVE_EVENTS.has(entry.event)) return false;
        if (query && !entryText(entry).includes(query)) return false;
        return true;
    };
    const clean = entry => {
        if (showThinking && showUsage && showRolls) return entry;
        return {
            ...entry,
            rows: entry.rows.filter(row => (showThinking || row.kind !== 'thinking')
                && (showUsage || row.kind !== 'usage')
                && (showRolls || row.kind !== 'assess')),
        };
    };
    const all = [...state.cycles, ...Object.values(state.live)].filter(keep).map(clean).sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    return { cycles: all, live: state.live, archive: state.archive.filter(keep).map(clean) };
}
