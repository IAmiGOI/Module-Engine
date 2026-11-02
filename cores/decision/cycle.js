import { buildDeciderContext } from '../../libraries/core/decision-context.js';
import { runDecisionCycle } from '../../libraries/core/decision-agent.js';
import { buildToolList } from '../../libraries/core/decision-tools.js';
import { createCycleRecord, thinkingSection } from '../../libraries/core/decision-log.js';
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
        return createHandlers({ store, publishEvent, getSettings, state, resolvePlace, lastTimeMark, similarityScores });
    }

    async function summaries() {
        try { return (await call('summary.list')) ?? []; } catch { return []; }
    }

    function buildContext({ chat = [], settings, summaries: list }) {
        return buildDeciderContext({
            rules: settings.rules, blocks: store.blocks(), summaries: list, chat, runs: store.runs(),
            thoughts: thinkingSection(store.cycles()), plan: store.plan(), arcs: store.arcs(), notes: store.notes(),
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
        publishEvent('decision.passive.ended', { runId, due: due.length, steps: result.steps, type: result.type });
        return { skipped: false, due: due.length, steps: result.steps, type: result.type };
    }

    return { run, runPassive, assessments: () => new Map(assessments), resetAssessments: () => assessments.clear() };
}
