import { lastActedTurns } from '../../libraries/core/decision-scene.js';
import { auditTurnInputs } from '../../libraries/core/decision-audit.js';
import { createKnowledge } from './knowledge.js';
import { createFileLayer } from './files-layer.js';
import { createCreationProvider } from './files-creation.js';
import { runDecisionCycle } from '../../libraries/core/decision-agent.js';
import { createUpdateStoryHandler } from './handlers-story.js';
import { ASK_USER_STREAK, DIRECTOR_REROLL, DIRECTOR_TURN, RESOLVER_AFTER_TURN } from '../../libraries/core/decision-prompts.js';
import { createCycleRecord } from '../../libraries/core/decision-log.js';
import { createCounsellor } from './counsellor.js';
import { createDirector } from './director.js';
import { createGod } from './god.js';
import { createCreationStore } from './creation.js';
import { createFailureRecorder, withRequiredReply } from './cycle-failure.js';
import { buildInscription } from '../../libraries/core/decision-push.js';
import { createModePicker } from './turn-modes.js';
import { resolverModeBlock, writerModeLine, modeContrast, resolverContrastBlock, writerContrastLine } from '../../libraries/core/turn-modes.js';
import { createHandlers } from './handlers.js';
import { createCycleJobs } from './cycle-jobs.js';
import { createTurnWindow } from './window.js';
import { createJudge } from './judge.js';
import { createPlaceReader, createTimeReader } from './readers.js';
import { createCycleLive } from './live.js';
import { createWakeQueue } from './queue.js';
import { createCycleContext, fallbackDecision, turnWake, wakeFor } from './cycle-context.js';
import { createRosterApplier } from './roster.js';
import { runAfterTurn } from './cycle-after-turn.js';
import { createQuestionQueue } from './questions.js';
import { createContextReport } from './context-report.js';
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

export function createDecisionCycle({ call, callTool, callService = null, getSettings, getGameSettings = null, getWorkers, store, researcher = null, banks = null, publishEvent, usage = () => null, capture = null, now = () => Date.now(), questions: providedQuestions = null, notify = null }) {
    // Аудит входов: одна находка — одно уведомление за сессию, дальше только строка в журнале хода.
    const auditSeen = new Set();
    const assessments = new Map();
    const state = { assessments, assessmentCounter: 0, turnCounter: 0, runId: '' };
    const wakeQueue = createWakeQueue({ enqueue: job => enqueueBackground(job), publishEvent });
    const live = createCycleLive({ publishEvent, getTurn: () => state.turnCounter, getClock: () => store.clock().minutes });
    // Creation (фаза 5) — один экземпляр на ядро: его читает резолвер и правит God.
    const creation = createCreationStore({ call, store, publishEvent, now });
    const context = createCycleContext({ call, store, banks, creation, capture, getGameSettings, getSettings, publishEvent });
    const resolvePlace = createPlaceReader(call);
    const lastTimeMark = createTimeReader(call);
    // Своя последовательная очередь роли: задания идут по одному, но не ждут чужих фоновых циклов.
    const ownQueue = () => {
        let tail = Promise.resolve();
        return job => { const next = tail.then(job, job); tail = next.catch(() => {}); return next; };
    };
    // Советник (часть 18): своя очередь, своё подключение, свой контекст. Ответ пользователю не ждёт
    // ни бутстрапа, ни Бога, ни директора — у каждого своё подключение.
    const counsellor = createCounsellor({
        call, callTool, store, banks, getSettings, getWorkers, publishEvent, capture, now,
        enqueue: ownQueue(),
    });
    // Director (часть 19): полу-слепой, по отчётам; Телеграмма держит следующий ход до Указа.
    const director = createDirector({
        call, callTool, store, banks, getSettings, getWorkers, publishEvent, capture, now, creation,
        enqueue: job => Promise.resolve(wakeQueue.schedule(job)),
    });
    // God (фаза 5): строит Creation и отвечает на Молитвы — своя очередь: долгое построение не держит Советника.
    const god = createGod({
        call, callTool, store, getSettings, getWorkers, publishEvent, capture, creation, now,
        enqueue: ownQueue(),
    });
    if (banks) god.setLayout({ marksForLorebook: () => banks.marksForLorebook?.() ?? null });

    function deciderWorker(settings) {
        const id = String(settings.decider.workerId ?? '').trim();
        if (!id) throw new DecisionConfigError('Decision core: no director worker is configured — choose one in the Director / Writer card.');
        const worker = getWorkers().find(item => item.id === id);
        if (!worker) throw new DecisionConfigError(`Decision core: the director worker "${id}" is not available — choose an existing connection in the Director / Writer card.`);
        if (worker.format !== OPENAI_FORMAT) throw new DecisionConfigError(`Decision core: the director needs an "openai" worker with multi-turn tools; "${worker.id}" is "${worker.format}". Choose an openai connection in the Director / Writer card.`);
        return worker;
    }

    const knowledge = createKnowledge({ call, store, banks, now });
    // Заполнение окна резолвера — для колесика в The Court.
    const contextReport = createContextReport({ call, publishEvent, now });
    // Вкладка «Files» окна The Court: те же файлы, что правят модели, — от имени пользователя.
    const files = createFileLayer({ banks, knowledge });
    files.addProvider(createCreationProvider({ creation, state: {} }));
    // Проверка формы классификатором выключена: за 8 ходов с Jev ни одного возврата, а запрос — на каждую попытку записи хода.
    const formChecker = null;
    const pickModes = createModePicker({ call, getSettings });
    // Ветка спекуляции приносит свою очередь: вопрос игроку из неё недопустим.
    const questions = providedQuestions ?? createQuestionQueue({ callService, publishEvent, now });
    // Эпоха чата: смена чата её увеличивает. Фоновый цикл старого чата обрывается и ничего не пишет в новый.
    let chatEpoch = 0;
    let backgroundController = null;
    let backgroundSettled = Promise.resolve();
    function chatChanged() {
        chatEpoch += 1;
        contextReport.reset();
        backgroundController?.abort(new Error('the chat was changed'));
        backgroundController = null;
        questions.cancelAll();
        creation.reset();
    }
    const turnWindow = createTurnWindow({ store, banks, creation, call, getSettings, deciderWorker, publishEvent, now });
    const applyRoster = createRosterApplier({ store, banks, state, window: turnWindow });
    const { judgeForcedMemory } = createJudge({ getSettings, deciderWorker, call, now, publishEvent });

    const recordFailure = createFailureRecorder({ store, state, getSettings, now });

    function handlersFor(settings) {
        const base = {
            ...createHandlers({ store, call, publishEvent, getSettings, getGameSettings, state, resolvePlace, lastTimeMark, researcher, banks, window: turnWindow, formChecker, questions, knowledge, applyRoster, timeOfDay: () => getSettings().bankTimeOfDay, getScales: async () => { await creation.load().catch(() => null); return creation.state()?.scales ?? []; } }),
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

    /**
     * Голос каждого, кто говорит на ходу, — из его банка (Spiritual 3: как показывает чувства, 5: как говорит), прямо в Inscription.
     * Банк у Писателя лежит далеко в контексте, а у реплик стояло только «in their own voice» — и он давал всем один свой голос.
     */
    async function voicesFor(form) {
        const speakers = new Set((Array.isArray(form?.beats) ? form.beats : [])
            .filter(beat => String(beat?.kind ?? '').toLowerCase() === 'line').map(beat => String(beat?.who ?? '').trim().toLowerCase()).filter(Boolean));
        if (!speakers.size || typeof banks?.great?.load !== 'function') return {};
        const state = await banks.great.load().catch(() => null);
        const lines = value => (Array.isArray(value) ? value : []).map(item => String(item ?? '').replace(/^\[[^\]]*\]\s*/, '').trim()).filter(Boolean).join(' ');
        const voices = {};
        for (const character of Object.values(state ?? {})) {
            const name = String(character?.name ?? '').trim();
            if (!name || !speakers.has(name.toLowerCase())) continue;
            const feeling = lines(character?.spiritual?.['3']), speech = lines(character?.spiritual?.['5']);
            if (feeling || speech) voices[name] = [speech ? `Speaks: ${speech}` : '', feeling ? `Shows feeling: ${feeling}` : ''].filter(Boolean).join(' ');
        }
        return voices;
    }

    function cycleRecord({ runId, event, result, thinking, wake, startedAt, workerId, usage: runUsage, contextMessages = [], speculative = null }) {
        const form = result.type === 'submit' ? (result.form ?? {}) : null;
        const push = form
            ? buildInscription({ form, assessments, place: form.meta?.place ?? '', timeBefore: form.meta?.timeBefore ?? '', timeAfter: form.meta?.timeAfter ?? '', modeLine: [writerContrastLine(state.contrast), writerModeLine(state.modes?.chosen)].filter(Boolean).join('\n'), voices: state.voices ?? {} })
            : '';
        if (form) form.push = push;
        const endedAt = now();
        const cycle = createCycleRecord({
            runId, event, messages: result.messages.slice(contextMessages.length), toolCalls: result.trace,
            thinking: typeof thinking === 'function' ? thinking() : thinking,
            warnings: [...(result.warnings ?? []), ...(state.formWarnings ?? [])], at: startedAt,
            usage: typeof runUsage === 'function' ? runUsage() : runUsage,
            form, push, wake, turn: state.turnCounter, clockMinutes: store.clock().minutes, modes: state.modes ?? null, contrast: state.contrast ?? null,
            workerId, endedAt, durationMs: endedAt - startedAt, speculative,
        });
        return { cycle, form, push };
    }

    async function runCycle({ chat, runId, type = 'normal', thinking = () => '', usage: runUsage = usage, toolFilter = null, lorebook = true, wake = null, signal: externalSignal = null, speculative = null, restarted = false }) {
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
        state.entrantsRestarted = restarted;
        state.userMessage = '';
        const lastUser = [...(Array.isArray(chat) ? chat : [])].reverse().find(entry => entry?.is_user === true);
        state.userMessage = String(lastUser?.mes ?? lastUser?.content ?? '').trim();
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
        // Режимы хода (1–2) — до задания: свой блок рядом с ним и броски по режиму. Без выборщика — общий шаблон.
        state.modes = toolFilter ? null : await pickModes(chat, externalSignal);
        const modeBlock = resolverModeBlock(state.modes?.chosen);
        // Резкий поворот сцены: оценки режимов далеко от прошлого принятого хода — обеим ролям сказать, что прошлое настроение не ведёт.
        const previousCycle = (store.cycles?.() ?? []).filter(cycle => ['turn', 'regenerate', 'swipe'].includes(cycle?.event) && !cycle?.rejected && cycle?.form && Number(cycle.turn) < state.turnCounter).at(-1);
        state.contrast = state.modes ? modeContrast(previousCycle?.modes?.answers, state.modes.answers) : null;
        const contrastBlock = resolverContrastBlock(state.contrast);
        const task = [reroll || modeBlock ? DIRECTOR_TURN : '', reroll ? DIRECTOR_REROLL : '', contrastBlock, modeBlock].filter(Boolean).join('\n\n');
        const built = await context.runContext({ settings, chat, lorebook, worker, reroll, turn: state.turnCounter, task });
        if (!restarted) {
            const audit = auditTurnInputs({
                greatBank: (await banks?.great?.load?.().catch(() => ({}))) ?? {}, roster: store.roster().active ?? [],
                user: String(banks?.persona?.()?.name ?? ''), windowEntries: store.window?.()?.entries ?? [], turn: state.turnCounter,
                lastActed: lastActedTurns(store.cycles?.() ?? []),
            });
            for (const item of audit) {
                state.formWarnings.push(`audit: ${item.message}`);
                if (!auditSeen.has(item.key)) { auditSeen.add(item.key); notify?.('warning', `ME: ${item.message}`); }
            }
        }
        contextReport.record(built, { turn: state.turnCounter });
        const tools = toolFilter ? await context.toolsFor(settings, { filter: toolFilter }) : await context.toolsFor(settings, { turn: true });
        // Режим без бросков — инструмента броска на этом ходу просто нет: спорить «бросать или нет» не о чем.
        // Набор инструментов не зависит от режима: он в начале запроса, и смена ломала бы кеш всего контекста.
        const controller = new AbortController();
        // Спекулятивную ветку отменяет тот, кто её начал: смена черновика, свайп, вопрос игроку.
        const forwardAbort = () => controller.abort(externalSignal?.reason);
        if (externalSignal?.aborted) forwardAbort();
        else externalSignal?.addEventListener?.('abort', forwardAbort, { once: true });
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
            // Пустой ответ повторяет общий алгоритм повтора (часть 19), а не агент.
            emptyRetry: false,
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
            externalSignal?.removeEventListener?.('abort', forwardAbort);
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
            const push = buildInscription({ form, assessments });
            form.push = push;
            await store.saveDraft(null).catch(() => {});
            const startedCycle = cycleRecord({
                runId, event: type === 'normal' ? 'turn' : type, result: { ...result, type: 'await', messages: [], trace: [] },
                thinking: thinking(), wake: startedWake, startedAt, workerId: worker.id, usage: runUsage, speculative,
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

        if (result.type === 'restart') {
            // Вошли персонажи с банками: ход заново, уже с ними в ростере (их Указ и нрав — в контексте). В журнал не пишется.
            agent.catch(() => {});
            wakeQueue.rest();
            return runCycle({ chat, runId, type, thinking, usage: runUsage, toolFilter, lorebook, wake, signal: externalSignal, speculative, restarted: true });
        }
        state.voices = result.type === 'submit' ? await voicesFor(result.form) : {};
        const { cycle, form, push } = cycleRecord({
            runId, event: type === 'normal' ? 'turn' : type, result, thinking,
            wake: startedWake, startedAt, workerId: worker.id, usage: runUsage, contextMessages: built.messages, speculative,
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
        // «После хода» ждёт ответа писателя: исход пишется по странице, а не по замыслу формы.
        return { ok: true, form, push, decision, trace: result.trace, warnings: result.warnings, steps: result.steps, workerId: worker.id, built, messages: result.messages };
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

    /**
     * «После хода» — отдельный вызов по тексту ответа писателя (заменяет прежнее продолжение с update_story).
     * Тело — в `cycle-after-turn.js`; здесь только фоновая очередь и состояние разговора.
     */
    function afterTurn({ runId, built, writerText, form }) {
        const startEpoch = chatEpoch;
        let settle = () => {};
        backgroundSettled = new Promise(resolve => { settle = resolve; });
        return runAfterTurn({ runId, built, writerText, form }, {
            getSettings, deciderWorker, context, handlersFor, runDecisionCycle, callTool, capture, live,
            cycleRecord, store, publishEvent, wakeFor, now, usage, startEpoch, state,
            epoch: () => chatEpoch,
            setController: controller => {
                backgroundController = controller;
                if (!controller) settle();
            },
        });
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
                emptyRetry: false,
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

    /**
     * Сообщение пользователя Советнику — он единственный собеседник (часть 18).
     * Запись в журнал и короткая переписка живут в Советнике; здесь только вход.
     */
    function sendMessage(params) {
        return counsellor.sendMessage(params);
    }

    /**
     * Повтор запроса — строкой журнала (часть 19): роль, попытка N/3, причина.
     * Пишется без пробуждения модели и без влияния на ход.
     */
    async function logRetry({ role = '', attempt = 1, maxAttempts = 3, reason = '', line = '' } = {}) {
        const body = String(line || `${role}: retry ${attempt}/${maxAttempts} — ${reason}`).trim();
        if (!body) return null;
        const at = now();
        const record = createCycleRecord({
            event: 'retry', message: { text: body, at }, at, endedAt: at, durationMs: 0,
            wake: { type: 'retry', label: 'A retry in the background', detail: body },
            turn: state.turnCounter, clockMinutes: store.clock().minutes,
            workerId: getSettings().decider.workerId || null,
        });
        try { await store.appendCycle(record); } catch { /* the retry line is not worth failing the save */ }
        publishEvent('decision.retry.logged', { record });
        // Лента дописывает готовую запись тем же событием, что сообщение пользователю.
        publishEvent('decision.message.added', { record });
        return record;
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
        run, runPassive: jobs.runPassive, runDraft: jobs.runDraft, runBootstrap: jobs.runBootstrap, logSettings, logRetry,
        onResearcherReport: jobs.onResearcherReport, sendMessage, judgeForcedMemory,
        relayGodQuestions: () => counsellor.relayGodQuestions(),
        relayStatus: report => counsellor.relayStatus(report),
        contextReport: () => contextReport.get(),
        // Советник (часть 18): будится после хода и по концу RP-дня.
        maybeRunCounsellor: counsellor.maybeRun,
        runCounsellor: counsellor.run,
        counsellorTurn: counsellor.currentTurn,
        // Director (часть 19): по отчётам; Телеграмма держит следующий ход.
        maybeRunDirector: director.maybeRun,
        runDirector: director.run,
        directorReason: director.reasonNow,
        directorTurn: director.currentTurn,
        waitForDecree: director.waitForDecree,
        // God (фаза 5): построение Creation и ответы на Молитвы.
        maybeRunGod: god.maybeRun,
        runGod: god.run,
        godReason: god.reasonNow,
        godTurn: god.currentTurn,
        creation,
        files,
        answerQuestion: params => questions.answer(params),
        chatChanged,
        // Вопрос от движка, а не от модели (например, «взять готовые банки?»): та же очередь и тот же тост.
        askUser: ({ question, options, why = '' }) => questions.ask({ question, options, why, allowed: true, asked: 0, limit: 1 }),
        question: () => questions.pending(),
        recordTurn: params => turnWindow.recordTurn(params),
        runAfterTurn: params => enqueueBackground(() => afterTurn(params)),
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
