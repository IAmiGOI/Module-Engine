import { assistantToolMessage, toolResultMessage } from './provider-tools.js';
import { commentProblem, stripComment } from './decision-tools.js';

/**
 * Один цикл директора — вызовы инструментов до `submit_turn` или `await`.
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

export const REMINDER_NO_TOOL = 'You did not call a tool. Call submit_turn to finish the turn, or await to end the cycle. Every call needs a comment of at least one full sentence.';
export const REMINDER_AWAIT = 'You are close to the step limit. Finish the turn with submit_turn, or end the cycle with await.';

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
    now = () => Date.now(),
    onStep = () => {},
} = {}) {
    if (typeof generate !== 'function') throw new Error('runDecisionCycle: "generate" must be a function.');
    const conversation = [...messages];
    const trace = [];
    const warnings = [];
    let steps = 0;
    let noTool = 0;

    const record = (entry) => {
        trace.push(entry);
        onStep(entry);
    };

    async function execute(call) {
        const startedAt = now();
        const args = call?.arguments && typeof call.arguments === 'object' ? call.arguments : {};
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
        const answer = normalizeAnswer(await generate({ messages: conversation, tools, toolChoice: 'auto', stream: false, returnMessage: true }));
        if (!answer.toolCalls.length) {
            if (implicitAwait) {
                warnings.push('the director answered without a tool call; treated as await');
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
            if (call.name === 'submit_turn' && result?.ok === true) {
                return { type: 'submit', form: result.form, trace, messages: conversation, steps, warnings };
            }
            if (call.name === 'await' && result?.ok !== false) {
                return { type: 'await', reason: call.arguments?.reason ?? '', trace, messages: conversation, steps, warnings };
            }
        }
        if (steps === maxSteps - 1) conversation.push({ role: 'user', content: REMINDER_AWAIT });
    }

    warnings.push(`the director hit the ${maxSteps}-step limit without submit_turn or await`);
    return { type: 'guard', reason: `step limit of ${maxSteps} reached`, trace, messages: conversation, steps, warnings };
}
