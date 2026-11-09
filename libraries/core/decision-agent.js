import { assistantToolMessage, toolResultMessage } from './provider-tools.js';
import { commentProblem, stripComment } from './decision-tools.js';

/**
 * Один цикл резолвера — вызовы инструментов до `inscribe` или `await`.
 * Чистый цикл: модель приходит снаружи (`generate`), исполнение инструментов —
 * тоже (`handlers` для своих, `callTool` для зарегистрированных через
 * `generation.registerTool`). Поэтому цикл проверяется на фейковой модели и
 * не знает ни шин, ни хранения.
 *
 * Правила (e1):
 *  - каждый вызов обязан нести комментарий; без него вызов не исполняется,
 *    а модели возвращается понятная ошибка;
 *  - ответ без вызова инструмента — не молчаливый конец: движок напоминает
 *    и после `noToolLimit` напоминаний сдаётся предохранителем;
 *  - лимит шагов без `await` — предохранитель, а не бесконечный цикл.
 */

export const TURN_TOOLS = Object.freeze(['inscribe']);

export const REMINDER_NO_TOOL = 'You did not call a tool. Call inscribe to finish the turn, or await to end the cycle. Every call needs a comment of at least one full sentence.';
export const REMINDER_AWAIT = 'You are close to the step limit. Finish the turn with inscribe, or end the cycle with await.';

const MAX_NO_TOOL = 2;

/** Строка от воркера — просто текст без вызова инструмента. */
export function normalizeGenerateAnswer(value) {
    if (typeof value !== 'string') return value;
    return { text: value, toolCalls: [] };
}

export function normalizeAnswer(answer) {
    if (typeof answer === 'string') return { text: answer, toolCalls: [] };
    return { text: String(answer?.text ?? ''), toolCalls: Array.isArray(answer?.toolCalls) ? answer.toolCalls : [] };
}

/**
 * @returns {{type:'submit'|'await'|'guard', reason?:string, form?:object, trace:Array, messages:Array, steps:number, warnings:string[]}}
 */
export async function runDecisionCycle({
    messages = [],
    tools = [],
    generate,
    handlers = {},
    callTool = null,
    maxSteps = 50,
    noToolLimit = MAX_NO_TOOL,
    implicitAwait = false,
    emptyRetry = true,
    stopAfter = [],
    now = () => Date.now(),
    onStep = () => {},
    onToolStart = () => {},
    onModelStart = () => {},
    onModelEnd = () => {},
} = {}) {
    if (typeof generate !== 'function') throw new Error('runDecisionCycle: "generate" must be a function.');
    const conversation = [...messages];
    const trace = [];
    const warnings = [];
    let steps = 0;
    let noTool = 0;
    let emptyRetried = false;

    const record = (entry) => {
        trace.push(entry);
        onStep(entry);
    };

    async function execute(call) {
        const startedAt = now();
        const args = call?.arguments && typeof call.arguments === 'object' ? call.arguments : {};
        onToolStart({ id: call?.id ?? '', name: call?.name ?? '', args, comment: args.comment ?? '', at: startedAt });
        // Аргументы не разобрались даже починкой движка — короткая подсказка модели, а не пустой вызов.
        if (call?.parseError) {
            const error = `Your arguments for "${call.name}" were not valid JSON. Call it again with one JSON object; no prose around it.`;
            record({ name: call.name, args, comment: args.comment ?? '', result: { ok: false, error }, error, durationMs: now() - startedAt, at: startedAt });
            return { ok: false, error };
        }
        const problem = commentProblem(args);
        if (problem) {
            const result = { ok: false, error: problem };
            record({ name: call.name, args, comment: args.comment ?? '', result, error: problem, durationMs: now() - startedAt, at: startedAt });
            return result;
        }
        try {
            let result;
            if (typeof handlers[call.name] === 'function') result = await handlers[call.name](args, { trace, steps });
            else if (typeof callTool === 'function') result = await callTool(call.name, stripComment(args));
            else result = { ok: false, error: `There is no tool named "${call.name}".` };
            record({ name: call.name, args, comment: args.comment, result, error: null, durationMs: now() - startedAt, at: startedAt });
            return result;
        } catch (error) {
            const message = error?.message ?? String(error);
            record({ name: call.name, args, comment: args.comment, result: { ok: false, error: message }, error: message, durationMs: now() - startedAt, at: startedAt });
            return { ok: false, error: message };
        }
    }

    while (steps < maxSteps) {
        steps += 1;
        const modelStartedAt = now();
        onModelStart({ step: steps, at: modelStartedAt });
        let answer;
        try {
            answer = normalizeAnswer(await generate({ messages: conversation, tools, toolChoice: 'auto', stream: true, returnMessage: true }));
        } catch (error) {
            // Упавший запрос к модели не стирает цикл: всё сделанное до него (вызовы, вопросы, ответы) остаётся в записи.
            const reason = error?.message ?? String(error);
            warnings.push(`the model request failed: ${reason}`);
            return { type: 'error', reason, error, trace, messages: conversation, steps, warnings };
        }
        // Пустой ответ — ни текста, ни вызова — почти всегда обрыв по лимиту токенов (ризонинг съел весь лимит).
        // Это не «я закончил»: один повтор с удвоенным лимитом, и честное предупреждение, если не помогло.
        if (emptyRetry && !answer.toolCalls.length && !String(answer.text ?? '').trim() && !emptyRetried) {
            emptyRetried = true;
            warnings.push('the answer came back empty (likely cut off by the token limit); retried with a doubled limit and lower reasoning');
            try {
                answer = normalizeAnswer(await generate({ messages: conversation, tools, toolChoice: 'auto', stream: true, returnMessage: true, boost: 2, lowerReasoning: true }));
            } catch (error) {
                const reason = error?.message ?? String(error);
                warnings.push(`the model request failed: ${reason}`);
                return { type: 'error', reason, error, trace, messages: conversation, steps, warnings };
            }
            if (!answer.toolCalls.length && !String(answer.text ?? '').trim()) warnings.push('the answer was empty again — cut off by the token limit; raise the director max tokens');
        }
        onModelEnd({
            step: steps, at: now(), durationMs: now() - modelStartedAt,
            text: String(answer?.text ?? ''), toolCalls: Array.isArray(answer?.toolCalls) ? answer.toolCalls : [],
        });
        if (!answer.toolCalls.length) {
            if (implicitAwait) {
                warnings.push('the director answered without a tool call; treated as await');
                const said = String(answer.text ?? '').trim();
                if (said) conversation.push({ role: 'assistant', content: said });
                return { type: 'await', reason: answer.text, trace, messages: conversation, steps, warnings, implicit: true };
            }
            noTool += 1;
            record({ name: '__reminder', args: {}, comment: '', result: { ok: false, error: 'no tool call' }, error: 'no tool call', durationMs: 0, at: now() });
            if (noTool > noToolLimit) {
                warnings.push('the director kept answering without a tool call; forced await');
                return { type: 'guard', reason: 'answered without a tool call', trace, messages: conversation, steps, warnings };
            }
            conversation.push({ role: 'user', content: REMINDER_NO_TOOL });
            continue;
        }
        noTool = 0;
        conversation.push(assistantToolMessage({ text: answer.text, toolCalls: answer.toolCalls }));

        for (const call of answer.toolCalls) {
            const result = await execute(call);
            conversation.push(toolResultMessage(call, result));
            if (TURN_TOOLS.includes(call.name) && result?.restart === true) {
                return { type: 'restart', reason: 'characters entered with their banks', trace, messages: conversation, steps, warnings };
            }
            if (TURN_TOOLS.includes(call.name) && result?.ok === true) {
                return { type: 'submit', form: result.form, trace, messages: conversation, steps, warnings };
            }
            if (stopAfter.includes(call.name) && result?.ok === true) {
                return { type: 'await', reason: `${call.name} done`, reply: '', trace, messages: conversation, steps, warnings };
            }
            if (call.name === 'await' && result?.ok !== false) {
                // Ответ пользователю — частью await: модель, которая работает инструментами, заполнит поле надёжнее,
                // чем напишет свободный текст. В ленте и в окне он виден как ответ директора.
                const reply = String(call.arguments?.reply ?? '').trim();
                if (reply) conversation.push({ role: 'assistant', content: reply });
                return { type: 'await', reason: call.arguments?.reason ?? '', reply, trace, messages: conversation, steps, warnings };
            }
        }
        if (steps === maxSteps - 1) conversation.push({ role: 'user', content: REMINDER_AWAIT });
    }

    warnings.push(`the resolver hit the ${maxSteps}-step limit without inscribe or await`);
    return { type: 'guard', reason: `step limit of ${maxSteps} reached`, trace, messages: conversation, steps, warnings };
}
