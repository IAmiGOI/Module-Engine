/**
 * Телеметрия: одна запись на вызов модели или классификатора — кто позвал и зачем, какая модель, токены, цена,
 * время, исход. Ни ключей, ни текстов промптов и ответов: только числа и метки. Чистые функции, без сети и хранения.
 */

const text = value => String(value ?? '').trim();
const num = value => (Number.isFinite(Number(value)) ? Number(value) : 0);

export const TELEMETRY_LIMIT = 20000;
export const TELEMETRY_STATUSES = Object.freeze(['ok', 'error', 'timeout', 'rate-limited', 'empty', 'stopped']);

/** usage провайдера (OpenAI/OpenRouter, Anthropic, Google) → числа. `cost` — только если провайдер сам его отдал. */
export function usageNumbers(usage) {
    const u = usage && typeof usage === 'object' ? usage : {};
    const prompt = num(u.prompt_tokens ?? u.input_tokens ?? u.promptTokenCount);
    const completion = num(u.completion_tokens ?? u.output_tokens ?? u.candidatesTokenCount);
    const cached = num(u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? u.cachedContentTokenCount ?? u.prompt_cache_hit_tokens);
    const reasoning = num(u.completion_tokens_details?.reasoning_tokens ?? u.thoughtsTokenCount);
    const cost = Number.isFinite(Number(u.cost)) ? Number(u.cost) : null;
    return { prompt, completion, cached, reasoning, cost };
}

/** Цена по таблице модели: цены за токен (как в OpenRouter /models); кешированные — по своей цене, если она есть. */
export function priceCost({ prompt = 0, completion = 0, cached = 0 } = {}, price = null) {
    if (!price) return null;
    const p = num(price.prompt), c = num(price.completion);
    if (!p && !c) return null;
    const cacheRead = Number.isFinite(Number(price.cacheRead)) && price.cacheRead !== '' ? num(price.cacheRead) : p;
    return Math.max(0, prompt - cached) * p + cached * cacheRead + completion * c;
}

/** Статус по ошибке: таймаут, лимит, остановка — отдельно, остальное — error. */
export function statusOf(error, { empty = false } = {}) {
    if (!error) return empty ? 'empty' : 'ok';
    const message = text(error?.message ?? error).toLowerCase();
    if (/abort|stopped|cancel/.test(message)) return 'stopped';
    if (/timed? ?out|timeout/.test(message)) return 'timeout';
    if (/429|rate.?limit/.test(message)) return 'rate-limited';
    return 'error';
}

/** Хост эндпоинта без пути и ключей: «openrouter.ai». */
export function hostOf(endpoint) {
    try { return new URL(text(endpoint)).host; } catch { return ''; }
}

/** Запись телеметрии из сырых сведений вызова. Цена: от провайдера, иначе по таблице, иначе — неизвестна. */
export function buildCallRecord({ at = Date.now(), kind = 'model', caller = '', purpose = '', workerId = '', model = '', endpoint = '', usage = null, price = null, durationMs = 0, status = 'ok', error = '', attempts = 1, questions = 0, answered = 0, chatId = '', turn = null } = {}) {
    const tokens = usageNumbers(usage);
    const fromTable = tokens.cost === null ? priceCost(tokens, price) : null;
    return {
        at: num(at), kind: text(kind) || 'model', caller: text(caller), purpose: text(purpose),
        workerId: text(workerId), model: text(model), host: hostOf(endpoint),
        prompt: tokens.prompt, completion: tokens.completion, cached: tokens.cached, reasoning: tokens.reasoning,
        cost: tokens.cost ?? fromTable, costSource: tokens.cost !== null ? 'provider' : fromTable !== null ? 'table' : 'unknown',
        durationMs: Math.max(0, Math.round(num(durationMs))), status: TELEMETRY_STATUSES.includes(status) ? status : 'error',
        error: text(error).slice(0, 300), attempts: Math.max(1, Math.round(num(attempts)) || 1),
        ...(kind === 'classifier' ? { questions: num(questions), answered: num(answered) } : {}),
        chatId: text(chatId), turn: Number.isFinite(Number(turn)) && turn !== null ? Number(turn) : null,
    };
}

/** Кольцо: новые в конец, старше лимита — прочь. */
export function appendRing(list, items, limit = TELEMETRY_LIMIT) {
    const next = [...(Array.isArray(list) ? list : []), ...(Array.isArray(items) ? items : [items]).filter(Boolean)];
    return next.length > limit ? next.slice(next.length - limit) : next;
}

/** Фильтр ленты: период, чат, ход, вызывающий, назначение, модель, статус, вид. Пустое поле — не фильтрует. */
export function filterCalls(records, { from = 0, to = 0, chatId = '', turn = null, caller = '', purpose = '', model = '', status = '', kind = '' } = {}) {
    return (Array.isArray(records) ? records : []).filter(record => (!from || record.at >= from)
        && (!to || record.at <= to)
        && (!chatId || record.chatId === chatId)
        && (turn === null || turn === '' || record.turn === Number(turn))
        && (!caller || record.caller === caller)
        && (!purpose || record.purpose === purpose)
        && (!model || record.model === model)
        && (!status || record.status === status)
        && (!kind || record.kind === kind));
}

const median = values => {
    const sorted = [...values].sort((a, b) => a - b);
    if (!sorted.length) return 0;
    const middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};

const dayOf = at => new Date(num(at)).toISOString().slice(0, 10);
const KEYS = Object.freeze({
    purpose: record => record.purpose || record.caller || '—', model: record => record.model || '—', caller: record => record.caller || '—',
    status: record => record.status, day: record => dayOf(record.at), chat: record => record.chatId || '—',
    turn: record => (record.turn === null ? '—' : `${record.chatId || '—'} #${record.turn}`), total: () => 'total',
});

/** Сводка по группам: вызовы, токены, цена (и сколько вызовов без цены), время среднее и медиана, ошибки и повторы. */
export function summarize(records, by = 'purpose') {
    const keyOf = KEYS[by] ?? KEYS.purpose;
    const groups = new Map();
    for (const record of Array.isArray(records) ? records : []) {
        const key = keyOf(record);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(record);
    }
    return [...groups.entries()].map(([key, list]) => ({
        key, calls: list.length,
        prompt: list.reduce((sum, r) => sum + r.prompt, 0), completion: list.reduce((sum, r) => sum + r.completion, 0),
        cached: list.reduce((sum, r) => sum + r.cached, 0), reasoning: list.reduce((sum, r) => sum + r.reasoning, 0),
        cost: list.reduce((sum, r) => sum + (r.cost ?? 0), 0), unpriced: list.filter(r => r.cost === null).length,
        avgMs: Math.round(list.reduce((sum, r) => sum + r.durationMs, 0) / list.length), medianMs: median(list.map(r => r.durationMs)),
        errors: list.filter(r => r.status !== 'ok').length, retries: list.reduce((sum, r) => sum + (r.attempts - 1), 0),
    })).sort((a, b) => b.cost - a.cost || b.calls - a.calls);
}

/** Сводки по дням — живут дольше кольца: при обрезке ленты день не пропадает из итогов. */
export function rollupDays(days, records) {
    const out = { ...(days && typeof days === 'object' ? days : {}) };
    for (const row of summarize(records, 'day')) {
        const before = out[row.key] ?? { calls: 0, prompt: 0, completion: 0, cached: 0, cost: 0, errors: 0 };
        out[row.key] = {
            calls: before.calls + row.calls, prompt: before.prompt + row.prompt, completion: before.completion + row.completion,
            cached: before.cached + row.cached, cost: before.cost + row.cost, errors: before.errors + row.errors,
        };
    }
    return out;
}

const CSV_FIELDS = Object.freeze(['at', 'kind', 'caller', 'purpose', 'workerId', 'model', 'host', 'prompt', 'completion', 'cached', 'reasoning', 'cost', 'costSource', 'durationMs', 'status', 'attempts', 'chatId', 'turn', 'error']);

export function toCsv(records) {
    const cell = value => {
        const raw = value === null || value === undefined ? '' : String(value);
        return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
    };
    return [CSV_FIELDS.join(','), ...(Array.isArray(records) ? records : []).map(record => CSV_FIELDS.map(field => cell(field === 'at' ? new Date(record.at).toISOString() : record[field])).join(','))].join('\n');
}

/** Таблица цен OpenRouter (/api/v1/models) → { model: { prompt, completion, cacheRead } } за токен. */
export function priceTable(models) {
    const table = {};
    for (const model of Array.isArray(models?.data) ? models.data : (Array.isArray(models) ? models : [])) {
        const id = text(model?.id);
        if (!id || !model?.pricing) continue;
        table[id] = { prompt: num(model.pricing.prompt), completion: num(model.pricing.completion), cacheRead: model.pricing.input_cache_read ?? '' };
    }
    return table;
}
