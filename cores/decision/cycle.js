import { buildDeciderContext } from '../../libraries/core/decision-context.js';
import { runDecisionCycle } from '../../libraries/core/decision-agent.js';
import { buildToolList } from '../../libraries/core/decision-tools.js';
import { createCycleRecord, thinkingSection } from '../../libraries/core/decision-log.js';
import { assessAction } from '../../libraries/core/decision-probability.js';
import { parseModelJson } from '../../libraries/core/parse-model-json.js';
import { deciderRequestParams } from '../../libraries/core/decision-settings.js';

/**
 * Один активный цикл директора: собрать контекст, дать модели инструменты,
 * провести вызовы, записать цикл в лог и вернуть форму. Хранение и шины —
 * снаружи (`call`, `callTool`, `store`), здесь только ход.
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
                arguments: { comment: 'Legacy JSON answer from the director.', resolution: parsed.decision, characters: [], ...(Array.isArray(parsed.blocks) ? { blocks: parsed.blocks } : {}) },
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
    let assessmentCounter = 0;
    let turnCounter = 0;
    const assessments = new Map();

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

    function handlers({ chat, runId, settings }) {
        return {
            update_roster: args => {
                const state = store.roster();
                const remove = new Set((Array.isArray(args.remove) ? args.remove : []).map(name => String(name).trim()).filter(Boolean));
                const next = [...state.active.filter(name => !remove.has(name))];
                for (const entry of Array.isArray(args.add) ? args.add : []) {
                    const name = String(entry?.name ?? '').trim();
                    if (name && !next.includes(name)) next.push(name);
                }
                return store.saveRoster({ active: next }).then(() => ({ ok: true, active: next, added: next.length - state.active.length + remove.size, removed: remove.size }));
            },
            assess: args => {
                assessmentCounter += 1;
                const id = `asm_${runId}_${assessmentCounter}`;
                const result = assessAction({
                    character: args.character, action: args.action, difficulty: args.difficulty, experience: args.experience,
                    seed: Number.isFinite(settings.assessSeed) ? settings.assessSeed : undefined,
                });
                assessments.set(id, { ...result, id });
                return { ok: true, id, ...result };
            },
            submit_turn: args => {
                turnCounter += 1;
                return { ok: true, turnId: `turn_${turnCounter}`, form: { ...args, chat } };
            },
            await: args => ({ ok: true, reason: String(args.reason ?? '') }),
        };
    }

    async function run({ chat, runId, type = 'normal', thinking = () => '' }) {
        const settings = getSettings();
        const worker = deciderWorker(settings);
        let summaries = [];
        try { summaries = (await call('summary.list')) ?? []; } catch { summaries = []; }
        const context = buildDeciderContext({
            rules: settings.rules, blocks: store.blocks(), summaries, chat, runs: store.runs(),
            thoughts: thinkingSection(store.cycles()), toolMode: true,
        });
        const tools = buildToolList(await externalTools());
        const startedAt = now();
        let modelCall = 0;
        const result = await runDecisionCycle({
            messages: context.messages,
            tools,
            generate: async ({ messages, tools: list, toolChoice, stream, returnMessage }) => {
                modelCall += 1;
                const answer = await call('model.generate', {
                    requestId: `${runId}:${modelCall}:${startedAt}`,
                    ...deciderRequestParams(settings.decider),
                    workerId: worker.id,
                    messages, tools: list, toolChoice, stream: false, returnMessage,
                });
                return normalizeGenerateAnswer(answer);
            },
            handlers: handlers({ chat, runId, settings }),
            callTool,
            maxSteps: settings.maxSteps,
            implicitAwait: Boolean(settings.implicitAwait),
            now,
        });

        const cycle = createCycleRecord({
            event: type === 'normal' ? 'turn' : type,
            messages: result.messages.slice(context.messages.length),
            toolCalls: result.trace,
            thinking: thinking(),
            warnings: result.warnings,
            at: startedAt,
        });
        await store.appendCycle(cycle).catch(() => {});

        if (result.type !== 'submit') {
            publishEvent('decision.cycle.ended', { runId, type: result.type, reason: result.reason, steps: result.steps });
            return { ok: false, reason: result.reason, trace: result.trace, warnings: result.warnings, steps: result.steps, workerId: worker.id };
        }
        const form = result.form ?? {};
        publishEvent('decision.cycle.submitted', { runId, type, steps: result.steps, characters: form.characters?.length ?? 0 });
        return { ok: true, form, decision: fallbackDecision(form), trace: result.trace, warnings: result.warnings, steps: result.steps, workerId: worker.id };
    }

    return { run, assessments: () => new Map(assessments), resetAssessments: () => assessments.clear() };
}
