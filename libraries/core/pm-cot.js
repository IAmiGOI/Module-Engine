import { evaluateCondition } from './pm-conditions.js';

/**
 * Guided CoT — скрытая цепочка рассуждений из нескольких шагов (PROMPT_MANAGER_PLAN.md, раздел 7). Чистая логика,
 * запросы к моделям приходят снаружи (`sendStep`). Шаг = узел верхнего уровня раздела CoT пресета (один промпт или группа);
 * шаг уходит как сообщение USER после ВСЕГО основного промпта (кеш префикса не ломается), ответы прошлых шагов и
 * ризонинг провайдера подставляются в следующие. Финальный запрос получает итог шагов одним сообщением.
 *
 * preset.cot: { enabled, mode: 'always'|'trigger'|'manual', condition, steps: [узлы], stepMaxTokens, stepWorkers: {id: workerId},
 *               injectAs: 'system'|'user', display: 'small'|'extended', regen: 'all'|'final', retries }
 */
export const COT_DEFAULTS = Object.freeze({
    enabled: false, mode: 'always', condition: null, steps: [], stepMaxTokens: 1500, stepWorkers: {},
    injectAs: 'system', display: 'small', regen: 'all', retries: 1,
});

export function normalizeCot(cot) {
    return { ...COT_DEFAULTS, ...(cot ?? {}), stepWorkers: { ...(cot?.stepWorkers ?? {}) }, steps: Array.isArray(cot?.steps) ? cot.steps : [] };
}

/** Идёт ли CoT в этой генерации: включён, есть шаги, режим `always` / условие сработало / ручной запуск. */
export function shouldRunCot(cotInput, facts, { manual = false } = {}) {
    const cot = normalizeCot(cotInput);
    if (!cot.enabled || !cot.steps.length) return false;
    if (cot.mode === 'manual') return manual;
    if (manual) return true;
    if (cot.mode === 'trigger') return evaluateCondition(cot.condition, facts);
    return true;
}

/** Ответ провайдера → текст и ризонинг (`reasoning_content` DeepSeek/OpenAI-совместимые, `reasoning` OpenRouter/Z.AI, блоки `thinking` Claude). */
export function extractStepOutput(json) {
    const choice = json?.choices?.[0]?.message ?? {};
    const blocks = Array.isArray(json?.content) ? json.content : Array.isArray(choice.content) ? choice.content : [];
    const text = typeof choice.content === 'string' ? choice.content : blocks.filter(b => b?.type === 'text' || typeof b === 'string').map(b => (typeof b === 'string' ? b : b.text ?? '')).join('');
    const thinking = blocks.filter(b => b?.type === 'thinking').map(b => b.thinking ?? '').join('\n');
    const reasoning = choice.reasoning_content ?? choice.reasoning ?? (thinking || '');
    return { text: String(text ?? ''), reasoning: typeof reasoning === 'string' ? reasoning : '' };
}

/** Сообщения для запроса шага: основной промпт, затем прошлые шаги (ответ + ризонинг), затем промпт шага как USER. */
export function buildStepMessages(baseMessages, priorSteps, stepPrompt) {
    const prior = priorSteps.map(step => ({ role: 'assistant', content: step.text, ...(step.reasoning ? { reasoning_content: step.reasoning } : {}) }));
    return [...baseMessages, ...prior, { role: 'user', content: stepPrompt }];
}

export class CotStepError extends Error {
    constructor(stepIndex, stepName, cause) {
        super(`Guided CoT step ${stepIndex + 1}${stepName ? ` "${stepName}"` : ''} failed: ${cause?.message ?? cause}`);
        this.name = 'CotStepError';
        this.stepIndex = stepIndex;
    }
}

/**
 * Прогон шагов по очереди. `steps` — [{ id, name, prompt }] (текст уже собран), `sendStep(messages, { step, index, maxTokens, workerId })`
 * → { text, reasoning }. Сбой шага: повтор `retries` раз, потом CotStepError (генерацию абортим). `onProgress({ index, total, phase })`.
 */
export async function runCot({ baseMessages, steps, sendStep, cot, onProgress = () => {} }) {
    const settings = normalizeCot(cot);
    const done = [];
    for (let index = 0; index < steps.length; index++) {
        const step = steps[index];
        onProgress({ index, total: steps.length, phase: 'start', name: step.name });
        const messages = buildStepMessages(baseMessages, done, step.prompt);
        let output = null;
        let lastError = null;
        for (let attempt = 0; attempt <= settings.retries && !output; attempt++) {
            try {
                output = await sendStep(messages, { step, index, maxTokens: settings.stepMaxTokens, workerId: settings.stepWorkers[step.id] ?? null });
                if (!output || typeof output.text !== 'string') throw new Error('empty answer');
            } catch (error) { lastError = error; output = null; }
        }
        if (!output) throw new CotStepError(index, step.name, lastError);
        done.push({ id: step.id, name: step.name, text: output.text, reasoning: output.reasoning ?? '' });
        onProgress({ index, total: steps.length, phase: 'done', name: step.name, text: output.text });
    }
    return done;
}

/** Итог шагов одним сообщением для финального запроса (после всей истории). */
export function buildCotInjection(steps, { injectAs = 'system' } = {}) {
    const body = steps.map((step, index) => `<step ${index + 1}${step.name ? ` name="${step.name}"` : ''}>\n${step.text}\n</step ${index + 1}>`).join('\n');
    return { role: injectAs === 'user' ? 'user' : 'system', content: `<guided_thinking>\n${body}\n</guided_thinking>` };
}

/** То, что сохраняется в метаданные сообщения и рисуется свёрнутым блоком в чате (не уходит в историю следующих ходов). */
export function cotRecord(steps, { at = Date.now() } = {}) {
    return { at, steps: steps.map(step => ({ id: step.id, name: step.name, text: step.text, reasoning: step.reasoning || undefined })) };
}
