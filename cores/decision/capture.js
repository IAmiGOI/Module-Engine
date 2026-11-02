import { extractReasoning } from '../../libraries/core/decision-reasoning.js';
import { extractCachedTokens } from '../../libraries/core/decision-cache.js';

/**
 * Ризонинг провайдера за ВЕСЬ цикл: у агента несколько вызовов, их requestId
 * начинаются с `${runId}:`. Текст копится по порядку — это то, что лог
 * хранит как thinking цикла; usage считает расходы.
 */
export function captureReasoning(host, prefix) {
    const state = { value: '', usage: { prompt: 0, completion: 0, cached: 0, total: 0 } };
    const unsubscribe = host.events.subscribe('model.generate.raw', payload => {
        if (!String(payload?.requestId ?? '').startsWith(prefix)) return;
        const extracted = extractReasoning(payload.format, payload.body);
        if (extracted) state.value = state.value ? `${state.value}\n\n${extracted}` : extracted;
        try {
            const usage = JSON.parse(payload.body)?.usage;
            if (usage) {
                state.usage.prompt += Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
                state.usage.completion += Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
                state.usage.cached += Number(extractCachedTokens(usage) ?? 0) || 0;
                state.usage.total = state.usage.prompt + state.usage.completion;
            }
        } catch { /* тело без usage — не ошибка */ }
    });
    return { get value() { return state.value; }, get usage() { return { ...state.usage }; }, stop: unsubscribe };
}
