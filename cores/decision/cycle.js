import { createKnowledge } from './knowledge.js';
import { runDecisionCycle } from '../../libraries/core/decision-agent.js';
import { ASK_USER_STREAK, DIRECTOR_PASSIVE, DIRECTOR_REROLL, DIRECTOR_TURN, fillPrompt } from '../../libraries/core/decision-prompts.js';
import { createCycleRecord } from '../../libraries/core/decision-log.js';
import { createFailureRecorder, withRequiredReply } from './cycle-failure.js';
import { buildPush } from '../../libraries/core/decision-push.js';
import { createHandlers } from './handlers.js';
import { createCycleJobs } from './cycle-jobs.js';
import { createTurnWindow } from './window.js';
import { createJudge } from './judge.js';
import { createPlaceReader, createTimeReader } from './readers.js';
import { createCycleLive } from './live.js';
import { createWakeQueue } from './queue.js';
import { createCycleContext, fallbackDecision, turnWake, wakeFor } from './cycle-context.js';
import { createFormChecker } from './form-check.js';
import { createQuestionQueue } from './questions.js';

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

export function createDecisionCycle({ call, callTool, callService = null, getSettings, getWorkers, store, researcher = null, banks = null, publishEvent, usage = () => null, capture = null, now = () => Date.now() }) {
    const assessments = new Map();
    const state = { assessments, assessmentCounter: 0, turnCounter: 0, runId: '' };
    const wakeQueue = createWakeQueue({ enqueue: job => enqueueBackground(job), publishEvent });
    const live = createCycleLive({ publishEvent, getTurn: () => state.turnCounter, getClock: () => store.clock().minutes });
    const context = createCycleContext({ call, store, banks });
    const resolvePlace = createPlaceReader(call);
    const lastTimeMark = createTimeReader(call);

    function deciderWorker(settings) {
        const id = String(settings.decider.workerId ?? '').trim();
        if (!id) throw new DecisionConfigError('Decision core: no director worker is configured — choose one in the Director / Writer card.');
        const worker = getWorkers().find(item => item.id === id);
        if (!worker) throw new DecisionConfigError(`Decision core: the director worker "${id}" is not available — choose an existing connection in the Director / Writer card.`);
        if (worker.format !== OPENAI_FORMAT) throw new DecisionConfigError(`Decision core: the director needs an "openai" worker with multi-turn tools; "${worker.id}" is "${worker.format}". Choose an openai connection in the Director / Writer card.`);
        return worker;
    }

    const knowledge = createKnowledge({ call, store, banks, now });
    const formChecker = createFormChecker({ call, getSettings, banks, knowledge });
    const questions = createQuestionQueue({ callService, publishEvent, now });
    // Эпоха чата: смена чата её увеличивает. Фоновый цикл старого чата обрывается и ничего не пишет в новый.
    let chatEpoch = 0;
    let backgroundController = null;
    function chatChanged() {
        chatEpoch += 1;
        backgroundController?.abort(new Error('the chat was changed'));
        backgroundController = null;
        questions.cancelAll();
    }
    const turnWindow = createTurnWindow({ store, banks, call, getSettings, deciderWorker, publishEvent, now });
    const { judgeForcedMemory } = createJudge({ getSettings, deciderWorker, call, now, publishEvent });

    const recordFailure = createFailureRecorder({ store, state, getSettings, now });

    function handlersFor(settings) {
        return withQuestionStreak({
            ...createHandlers({ store, call, publishEvent, getSettings, state, resolvePlace, lastTimeMark, researcher, banks, window: turnWindow, formChecker, questions }),
            ...knowledge.handlers,
        });
    }

    // Не больше двух вопросов подряд: третий ask_user без другой работы между ними — отказ инструмента.
    // Счётчик сбрасывает любой другой вызов.
    const MAX_QUESTIONS_IN_A_ROW = 2;
    function withQuestionStreak(handlers) {
        return Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, async (args, extra) => {
            if (name !== 'ask_user') { state.questionStreak = 0; return handler(args, extra); }
            if ((state.questionStreak ?? 0) >= MAX_QUESTIONS_IN_A_ROW) return { ok: false, error: ASK_USER_STREAK };
            const result = await handler(args, extra);
            if (result?.asked) state.questionStreak = (state.questionStreak ?? 0) + 1;
            return result;
        }]));
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
            thinking: typeof thinking === 'function' ? thinking() : thinking,
            warnings: [...(result.warnings ?? []), ...(state.formWarnings ?? [])], at: startedAt,
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
        state.sceneText = context.sceneText(chat);
        state.formWarnings = [];
        state.knowledgeReturns = new Set();
        const lastUser = [...(Array.isArray(chat) ? chat : [])].reverse().find(entry => entry?.is_user === true);
        state.canAsk = /\(\s*ooc\s*:/i.test(String(lastUser?.mes ?? lastUser?.content ?? ''));
        state.canWriteBrief = state.canAsk;
        state.questionCount = 0;
        state.questionStreak = 0;
        state.questionLimit = settings.bootstrap?.maxQuestions ?? 5;
        state.briefWritten = false;
        wakeQueue.begin();
        const startedWake = wake ?? turnWake(type);
        const startedAt = now();
        live.started({ runId, event: type === 'normal' ? 'turn' : type, wake: startedWake, at: startedAt, type });
        const reroll = type === 'regenerate' || type === 'swipe';
        const built = await context.runContext({ settings, chat, lorebook, worker, reroll, task: reroll ? `${DIRECTOR_TURN}\n\n${DIRECTOR_REROLL}` : '' });
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
            if (!settings.turnDraft || !draft) {
                const seconds = Math.round(Number(settings.formTimeoutMs) / 1000);
                const error = new Error(`The director did not finish the turn within ${seconds} s. Press Regenerate to try again.`);
                error.code = 'decision-timeout';
                throw error;
            }
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
        if (form) live.form({ runId, form, push });
        live.finished({ cycle });
        wakeQueue.rest();

        if (result.type !== 'submit') {
            if (result.type === 'error') researcher?.cancel?.({ runId });
            publishEvent('decision.cycle.ended', { runId, type: result.type, reason: result.reason, steps: result.steps });
            return { ok: false, reason: result.reason, trace: result.trace, warnings: result.warnings, steps: result.steps, workerId: worker.id };
        }
        const decision = fallbackDecision(form);
        publishEvent('decision.cycle.submitted', { runId, type, steps: result.steps, characters: form.characters?.length ?? 0 });
        return { ok: true, form, push, decision, trace: result.trace, warnings: result.warnings, steps: result.steps, workerId: worker.id };
    }

    async function run(options) {
        const startedAt = now();
        try {
            return await runCycle(options);
        } catch (error) {
            const message = error?.message ?? String(error);
            researcher?.cancel?.({ runId: options?.runId });
            wakeQueue.rest();
            await recordFailure({ runId: options?.runId, event: options?.type && options.type !== 'normal' ? options.type : 'turn', wake: options?.wake ?? turnWake(options?.type ?? 'normal'), startedAt, message });
            live.failed({ runId: options?.runId, message });
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

    async function backgroundRun({ runId, event, task, thinking: givenThinking = null, wake = null, canAsk = false, maxSteps = null }) {
        const captured = typeof capture === 'function' && !givenThinking
            ? capture(`${runId}:`, { onThinking: text => publishEvent('decision.cycle.thinking', { runId, text }) })
            : null;
        const thinking = givenThinking ?? (() => captured?.value ?? '');
        const epoch = chatEpoch;
        const controller = new AbortController();
        backgroundController = controller;
        const stale = () => epoch !== chatEpoch;
        const runUsage = () => (captured ? captured.usage : usage());
        const settings = getSettings();
        const worker = deciderWorker(settings);
        state.runId = runId;
        state.canAsk = canAsk;
        state.canWriteBrief = canAsk;
        state.questionCount = 0;
        state.questionStreak = 0;
        state.questionLimit = settings.bootstrap?.maxQuestions ?? 5;
        state.briefWritten = false;
        state.sceneText = '';
        wakeQueue.begin();
        const startedWake = wake ?? wakeFor({ type: event, label: `The director woke up: ${event}` });
        const startedAt = now();
        live.started({ runId, event, wake: startedWake, at: startedAt });
        let result;
        try {
            const built = await context.runContext({ settings, task, worker });
            const tools = await context.toolsFor(settings, { background: true });
            const hooks = live.hooks({ runId, thinking });
            result = await runDecisionCycle({
                messages: built.messages,
                tools,
                generate: context.generateFor({ settings, worker, runId, prefix: 'p', startedAt, effort: settings.adaptiveReasoning ? 'high' : null, signal: controller.signal }),
                handlers: event === 'message' ? withRequiredReply(handlersFor(settings)) : handlersFor(settings),
                callTool,
                maxSteps: maxSteps ?? settings.maxSteps,
                implicitAwait: true,
                now,
                ...hooks,
            });
            const { cycle } = cycleRecord({
                runId, event, result, thinking, wake: startedWake, startedAt,
                workerId: worker.id, usage: runUsage(), contextMessages: built.messages,
            });
            result.cycle = cycle;
        } catch (error) {
            // Исключение посреди фонового цикла не должно оставлять директора «занятым» навсегда.
            const message = error?.message ?? String(error);
            researcher?.cancel?.({ runId });
            wakeQueue.rest();
            if (!stale()) await recordFailure({ runId, event, wake: startedWake, startedAt, message });
            live.failed({ runId, message });
            throw error;
        } finally {
            captured?.stop();
            if (backgroundController === controller) backgroundController = null;
        }
        const { cycle } = result;
        if (stale()) {
            // Цикл старого чата: в журнал и окно нового он не попадает.
            wakeQueue.rest();
            live.finished({ cycle });
            return { skipped: true, stale: true, steps: result.steps, type: 'stale', briefWritten: false };
        }
        await store.appendCycle(cycle).catch(() => {});
        await turnWindow.recordBackground(cycle).catch(error => publishEvent('decision.log.warning', { reason: `window append failed: ${error?.message ?? error}` }));
        live.finished({ cycle });
        wakeQueue.rest();
        publishEvent('decision.passive.ended', { runId, event, steps: result.steps, type: result.type });
        if (result.type === 'error') researcher?.cancel?.({ runId });
        return { skipped: false, steps: result.steps, type: result.type, reason: result.reason, briefWritten: Boolean(state.briefWritten) };
    }

    const jobs = createCycleJobs({ backgroundRun, enqueueBackground, wakeQueue, store, getSettings, wakeFor, now });

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
            runId, event: 'message', canAsk: true,
            wake: wakeFor({ type: 'message', label: 'A message from the user', detail: clean, text: clean }),
            task: fillPrompt(DIRECTOR_PASSIVE, {
                event: `The user wrote to you directly, outside the story:\n\n${clean}\n\nTreat it as direction for where the story should go, not as an order.`,
            }),
        })).catch(error => live.failed({ runId, message: error?.message ?? String(error) }));
        return { ok: true, record };
    }

    return {
        run, runPassive: jobs.runPassive, runDraft: jobs.runDraft, runBootstrap: jobs.runBootstrap,
        onResearcherReport: jobs.onResearcherReport, sendMessage, judgeForcedMemory,
        answerQuestion: params => questions.answer(params),
        chatChanged,
        // Вопрос от движка, а не от модели (например, «взять готовые банки?»): та же очередь и тот же тост.
        askUser: ({ question, options, why = '' }) => questions.ask({ question, options, why, allowed: true, asked: 0, limit: 1 }),
        question: () => questions.pending(),
        recordTurn: params => turnWindow.recordTurn(params),
        removeLastWindowTurn: () => turnWindow.removeLastTurn(),
        syncWindow: () => turnWindow.maybeSwitch(),
        noteCorrection: params => turnWindow.noteCorrection(params),
        window: turnWindow,
        assessments: () => new Map(assessments), resetAssessments: () => assessments.clear(),
        waiting: () => ({ awaiting: wakeQueue.isAwaiting(), queued: wakeQueue.queued() }),
    };
}
