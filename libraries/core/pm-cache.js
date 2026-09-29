import { estimateMessageTokens } from './pm-tokens.js';

/**
 * Анализ кеша префикса (PROMPT_MANAGER_PLAN.md, раздел 0 «Кеш префикса», раздел 11.5).
 * Провайдерный кеш работает по общему НАЧАЛУ запроса: первое отличие ломает всё, что после него.
 * Чистые функции над списками сообщений (`_block` — id блока-источника, `_hid` — сообщение истории).
 */
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

/**
 * По серии запросов находит «изменчивые» блоки (текст менялся хотя бы раз) и считает,
 * сколько стабильных токенов стоят ПОСЛЕ первого изменчивого — их можно вернуть в кеш,
 * если поднять выше (или изменчивое опустить вниз).
 */
export function analyzeStability(requests, count = estimateMessageTokens) {
    if (requests.length < 2) return { volatile: [], recoverableTokens: 0, advice: [] };
    const last = requests.at(-1);
    const volatile = new Set();
    for (let i = 1; i < requests.length; i++) {
        const before = new Map(requests[i - 1].filter(m => m._block).map(m => [m._block, m.content]));
        for (const m of requests[i]) if (m._block && before.has(m._block) && before.get(m._block) !== m.content) volatile.add(m._block);
    }
    const firstVolatile = last.findIndex(m => volatile.has(m._block));
    if (firstVolatile < 0) return { volatile: [], recoverableTokens: 0, advice: [] };
    const stableAfter = last.slice(firstVolatile).filter(m => m._block && !volatile.has(m._block) && m._hid === undefined);
    const recoverableTokens = stableAfter.reduce((sum, m) => sum + count(m), 0);
    const advice = [...new Set(stableAfter.map(m => m._block))].map(block => ({ block, movesAbove: label(last[firstVolatile]) }));
    return { volatile: [...volatile], recoverableTokens, advice };
}
