import { buildDeciderContext } from '../../libraries/core/decision-context.js';
import { runDecisionCycle } from '../../libraries/core/decision-agent.js';
import { buildToolList } from '../../libraries/core/decision-tools.js';
import { createCycleRecord, thinkingMessages, compactLog, totalLogTokens } from '../../libraries/core/decision-log.js';
import { parseModelJson } from '../../libraries/core/parse-model-json.js';
import { deciderRequestParams } from '../../libraries/core/decision-settings.js';
import { buildPush } from '../../libraries/core/decision-push.js';
import { librarySection, duePlans } from '../../libraries/core/decision-library.js';
import { bankIndex } from '../../libraries/core/decision-bank.js';
import { createHandlers, createPlaceReader, createTimeReader, createSimilarity } from './handlers.js';

/**
 * Активный и пассивный циклы директора. Здесь только оркестровка: контекст,
 * модель, инструменты, лог. Исполнители инструментов — в `handlers.js`.
 */

const OPENAI_FORMAT = 'openai';

function resolveWorker(workers, id) {
    if (id) return workers.find(worker => worker.id === id) ?? null;
    return workers[0] ?? null;
}

/** `model.generate` может вернуть строку (старый/фейковый воркер) — тогда понимаем её как прежний JSON директора. */
function normalizeGenerateAnswer(value) {
    if (typeof value !== 'string') return value;
    const parsed = parseModelJson(value);
    if (parsed && typeof parsed === 'object' && typeof parsed.decision === 'string') {
        return {
            text: '',
            toolCalls: [{
                id: 'legacy_json', name: 'submit_turn',
                arguments: {
                    comment: 'Legacy JSON answer from the director.',
                    resolution: parsed.decision,
                    userResult: 'The user action is reflected in the decision.',
                    scene: { minutes: 0 },
                    characters: [],
                    _decision: parsed.decision,
                    ...(Array.isArray(parsed.blocks) ? { blocks: parsed.blocks } : {}),
                },
                rawArguments: '{}',
            }],
        };
    }
    return { text: value, toolCalls: [] };
}

function fallbackDecision(form) {
    const lines = (Array.isArray(form?.characters) ? form.characters : [])
        .filter(character => String(character?.action ?? '').trim())
        .map(character => `${character.name}: ${character.action}`);
    return [String(form?.resolution ?? '').trim(), ...lines].filter(Boolean).join('\n') || 'The turn is decided.';
}

export function createDecisionCycle({ call, callTool, getSettings, getWorkers, store, publishEvent, now = () => Date.now() }) {
    const assessments = new Map();
    const state = { assessments, assessmentCounter: 0, turnCounter: 0, runId: '' };
    const resolvePlace = createPlaceReader(call);
    const lastTimeMark = createTimeReader(call);
    const similarityScores = createSimilarity(call);

    function deciderWorker(settings) {
        const worker = resolveWorker(getWorkers(), settings.decider.workerId);
        if (!worker) throw new Error('Decision core: no director worker is configured — choose one in the Director / Writer card.');
        if (worker.format !== OPENAI_FORMAT) throw new Error(`Decision core: the director needs an "openai" worker with multi-turn tools; "${worker.id}" is "${worker.format}".`);
        return worker;
    }

    async function externalTools() {
        try {
            const tools = await call('generation.tools');
            return Array.isArray(tools) ? tools : [];
        } catch { return []; }
    }

    function handlersFor(settings) {
        return createHandlers({ store, call, publishEvent, getSettings, state, resolvePlace, lastTimeMark, similarityScores });
    }

    async function summaries() {
        try { return (await call('summary.list')) ?? []; } catch { return []; }
    }

    function buildContext({ chat = [], settings, summaries: list }) {
        return buildDeciderContext({
            rules: settings.rules, blocks: store.blocks(), summaries: list, chat, runs: store.runs(),
            thoughtMessages: thinkingMessages(store.cycles()), plan: store.plan(), arcs: store.arcs(), notes: store.notes(),
            libraryText: [librarySection(store.library(), store.plans(), store.clock().minutes), bankIndex(store.bank())].filter(Boolean).join('\n\n'),
            roster: store.roster().active, planMissing: !store.plan(), toolMode: true,
        });
    }

    function generateFor({ settings, worker, runId, prefix, startedAt }) {
        let modelCall = 0;
        return async ({ messages, tools, toolChoice, returnMessage }) => {
            modelCall += 1;
            const answer = await call('model.generate', {
                requestId: `${runId}:${prefix}${modelCall}:${startedAt}`,
                ...deciderRequestParams(settings.decider),
                workerId: worker.id,
                messages, tools, toolChoice, stream: false, returnMessage,
            });
            return normalizeGenerateAnswer(answer);
        };
    }

    const ARC_SUMMARY_SYSTEM = `You compact the director's own log. Summarize the completed arcs into a short, factual record: what happened, what changed, what is still open. Keep names and causal links, drop scene detail. Output ONLY the summary text, no preamble.`;

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
        const prompt = closed.map(arc => `ARC: ${arc.title}\nStages: ${(arc.stages ?? []).map(stage => stage.note).filter(Boolean).join('; ') || 'none'}`).join('\n\n');
        let summary = '';
        try {
            summary = await call('model.generate', { workerId: worker.id, systemPrompt: ARC_SUMMARY_SYSTEM, prompt, maxTokens: 1200, temperature: 0, stream: false });
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

    async function run({ chat, runId, type = 'normal', thinking = () => '' }) {
        const settings = getSettings();
        const worker = deciderWorker(settings);
        state.runId = runId;
        const context = buildContext({ chat, settings, summaries: await summaries() });
        const tools = buildToolList(await externalTools());
        const startedAt = now();
        const result = await runDecisionCycle({
            messages: context.messages,
            tools,
            generate: generateFor({ settings, worker, runId, prefix: '', startedAt }),
            handlers: handlersFor(settings),
            callTool,
            maxSteps: settings.maxSteps,
            implicitAwait: Boolean(settings.implicitAwait),
            now,
        });

        const cycle = createCycleRecord({
            event: type === 'normal' ? 'turn' : type,
            messages: result.messages.slice(context.messages.length),
            toolCalls: result.trace, thinking: thinking(), warnings: result.warnings, at: startedAt,
        });
        await store.appendCycle(cycle).catch(() => {});
        await maybeCompactLog().catch(() => {});

        if (result.type !== 'submit') {
            publishEvent('decision.cycle.ended', { runId, type: result.type, reason: result.reason, steps: result.steps });
            return { ok: false, reason: result.reason, trace: result.trace, warnings: result.warnings, steps: result.steps, workerId: worker.id };
        }
        const form = result.form ?? {};
        const push = buildPush({
            form, assessments,
            place: form.meta?.place ?? '', timeBefore: form.meta?.timeBefore ?? '', timeAfter: form.meta?.timeAfter ?? '',
        });
        form.push = push;
        const decision = String(form._decision ?? '').trim() || fallbackDecision(form);
        publishEvent('decision.cycle.submitted', { runId, type, steps: result.steps, characters: form.characters?.length ?? 0 });
        return { ok: true, form, push, decision, trace: result.trace, warnings: result.warnings, steps: result.steps, workerId: worker.id };
    }

    const PASSIVE_TASK = `Some character plans have ended by RP time. Handle them in the order given, oldest first:
- call resolve_character_plan for each: say what actually came of the plan, mark the record "important" if it must never be compressed, and give the next plan when one is due;
- do not submit a turn in this cycle;
- when the list is empty, call await.
The user's turn does not wait for you.`;

    let passiveTail = Promise.resolve();

    /** Пассивный цикл: только если есть завершившиеся планы. Очередь — строго по одному. */
    function runPassive({ runId, thinking = () => '' } = {}) {
        const job = passiveTail.then(() => passiveRun({ runId, thinking }), () => passiveRun({ runId, thinking }));
        passiveTail = job.then(() => {}, () => {});
        return job;
    }

    async function passiveRun({ runId, thinking }) {
        const clock = store.clock();
        const due = duePlans(store.plans(), clock.minutes);
        if (!due.length) return { skipped: true, due: 0 };
        const settings = getSettings();
        const worker = deciderWorker(settings);
        state.runId = runId;
        const context = buildContext({ settings, summaries: await summaries() });
        const dueText = due.map(plan => `- ${plan.character} (level ${plan.level}): ${plan.summary}${plan.needsNewPlan ? ' [left the active roster — a new plan is needed]' : ''}`).join('\n');
        const messages = [...context.messages, { role: 'user', content: `${PASSIVE_TASK}\n\n${dueText}` }];
        const tools = buildToolList(await externalTools()).filter(tool => tool.name !== 'submit_turn');
        const startedAt = now();
        const result = await runDecisionCycle({
            messages,
            tools,
            generate: generateFor({ settings, worker, runId, prefix: 'p', startedAt }),
            handlers: handlersFor(settings),
            callTool,
            maxSteps: settings.maxSteps,
            implicitAwait: true,
            now,
        });
        const cycle = createCycleRecord({
            event: 'time', messages: result.messages.slice(messages.length), toolCalls: result.trace,
            thinking: thinking(), warnings: result.warnings, at: startedAt,
        });
        await store.appendCycle(cycle).catch(() => {});
        await maybeCompactLog().catch(() => {});
        publishEvent('decision.passive.ended', { runId, due: due.length, steps: result.steps, type: result.type });
        return { skipped: false, due: due.length, steps: result.steps, type: result.type };
    }

    const FORCED_SYSTEM = `You protect the long-term memory of a roleplay. You get summaries that are about to be folded into a higher-level summary. Decide which of them must be KEPT as they are: a summary is worth keeping if it holds a promise, a betrayal, a lasting rule, a relationship change or an open thread that a higher-level summary would blur.
Reply with ONLY a JSON object: {"keep":["summary id", …]}. An empty list means fold everything. Never invent ids.`;

    /** Forced Memory: какие саммари батча не сворачивать. Ядро выключено — пусто, без вызова модели. */
    async function judgeForcedMemory({ batch = [] } = {}) {
        const settings = getSettings();
        const list = (Array.isArray(batch) ? batch : []).filter(record => record?.id);
        if (!settings.enabled || !list.length) return { keep: [] };
        const worker = deciderWorker(settings);
        const ids = new Set(list.map(record => record.id));
        const prompt = `Summaries about to be folded:\n\n${list.map(record => `[${record.id}] (level ${record.level}, messages #${record.startIndex}–#${record.endIndex})\n${record.text}`).join('\n\n')}`;
        const answer = await call('model.generate', {
            workerId: worker.id, systemPrompt: FORCED_SYSTEM, prompt, maxTokens: 800, temperature: 0, stream: false,
        });
        const parsed = parseModelJson(answer);
        const keep = Array.isArray(parsed?.keep) ? parsed.keep.filter(id => ids.has(id)) : [];
        publishEvent('decision.forcedMemory.judged', { batch: list.length, keep: keep.length });
        return { keep };
    }

    return { run, runPassive, judgeForcedMemory, assessments: () => new Map(assessments), resetAssessments: () => assessments.clear() };
}
