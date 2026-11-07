import { createKnowledge } from './knowledge.js';
import { runDecisionCycle } from '../../libraries/core/decision-agent.js';
import { afterTurnEnabled } from '../../libraries/core/decision-settings.js';
import { createUpdateStoryHandler } from './handlers-story.js';
import { ASK_USER_STREAK, DIRECTOR_PASSIVE, DIRECTOR_REROLL, DIRECTOR_TURN, DIRECTOR_AFTER_TURN, AFTER_TURN_SUBMIT_CLOSED, AFTER_TURN_USE_UPDATE_STORY, fillPrompt } from '../../libraries/core/decision-prompts.js';
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
import { bootstrapQuestionCount } from '../../libraries/core/game-settings.js';

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

const PREEMPT_WAIT_MS = 3000;

export function createDecisionCycle({ call, callTool, callService = null, getSettings, getGameSettings = null, getWorkers, store, researcher = null, banks = null, publishEvent, usage = () => null, capture = null, now = () => Date.now() }) {
    const assessments = new Map();
    const state = { assessments, assessmentCounter: 0, turnCounter: 0, runId: '' };
    const wakeQueue = createWakeQueue({ enqueue: job => enqueueBackground(job), publishEvent });
    const live = createCycleLive({ publishEvent, getTurn: () => state.turnCounter, getClock: () => store.clock().minutes });
    const context = createCycleContext({ call, store, banks, capture, getGameSettings });
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
    let backgroundSettled = Promise.resolve();
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
        const base = {
            ...createHandlers({ store, call, publishEvent, getSettings, getGameSettings, state, resolvePlace, lastTimeMark, researcher, banks, window: turnWindow, formChecker, questions, knowledge }),
            ...knowledge.handlers,
        };
        return withQuestionStreak({ ...base, update_story: createUpdateStoryHandler(base) });
    }

    /** Лимит вопросов bootstrap: новая настройка игры, без неё — прежняя `bootstrap.maxQuestions`. */
    function questionLimit(settings) {
        const game = typeof getGameSettings === 'function' ? getGameSettings() : null;
        return game ? bootstrapQuestionCount(game) : (settings.bootstrap?.maxQuestions ?? 5);
    }

    /** Номер последнего хода: из окна (а без ходов в окне — из журнала). При переигровке того же сообщения — на один меньше. */
    function turnBase({ reroll = false, userText = '' } = {}) {
        const entries = Array.isArray(store.window?.()?.entries) ? store.window().entries : [];
        const turns = entries.filter(entry => entry.kind === 'turn');
        const last = turns.at(-1);
        const fromLog = Math.max(0, ...(typeof store.cycles === 'function' ? store.cycles() : [])
            .filter(cycle => ['turn', 'regenerate', 'swipe'].includes(cycle?.event) && !cycle?.rejected && cycle?.form)
            .map(cycle => Number(cycle.turn) || 0));
        const base = last ? Number(last.turn) || 0 : fromLog;
        if (!reroll || !last) return base;
        const firstLine = String(userText).split('\n').map(line => line.trim()).find(Boolean) ?? '';
        const userLine = String(last.text ?? '').split('\n').find(line => line.startsWith('User: ')) ?? '';
        const same = Boolean(firstLine) && userLine.slice('User: '.length).trim().startsWith(firstLine.slice(0, 120));
        return same ? Math.max(0, base - 1) : base;
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
        // Ход важнее фонового цикла: тот делит с ходом слот модели директора и общее состояние, а срок хода уже идёт (ход 111 ждал 145 с и упал по 180 с).
        if (backgroundController) {
            const preempt = new Error('a turn started');
            preempt.code = 'preempted';
            backgroundController.abort(preempt);
            // Модель отменяется по signal; если провайдер не отпускает — ход не ждёт дольше пары секунд.
            let wait = null;
            await Promise.race([backgroundSettled, new Promise(resolve => { wait = setTimeout(resolve, PREEMPT_WAIT_MS); })]);
            clearTimeout(wait);
        }
        const settings = getSettings();
        const worker = deciderWorker(settings);
        state.runId = runId;
        state.sceneText = context.sceneText(chat);
        state.formWarnings = [];
        state.knowledgeReturns = new Set();
        state.departureWarned = false;
        const lastUser = [...(Array.isArray(chat) ? chat : [])].reverse().find(entry => entry?.is_user === true);
        // Номер хода — из сохранённого окна, а не из памяти вкладки: счётчик сбрасывался при каждой перезагрузке страницы.
        state.turnCounter = turnBase({ reroll: type === 'regenerate' || type === 'swipe', userText: String(lastUser?.mes ?? lastUser?.content ?? '') });
        state.canAsk = /\(\s*ooc\s*:/i.test(String(lastUser?.mes ?? lastUser?.content ?? ''));
        state.canWriteBrief = state.canAsk;
        state.questionCount = 0;
        state.questionStreak = 0;
        state.questionLimit = questionLimit(settings);
        state.briefWritten = false;
        wakeQueue.begin();
        const startedWake = wake ?? turnWake(type);
        const startedAt = now();
        live.started({ runId, event: type === 'normal' ? 'turn' : type, wake: startedWake, at: startedAt, type });
        const reroll = type === 'regenerate' || type === 'swipe';
        const built = await context.runContext({ settings, chat, lorebook, worker, reroll, turn: state.turnCounter, task: reroll ? `${DIRECTOR_TURN}\n\n${DIRECTOR_REROLL}` : '' });
        const tools = await context.toolsFor(settings, { filter: toolFilter });
        const controller = new AbortController();
        const hooks = live.hooks({ runId, thinking });
        const agent = runDecisionCycle({
            messages: built.messages,
            tools,
            generate: context.generateFor({
                settings, worker, runId, prefix: '', startedAt, effort: settings.adaptiveReasoning ? 'low' : null, signal: controller.signal,
                thinkLimit: Number(settings.thinkingLimitTokens) || 0,
                onCut: ({ tokens }) => {
                    state.formWarnings = [...(state.formWarnings ?? []), `the director thought for ${tokens} tokens and was asked to decide concretely`];
                    publishEvent('decision.cycle.thinkingCut', { runId, tokens });
                },
            }),
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
        // Заметки, знания и планы — после формы, пока пишет прозаик: раньше цикл кончался на submit_turn, и эта работа копилась до сообщения пользователя.
        if (afterTurnEnabled(settings)) enqueueBackground(() => afterTurn({ runId, messages: result.messages, tools })).catch(() => {});
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

    const AFTER_TURN_STEPS = 8;

    /** Продолжение цикла хода в фоне: тот же разговор (кеш тот же), повторный submit_turn закрыт, следующий ход прерывает. */
    async function afterTurn({ runId: turnRunId, messages, tools }) {
        const runId = `${turnRunId}_after`;
        const epoch = chatEpoch;
        const controller = new AbortController();
        backgroundController = controller;
        let settle = () => {};
        backgroundSettled = new Promise(resolve => { settle = resolve; });
        const captured = typeof capture === 'function' ? capture(`${runId}:`, { onThinking: text => publishEvent('decision.cycle.thinking', { runId, text }) }) : null;
        const thinking = () => captured?.value ?? '';
        const settings = getSettings();
        const worker = deciderWorker(settings);
        const startedWake = wakeFor({ type: 'after_turn', label: 'The director finishes the turn' });
        const startedAt = now();
        const start = [...messages, { role: 'user', content: DIRECTOR_AFTER_TURN }];
        state.runId = runId;
        live.started({ runId, event: 'after_turn', wake: startedWake, at: startedAt });
        try {
            // Отдельные записи закрыты: раньше цикл шёл цепочкой по персонажу на вызов (3–8 запросов с полным контекстом).
            const single = async () => ({ ok: false, error: AFTER_TURN_USE_UPDATE_STORY });
            const handlers = {
                ...handlersFor(settings), submit_turn: async () => ({ ok: false, error: AFTER_TURN_SUBMIT_CLOSED }),
                character_knowledge: single, character_note: single, set_character_plan: single, set_plan: single,
            };
            const result = await runDecisionCycle({
                messages: start, tools, handlers, callTool, maxSteps: AFTER_TURN_STEPS, implicitAwait: true, now, stopAfter: ['update_story'],
                generate: context.generateFor({ settings, worker, runId, prefix: 'a', startedAt, effort: settings.adaptiveReasoning ? 'low' : null, signal: controller.signal }),
                ...live.hooks({ runId, thinking }),
            });
            if (epoch !== chatEpoch) { live.finished({ cycle: null }); return; }
            const { cycle } = cycleRecord({ runId, event: 'after_turn', result, thinking, wake: startedWake, startedAt, workerId: worker.id, usage: captured ? captured.usage : usage(), contextMessages: start });
            await store.appendCycle(cycle).catch(() => {});
            live.finished({ cycle });
        } catch (error) {
            live.failed({ runId, message: error?.message ?? String(error) });
        } finally {
            captured?.stop();
            if (backgroundController === controller) backgroundController = null;
            settle();
        }
    }

    async function backgroundRun({ runId, event, task, thinking: givenThinking = null, wake = null, canAsk = false, maxSteps = null }) {
        const captured = typeof capture === 'function' && !givenThinking
            ? capture(`${runId}:`, { onThinking: text => publishEvent('decision.cycle.thinking', { runId, text }) })
            : null;
        const thinking = givenThinking ?? (() => captured?.value ?? '');
        const epoch = chatEpoch;
        const controller = new AbortController();
        backgroundController = controller;
        let settle = () => {};
        backgroundSettled = new Promise(resolve => { settle = resolve; });
        const stale = () => epoch !== chatEpoch;
        const runUsage = () => (captured ? captured.usage : usage());
        const settings = getSettings();
        const worker = deciderWorker(settings);
        state.runId = runId;
        state.canAsk = canAsk;
        state.canWriteBrief = canAsk;
        state.questionCount = 0;
        state.questionStreak = 0;
        state.questionLimit = questionLimit(settings);
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
            const preempted = controller.signal.aborted && controller.signal.reason?.code === 'preempted';
            if (!stale() && !preempted) await recordFailure({ runId, event, wake: startedWake, startedAt, message });
            live.failed({ runId, message });
            throw error;
        } finally {
            captured?.stop();
            if (backgroundController === controller) backgroundController = null;
            settle();
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

    /**
     * Смена настроек игры — запись в журнал, как сообщение пользователя
     * директору: без пробуждения модели и без влияния на ход.
     */
    async function logSettings({ text } = {}) {
        const body = String(text ?? '').trim();
        if (!body) return null;
        const at = now();
        const record = createCycleRecord({
            event: 'settings', message: { text: body, at }, at, endedAt: at, durationMs: 0,
            wake: wakeFor({ type: 'settings', label: 'Game settings changed', detail: body }),
            turn: state.turnCounter, clockMinutes: store.clock().minutes,
            workerId: getSettings().decider.workerId || null,
        });
        try { await store.appendCycle(record); } catch { /* the log line is not worth failing the save */ }
        publishEvent('decision.message.added', { record });
        return record;
    }

    return {
        run, runPassive: jobs.runPassive, runDraft: jobs.runDraft, runBootstrap: jobs.runBootstrap, logSettings,
        onResearcherReport: jobs.onResearcherReport, sendMessage, judgeForcedMemory,
        answerQuestion: params => questions.answer(params),
        chatChanged,
        // Вопрос от движка, а не от модели (например, «взять готовые банки?»): та же очередь и тот же тост.
        askUser: ({ question, options, why = '' }) => questions.ask({ question, options, why, allowed: true, asked: 0, limit: 1 }),
        question: () => questions.pending(),
        recordTurn: params => turnWindow.recordTurn(params),
        rebuildWindow: async () => {
            const rebuilt = (await turnWindow.rebuildFromRuns()) || (await turnWindow.fillWriterText());
            await turnWindow.repairFrozen();
            return rebuilt;
        },
        removeLastWindowTurn: () => turnWindow.removeLastTurn(),
        syncWindow: () => turnWindow.maybeSwitch(),
        noteCorrection: params => turnWindow.noteCorrection(params),
        window: turnWindow,
        assessments: () => new Map(assessments), resetAssessments: () => assessments.clear(),
        waiting: () => ({ awaiting: wakeQueue.isAwaiting(), queued: wakeQueue.queued() }),
    };
}
