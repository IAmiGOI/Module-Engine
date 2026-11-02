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

export function createCycleRecord({ id, event = 'turn', messages = [], toolCalls = [], thinking = '', warnings = [], usage = null, at = Date.now() } = {}) {
    const cycle = {
        id: String(id ?? `cyc_${at.toString(36)}_${Math.random().toString(36).slice(2, 8)}`),
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
        tokens: 0,
    };
    cycle.tokens = cycleTokens(cycle);
    return cycle;
}

/** Токены одного цикла: сообщения цикла, аргументы/результаты вызовов и thinking. */
export function cycleTokens(cycle) {
    const messageTokens = (cycle?.messages ?? []).reduce((sum, message) => sum + estimateTokens(message?.content) + 4, 0);
    const callTokens = (cycle?.toolCalls ?? []).reduce((sum, call) => sum + estimateTokens(JSON.stringify(call?.args ?? {})) + estimateTokens(JSON.stringify(call?.result ?? null)), 0);
    return messageTokens + callTokens + estimateTokens(cycle?.thinking) + estimateTokens((cycle?.warnings ?? []).join('\n'));
}

export function totalLogTokens(cycles) {
    return (Array.isArray(cycles) ? cycles : []).reduce((sum, cycle) => sum + (Number(cycle?.tokens) || cycleTokens(cycle)), 0);
}

/**
 * «Thinking за текущий цикл и два предыдущих»: у более старых циклов текст
 * рассуждения стирается, сама запись остаётся. Пачкой — вызывающий решает,
 * на какой границе звать (ядро зовёт раз в три цикла, см. DESIGN о кеше).
 */
export function trimThinking(cycles, keep = 2) {
    const list = Array.isArray(cycles) ? cycles : [];
    const firstKept = list.length - Math.max(0, keep) - 1; // текущий + keep предыдущих
    return list.map((cycle, index) => (index < firstKept && cycle.thinking ? { ...cycle, thinking: '', tokens: cycleTokens({ ...cycle, thinking: '' }) } : cycle));
}

/**
 * Порог (по умолчанию 500 тыс. токенов): самые старые **завершённые** циклы
 * уходят в архив, пока лог не влезет. Текущий цикл (`last`) не выкидывается
 * никогда. Возвращает `{ cycles, archived }`; `archived` — новые записи
 * архива, вызывающий сам решает, дописать ли их к своему архиву.
 */
export function compactLog(cycles, { limitTokens = 500000, keepCurrent = true, archiveLimitTokens = 500000 } = {}) {
    const list = Array.isArray(cycles) ? [...cycles] : [];
    const archived = [];
    let tokens = totalLogTokens(list);
    while (tokens > limitTokens && list.length > (keepCurrent ? 1 : 0)) {
        const [oldest] = list.splice(0, 1);
        archived.push(oldest);
        tokens -= Number(oldest?.tokens) || cycleTokens(oldest);
    }
    let archiveTokens = totalLogTokens(archived);
    const trimmedArchive = [];
    for (const cycle of archived) {
        if (archiveTokens <= archiveLimitTokens) trimmedArchive.push(cycle);
        else archiveTokens -= Number(cycle.tokens) || cycleTokens(cycle);
    }
    return { cycles: list, archived: trimmedArchive, tokens, droppedFromArchive: archived.length - trimmedArchive.length };
}

/** Текст думания для контекста — только у трёх последних циклов, которые ещё его хранят. */
export function thinkingSection(cycles) {
    const body = (Array.isArray(cycles) ? cycles : [])
        .filter(cycle => String(cycle?.thinking ?? '').trim())
        .map(cycle => `[cycle ${cycle.at}] ${String(cycle.thinking).trim()}`)
        .join('\n\n');
    return body ? `YOUR RECENT THINKING (the last three cycles):\n\n${body}` : '';
}

/**
 * То же, но ОТДЕЛЬНЫМИ сообщениями на цикл. Так новое thinking дописывается
 * в конец и не меняет предыдущие сообщения — кеш префикса переживает
 * добавление, чего один склеенный блок не даёт.
 */
export function thinkingMessages(cycles) {
    return (Array.isArray(cycles) ? cycles : [])
        .filter(cycle => String(cycle?.thinking ?? '').trim())
        .map(cycle => ({ role: 'system', content: `YOUR THINKING FROM CYCLE ${cycle.at}:\n\n${String(cycle.thinking).trim()}` }));
}
