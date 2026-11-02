import { estimateTokens } from './token-estimate.js';

/**
 * Кеш префикса: что общего у двух подряд идущих запросов и сколько токенов
 * ответа провайдер взял из кеша. Чистые функции над списками сообщений
 * (`_block` — id блока-источника, `_hid` — сообщение истории).
 *
 * Провайдерный кеш работает по общему НАЧАЛУ запроса: первое отличие ломает
 * всё, что после него.
 */
const MESSAGE_OVERHEAD = 4;

export function estimateMessageTokens(message) {
    let total = MESSAGE_OVERHEAD + estimateTokens(typeof message.content === 'string' ? message.content : '');
    if (Array.isArray(message.content)) for (const part of message.content) total += estimateTokens(part?.text ?? '') + (part?.type === 'image_url' ? 85 : 0);
    if (message.tool_calls) total += estimateTokens(JSON.stringify(message.tool_calls));
    return total;
}

const sameMessage = (a, b) => a.role === b.role && (a.content ?? '') === (b.content ?? '')
    && JSON.stringify(a.tool_calls ?? null) === JSON.stringify(b.tool_calls ?? null) && (a.tool_call_id ?? '') === (b.tool_call_id ?? '');

const label = message => message?._block ?? (message?._hid !== undefined ? `history #${message._hid}` : 'unknown');

/** Сравнение двух подряд идущих запросов: общий префикс, точка расхождения, блок-виновник. */
export function compareRequests(previous, next, count = estimateMessageTokens) {
    let shared = 0;
    while (shared < previous.length && shared < next.length && sameMessage(previous[shared], next[shared])) shared++;
    const sharedTokens = next.slice(0, shared).reduce((sum, m) => sum + count(m), 0);
    const totalTokens = next.reduce((sum, m) => sum + count(m), 0);
    const identical = shared === previous.length && shared === next.length;
    let culprit = null;
    if (!identical) {
        const was = previous[shared], now = next[shared];
        culprit = { index: shared, block: label(now ?? was), reason: !was ? 'appended' : !now ? 'removed at the end' : label(was) !== label(now) ? 'different block in this place' : 'content changed' };
    }
    return { identical, sharedMessages: shared, sharedTokens, totalTokens, ratio: totalTokens ? sharedTokens / totalTokens : 1, culprit };
}

/** Сколько токенов провайдер взял из кеша — из блока `usage` ответа (разные формы у разных API). */
export function extractCachedTokens(usage) {
    if (!usage || typeof usage !== 'object') return null;
    const candidates = [usage.prompt_tokens_details?.cached_tokens, usage.cached_tokens, usage.prompt_cache_hit_tokens, usage.cache_read_input_tokens, usage.cachedContentTokenCount];
    const found = candidates.find(value => Number.isFinite(value));
    return found ?? null;
}
