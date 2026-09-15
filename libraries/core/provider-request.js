/**
 * Формат запроса/ответа для API-совместимых удалённых моделей — pure
 * request-shaping, no network of its own (see NAMING_PHILOSOPHY.md:
 * `buildX()`/`computeX()` never reach outside). Ported from Alpha's
 * SidecarService `#openAi`/`#anthropic`/`#google`, split into pure
 * functions so the model Ядра can test request-shaping without a real
 * `fetch` anywhere — the actual HTTP call is the Сервис HTTP's job
 * (services/http.js), reached through the Гейт для сети.
 *
 * **Ризонинг — три РАЗНЫХ настоящих API, ни одного общего поля.** Ни у
 * Anthropic, ни у Google нет понятия "effort" вообще — только вкл/выкл и
 * бюджет токенов; у OpenAI-совместимых форматов единого стандарта не
 * существует в принципе, разные бэкенды понимают это поле по-разному (или
 * не понимают вовсе — а строгий API на неопознанное поле может и вовсе
 * отказать). Поэтому:
 *  - **openai** — ризонинг уходит ТОЛЬКО на настоящий OpenRouter (проверка
 *    по эндпоинту, `isOpenRouter()`), тем же unified `reasoning` полем, что
 *    и в SideCar Alpha (`request.reasoningMode !== 'inherit'` — иначе
 *    провайдер решает сам, и в тело не попадает вообще ничего). На "просто
 *    OpenAI-совместимый" эндпоинт (в т.ч. настоящий api.openai.com) ничего
 *    не уходит — сознательно, тот же выбор, что уже был в Alpha; настоящий
 *    `reasoning_effort` у o-серии OpenAI можно добавить отдельно, если
 *    реальный пользователь попросит именно его.
 *  - **anthropic** — реальный `thinking: {type, budget_tokens}` (в Alpha
 *    этого не было вовсе). `budget_tokens` у Anthropic обязан быть ≥ 1024 И
 *    строго меньше `max_tokens` — оба ограничения проверены по документации
 *    и применены здесь, а не оставлены как повод для непонятной ошибки от
 *    самого Anthropic.
 *  - **google** — реальный `thinkingConfig: {thinkingBudget}` (тоже не было
 *    у Alpha): 0 выключает, -1 — «пусть модель решает сама» (бюджет не
 *    задан), положительное число — явный бюджет.
 */

const FORMATS = Object.freeze(['openai', 'anthropic', 'google']);

/** Defensive reader — an unrecognized/missing format falls back to 'openai', the most common API shape. */
export function resolveProviderFormat(format) {
    return FORMATS.includes(format) ? format : 'openai';
}

/**
 * `worker` = { endpoint, apiKey, model, format }. `request` = { prompt,
 * systemPrompt, temperature, maxTokens, topP, topK, seed }. Returns
 * `{ url, method, headers, body }` — everything `http.request` needs, with
 * `body` already JSON-stringified (matching services/http.js's contract).
 *
 * `stream` (opt-in, default `false` — existing callers untouched) shapes the
 * request so the provider replies with SSE instead of one JSON blob: OpenAI/
 * Anthropic take a body flag, Google instead needs a DIFFERENT endpoint
 * (`streamGenerateContent` vs `generateContent` — its REST API has no
 * `stream` body field at all, this isn't a stylistic choice).
 */
export function buildProviderRequest(worker, request, { stream = false } = {}) {
    const format = resolveProviderFormat(worker.format);
    if (format === 'anthropic') return buildAnthropicRequest(worker, request, stream);
    if (format === 'google') return buildGoogleRequest(worker, request, stream);
    return buildOpenAiRequest(worker, request, stream);
}

/** OpenRouter — единственный openai-формат, чей unified `reasoning` мы знаем и на который согласны положиться (см. doc-comment файла). */
function isOpenRouter(endpoint) {
    return /openrouter\.ai/i.test(String(endpoint ?? ''));
}

/**
 * OpenRouter's `max_tokens` is a completion-only budget (prompt is billed
 * separately against the context window — see OpenRouter's own Parameters
 * doc), but for reasoning models that budget is SHARED between the model's
 * thinking and its visible reply. Left unchecked, a model can spend the
 * entire `max_tokens` on reasoning and return an empty completion. This
 * reserve guarantees room for the actual reply regardless of what
 * `reasoningBudget` asks for.
 */
const RESERVED_COMPLETION_TOKENS = 200;

function buildOpenAiReasoning(worker, request) {
    // Молчим и на "не OpenRouter", и на что угодно, что НЕ прямое явное
    // enabled/disabled — `inherit`, отсутствующее поле, любой мусор. Раньше
    // здесь была проверка только на `!== 'inherit'`, и вызов с пустым/чужим
    // `reasoningMode` (например прямой сбор запроса в обход
    // `resolveGenerateRequest()`, как в тестах) молча уезжал как ВКЛЮЧЁННЫЙ
    // ризонинг — ровно то, чего вызывающий никогда не просил.
    if (!isOpenRouter(worker.endpoint)) return {};
    if (request.reasoningMode !== 'enabled' && request.reasoningMode !== 'disabled') return {};
    const reasoning = { enabled: request.reasoningMode === 'enabled', effort: request.reasoningEffort };
    if (reasoning.enabled) {
        const cap = Math.max(0, request.maxTokens - RESERVED_COMPLETION_TOKENS);
        if (cap > 0) reasoning.max_tokens = request.reasoningBudget ? Math.min(request.reasoningBudget, cap) : cap;
    }
    return { reasoning };
}

/**
 * `request.messages` — opt-in multi-turn escape hatch (see
 * resolveGenerateRequest()'s doc-comment in internal-engine.js), `openai`
 * format only: sent to the provider EXACTLY as given (any role, any order,
 * any count) instead of the usual `prompt`+`systemPrompt` sugar. `google`/
 * `anthropic` builders deliberately do NOT support this — legacy formats,
 * frozen, not worth the real per-provider work (Anthropic has no in-conversation
 * `system` role at all; Google has no multi-turn `contents` support here yet)
 * for something about to be removed.
 */
function resolveOpenAiMessages(request) {
    if (Array.isArray(request.messages) && request.messages.length) return request.messages;
    const messages = request.systemPrompt ? [{ role: 'system', content: request.systemPrompt }] : [];
    messages.push({ role: 'user', content: request.prompt });
    return messages;
}

function buildOpenAiRequest(worker, request, stream) {
    const url = /\/chat\/completions$/.test(worker.endpoint) ? worker.endpoint : `${trimTrailingSlash(worker.endpoint)}/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (worker.apiKey) headers.Authorization = `Bearer ${worker.apiKey}`;
    const messages = resolveOpenAiMessages(request);
    return {
        url, method: 'POST', headers,
        body: JSON.stringify({
            model: worker.model, messages,
            temperature: request.temperature, top_p: request.topP, max_tokens: request.maxTokens,
            ...(request.topK ? { top_k: request.topK } : {}),
            ...(request.seed ? { seed: request.seed } : {}),
            ...buildOpenAiReasoning(worker, request),
            ...(stream ? { stream: true } : {}),
        }),
    };
}

/**
 * Anthropic требует `budget_tokens` не меньше 1024 и строго меньше
 * `max_tokens` — оба ограничения задокументированы у самого Anthropic;
 * нарушить любое из них значит получить отказ на КАЖДЫЙ запрос с включённым
 * ризонингом, а не полезный сигнал о том, что бюджет настроен неудачно.
 * Молчим (не шлём `thinking` вовсе) и на `inherit`, и на что угодно, что не
 * прямое явное `enabled`/`disabled` — та же защита, что у OpenAI-ветки.
 */
function buildAnthropicThinking(request) {
    if (request.reasoningMode === 'disabled') return { thinking: { type: 'disabled' } };
    if (request.reasoningMode !== 'enabled') return {};
    // Если max_tokens сам меньше или равен минимально допустимому бюджету,
    // валидного значения не существует В ПРИНЦИПЕ — отправить его всё равно
    // значило бы гарантированно отказанный запрос вместо того, чтобы просто
    // не включать ризонинг в этот раз.
    if (request.maxTokens <= 1024) return {};
    const budget = Math.min(Math.max(1024, request.reasoningBudget || 1024), request.maxTokens - 1);
    return { thinking: { type: 'enabled', budget_tokens: budget } };
}

function buildAnthropicRequest(worker, request, stream) {
    const url = /\/messages$/.test(worker.endpoint) ? worker.endpoint : `${trimTrailingSlash(worker.endpoint)}/messages`;
    return {
        url, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': worker.apiKey ?? '', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
            model: worker.model, max_tokens: request.maxTokens, temperature: request.temperature,
            top_p: request.topP, top_k: request.topK || undefined,
            system: request.systemPrompt || undefined,
            messages: [{ role: 'user', content: request.prompt }],
            ...buildAnthropicThinking(request),
            ...(stream ? { stream: true } : {}),
        }),
    };
}

/** Google: 0 — выключено, -1 — «пусть модель сама решает бюджет» (включено, но без явного числа), положительное число — явный бюджет. Молчим (никакого `thinkingConfig`) на `inherit` и на что угодно, что не прямое явное `enabled`/`disabled` — та же защита, что у остальных форматов. */
function buildGoogleThinking(request) {
    if (request.reasoningMode === 'disabled') return { thinkingConfig: { thinkingBudget: 0 } };
    if (request.reasoningMode !== 'enabled') return {};
    return { thinkingConfig: { thinkingBudget: request.reasoningBudget > 0 ? request.reasoningBudget : -1 } };
}

function buildGoogleRequest(worker, request, stream) {
    // Google's REST API has no `stream` body flag — streaming is a DIFFERENT
    // method (`streamGenerateContent`) on the same resource, and `alt=sse`
    // is required to get real SSE frames back instead of one JSON array
    // delivered in a single response (the method's default framing).
    const apiMethod = stream ? 'streamGenerateContent' : 'generateContent';
    const query = stream ? `alt=sse&key=${encodeURIComponent(worker.apiKey ?? '')}` : `key=${encodeURIComponent(worker.apiKey ?? '')}`;
    const url = `${trimTrailingSlash(worker.endpoint)}/${encodeURIComponent(worker.model)}:${apiMethod}?${query}`;
    const text = request.systemPrompt ? `${request.systemPrompt}\n\n---\n\n${request.prompt}` : request.prompt;
    return {
        url, method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text }] }],
            generationConfig: {
                temperature: request.temperature, topP: request.topP, topK: request.topK || undefined,
                maxOutputTokens: request.maxTokens, ...(request.seed ? { seed: request.seed } : {}),
                ...buildGoogleThinking(request),
            },
        }),
    };
}

function trimTrailingSlash(url) {
    return String(url ?? '').replace(/\/+$/, '');
}

/**
 * Defensive reader over ONE already-parsed SSE frame (`{ event, data }` from
 * [sse-stream.js](sse-stream.js)) — same contract as `resolveProviderResponseText()`:
 * garbage/unexpected shape yields an empty, not-done delta rather than
 * throwing mid-stream (a single malformed frame must not kill the whole
 * response). Every format signals completion differently:
 *  - **openai** — sentinel frame `data: [DONE]`, no JSON body at all.
 *  - **anthropic** — a real event stream (`message_start`/`content_block_delta`/
 *    `message_stop`/...); only `content_block_delta` carries text, `message_stop`
 *    ends it. Reads the frame's OWN `type` field (always mirrors `event` per
 *    Anthropic's docs) rather than trusting `event` alone, in case a provider
 *    ever omits the named field but keeps the JSON honest.
 *  - **google** — no sentinel; each frame is a full (partial) `GenerateContentResponse`,
 *    same shape as the non-streaming reply. Done is inferred from `finishReason`
 *    showing up, not from the transport — the stream's real end is the caller's
 *    (http.js's) job once the reader itself reports done.
 */
export function resolveStreamDelta(format, frame) {
    const resolvedFormat = resolveProviderFormat(format);
    const data = frame?.data ?? '';
    if (resolvedFormat === 'openai') {
        if (data.trim() === '[DONE]') return { delta: '', done: true };
        try {
            const json = JSON.parse(data);
            return { delta: String(json?.choices?.[0]?.delta?.content ?? ''), done: false };
        } catch { return { delta: '', done: false }; }
    }
    if (resolvedFormat === 'anthropic') {
        try {
            const json = JSON.parse(data);
            if (json?.type === 'message_stop') return { delta: '', done: true };
            if (json?.type === 'content_block_delta') return { delta: String(json?.delta?.text ?? ''), done: false };
            return { delta: '', done: false };
        } catch { return { delta: '', done: false }; }
    }
    // google
    try {
        const json = JSON.parse(data);
        const candidate = json?.candidates?.[0];
        return { delta: String(candidate?.content?.parts?.[0]?.text ?? ''), done: Boolean(candidate?.finishReason) };
    } catch { return { delta: '', done: false }; }
}

/** Defensive reader — a malformed/unexpected response body yields '' rather than throwing, matching `resolveX()`'s contract. */
export function resolveProviderResponseText(format, responseBody) {
    let json;
    try { json = JSON.parse(responseBody); } catch { return ''; }
    const resolvedFormat = resolveProviderFormat(format);
    if (resolvedFormat === 'anthropic') return String(json?.content?.find(block => block.type === 'text')?.text ?? '').trim();
    if (resolvedFormat === 'google') return String(json?.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim();
    return String(json?.choices?.[0]?.message?.content ?? '').trim();
}
