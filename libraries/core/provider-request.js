/**
 * Формат запроса/ответа для API-совместимых удалённых моделей — pure
 * request-shaping, no network of its own (see NAMING_PHILOSOPHY.md:
 * `buildX()`/`computeX()` never reach outside). Ported from Alpha's
 * SidecarService `#openAi`/`#anthropic`/`#google`, split into pure
 * functions so the model Ядра can test request-shaping without a real
 * `fetch` anywhere — the actual HTTP call is the Сервис HTTP's job
 * (services/http.js), reached through the Гейт для сети.
 *
 * Deliberately narrower than Alpha's sampler surface (no reasoning-mode/
 * OpenRouter-specific fields yet) — the essentials that make a `model.generate`
 * request meaningful across all three formats; can grow later if a real
 * caller needs more, per priority #1 (don't build ahead of actual need).
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
        }),
    };
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
        }),
    };
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
