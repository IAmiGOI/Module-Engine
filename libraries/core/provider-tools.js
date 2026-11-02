/**
 * Инструменты провайдеров (function calling) — формулировка запроса и разбор
 * ответа. Вынесено из `provider-request.js`, чтобы тот не рос за 300 строк и
 * чтобы поддержку `tools` можно было включить **только по явному запросу**:
 * вызывающий без `tools` получает ровно то тело, что получал раньше, байт в
 * байт (важно для всех нынешних потребителей `model.generate`).
 *
 * Чистые функции: ни сети, ни шин. Формат определения — родной для
 * SillyTavern (`{ name, displayName, description, parameters }`), но
 * принимается и уже собранный OpenAI-вариант (`{ type: 'function', … }`).
 */

/** Одно определение инструмента → форма OpenAI `tools[]`. Неизвестный/пустой — `null` (молча отбрасывается). */
export function normalizeToolDefinition(definition) {
    if (!definition || typeof definition !== 'object') return null;
    if (definition.type === 'function' && definition.function) {
        const fn = definition.function;
        if (!String(fn.name ?? '').trim()) return null;
        return { type: 'function', function: { ...fn, name: String(fn.name).trim() } };
    }
    const name = String(definition.name ?? '').trim();
    if (!name) return null;
    return {
        type: 'function',
        function: {
            name,
            description: String(definition.description ?? ''),
            parameters: definition.parameters && typeof definition.parameters === 'object' ? definition.parameters : { type: 'object', properties: {} },
        },
    };
}

/** Есть ли у запроса инструменты, которые надо отправить провайдеру. */
export function hasToolRequest(request) {
    return Array.isArray(request?.tools) && request.tools.length > 0;
}

/**
 * Поля тела OpenAI-запроса, относящиеся к инструментам. Пустой объект, когда
 * `tools` не передан вовсе — тогда тело не меняется ни на байт.
 */
export function buildOpenAiTools(request) {
    if (!hasToolRequest(request)) return {};
    const tools = request.tools.map(normalizeToolDefinition).filter(Boolean);
    if (!tools.length) return {};
    const body = { tools };
    const choice = request.toolChoice;
    if (typeof choice === 'string' && ['auto', 'none', 'required'].includes(choice)) body.tool_choice = choice;
    else if (choice && typeof choice === 'object') body.tool_choice = choice;
    if (typeof request.parallelToolCalls === 'boolean') body.parallel_tool_calls = request.parallelToolCalls;
    return body;
}

function normalizeOpenAiToolCalls(message) {
    const raw = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    return raw.map((call, index) => {
        const fn = call?.function ?? call;
        let args = fn?.arguments;
        if (typeof args === 'string') {
            try { args = JSON.parse(args); } catch { args = {}; }
        }
        return {
            id: String(call?.id ?? `call_${index}`),
            name: String(fn?.name ?? ''),
            arguments: args && typeof args === 'object' ? args : {},
            rawArguments: typeof fn?.arguments === 'string' ? fn.arguments : JSON.stringify(args ?? {}),
        };
    }).filter(call => call.name);
}

function normalizeAnthropicToolCalls(json) {
    const blocks = Array.isArray(json?.content) ? json.content : [];
    return blocks.filter(block => block?.type === 'tool_use').map(block => ({
        id: String(block.id ?? ''),
        name: String(block.name ?? ''),
        arguments: block.input && typeof block.input === 'object' ? block.input : {},
        rawArguments: JSON.stringify(block.input ?? {}),
    })).filter(call => call.name);
}

function normalizeGoogleToolCalls(json) {
    const parts = json?.candidates?.[0]?.content?.parts ?? [];
    return parts.filter(part => part?.functionCall).map((part, index) => ({
        id: String(part.functionCall.id ?? `call_${index}`),
        name: String(part.functionCall.name ?? ''),
        arguments: part.functionCall.args && typeof part.functionCall.args === 'object' ? part.functionCall.args : {},
        rawArguments: JSON.stringify(part.functionCall.args ?? {}),
    })).filter(call => call.name);
}

/**
 * Ответ провайдера → `{ text, toolCalls, finishReason }`. `text` — то же, что
 * вернул бы `resolveProviderResponseText()`, то есть старый контракт не
 * теряется; `toolCalls` — нормализованные вызовы. Мусор даёт пустой ответ,
 * а не исключение (тот же договор, что у остальных `resolveX()`).
 */
export function resolveProviderResponseMessage(format, responseBody) {
    let json;
    try { json = JSON.parse(responseBody); } catch { return { text: '', toolCalls: [], finishReason: null }; }
    const resolved = String(format ?? 'openai');
    if (resolved === 'anthropic') {
        const text = String((json?.content ?? []).find(block => block?.type === 'text')?.text ?? '').trim();
        return { text, toolCalls: normalizeAnthropicToolCalls(json), finishReason: json?.stop_reason ?? null };
    }
    if (resolved === 'google') {
        const candidate = json?.candidates?.[0];
        const text = String(candidate?.content?.parts?.find(part => typeof part?.text === 'string')?.text ?? '').trim();
        return { text, toolCalls: normalizeGoogleToolCalls(json), finishReason: candidate?.finishReason ?? null };
    }
    const choice = json?.choices?.[0];
    const message = choice?.message ?? {};
    const text = String(message?.content ?? '').trim();
    const legacy = message?.function_call ? [{ id: 'call_legacy', function: message.function_call }] : null;
    return {
        text,
        toolCalls: normalizeOpenAiToolCalls({ tool_calls: message?.tool_calls ?? legacy ?? [] }),
        finishReason: choice?.finish_reason ?? null,
    };
}

/** Сообщение ассистента для следующего круга диалога — в форме OpenAI, как его примет `model.generate.messages`. */
export function assistantToolMessage({ text = '', toolCalls = [] } = {}) {
    return {
        role: 'assistant',
        content: String(text ?? ''),
        ...(toolCalls.length ? {
            tool_calls: toolCalls.map(call => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: call.rawArguments ?? JSON.stringify(call.arguments ?? {}) },
            })),
        } : {}),
    };
}

/** Сообщение с результатом инструмента — `role: 'tool'` с тем же `tool_call_id`. */
export function toolResultMessage(call, result) {
    return {
        role: 'tool',
        tool_call_id: call.id,
        name: call.name,
        content: typeof result === 'string' ? result : JSON.stringify(result ?? null),
    };
}
