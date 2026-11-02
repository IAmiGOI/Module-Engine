import { extractReasoning } from '../../libraries/core/decision-reasoning.js';
import { extractCachedTokens } from '../../libraries/core/decision-cache.js';

/**
 * Ризонинг и текст провайдера за ВЕСЬ цикл: у агента несколько вызовов, их
 * requestId начинаются с `${runId}:`. Текст копится по порядку — это то, что
 * лог хранит как thinking цикла; usage считает расходы. При потоке те же
 * данные приходят дельтами (`model.generate.reasoning`/`.chunk`), поэтому
 * окно показывает thinking по мере прихода, а не только после ответа.
 */
export function captureReasoning(host, prefix, { onThinking = () => {}, onAnswer = () => {} } = {}) {
    const state = { value: '', usage: { prompt: 0, completion: 0, cached: 0, total: 0 } };
    const matches = payload => String(payload?.requestId ?? '').startsWith(prefix);
    const addUsage = usage => {
        if (!usage) return;
        state.usage.prompt += Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
        state.usage.completion += Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
        state.usage.cached += Number(extractCachedTokens(usage) ?? 0) || 0;
        state.usage.total = state.usage.prompt + state.usage.completion;
    };
    const subscriptions = [
        host.events.subscribe('model.generate.raw', payload => {
            if (!matches(payload)) return;
            const extracted = extractReasoning(payload.format, payload.body);
            if (extracted) state.value = state.value ? `${state.value}\n\n${extracted}` : extracted;
            if (payload.usage) addUsage(payload.usage);
            else {
                try { addUsage(JSON.parse(payload.body)?.usage); } catch { /* тело без usage — не ошибка */ }
            }
        }),
        host.events.subscribe('model.generate.reasoning', payload => {
            if (!matches(payload) || !payload.delta) return;
            state.value += String(payload.delta);
            onThinking(state.value);
        }),
        host.events.subscribe('model.generate.chunk', payload => {
            if (!matches(payload) || !payload.text) return;
            onAnswer(String(payload.text));
        }),
    ];
    return {
        get value() { return state.value; },
        get usage() { return { ...state.usage }; },
        stop: () => { for (const unsubscribe of subscriptions) unsubscribe(); },
    };
}
