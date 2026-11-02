import { buildDeciderContext } from '../../libraries/core/decision-context.js';
import { runDecisionCycle, normalizeGenerateAnswer } from '../../libraries/core/decision-agent.js';
import { buildToolList } from '../../libraries/core/decision-tools.js';
import { DIRECTOR_PASSIVE, fillPrompt } from '../../libraries/core/decision-prompts.js';
import { buildLorebookContext } from '../../libraries/core/decision-lorebook.js';
import { createCycleRecord, thinkingMessages } from '../../libraries/core/decision-log.js';
import { deciderRequestParams } from '../../libraries/core/decision-settings.js';
import { buildPush } from '../../libraries/core/decision-push.js';
import { librarySection, duePlans } from '../../libraries/core/decision-library.js';
import { bankIndex } from '../../libraries/core/decision-bank.js';
import { researchSection } from '../../libraries/core/decision-researcher.js';
import { createHandlers } from './handlers.js';
import { createCompaction } from './compaction.js';
import { createJudge } from './judge.js';
import { createPlaceReader, createTimeReader, createSimilarity } from './readers.js';
import { assembleSectionFor } from './prompt-sections.js';

/**
 * Активный и пассивный циклы директора. Здесь только оркестровка: контекст,
 * модель, инструменты, лог. Исполнители инструментов — в `handlers.js`.
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

    const { maybeCompactLog } = createCompaction({ store, getSettings, deciderWorker, call, now, publishEvent });
    const { judgeForcedMemory } = createJudge({ getSettings, deciderWorker, call, now, publishEvent });

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

    function buildContext({ chat = [], settings, summaries: list, task = '', lorebookText = '', directorBlock = [] }) {
        return buildDeciderContext({
            summaries: list, chat, runs: store.runs(),
            thoughtMessages: thinkingMessages(store.cycles()), plan: store.plan(), arcs: store.arcs(), notes: store.notes(),
            libraryText: [librarySection(store.library(), store.plans(), store.clock().minutes), bankIndex(store.bank()), researchSection(store.research())].filter(Boolean).join('\n\n'),
            roster: store.roster().active, planMissing: !store.plan(), directorBlock, lorebookText, task,
        });
    }

    /** Пользовательский блок директора — тот же, что раньше брался из `prompts.director`, но собранный из раздела. */
    async function directorBlockFor(settings, chat, worker) {
        const block = await assembleSectionFor({ sectionId: 'director', settings, chat, call, model: worker.model });
        return block.messages;
    }

    /** Лорбук — только директору: стабильный текст книги. Ошибка чтения не ломает ход. */
    async function lorebookTextFor(enabled) {
        if (!enabled) return '';
        try {
            const books = await call('lorebook.books');
            if (!Array.isArray(books) || !books.length) return '';
            return buildLorebookContext((await call('lorebook.entries')) ?? []).text;
        } catch { return ''; }
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

    async function run({ chat, runId, type = 'normal', thinking = () => '', usage: runUsage = usage, toolFilter = null, lorebook = true }) {
        const settings = getSettings();
        const worker = deciderWorker(settings);
        state.runId = runId;
        awaiting = false;
        const context = buildContext({
            chat, settings, summaries: await summaries(), lorebookText: await lorebookTextFor(lorebook),
            directorBlock: await directorBlockFor(settings, chat ?? [], worker),
        });
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
                runId, event: 'turn', messages: [], toolCalls: [], thinking: thinking(),
                warnings: ['the form timed out; the saved draft was used'], at: startedAt, usage: runUsage(),
            })).catch(() => {});
            awaiting = true;
            publishEvent('decision.cycle.draft_used', { runId, minutes: form.scene.minutes });
            return { ok: true, form, push, decision: fallbackDecision(form), trace: [], warnings: ['form timeout; draft used'], steps: 0, workerId: worker.id, draft: true };
        }

        const cycle = createCycleRecord({
            runId, event: type === 'normal' ? 'turn' : type,
            messages: result.messages.slice(context.messages.length),
            toolCalls: result.trace, thinking: thinking(), warnings: result.warnings, at: startedAt, usage: runUsage(),
        });
        await store.appendCycle(cycle).catch(() => {});
        await maybeCompactLog().catch(error => publishEvent('decision.log.warning', { reason: `log compaction failed: ${error?.message ?? error}` }));

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
        const context = buildContext({
            settings, summaries: await summaries(), task, lorebookText: await lorebookTextFor(true),
            directorBlock: await directorBlockFor(settings, [], worker),
        });
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
            runId, event, messages: result.messages.slice(messages.length), toolCalls: result.trace,
            thinking: thinking(), warnings: result.warnings, at: startedAt, usage: usage(),
        });
        await store.appendCycle(cycle).catch(() => {});
        await maybeCompactLog().catch(error => publishEvent('decision.log.warning', { reason: `log compaction failed: ${error?.message ?? error}` }));
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

    return { run, runPassive, runDraft, onResearcherReport, judgeForcedMemory, assessments: () => new Map(assessments), resetAssessments: () => assessments.clear() };
}
