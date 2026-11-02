import { buildDeciderContext } from '../../libraries/core/decision-context.js';
import { runDecisionCycle } from '../../libraries/core/decision-agent.js';
import { buildToolList } from '../../libraries/core/decision-tools.js';
import { createCycleRecord, thinkingSection } from '../../libraries/core/decision-log.js';
import { assessAction, DIFFICULTY_ANCHORS, EXPERIENCE_ANCHORS, lexicalSimilarity } from '../../libraries/core/decision-probability.js';
import { parseModelJson } from '../../libraries/core/parse-model-json.js';
import { deciderRequestParams } from '../../libraries/core/decision-settings.js';
import { validateTurn } from '../../libraries/core/decision-turn.js';
import { buildPush } from '../../libraries/core/decision-push.js';
import { shiftTimeLabel } from '../../libraries/core/time-shift.js';

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

    const anchorVectors = new Map();
    async function vectorFor(text, kind) {
        const key = `${kind}:${text}`;
        if (anchorVectors.has(key)) return anchorVectors.get(key);
        const vector = await call('embedding.compute', { text, kind });
        if (Array.isArray(vector)) anchorVectors.set(key, vector);
        return Array.isArray(vector) ? vector : null;
    }

    /** Близость слова директора к каждой опоре через e5-small; `null` — модель недоступна, тогда лексика. */
    async function similarityScores(phrase, anchors) {
        try {
            const query = await vectorFor(phrase, 'query');
            if (!query) return null;
            const scores = new Map();
            for (const anchor of anchors) {
                for (const anchorPhrase of anchor.phrases) {
                    const vector = await vectorFor(anchorPhrase, 'passage');
                    if (!vector) continue;
                    const similarity = await call('embedding.similarity', { a: query, b: vector });
                    if (Number.isFinite(similarity)) scores.set(anchorPhrase, similarity);
                }
            }
            return scores.size ? scores : null;
        } catch { return null; }
    }

    async function resolvePlace() {
        try {
            const position = await call('map.position.get');
            if (!position?.nodeId) return '';
            const nodes = await call('map.nodes.list');
            const path = await call('map.nodes.containmentPath', { id: position.nodeId });
            const byId = new Map((Array.isArray(nodes) ? nodes : []).map(node => [node.id, node]));
            return (Array.isArray(path) ? path : []).map(id => byId.get(id)?.name ?? id).join(' → ');
        } catch { return ''; }
    }

    async function lastTimeMark() {
        try {
            const marks = await call('chatHistory.annotations', { namespace: 'module.time' });
            const ids = Object.keys(marks ?? {}).sort((a, b) => Number(a) - Number(b));
            return String(marks?.[ids.at(-1)] ?? '');
        } catch { return ''; }
    }

    function handlers({ runId, settings }) {
        return {
            update_roster: async args => {
                const before = store.roster().active;
                const remove = new Set((Array.isArray(args.remove) ? args.remove : []).map(name => String(name).trim()).filter(Boolean));
                const next = [...before.filter(name => !remove.has(name))];
                for (const entry of Array.isArray(args.add) ? args.add : []) {
                    const name = String(entry?.name ?? '').trim();
                    if (name && !next.some(existing => existing.toLowerCase() === name.toLowerCase())) next.push(name);
                }
                await store.saveRoster({ active: next });
                return { ok: true, active: next, added: next.filter(name => !before.includes(name)).length, removed: before.filter(name => !next.includes(name)).length };
            },
            assess: async args => {
                assessmentCounter += 1;
                const id = `asm_${runId}_${assessmentCounter}`;
                const [difficultyScores, experienceScores] = await Promise.all([
                    similarityScores(args.difficulty, DIFFICULTY_ANCHORS),
                    similarityScores(args.experience, EXPERIENCE_ANCHORS),
                ]);
                // Обе шкалы проецируются своей близостью; если e5 недоступна — лексика для обеих.
                const similarity = (text, anchorPhrase) => difficultyScores?.get(anchorPhrase)
                    ?? experienceScores?.get(anchorPhrase)
                    ?? lexicalSimilarity(text, anchorPhrase);
                const seed = Number.isFinite(settings.assessSeed) ? settings.assessSeed + assessmentCounter : undefined;
                const result = assessAction({
                    character: args.character, action: args.action, difficulty: args.difficulty, experience: args.experience, seed, similarity,
                });
                assessments.set(id, { ...result, id });
                return { ok: true, id, ...result };
            },
            submit_turn: async args => {
                const validation = validateTurn({ form: args, roster: store.roster().active, assessments });
                if (!validation.ok) return { ok: false, missing: validation.missing };
                const place = await resolvePlace();
                const timeBefore = await lastTimeMark();
                const timeAfter = shiftTimeLabel(timeBefore, validation.normalized.scene.minutes) ?? '';
                const form = {
                    ...validation.normalized,
                    scene: { ...validation.normalized.scene, place: place || validation.normalized.scene.place || '' },
                    meta: { place, timeBefore, timeAfter },
                };
                turnCounter += 1;
                publishEvent('decision.timeShift', { runId, minutes: validation.normalized.scene.minutes, timeBefore, timeAfter });
                return { ok: true, turnId: `turn_${turnCounter}`, form };
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
        const push = buildPush({
            form, assessments,
            place: form.meta?.place ?? '', timeBefore: form.meta?.timeBefore ?? '', timeAfter: form.meta?.timeAfter ?? '',
        });
        form.push = push;
        const decision = String(form._decision ?? '').trim() || fallbackDecision(form);
        publishEvent('decision.cycle.submitted', { runId, type, steps: result.steps, characters: form.characters?.length ?? 0 });
        return { ok: true, form, push, decision, trace: result.trace, warnings: result.warnings, steps: result.steps, workerId: worker.id };
    }

    return { run, assessments: () => new Map(assessments), resetAssessments: () => assessments.clear() };
}
