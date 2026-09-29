/**
 * Основное подключение SillyTavern как воркер движка — чистые функции, без сети: форма запроса к бэкенду самого ST и разбор его
 * ответа. Ключи и адрес провайдера ST держит у себя на сервере (secrets), поэтому воркеру не нужно ни то, ни другое: запрос идёт на
 * `/api/backends/…/generate` того же сервера, с теми же настройками, что выбраны в ST сейчас. Сменил пользователь модель в ST —
 * воркер сразу ходит в новую.
 *
 * Поля тела — те же, что собирает сам ST (`public/scripts/custom-request.js`: `ChatCompletionService.createRequestData`,
 * `TextCompletionService.createRequestData`, и `presetToGeneratePayload`, откуда список полей адреса у разных источников).
 */

export const ST_MAIN_WORKER_ID = 'st-main';
export const ST_MAIN_FORMAT = 'sillytavern';
export const CHAT_COMPLETIONS_ENDPOINT = '/api/backends/chat-completions/generate';
export const TEXT_COMPLETIONS_ENDPOINT = '/api/backends/text-completions/generate';

/** Поля адреса, которые у разных источников chat completion лежат в настройках ST отдельно (custom-request.js, presetToGeneratePayload). */
const ENDPOINT_FIELDS = ['custom_url', 'vertexai_region', 'zai_endpoint', 'siliconflow_endpoint', 'minimax_endpoint', 'pollinations_endpoint'];
const CUSTOM_SOURCE_FIELDS = ['custom_include_body', 'custom_exclude_body', 'custom_include_headers'];

/** Готовая запись воркера для списка подключений: ни адреса, ни ключа — всё берётся из ST. */
export function stMainWorkerRecord(extra = {}) {
    return { name: 'SillyTavern main connection', ...extra, id: ST_MAIN_WORKER_ID, format: ST_MAIN_FORMAT, endpoint: '', apiKey: '', model: '' };
}

/** Что сейчас выбрано в ST: `{ api, source, model, supported }` — для подписи в панели и проверки до запроса. */
export function describeMainConnection(context) {
    const api = String(context?.mainApi ?? '');
    if (api === 'openai') {
        const settings = context?.chatCompletionSettings ?? {};
        let model = '';
        try { model = String(context?.getChatCompletionModel?.() ?? ''); } catch { model = ''; }
        return { api, source: String(settings.chat_completion_source ?? ''), model, supported: true };
    }
    if (api === 'textgenerationwebui') {
        const settings = context?.textCompletionSettings ?? {};
        return { api, source: String(settings.type ?? ''), model: '', supported: true };
    }
    return { api, source: '', model: '', supported: false };
}

function toMessages({ messages, prompt, systemPrompt }) {
    if (Array.isArray(messages) && messages.length) return messages.map(message => ({ role: message.role, content: String(message.content ?? ''), ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}) }));
    return [
        ...(systemPrompt ? [{ role: 'system', content: String(systemPrompt) }] : []),
        { role: 'user', content: String(prompt ?? '') },
    ];
}

/**
 * `request` = `{ messages?, prompt?, systemPrompt?, maxTokens?, temperature? }` → `{ url, body }` для `fetch` к серверу ST.
 * Бросает, если в ST выбран API, который так не вызвать (Kobold Horde, NovelAI).
 */
export function buildMainConnectionRequest(context, request = {}) {
    const connection = describeMainConnection(context);
    if (!connection.supported) throw new Error(`SillyTavern's main API "${connection.api || 'unknown'}" cannot be used as a worker — switch ST to Chat Completion or Text Completion.`);
    const messages = toMessages(request);
    const maxTokens = Number.isFinite(request.maxTokens) ? request.maxTokens : undefined;
    const temperature = Number.isFinite(request.temperature) ? request.temperature : undefined;
    let body;
    if (connection.api === 'openai') {
        const settings = context.chatCompletionSettings ?? {};
        body = {
            stream: false, messages, model: connection.model || undefined, chat_completion_source: connection.source,
            max_tokens: maxTokens, temperature, reverse_proxy: settings.reverse_proxy, proxy_password: settings.proxy_password,
            use_sysprompt: true,
        };
        for (const field of ENDPOINT_FIELDS) if (settings[field]) body[field] = settings[field];
        if (connection.source === 'custom') for (const field of CUSTOM_SOURCE_FIELDS) if (settings[field]) body[field] = settings[field];
    } else {
        const settings = context.textCompletionSettings ?? {};
        let server = '';
        try { server = String(context.getTextGenServer?.(settings.type) ?? ''); } catch { server = ''; }
        body = {
            stream: false, prompt: messages.map(message => message.content).join('\n\n'),
            max_tokens: maxTokens, max_new_tokens: maxTokens, temperature, api_type: settings.type, api_server: server || undefined,
        };
    }
    for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
    return { url: connection.api === 'openai' ? CHAT_COMPLETIONS_ENDPOINT : TEXT_COMPLETIONS_ENDPOINT, body };
}

function joinParts(parts) {
    return Array.isArray(parts) ? parts.map(part => (typeof part === 'string' ? part : part?.text ?? '')).join('') : '';
}

/** Текст ответа из любой формы, которую отдаёт сервер ST (OpenAI-подобная, Claude, Gemini, text completion разных бэкендов). */
/** Ризонинг ответа (`reasoning_content`, `reasoning` или блоки `thinking`) — пустая строка, если провайдер его не отдал. */
export function extractMainConnectionReasoning(json) {
    const message = json?.choices?.[0]?.message ?? {};
    const direct = message.reasoning_content ?? message.reasoning;
    if (typeof direct === 'string') return direct;
    const blocks = Array.isArray(json?.content) ? json.content : [];
    return blocks.filter(block => block?.type === 'thinking').map(block => block.thinking ?? '').join('\n');
}

export function extractMainConnectionText(json) {
    if (!json || typeof json !== 'object') return '';
    const choice = json.choices?.[0];
    if (choice) {
        const content = choice.message?.content;
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) return joinParts(content);
        if (typeof choice.text === 'string') return choice.text;
    }
    if (Array.isArray(json.content)) return joinParts(json.content);
    if (json.candidates?.[0]?.content?.parts) return joinParts(json.candidates[0].content.parts);
    if (typeof json.results?.[0]?.text === 'string') return json.results[0].text;
    if (typeof json.content === 'string') return json.content;
    if (typeof json.text === 'string') return json.text;
    if (typeof json.output === 'string') return json.output;
    return '';
}
