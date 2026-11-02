/**
 * Тело основного запроса ST → тело прозаика — чистые функции. Замена
 * происходит на `generation.payload` (`fold`), поэтому на вход приходит уже
 * собранное кем-то тело, а на выход — новое; неизвестное тело возвращается
 * `null` и уходит нетронутым (ARCHITECTURE.md: «незнакомое тело запроса
 * пропускается нетронутым»).
 */

/** Ключи, которыми ST и его источники включают ризонинг. Удаляются всегда. */
const REASONING_KEYS = Object.freeze([
    'reasoning_effort',
    'reasoning',
    'include_reasoning',
    'reasoning_budget',
    'thinking',
    'thinkingConfig',
    'enable_thinking',
    'thinking_budget',
]);

/** Ключи, которыми тело просит у провайдера инструменты. У прозаика их нет никогда. */
const TOOL_KEYS = Object.freeze(['tools', 'tool_choice', 'functions', 'function_call', 'parallel_tool_calls', 'tool_config']);

const ANTHROPIC_SOURCES = Object.freeze(['claude', 'anthropic']);
const GOOGLE_SOURCES = Object.freeze(['makersuite', 'vertexai', 'google', 'gemini']);

/**
 * Снимает инструменты с тела основного запроса ST. При включённом ядре все
 * ToolCalls живут у директора; прозаик получает тело без `tools` и без
 * выбора инструмента, иначе ST/провайдер могли бы снова позвать инструмент
 * мимо директора. Тело без этих ключей не меняется.
 */
export function stripTools(body) {
    const next = { ...(body ?? {}) };
    for (const key of TOOL_KEYS) delete next[key];
    if (next.generationConfig && typeof next.generationConfig === 'object') {
        const generationConfig = { ...next.generationConfig };
        for (const key of TOOL_KEYS) delete generationConfig[key];
        next.generationConfig = generationConfig;
    }
    return next;
}

/**
 * Какой формат у ЭТОГО тела. `messages` — Chat Completion; источник уточняет
 * диалект. `prompt` — Text Completion: ризонинга там нет вовсе.
 */
export function resolveBodyFormat(payload) {
    if (Array.isArray(payload?.messages)) {
        const source = String(payload?.chat_completion_source ?? '').toLowerCase();
        if (ANTHROPIC_SOURCES.includes(source)) return 'anthropic';
        if (GOOGLE_SOURCES.includes(source)) return 'google';
        return 'openai';
    }
    if (typeof payload?.prompt === 'string') return 'text';
    return null;
}

/**
 * Выключает ризонинг для каждого формата, который знает
 * [provider-request.js](provider-request.js):
 *  - `openai` — убирает ключи; на OpenRouter (единственный openai-совместимый
 *    источник с известным unified-полем) ставит явное `enabled: false`;
 *  - `anthropic` — `thinking: { type: 'disabled' }`;
 *  - `google` — `thinkingConfig: { thinkingBudget: 0 }`;
 *  - `text` — ризонинга нет, только чистка ключей.
 *
 * Явные формы намеренно совпадают с тем, что делает `buildProviderRequest()`
 * при `reasoningMode: 'disabled'`. Принятие этих ключей сервером ST для
 * проксируемых источников — живая проверка владельца (см. DESIGN.md).
 */
export function disableReasoning(body, format = resolveBodyFormat(body)) {
    const next = { ...(body ?? {}) };
    for (const key of REASONING_KEYS) delete next[key];
    if (next.generationConfig && typeof next.generationConfig === 'object') {
        const generationConfig = { ...next.generationConfig };
        delete generationConfig.thinkingConfig;
        next.generationConfig = generationConfig;
    }
    const source = String(next.chat_completion_source ?? '').toLowerCase();
    if (format === 'openai' && source === 'openrouter') next.reasoning = { enabled: false };
    if (format === 'anthropic') next.thinking = { type: 'disabled' };
    if (format === 'google') {
        // Нативный Google-запрос держит это внутри `generationConfig`
        // (provider-request.js); у тела ST такого объекта нет — тогда
        // выключатель кладётся рядом с остальными полями.
        if (next.generationConfig && typeof next.generationConfig === 'object') next.generationConfig = { ...next.generationConfig, thinkingConfig: { thinkingBudget: 0 } };
        else next.thinkingConfig = { thinkingBudget: 0 };
    }
    return next;
}

function applySampler(body, writer, format) {
    if (!writer?.applySampler) return body;
    const next = { ...body };
    if (Number.isFinite(writer.temperature)) next.temperature = writer.temperature;
    if (Number.isFinite(writer.topP)) next.top_p = writer.topP;
    if (Number.isFinite(writer.topK)) next.top_k = writer.topK;
    if (Number.isFinite(writer.maxTokens)) {
        next.max_tokens = writer.maxTokens;
        if (format === 'text') next.max_new_tokens = writer.maxTokens;
    }
    return next;
}

/**
 * Собирает новое тело: заменяет `messages` (Chat Completion) или `prompt`
 * (Text Completion), применяет сэмплер прозаика (если включён), при
 * необходимости подменяет `model` и в любом случае выключает ризонинг.
 * `model` — из выбранного воркера; для `st-main` его нет, поэтому поле не
 * трогается.
 */
export function computeWriterPayload(payload, context, { writer = {}, model = '' } = {}) {
    const format = resolveBodyFormat(payload);
    if (!format) return null;
    const messages = Array.isArray(context?.messages) ? context.messages : [];
    const prompt = typeof context?.prompt === 'string' ? context.prompt : '';
    if (format === 'text' ? !prompt : !messages.length) return null;
    let body = { ...payload };
    if (format === 'text') body.prompt = prompt;
    else body.messages = messages;
    body = applySampler(body, writer, format);
    if (model) body.model = model;
    body = stripTools(body);
    return disableReasoning(body, format);
}
