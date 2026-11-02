import { extractMainConnectionReasoning } from './st-main-request.js';

/**
 * Ризонинг провайдера из сырого тела ответа — защитное чтение: не JSON,
 * стриминговые SSE-кадры и незнакомая форма дают пустую строку, а не
 * исключение. Запись прогона директора хранит эту строку рядом с решением.
 */
function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function fromOpenAi(json) {
    const message = json?.choices?.[0]?.message ?? {};
    const direct = text(message.reasoning_content) || text(message.reasoning);
    if (direct) return direct;
    if (Array.isArray(message.content)) {
        return message.content
            .filter(part => part?.type === 'thinking' || part?.type === 'reasoning')
            .map(part => text(part.thinking) || text(part.text))
            .filter(Boolean)
            .join('\n');
    }
    return '';
}

function fromAnthropic(json) {
    return (Array.isArray(json?.content) ? json.content : [])
        .filter(block => block?.type === 'thinking')
        .map(block => text(block.thinking))
        .filter(Boolean)
        .join('\n');
}

function fromGoogle(json) {
    const parts = json?.candidates?.[0]?.content?.parts;
    return (Array.isArray(parts) ? parts : [])
        .filter(part => part?.thought === true)
        .map(part => text(part.text))
        .filter(Boolean)
        .join('\n');
}

export function extractReasoning(format, rawBody) {
    let json;
    try { json = JSON.parse(String(rawBody ?? '')); }
    catch { return ''; }
    if (!json || typeof json !== 'object') return '';
    if (format === 'anthropic') return fromAnthropic(json);
    if (format === 'google') return fromGoogle(json);
    if (format === 'sillytavern') {
        try { return text(extractMainConnectionReasoning(json)); }
        catch { return ''; }
    }
    return fromOpenAi(json);
}
