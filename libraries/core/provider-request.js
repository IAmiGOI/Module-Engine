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
 */
export function buildProviderRequest(worker, request) {
    const format = resolveProviderFormat(worker.format);
    if (format === 'anthropic') return buildAnthropicRequest(worker, request);
    if (format === 'google') return buildGoogleRequest(worker, request);
    return buildOpenAiRequest(worker, request);
}

/** OpenRouter — единственный openai-формат, чей unified `reasoning` мы знаем и на который согласны положиться (см. doc-comment файла). */
function isOpenRouter(endpoint) {
    return /openrouter\.ai/i.test(String(endpoint ?? ''));
}

function buildOpenAiReasoning(worker, request) {
    // Молчим и на "не OpenRouter", и на что угодно, что НЕ прямое явное
    // enabled/disabled — `inherit`, отсутствующее поле, любой мусор. Раньше
    // здесь была проверка только на `!== 'inherit'`, и вызов с пустым/чужим
    // `reasoningMode` (например прямой сбор запроса в обход
    // `resolveGenerateRequest()`, как в тестах) молча уезжал как ВКЛЮЧЁННЫЙ
    // ризонинг — ровно то, чего вызывающий никогда не просил.
    if (!isOpenRouter(worker.endpoint)) return {};
    if (request.reasoningMode !== 'enabled' && request.reasoningMode !== 'disabled') return {};
    return {
        reasoning: {
            enabled: request.reasoningMode === 'enabled',
            effort: request.reasoningEffort,
            ...(request.reasoningBudget ? { max_tokens: request.reasoningBudget } : {}),
        },
    };
}

function buildOpenAiRequest(worker, request) {
    const url = /\/chat\/completions$/.test(worker.endpoint) ? worker.endpoint : `${trimTrailingSlash(worker.endpoint)}/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (worker.apiKey) headers.Authorization = `Bearer ${worker.apiKey}`;
    const messages = request.systemPrompt ? [{ role: 'system', content: request.systemPrompt }] : [];
    messages.push({ role: 'user', content: request.prompt });
    return {
        url, method: 'POST', headers,
        body: JSON.stringify({
            model: worker.model, messages,
            temperature: request.temperature, top_p: request.topP, max_tokens: request.maxTokens,
            ...(request.topK ? { top_k: request.topK } : {}),
            ...(request.seed ? { seed: request.seed } : {}),
            ...buildOpenAiReasoning(worker, request),
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

function buildAnthropicRequest(worker, request) {
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
        }),
    };
}

/** Google: 0 — выключено, -1 — «пусть модель сама решает бюджет» (включено, но без явного числа), положительное число — явный бюджет. Молчим (никакого `thinkingConfig`) на `inherit` и на что угодно, что не прямое явное `enabled`/`disabled` — та же защита, что у остальных форматов. */
function buildGoogleThinking(request) {
    if (request.reasoningMode === 'disabled') return { thinkingConfig: { thinkingBudget: 0 } };
    if (request.reasoningMode !== 'enabled') return {};
    return { thinkingConfig: { thinkingBudget: request.reasoningBudget > 0 ? request.reasoningBudget : -1 } };
}

function buildGoogleRequest(worker, request) {
    const url = `${trimTrailingSlash(worker.endpoint)}/${encodeURIComponent(worker.model)}:generateContent?key=${encodeURIComponent(worker.apiKey ?? '')}`;
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

/** Defensive reader — a malformed/unexpected response body yields '' rather than throwing, matching `resolveX()`'s contract. */
export function resolveProviderResponseText(format, responseBody) {
    let json;
    try { json = JSON.parse(responseBody); } catch { return ''; }
    const resolvedFormat = resolveProviderFormat(format);
    if (resolvedFormat === 'anthropic') return String(json?.content?.find(block => block.type === 'text')?.text ?? '').trim();
    if (resolvedFormat === 'google') return String(json?.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim();
    return String(json?.choices?.[0]?.message?.content ?? '').trim();
}
