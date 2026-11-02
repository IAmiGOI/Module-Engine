import { buildDeciderContext } from '../../libraries/core/decision-context.js';
import { runDecisionCycle } from '../../libraries/core/decision-agent.js';
import { buildToolList, FORCED_MEMORY_TOOL, AWAIT_TOOL } from '../../libraries/core/decision-tools.js';
import { DIRECTOR_PASSIVE, DIRECTOR_FORCED_MEMORY, DIRECTOR_ARC_SUMMARY, fillPrompt } from '../../libraries/core/decision-prompts.js';
import { createCycleRecord, thinkingMessages, compactLog, totalLogTokens } from '../../libraries/core/decision-log.js';
import { deciderRequestParams } from '../../libraries/core/decision-settings.js';
import { buildPush } from '../../libraries/core/decision-push.js';
import { librarySection, duePlans } from '../../libraries/core/decision-library.js';
import { bankIndex } from '../../libraries/core/decision-bank.js';
import { researchSection } from '../../libraries/core/decision-researcher.js';
import { createHandlers, createPlaceReader, createTimeReader, createSimilarity } from './handlers.js';

/**
 * Активный и пассивный циклы директора. Здесь только оркестровка: контекст,
 * модель, инструменты, лог. Исполнители инструментов — в `handlers.js`.
 */

const OPENAI_FORMAT = 'openai';

/** Строка от воркера — просто текст без вызова инструмента: директор получит напоминание. */
function normalizeGenerateAnswer(value) {
    if (typeof value !== 'string') return value;
    return { text: value, toolCalls: [] };
}

/** Ошибка настройки: воркера директора нет или он не `openai`. От неё не помогает повтор. */
export class DecisionConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = 'DecisionConfigError';
        this.code = 'decision-config';
    }
}

function fallbackDecision(form) {
    const lines = (Array.isArray(form?.characters) ? form.characters : [])
        .filter(character => String(character?.action ?? '').trim())
        .map(character => `${character.name}: ${character.action}`);
    return [String(form?.resolution ?? '').trim(), ...lines].filter(Boolean).join('\n') || 'The turn is decided.';
}

export function createDecisionCycle({ call, callTool, getSettings, getWorkers, store, researcher = null, publishEvent, usage = () => null, now = () => Date.now() }) {
    const assessments = new Map();
    const state = { assessments, assessmentCounter: 0, turnCounter: 0, runId: '' };
    let awaiting = false; // директор между циклами: отчёт субагента может его разбудить
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

    async function externalTools() {
        try {
            const tools = await call('generation.tools');
            return Array.isArray(tools) ? tools : [];
        } catch { return []; }
    }

    function handlersFor(settings) {
        return createHandlers({ store, call, publishEvent, getSettings, state, resolvePlace, lastTimeMark, similarityScores, researcher });
    }

    async function summaries() {
        try { return (await call('summary.list')) ?? []; } catch { return []; }
    }

    function buildContext({ chat = [], settings, summaries: list, task = '' }) {
        return buildDeciderContext({
            summaries: list, chat, runs: store.runs(),
            thoughtMessages: thinkingMessages(store.cycles()), plan: store.plan(), arcs: store.arcs(), notes: store.notes(),
            libraryText: [librarySection(store.library(), store.plans(), store.clock().minutes), bankIndex(store.bank()), researchSection(store.research())].filter(Boolean).join('\n\n'),
            roster: store.roster().active, planMissing: !store.plan(), directorBlock: settings.prompts.director, task,
        });
    }

    function generateFor({ settings, worker, runId, prefix, startedAt, effort = null, signal = null }) {
        let modelCall = 0;
        return async ({ messages, tools, toolChoice, returnMessage }) => {
            modelCall += 1;
            const answer = await call('model.generate', {
                requestId: `${runId}:${prefix}${modelCall}:${startedAt}`,
                ...deciderRequestParams(settings.decider),
                ...(effort ? { reasoningEffort: effort } : {}),
                workerId: worker.id,
                messages, tools, toolChoice, stream: false, returnMessage,
                ...(signal ? { signal } : {}),
            });
            return normalizeGenerateAnswer(answer);
        };
    }

    async function toolsFor(settings, { background = false, filter = null } = {}) {
        return buildToolList(await externalTools()).filter(tool => {
            if (filter && !filter.includes(tool.name)) return false;
            if (background && tool.name === 'submit_turn') return false;
            if (!settings.turnDraft && tool.name === 'save_draft') return false;
            return true;
        });
    }

    /**
     * Порог лога (500 тыс. по умолчанию). Сначала директор отдельным
     * запросом пишет сводку завершённых арок; только потом сырые старые
     * циклы уходят в архив. Нет завершённых арок — предупреждение, лог не
     * трогаем (лучше честный перегруз, чем потерянный контекст).
     */
    async function maybeCompactLog() {
        const settings = getSettings();
        const cycles = store.cycles();
        const before = totalLogTokens(cycles);
        if (before <= settings.logLimitTokens) return null;
        const closed = store.arcs().filter(arc => arc.status === 'closed' && !arc.summary);
        if (!closed.length) {
            publishEvent('decision.log.warning', { reason: 'no closed arcs to summarize; the log is over the limit', tokens: before });
            return null;
        }
        const worker = deciderWorker(settings);
        const prompt = fillPrompt(DIRECTOR_ARC_SUMMARY, { arcs: closed.map(arc => `ARC: ${arc.title}\nStages: ${(arc.stages ?? []).map(stage => stage.note).filter(Boolean).join('; ') || 'none'}`).join('\n\n') });
        let summary = '';
        try {
            summary = await call('model.generate', { workerId: worker.id, prompt, maxTokens: 1200, temperature: 0, stream: false });
        } catch (error) {
            publishEvent('decision.log.warning', { reason: `arc summary failed: ${error?.message ?? error}`, tokens: before });
            return null;
        }
        if (!String(summary ?? '').trim()) {
            publishEvent('decision.log.warning', { reason: 'the director returned an empty arc summary', tokens: before });
            return null;
        }
        const arcs = store.arcs().map(arc => (closed.some(item => item.id === arc.id) ? { ...arc, summary: String(summary).trim(), summaryAt: now() } : arc));
        await store.saveArcs(arcs);
        const result = compactLog(cycles, { limitTokens: settings.logLimitTokens, archiveLimitTokens: settings.archiveLimitTokens, keepCurrent: true });
        await store.saveLog(result.cycles, { archived: result.archived });
        publishEvent('decision.log.compacted', { before, after: totalLogTokens(result.cycles), archived: result.archived.length });
        return result;
    }

    async function run({ chat, runId, type = 'normal', thinking = () => '', usage: runUsage = usage, toolFilter = null }) {
        const settings = getSettings();
        const worker = deciderWorker(settings);
        state.runId = runId;
        awaiting = false;
        const context = buildContext({ chat, settings, summaries: await summaries() });
        const tools = await toolsFor(settings, { filter: toolFilter });
        const startedAt = now();
        const controller = new AbortController();
        const agent = runDecisionCycle({
            messages: context.messages,
            tools,
            generate: generateFor({ settings, worker, runId, prefix: '', startedAt, effort: settings.adaptiveReasoning ? 'low' : null, signal: controller.signal }),
            handlers: handlersFor(settings),
            callTool,
            maxSteps: settings.maxSteps,
            implicitAwait: Boolean(settings.implicitAwait),
            now,
        });
        let timer = null;
        const timeout = new Promise(resolve => { timer = setTimeout(() => resolve({ type: 'timeout', reason: 'form timeout', trace: [], warnings: [], steps: 0, messages: context.messages }), settings.formTimeoutMs); });
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
            await store.saveDraft(null).catch(() => {});
            await store.appendCycle(createCycleRecord({
                event: 'turn', messages: [], toolCalls: [], thinking: thinking(),
                warnings: ['the form timed out; the saved draft was used'], at: startedAt, usage: runUsage(),
            })).catch(() => {});
            awaiting = true;
            publishEvent('decision.cycle.draft_used', { runId, minutes: form.scene.minutes });
            return { ok: true, form, push, decision: fallbackDecision(form), trace: [], warnings: ['form timeout; draft used'], steps: 0, workerId: worker.id, draft: true };
        }

        const cycle = createCycleRecord({
            event: type === 'normal' ? 'turn' : type,
            messages: result.messages.slice(context.messages.length),
            toolCalls: result.trace, thinking: thinking(), warnings: result.warnings, at: startedAt, usage: runUsage(),
        });
        await store.appendCycle(cycle).catch(() => {});
        await maybeCompactLog().catch(() => {});

        if (result.type !== 'submit') {
            awaiting = true;
            publishEvent('decision.cycle.ended', { runId, type: result.type, reason: result.reason, steps: result.steps });
            return { ok: false, reason: result.reason, trace: result.trace, warnings: result.warnings, steps: result.steps, workerId: worker.id };
        }
        const form = result.form ?? {};
        const push = buildPush({
            form, assessments,
            place: form.meta?.place ?? '', timeBefore: form.meta?.timeBefore ?? '', timeAfter: form.meta?.timeAfter ?? '',
        });
        form.push = push;
        const decision = fallbackDecision(form);
        awaiting = true;
        publishEvent('decision.cycle.submitted', { runId, type, steps: result.steps, characters: form.characters?.length ?? 0 });
        return { ok: true, form, push, decision, trace: result.trace, warnings: result.warnings, steps: result.steps, workerId: worker.id };
    }

    let backgroundTail = Promise.resolve();

    /** Фоновый цикл (планы или отчёт субагента) — строго по одному, не в ходу прозаика. */
    function enqueueBackground(run) {
        const job = backgroundTail.then(run, run);
        backgroundTail = job.then(() => {}, () => {});
        return job;
    }

    async function backgroundRun({ runId, event, task, thinking = () => '' }) {
        const settings = getSettings();
        const worker = deciderWorker(settings);
        state.runId = runId;
        awaiting = false;
        const context = buildContext({ settings, summaries: await summaries(), task });
        const messages = context.messages;
        const tools = await toolsFor(settings, { background: true });
        const startedAt = now();
        const result = await runDecisionCycle({
            messages,
            tools,
            generate: generateFor({ settings, worker, runId, prefix: 'p', startedAt, effort: settings.adaptiveReasoning ? 'high' : null }),
            handlers: handlersFor(settings),
            callTool,
            maxSteps: settings.maxSteps,
            implicitAwait: true,
            now,
        });
        const cycle = createCycleRecord({
            event, messages: result.messages.slice(messages.length), toolCalls: result.trace,
            thinking: thinking(), warnings: result.warnings, at: startedAt, usage: usage(),
        });
        await store.appendCycle(cycle).catch(() => {});
        await maybeCompactLog().catch(() => {});
        awaiting = true;
        publishEvent('decision.passive.ended', { runId, event, steps: result.steps, type: result.type });
        return { skipped: false, steps: result.steps, type: result.type };
    }

    /** Пассивный цикл: только если есть завершившиеся планы. */
    function runPassive({ runId, thinking = () => '' } = {}) {
        return enqueueBackground(async () => {
            const clock = store.clock();
            const due = duePlans(store.plans(), clock.minutes);
            if (!due.length) return { skipped: true, due: 0 };
            const dueText = due.map(plan => `- ${plan.character} (level ${plan.level}): ${plan.summary}${plan.needsNewPlan ? ' [left the active roster — a new plan is needed]' : ''}`).join('\n');
            const draftLine = getSettings().turnDraft ? '\nBefore await, if you can guess the likely next turn, call save_draft with it.' : '';
            return backgroundRun({ runId, event: 'time', task: fillPrompt(DIRECTOR_PASSIVE, { event: `${dueText}${draftLine}` }), thinking });
        });
    }

    /** Старт по набору текста: подготовить заготовку хода заранее (настройка, по умолчанию выключена). */
    function runDraft({ runId } = {}) {
        return enqueueBackground(() => backgroundRun({
            runId: runId ?? `typing_${now()}`,
            event: 'turn',
            task: 'The user is typing. Prepare a draft of the likely next decisions. If turn drafting is on, call save_draft with it, then await. Do not submit a turn.',
        }));
    }

    /** Отчёт субагента будит директора, только если он между циклами. */
    function onResearcherReport(payload = {}) {
        if (!awaiting) return Promise.resolve({ skipped: true, reason: 'the director is not between cycles' });
        return enqueueBackground(() => backgroundRun({
            runId: `researcher_${payload.taskId ?? 'task'}`,
            event: 'researcher',
            task: fillPrompt(DIRECTOR_PASSIVE, { event: `A researcher reported:\n${String(payload.report ?? '')}` }),
        }));
    }

    /** Forced Memory: какие саммари батча не сворачивать. Без воркера — пусто, без вызова модели. */
    async function judgeForcedMemory({ batch = [] } = {}) {
        const settings = getSettings();
        const list = (Array.isArray(batch) ? batch : []).filter(record => record?.id);
        if (!list.length) return { keep: [] };
        let worker;
        try { worker = deciderWorker(settings); } catch (error) {
            if (error?.code === 'decision-config') return { keep: [] };
            throw error;
        }
        const ids = new Set(list.map(record => record.id));
        const kept = new Set();
        const prompt = fillPrompt(DIRECTOR_FORCED_MEMORY, {
            summaries: list.map(record => `[${record.id}] (level ${record.level}, messages #${record.startIndex}–#${record.endIndex})\n${record.text}`).join('\n\n'),
        });
        await runDecisionCycle({
            messages: [{ role: 'system', content: prompt }],
            tools: [FORCED_MEMORY_TOOL, AWAIT_TOOL],
            generate: async ({ messages, tools, toolChoice, returnMessage }) => normalizeGenerateAnswer(await call('model.generate', {
                workerId: worker.id, messages, tools, toolChoice, stream: false, returnMessage, maxTokens: 800, temperature: 0,
            })),
            handlers: {
                forced_memory: async args => {
                    if (args.op === 'keep' && ids.has(args.summaryId)) kept.add(args.summaryId);
                    if (args.op === 'unkeep') kept.delete(args.summaryId);
                    return { ok: true };
                },
                await: async () => ({ ok: true }),
            },
            maxSteps: 20,
            implicitAwait: true,
            now,
        });
        const keep = [...kept];
        publishEvent('decision.forcedMemory.judged', { batch: list.length, keep: keep.length });
        return { keep };
    }

    return { run, runPassive, runDraft, onResearcherReport, judgeForcedMemory, assessments: () => new Map(assessments), resetAssessments: () => assessments.clear() };
}
