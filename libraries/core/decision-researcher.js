import { assistantToolMessage, toolResultMessage } from './provider-tools.js';
import { commentProblem } from './decision-tools.js';
import { RESEARCHER_SYSTEM, fillPrompt } from './decision-prompts.js';

/**
 * Веб-субагент директора — свой воркер и те же инструменты, что у гида Mea
 * (`stWebSearch.*`). Задача ставится из директора и живёт в фоне: `start()`
 * возвращается сразу. Не больше двух задач одновременно; третья — отказ, а
 * не ожидание. Не больше `maxSteps` шагов, потом отчёт.
 *
 * Отчёт приходит в лог директора и публикуется событием; ждать его в цикле
 * директора запрещено (это правило его промпта).
 */

const COMMENT = {
    type: 'string',
    description: 'Why you are calling this tool, in at least one full sentence. Required.',
};

function withComment(schema) {
    const parameters = schema.parameters ?? { type: 'object', properties: {} };
    return {
        ...schema,
        parameters: {
            ...parameters,
            properties: { ...(parameters.properties ?? {}), comment: COMMENT },
            required: [...new Set([...(parameters.required ?? []), 'comment'])],
        },
    };
}

export const RESEARCH_TOOLS = Object.freeze([
    withComment({
        name: 'web_search', displayName: 'Search the web',
        description: 'Search the internet. Returns up to six results with titles, addresses and snippets.',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    }),
    withComment({
        name: 'web_open', displayName: 'Open a page',
        description: 'Open a page by address and get its size, outline and beginning. Read more with web_view or web_find.',
        parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    }),
    withComment({
        name: 'web_view', displayName: 'Read a page section',
        description: 'Read a section or a stretch of an opened page.',
        parameters: { type: 'object', properties: { id: { type: 'string' }, section: { type: 'string' }, offset: { type: 'number' }, chars: { type: 'number' } }, required: ['id'] },
    }),
    withComment({
        name: 'web_find', displayName: 'Find on a page',
        description: 'Look for words or meaning on an opened page.',
        parameters: { type: 'object', properties: { id: { type: 'string' }, query: { type: 'string' } }, required: ['id', 'query'] },
    }),
    withComment({
        name: 'finish', displayName: 'Send the report',
        description: 'Finish the task and send the report to the director. Say what you found, what is uncertain, and where it came from.',
        parameters: { type: 'object', properties: { report: { type: 'string' } }, required: ['report'] },
    }),
]);

/** Секция контекста: последние завершённые отчёты; незавершённые — только строкой статуса. */
export function researchSection(tasks, { limit = 5, reportChars = 800 } = {}) {
    const list = Array.isArray(tasks) ? tasks : [];
    if (!list.length) return '';
    const finished = list.filter(task => task.status === 'done').slice(-limit);
    const running = list.filter(task => task.status === 'running');
    const parts = [];
    if (running.length) parts.push(`In progress: ${running.map(task => task.task).join('; ')}`);
    for (const task of finished) parts.push(`[${task.task}]\n${String(task.report ?? '').slice(0, reportChars)}`);
    return parts.length ? `RESEARCHER REPORTS (background; you never wait for them):\n\n${parts.join('\n\n')}` : '';
}

function taskId(now, rid) {
    return `res_${now.toString(36)}_${rid().toString(36).slice(2, 8)}`;
}

export function createResearcher({ call, callService = call, getSettings, getWorkers, store, publishEvent, now = () => Date.now(), rid = Math.random }) {
    const running = new Map();
    const NUDGE = 'Call finish now with your report. Put the whole report into its "report" field.';

    async function execute(name, args) {
        if (name === 'web_search') return callService('stWebSearch.search', { query: args.query });
        if (name === 'web_open') return callService('stWebSearch.open', { url: args.url });
        if (name === 'web_view') return callService('stWebSearch.view', { id: args.id, section: args.section, offset: args.offset, chars: args.chars });
        if (name === 'web_find') return callService('stWebSearch.find', { id: args.id, query: args.query });
        if (name === 'finish') return { ok: true };
        return { ok: false, error: `There is no researcher tool named "${name}".` };
    }

    function workerFor(settings) {
        const workers = getWorkers();
        if (settings.researcher.workerId) return workers.find(worker => worker.id === settings.researcher.workerId) ?? null;
        return workers[0] ?? null;
    }

    async function runTask(task, settings, { system = null } = {}) {
        const worker = workerFor(settings);
        const maxSteps = Math.max(1, Number(task.maxSteps) || settings.researcher.maxSteps);
        let report = '';
        let steps = 0;
        let failure = null;
        let nudged = false;
        const trace = [];
        const systemPrompt = system || fillPrompt(RESEARCHER_SYSTEM, { steps: maxSteps });
        const messages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: `RESEARCH TASK:\n\n${task.task}` }];
        try {
            if (!worker) throw new Error('no researcher worker is configured');
            if (worker.format !== 'openai') throw new Error(`the researcher needs an "openai" worker, "${worker.id}" is "${worker.format}"`);
            while (steps < maxSteps && !report) {
                if (task.controller?.signal.aborted) throw new Error(task.cancelReason || 'cancelled');
                steps += 1;
                const answer = await call('model.generate', {
                    workerId: worker.id, messages, tools: RESEARCH_TOOLS, toolChoice: 'auto',
                    stream: false, returnMessage: true, maxTokens: Number(task.maxTokens) || 2000,
                    ...(task.controller ? { signal: task.controller.signal } : {}),
                });
                if (task.controller?.signal.aborted) throw new Error(task.cancelReason || 'cancelled');
                const calls = Array.isArray(answer?.toolCalls) ? answer.toolCalls : [];
                const text = String(answer?.text ?? '');
                if (!calls.length) {
                    if (text.trim()) { report = text.trim(); break; }
                    // Пустой ответ без инструмента (часто: ризонинг съел лимит) — один раз просим finish, потом сдаёмся.
                    if (nudged) throw new Error('the model returned no report');
                    nudged = true;
                    messages.push({ role: 'user', content: NUDGE });
                    continue;
                }
                messages.push(assistantToolMessage({ text, toolCalls: calls }));
                for (const toolCall of calls) {
                    const args = toolCall.arguments ?? {};
                    const problem = commentProblem(args);
                    let result;
                    if (problem) result = { ok: false, error: problem };
                    else {
                        try { result = await execute(toolCall.name, args); }
                        catch (error) { result = { ok: false, error: error?.message ?? String(error) }; }
                    }
                    trace.push({ name: toolCall.name, args, comment: String(args.comment ?? ''), result, error: problem ?? result?.error ?? null, at: now() });
                    messages.push(toolResultMessage(toolCall, result));
                    if (toolCall.name === 'finish' && !problem) {
                        report = String(args.report ?? '').trim();
                        if (!report) throw new Error('the researcher finished without text');
                        break;
                    }
                }
            }
            if (!report) throw new Error(`the ${maxSteps}-step limit was reached without a report`);
        } catch (error) {
            // Отказ — это ошибка задачи, а не её отчёт: иначе служебная строка становилась «готовым» дата-банком.
            failure = error?.message ?? String(error);
            report = `The researcher failed: ${failure}`;
        }
        const { controller: _controller, ...plain } = task;
        const cancelled = Boolean(task.controller?.signal.aborted);
        const finished = { ...plain, status: cancelled ? 'cancelled' : 'done', report, steps, finishedAt: now(), trace, error: failure };
        await store.updateResearch(task.id, finished).catch(() => {});
        running.delete(task.id);
        // Отменённая задача (ход, который её запустил, упал) директора не будит.
        if (task.notify !== false && !cancelled) publishEvent('decision.researcher.report', { taskId: task.id, task: task.task, report, steps });
        return finished;
    }

    /** Ставит задачу и сразу возвращает id. Третья задача — отказ, не ожидание. */
    /**
     * Ставит задачу и сразу возвращает id. Задачи директора — не больше `maxTasks`, третья — отказ, не ожидание.
     * Сборка дата-банков (`kind: 'bank'`) — свой лимит `bankConcurrency` и не занимает места исследований директора.
     */
    function start({ task, system = null, kind = 'research', notify = true, maxSteps = null, maxTokens = null, runId = null } = {}) {
        const settings = getSettings();
        const text = String(task ?? '').trim();
        if (!text) return { ok: false, error: 'A researcher task needs text.' };
        const isBank = kind === 'bank';
        const sameKind = [...running.values()].filter(item => (item.kind === 'bank') === isBank).length;
        const limit = isBank ? Math.max(1, Number(settings.researcher.bankConcurrency) || 4) : settings.researcher.maxTasks;
        if (sameKind >= limit) {
            return { ok: false, error: isBank ? 'The bank builders are all busy.' : 'Two research tasks are already running — wait for their reports, do not queue a third.' };
        }
        const record = { id: taskId(now(), rid), task: text, kind, notify: notify !== false, status: 'running', steps: 0, startedAt: now(), report: null, maxSteps, maxTokens, runId: runId || null };
        running.set(record.id, { ...record, controller: new AbortController() });
        store.addResearch(record).catch(() => {});
        const done = runTask(running.get(record.id), settings, { system });
        return { ok: true, taskId: record.id, done };
    }

    /** Снять задания, запущенные этим ходом: ход упал или истёк — их отчёты уже никому не нужны. */
    function cancel({ runId, all = false, reason = 'cancelled: the turn that started it failed' } = {}) {
        let count = 0;
        for (const item of running.values()) {
            if (item.controller.signal.aborted) continue;
            if (!all && (!runId || item.runId !== runId)) continue;
            item.cancelReason = reason;
            item.controller.abort(new Error(reason));
            // Слот освобождается сразу: новый чат не ждёт, пока отменённое задание дочитает свой последний запрос.
            if (all) running.delete(item.id);
            count += 1;
        }
        return count;
    }

    return { start, cancel, running: () => [...running.values()].filter(item => item.kind !== 'bank').length, tasks: () => store.research() };
}
