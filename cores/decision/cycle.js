import { runDecisionCycle } from '../../libraries/core/decision-agent.js';
import { DIRECTOR_PASSIVE, fillPrompt } from '../../libraries/core/decision-prompts.js';
import { createCycleRecord } from '../../libraries/core/decision-log.js';
import { buildPush } from '../../libraries/core/decision-push.js';
import { duePlans } from '../../libraries/core/decision-library.js';
import { createHandlers } from './handlers.js';
import { createCompaction } from './compaction.js';
import { createJudge } from './judge.js';
import { createPlaceReader, createTimeReader, createSimilarity } from './readers.js';
import { createCycleLive } from './live.js';
import { createWakeQueue } from './queue.js';
import { createCycleContext, fallbackDecision, turnWake, wakeFor } from './cycle-context.js';

/**
 * Активный и пассивный циклы директора. Здесь только оркестровка: контекст,
 * модель, инструменты, лог. Исполнители инструментов — в `handlers.js`,
 * сборка контекста — в `cycle-context.js`.
 */

const OPENAI_FORMAT = 'openai';

/** Ошибка настройки: воркера директора нет или он не `openai`. От неё не помогает повтор. */
export class DecisionConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = 'DecisionConfigError';
        this.code = 'decision-config';
    }
}

export function createDecisionCycle({ call, callTool, getSettings, getWorkers, store, researcher = null, publishEvent, usage = () => null, now = () => Date.now() }) {
    const assessments = new Map();
    const state = { assessments, assessmentCounter: 0, turnCounter: 0, runId: '' };
    const wakeQueue = createWakeQueue({ enqueue: job => enqueueBackground(job), publishEvent });
    const live = createCycleLive({ publishEvent, getTurn: () => state.turnCounter, getClock: () => store.clock().minutes });
    const context = createCycleContext({ call, store });
    const resolvePlace = createPlaceReader(call);
    const lastTimeMark = createTimeReader(call);
    const similarityScores = createSimilarity(call);

    function deciderWorker(settings) {
        const id = String(settings.decider.workerId ?? '').trim();
        if (!id) throw new DecisionConfigError('Decision core: no director worker is configured — choose one in the Director / Writer card.');
        const worker = getWorkers().find(item => item.id === id);
        if (!worker) throw new DecisionConfigError(`Decision core: the director worker "${id}" is not available — choose an existing connection in the Director / Writer card.`);
        if (worker.format !== OPENAI_FORMAT) throw new DecisionConfigError(`Decision core: the director needs an "openai" worker with multi-turn tools; "${worker.id}" is "${worker.format}". Choose an openai connection in the Director / Writer card.`);
        return worker;
    }

    const { maybeCompactLog } = createCompaction({ store, getSettings, deciderWorker, call, now, publishEvent });
    const { judgeForcedMemory } = createJudge({ getSettings, deciderWorker, call, now, publishEvent });

    function handlersFor(settings) {
        return createHandlers({ store, call, publishEvent, getSettings, state, resolvePlace, lastTimeMark, similarityScores, researcher });
    }

    function cycleRecord({ runId, event, result, thinking, wake, startedAt, workerId, usage: runUsage, contextMessages = [] }) {
        const form = result.type === 'submit' ? (result.form ?? {}) : null;
        const push = form
            ? buildPush({ form, assessments, place: form.meta?.place ?? '', timeBefore: form.meta?.timeBefore ?? '', timeAfter: form.meta?.timeAfter ?? '' })
            : '';
        if (form) form.push = push;
        const endedAt = now();
        const cycle = createCycleRecord({
            runId, event, messages: result.messages.slice(contextMessages.length), toolCalls: result.trace,
            thinking: typeof thinking === 'function' ? thinking() : thinking, warnings: result.warnings, at: startedAt,
            usage: typeof runUsage === 'function' ? runUsage() : runUsage,
            form, push, wake, turn: state.turnCounter, clockMinutes: store.clock().minutes,
            workerId, endedAt, durationMs: endedAt - startedAt,
        });
        return { cycle, form, push };
    }

    async function runCycle({ chat, runId, type = 'normal', thinking = () => '', usage: runUsage = usage, toolFilter = null, lorebook = true, wake = null }) {
        const settings = getSettings();
        const worker = deciderWorker(settings);
        state.runId = runId;
        wakeQueue.begin();
        const startedWake = wake ?? turnWake(type);
        const startedAt = now();
        live.started({ runId, event: type === 'normal' ? 'turn' : type, wake: startedWake, at: startedAt, type });
        const built = await context.runContext({ settings, chat, lorebook, worker });
        const tools = await context.toolsFor(settings, { filter: toolFilter });
        const controller = new AbortController();
        const hooks = live.hooks({ runId, thinking });
        const agent = runDecisionCycle({
            messages: built.messages,
            tools,
            generate: context.generateFor({ settings, worker, runId, prefix: '', startedAt, effort: settings.adaptiveReasoning ? 'low' : null, signal: controller.signal }),
            handlers: handlersFor(settings),
            callTool,
            maxSteps: settings.maxSteps,
            implicitAwait: Boolean(settings.implicitAwait),
            now,
            ...hooks,
        });
        let timer = null;
        const timeout = new Promise(resolve => { timer = setTimeout(() => resolve({ type: 'timeout', reason: 'form timeout', trace: [], warnings: [], steps: 0, messages: built.messages }), settings.formTimeoutMs); });
        let result;
        try {
            result = await Promise.race([agent, timeout]);
        } finally {
            // Даже если агент упал, таймер не должен держать процесс живым.
            if (timer) clearTimeout(timer);
        }

        if (result.type === 'timeout') {
            controller.abort(new Error('form timeout'));
            agent.catch(() => {});
            const draft = store.draft();
            if (!settings.turnDraft || !draft) throw new Error(`The director did not submit the turn within ${settings.formTimeoutMs} ms.`);
            const form = {
                ...draft,
                scene: { minutes: Number(draft.scene?.minutes) || 0, ...(draft.scene ?? {}) },
                characters: Array.isArray(draft.characters) ? draft.characters : [],
                meta: { place: draft.scene?.place ?? '', timeBefore: '', timeAfter: '', clockMinutes: store.clock().minutes },
            };
            const push = buildPush({ form, assessments });
            form.push = push;
            await store.saveDraft(null).catch(() => {});
            const startedCycle = cycleRecord({
                runId, event: type === 'normal' ? 'turn' : type, result: { ...result, type: 'await', messages: [], trace: [] },
                thinking: thinking(), wake: startedWake, startedAt, workerId: worker.id, usage: runUsage,
            });
            const warnings = ['the form timed out; the saved draft was used'];
            const cycle = { ...startedCycle.cycle, form, push, warnings };
            await store.appendCycle(cycle).catch(() => {});
            live.form({ runId, form, push });
            live.finished({ cycle });
            wakeQueue.rest();
            publishEvent('decision.cycle.draft_used', { runId, minutes: form.scene.minutes });
            return { ok: true, form, push, decision: fallbackDecision(form), trace: [], warnings, steps: 0, workerId: worker.id, draft: true };
        }

        const { cycle, form, push } = cycleRecord({
            runId, event: type === 'normal' ? 'turn' : type, result, thinking,
            wake: startedWake, startedAt, workerId: worker.id, usage: runUsage, contextMessages: built.messages,
        });
        await store.appendCycle(cycle).catch(() => {});
        await maybeCompactLog().catch(error => publishEvent('decision.log.warning', { reason: `log compaction failed: ${error?.message ?? error}` }));
        if (form) live.form({ runId, form, push });
        live.finished({ cycle });
        wakeQueue.rest();

        if (result.type !== 'submit') {
            publishEvent('decision.cycle.ended', { runId, type: result.type, reason: result.reason, steps: result.steps });
            return { ok: false, reason: result.reason, trace: result.trace, warnings: result.warnings, steps: result.steps, workerId: worker.id };
        }
        const decision = fallbackDecision(form);
        publishEvent('decision.cycle.submitted', { runId, type, steps: result.steps, characters: form.characters?.length ?? 0 });
        return { ok: true, form, push, decision, trace: result.trace, warnings: result.warnings, steps: result.steps, workerId: worker.id };
    }

    async function run(options) {
        try {
            return await runCycle(options);
        } catch (error) {
            wakeQueue.rest();
            live.failed({ runId: options?.runId, message: error?.message ?? String(error) });
            throw error;
        }
    }

    let backgroundTail = Promise.resolve();

    /** Фоновый цикл (планы, отчёт субагента, сообщение пользователя) — строго по одному, не в ходу прозаика. */
    function enqueueBackground(run) {
        const job = backgroundTail.then(run, run);
        backgroundTail = job.then(() => {}, () => {});
        return job;
    }

    async function backgroundRun({ runId, event, task, thinking = () => '', wake = null }) {
        const settings = getSettings();
        const worker = deciderWorker(settings);
        state.runId = runId;
        wakeQueue.begin();
        const startedWake = wake ?? wakeFor({ type: event, label: `The director woke up: ${event}` });
        const startedAt = now();
        live.started({ runId, event, wake: startedWake, at: startedAt });
        const built = await context.runContext({ settings, task, worker });
        const tools = await context.toolsFor(settings, { background: true });
        const hooks = live.hooks({ runId, thinking });
        const result = await runDecisionCycle({
            messages: built.messages,
            tools,
            generate: context.generateFor({ settings, worker, runId, prefix: 'p', startedAt, effort: settings.adaptiveReasoning ? 'high' : null }),
            handlers: handlersFor(settings),
            callTool,
            maxSteps: settings.maxSteps,
            implicitAwait: true,
            now,
            ...hooks,
        });
        const { cycle } = cycleRecord({
            runId, event, result, thinking, wake: startedWake, startedAt,
            workerId: worker.id, usage: usage(), contextMessages: built.messages,
        });
        await store.appendCycle(cycle).catch(() => {});
        await maybeCompactLog().catch(error => publishEvent('decision.log.warning', { reason: `log compaction failed: ${error?.message ?? error}` }));
        live.finished({ cycle });
        wakeQueue.rest();
        publishEvent('decision.passive.ended', { runId, event, steps: result.steps, type: result.type });
        return { skipped: false, steps: result.steps, type: result.type };
    }

    /** Пассивный цикл: только если есть завершившиеся планы. */
    function runPassive({ runId, thinking = () => '' } = {}) {
        return wakeQueue.schedule(() => {
            const clock = store.clock();
            const due = duePlans(store.plans(), clock.minutes);
            if (!due.length) return { skipped: true, due: 0 };
            const dueText = due.map(plan => `- ${plan.character} (level ${plan.level}): ${plan.summary}${plan.needsNewPlan ? ' [left the active roster — a new plan is needed]' : ''}`).join('\n');
            const draftLine = getSettings().turnDraft ? '\nBefore await, if you can guess the likely next turn, call save_draft with it.' : '';
            return backgroundRun({
                runId, event: 'time', thinking,
                wake: wakeFor({ type: 'time', label: 'The clock moved', detail: dueText }),
                task: fillPrompt(DIRECTOR_PASSIVE, { event: `${dueText}${draftLine}` }),
            });
        });
    }

    /** Старт по набору текста: подготовить заготовку хода заранее (настройка, по умолчанию выключена). */
    function runDraft({ runId } = {}) {
        return wakeQueue.schedule(() => backgroundRun({
            runId: runId ?? `typing_${now()}`,
            event: 'typing',
            wake: wakeFor({ type: 'typing', label: 'The user is typing' }),
            task: 'The user is typing. Prepare a draft of the likely next decisions. If turn drafting is on, call save_draft with it, then await. Do not submit a turn.',
        }));
    }

    /** Отчёт субагента будит директора; во время хода ждёт в очереди. */
    function onResearcherReport(payload = {}) {
        const task = String(payload.task ?? '');
        const report = String(payload.report ?? '');
        return wakeQueue.schedule(() => backgroundRun({
            runId: `researcher_${payload.taskId ?? 'task'}`,
            event: 'researcher',
            wake: wakeFor({ type: 'researcher', label: 'A researcher reported', detail: report, task }),
            task: fillPrompt(DIRECTOR_PASSIVE, { event: `A researcher reported:\n${report}` }),
        }));
    }

    /** Сообщение пользователя директору: в лог сразу, пробуждение — в очередь. */
    async function sendMessage({ text } = {}) {
        const clean = String(text ?? '').trim();
        if (!clean) return { ok: false, error: 'An empty message is not sent.' };
        const at = now();
        const record = createCycleRecord({
            event: 'message', message: { text: clean, at }, at, endedAt: at, durationMs: 0,
            wake: wakeFor({ type: 'message', label: 'A message from the user', detail: clean }),
            turn: state.turnCounter, clockMinutes: store.clock().minutes,
            workerId: getSettings().decider.workerId || null,
        });
        try { await store.appendCycle(record); } catch { /* the wake still runs */ }
        publishEvent('decision.message.added', { record });
        const runId = `message_${at.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        wakeQueue.schedule(() => backgroundRun({
            runId, event: 'message',
            wake: wakeFor({ type: 'message', label: 'A message from the user', detail: clean, text: clean }),
            task: fillPrompt(DIRECTOR_PASSIVE, {
                event: `The user wrote to you directly, outside the story:\n\n${clean}\n\nTreat it as direction for where the story should go, not as an order.`,
            }),
        })).catch(error => live.failed({ runId, message: error?.message ?? String(error) }));
        return { ok: true, record };
    }

    return {
        run, runPassive, runDraft, onResearcherReport, sendMessage, judgeForcedMemory,
        assessments: () => new Map(assessments), resetAssessments: () => assessments.clear(),
        waiting: () => ({ awaiting: wakeQueue.isAwaiting(), queued: wakeQueue.queued() }),
    };
}
