import { estimateTokens } from './token-estimate.js';

/**
 * Лог директора — чистые операции над массивом циклов. Хранение (когда и
 * куда писать) — дело ядра; здесь только форма записи, подсчёт токенов,
 * хранение thinking за три цикла и грузовой порог с архивом.
 *
 * Форма записи:
 * `{ id, at, event, messages, toolCalls, thinking, tokens, warnings }`.
 * В чат и прозаику это не попадает ни при каких условиях.
 */

export function createCycleRecord({
    id, runId = '', event = 'turn', messages = [], toolCalls = [], thinking = '', warnings = [], usage = null,
    at = Date.now(), endedAt = null, durationMs = null, form = null, push = '', wake = null, message = null,
    turn = null, clockMinutes = null, workerId = null, rejected = false, rejectedAt = null, modes = null,
} = {}) {
    const number = value => (Number.isFinite(Number(value)) ? Number(value) : null);
    const cycle = {
        id: String(id ?? `cyc_${at.toString(36)}_${Math.random().toString(36).slice(2, 8)}`),
        runId: String(runId ?? ''),
        at,
        event,
        messages: (Array.isArray(messages) ? messages : []).map(message => ({ role: String(message?.role ?? ''), content: String(message?.content ?? '') })),
        toolCalls: (Array.isArray(toolCalls) ? toolCalls : []).map(call => ({
            name: String(call?.name ?? ''), args: call?.args ?? {}, comment: String(call?.comment ?? ''),
            result: call?.result ?? null, error: call?.error ?? null, durationMs: call?.durationMs ?? null, at: call?.at ?? at,
        })),
        thinking: String(thinking ?? ''),
        warnings: (Array.isArray(warnings) ? warnings : []).map(String),
        usage: usage && typeof usage === 'object' ? { ...usage } : null,
        // Всё, что окно ленты показывает отдельными строками. Хранится здесь,
        // а не вычисляется в окне: лог — единственный источник прошлого.
        form: form && typeof form === 'object' ? form : null,
        push: String(push ?? ''),
        wake: wake && typeof wake === 'object' ? { ...wake } : null,
        message: message && typeof message === 'object' ? { text: String(message.text ?? ''), at: message.at ?? at } : null,
        turn: number(turn),
        clockMinutes: number(clockMinutes),
        workerId: workerId ? String(workerId) : null,
        endedAt: number(endedAt),
        durationMs: number(durationMs),
        rejected: Boolean(rejected),
        rejectedAt: number(rejectedAt),
        // Режимы хода: сцена, оценки и выбор — заодно готовая разметка для локальной модели (DataGen).
        ...(modes && typeof modes === 'object' ? { modes: { scene: String(modes.scene ?? ''), answers: { ...(modes.answers ?? {}) }, chosen: [...(modes.chosen ?? [])], source: String(modes.source ?? '') } } : {}),
        tokens: 0,
    };
    cycle.tokens = cycleTokens(cycle);
    return cycle;
}

/** Токены одного цикла: сообщения цикла, аргументы/результаты вызовов и thinking. */
export function cycleTokens(cycle) {
    const messageTokens = (cycle?.messages ?? []).reduce((sum, message) => sum + estimateTokens(message?.content) + 4, 0);
    const callTokens = (cycle?.toolCalls ?? []).reduce((sum, call) => sum + estimateTokens(JSON.stringify(call?.args ?? {})) + estimateTokens(JSON.stringify(call?.result ?? null)), 0);
    const formTokens = estimateTokens(JSON.stringify(cycle?.form ?? null)) + estimateTokens(cycle?.push) + estimateTokens(cycle?.message?.text);
    return messageTokens + callTokens + formTokens + estimateTokens(cycle?.thinking) + estimateTokens((cycle?.warnings ?? []).join('\n'));
}

export function totalLogTokens(cycles) {
    return (Array.isArray(cycles) ? cycles : []).reduce((sum, cycle) => sum + (Number(cycle?.tokens) || cycleTokens(cycle)), 0);
}
