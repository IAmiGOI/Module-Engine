/**
 * Ответ прозаика в форме, которую ждёт ST. Чистые функции: ни сети, ни
 * Response — только перевод openai-кадров подключения ME в диалект источника,
 * выбранного в ST, и безопасный текст ошибки (без тела запроса и ключей).
 */

const ANTHROPIC_SOURCES = new Set(['claude', 'anthropic']);
const GOOGLE_SOURCES = new Set(['makersuite', 'vertexai', 'google', 'gemini']);
const COHERE_SOURCES = new Set(['cohere']);

export function writerSourceFormat(source) {
    const value = String(source ?? '').toLowerCase();
    if (ANTHROPIC_SOURCES.has(value)) return 'anthropic';
    if (GOOGLE_SOURCES.has(value)) return 'google';
    if (COHERE_SOURCES.has(value)) return 'cohere';
    return 'openai';
}

export function isStreamDone(data) {
    return String(data ?? '').trim() === '[DONE]';
}

/** Ошибка провайдера → короткий текст. Тело ответа целиком не отдаём: в нём может быть что угодно. */
export function providerErrorText(text, status = 0) {
    try {
        const json = JSON.parse(text);
        const message = json?.error?.message ?? json?.message ?? json?.error ?? json?.detail;
        if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 300);
    } catch { /* not JSON */ }
    return status ? `HTTP ${status}` : 'the request failed';
}

export function writerErrorMessage(connectionId, status, text) {
    const name = String(connectionId ?? '').trim() || 'unnamed';
    return `Writer connection "${name}" failed${status ? ` with HTTP ${status}` : ''}: ${providerErrorText(text, status)}`;
}

export function writerErrorBody(message) {
    return { error: { message: String(message ?? 'The writer request failed.') } };
}

/**
 * Один openai-кадр потока → кадр в форме источника ST.
 * `[DONE]` остаётся как есть: ST проверяет его ДО JSON во всех источниках.
 */
export function translateWriterFrame(data, format = 'openai') {
    if (isStreamDone(data)) return '[DONE]';
    let json;
    try { json = JSON.parse(data); } catch { return null; }
    if (json?.error || json?.message || json?.detail) return data;
    const choice = json?.choices?.[0] ?? {};
    const content = String(choice?.delta?.content ?? choice?.message?.content ?? choice?.text ?? '');
    const reasoning = String(choice?.delta?.reasoning_content ?? choice?.delta?.reasoning ?? '');
    if (format === 'openai') return data;
    if (format === 'anthropic') {
        if (!content && !reasoning) return null;
        return JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: content, ...(reasoning ? { thinking: reasoning } : {}) } });
    }
    if (format === 'google') {
        const parts = [];
        if (reasoning) parts.push({ text: reasoning, thought: true });
        if (content) parts.push({ text: content });
        if (!parts.length) return null;
        return JSON.stringify({ candidates: [{ content: { parts } }] });
    }
    if (format === 'cohere') {
        if (!content) return null;
        return JSON.stringify({ delta: { message: { content: { text: content } } } });
    }
    return data;
}

/** JSON-ответ подключения: ST для всех chat-источников читает `choices[0].message.content`. */
export function writerJsonBody(text) {
    try {
        const json = JSON.parse(text);
        if (json && typeof json === 'object') return json;
    } catch { /* not JSON */ }
    return { choices: [{ message: { content: String(text ?? '') } }] };
}
