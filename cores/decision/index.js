import { request } from '../../libraries/shared/request.js';
import { clampDecisionSettings, DECISION_NAMESPACE, DEFAULT_SETTINGS } from '../../libraries/core/decision-settings.js';
import { buildWriterContext } from '../../libraries/core/decision-context.js';
import { applyBlockEdits } from '../../libraries/core/decision-format.js';
import { computeWriterPayload } from '../../libraries/core/decision-body.js';
import { extractReasoning } from '../../libraries/core/decision-reasoning.js';
import { createDecisionStore } from './store.js';
import { createDecisionCycle } from './cycle.js';

const BEFORE_SEND_PIPELINE = 'generation.beforeSend';
const PAYLOAD_PIPELINE = 'generation.payload';
const DECIDE_STAGE = 'decision:decide';
const REWRITE_STAGE = 'decision:rewrite';
const PM_STAGE = 'prompt-manager:rewrite';
const DECIDE_CONTRACT = 'decision.decide';
const REWRITE_CONTRACT = 'decision.rewrite';
const RETRY_DELAY_MS = 500;

/**
 * Ядро «директор + прозаик» (docs/research-decision/DESIGN.md).
 *
 * Директор думает и решает на `generation.beforeSend`; прозаик пишет тот же
 * основной запрос ST на `generation.payload`, но с телом, заменённым его
 * контекстом. Ядро по умолчанию выключено: пока `settings.enabled` false,
 * этапы НЕ регистрируются, и путь генерации остаётся прежним.
 *
 * Порядок на `payload` задан зависимостью, а не порядком регистрации:
 * `decision:rewrite` объявляет `needs: ['prompt-manager:rewrite']`, если PM
 * уже зарегистрировал свой этап, и поэтому всегда идёт последним. Если PM
 * загрузится позже, этап перерегистрируется по `pipeline.stagesChanged`.
 *
 * Правки блоков и запись прогона живут в памяти до успешного конца прогона
 * (`generation.completed` с `outcome: 'ended'`). Вытесненный/отменённый/
 * остановленный прогон ничего не коммитит — полузаписанных блоков не бывает.
 */
export function createDecisionCore(host, { publish, retryDelayMs = RETRY_DELAY_MS } = {}) {
    const publishEvent = publish ?? ((event, payload) => host.events.emit(event, payload));
    let settings = clampDecisionSettings(DEFAULT_SETTINGS);
    let workers = [];
    let pending = null; // текущий прогон директора: { runId, type, chat, decision, edits, blocksAfter, … }
    let stagesRegistered = false;
    let registering = false;
    let rewriteNeedsPm = false;
    let runCounter = 0;
    const attempts = new Map(); // runId -> шаги попыток (успешная и провалившиеся)
    const subscriptions = [];
    const unregisters = [];

    const call = async (contract, params, options) => {
        const result = await request(host.own, contract, { params, ...options });
        return result.ok ? result.value : undefined;
    };
    const notify = (tone, text) => { request(host.own, 'ui.notify', { params: { tone, text } }); };
    /** Строгий вызов: ошибка контракта обязана дойти до цикла, иначе сбой модели выглядел бы как «модель молчит». */
    const callStrict = async (contract, params, options) => {
        const result = await request(host.own, contract, { params, ...options });
        if (!result.ok) throw new Error(result.error.message);
        return result.value;
    };
    const store = createDecisionStore({ call, publishEvent });
    const cycle = createDecisionCycle({
        call: callStrict,
        callTool: async (name, args) => callStrict('generation.callTool', { name, args }),
        getSettings: () => settings,
        getWorkers: () => workers,
        store,
        publishEvent,
    });

    async function reload() {
        await store.reload();
        workers = (await call('model.workers.get')) ?? [];
        return { blocks: store.blocks(), runs: store.runs() };
    }

    async function saveSettings(patch = {}) {
        const wasEnabled = settings.enabled;
        settings = clampDecisionSettings({ ...settings, ...patch });
        await call('storage.settings.set', { namespace: DECISION_NAMESPACE, key: 'settings', value: settings });
        if (!wasEnabled && settings.enabled) await registerStages();
        if (wasEnabled && !settings.enabled) {
            await unregisterStages();
            pending = null;
            attempts.clear();
        }
        return settings;
    }

    function rewriteStage(withPm) {
        return {
            id: REWRITE_STAGE,
            contract: REWRITE_CONTRACT,
            params: { payload: { $from: '$value' } },
            ...(withPm ? { needs: [PM_STAGE] } : {}),
            onExhausted: 'abort',
        };
    }

    async function addStage(pipelineId, stage) {
        return Boolean(await call('pipeline.stages.add', { pipelineId, stage }).then(value => value !== undefined));
    }

    async function hasStage(pipelineId, stageId) {
        const stages = await call('pipeline.stages', { pipelineId });
        return Array.isArray(stages) && stages.some(stage => stage.id === stageId);
    }

    async function registerStages() {
        if (registering || stagesRegistered) return;
        registering = true;
        try {
            const decided = await addStage(BEFORE_SEND_PIPELINE, {
                id: DECIDE_STAGE,
                contract: DECIDE_CONTRACT,
                params: { chat: { $from: '$input.chat' }, type: { $from: '$input.type' }, runId: { $from: '$input.runId' } },
                fallbacks: [{ delayMs: retryDelayMs }],
                onExhausted: 'abort',
            });
            rewriteNeedsPm = await hasStage(PAYLOAD_PIPELINE, PM_STAGE);
            const rewritten = await addStage(PAYLOAD_PIPELINE, rewriteStage(rewriteNeedsPm));
            stagesRegistered = Boolean(decided && rewritten);
        } finally {
            registering = false;
        }
    }

    async function unregisterStages() {
        if (!stagesRegistered) return;
        stagesRegistered = false;
        rewriteNeedsPm = false;
        await call('pipeline.stages.remove', { pipelineId: BEFORE_SEND_PIPELINE, stageId: DECIDE_STAGE });
        await call('pipeline.stages.remove', { pipelineId: PAYLOAD_PIPELINE, stageId: REWRITE_STAGE });
    }

    /**
     * Захват ризонинга провайдера за ВЕСЬ цикл: у агента несколько вызовов,
     * их requestId начинаются с `${runId}:`. Текст копится по порядку — это
     * то, что лог хранит как thinking цикла.
     */
    function captureReasoning(prefix) {
        const state = { value: '' };
        const unsubscribe = host.events.subscribe('model.generate.raw', payload => {
            if (!String(payload?.requestId ?? '').startsWith(prefix)) return;
            const extracted = extractReasoning(payload.format, payload.body);
            if (extracted) state.value = state.value ? `${state.value}\n\n${extracted}` : extracted;
        });
        return { get value() { return state.value; }, stop: unsubscribe };
    }

    function recordStep(runId, step) {
        const list = attempts.get(runId) ?? [];
        list.push(step);
        attempts.set(runId, list);
        return list;
    }

    async function decide(input = {}) {
        if (!settings.enabled) return { skipped: 'the decision core is off' };
        const runId = input.runId ?? `decision_${(runCounter += 1)}`;
        const type = input.type ?? 'normal';
        const chat = Array.isArray(input.chat) ? input.chat : [];
        if ((type === 'regenerate' || type === 'swipe') && settings.regen === 'writer') {
            const last = store.lastRun();
            if (last) {
                const push = last.push ?? last.decision;
                pending = { runId, type, chat, chatLength: chat.length, decision: push, push, form: last.form ?? null, edits: [], blocksAfter: store.blocks(), reasoning: last.reasoning ?? '', steps: [], workerId: last.workerId ?? null, reused: true };
                publishEvent('decision.started', { runId, type, reused: true });
                publishEvent('decision.completed', { runId, reused: true, edits: 0, blocks: store.blocks().length, workerId: pending.workerId });
                return { reused: true, decision: push };
            }
        }
        const attempt = (attempts.get(runId)?.length ?? 0) + 1;
        publishEvent('decision.started', { runId, type, attempt });
        const startedAt = Date.now();
        const captured = captureReasoning(`${runId}:`);
        try {
            const result = await cycle.run({ chat, runId, type, thinking: () => captured.value });
            if (!result.ok) throw new Error(`The director did not submit the turn: ${result.reason ?? 'no form'}.`);
            const edits = Array.isArray(result.form?.blocks) ? result.form.blocks : [];
            const applied = applyBlockEdits(store.blocks(), edits);
            const steps = recordStep(runId, { attempt, workerId: result.workerId ?? null, durationMs: Date.now() - startedAt, error: null });
            pending = {
                runId, type, chat, chatLength: chat.length, decision: result.decision,
                push: result.push ?? result.decision, form: result.form, edits, blocksAfter: applied.blocks, reasoning: captured.value,
                warnings: [...(result.warnings ?? []), ...applied.warnings], steps,
                workerId: result.workerId ?? null, trace: result.trace ?? [],
            };
            publishEvent('decision.completed', { runId, edits: edits.length, blocks: applied.blocks.length, workerId: pending.workerId });
            return { decision: result.decision, edits: edits.length };
        } catch (error) {
            recordStep(runId, { attempt, workerId: settings.decider.workerId || null, durationMs: Date.now() - startedAt, error: error?.message ?? String(error) });
            publishEvent('decision.failed', { runId, message: error?.message ?? String(error) });
            throw error;
        } finally {
            captured.stop();
        }
    }

    async function rewrite(input = {}) {
        const payload = input.payload ?? input;
        if (!settings.enabled || !pending || !payload) return payload;
        const summaries = (await call('summary.list')) ?? [];
        const context = buildWriterContext({ blocks: pending.blocksAfter ?? store.blocks(), notes: store.notes(), summaries, chat: pending.chat, decision: pending.push ?? pending.decision });
        const worker = workers.find(item => item.id === settings.writer.workerId);
        const model = worker && worker.id !== 'st-main' ? String(worker.model ?? '') : '';
        return computeWriterPayload(payload, context, { writer: settings.writer, model }) ?? payload;
    }

    function onBeforeSend(payload) {
        if (pending && payload?.runId && pending.runId !== payload.runId) {
            pending = null;
            attempts.clear();
        }
    }

    function onCompleted(payload) {
        if (!pending) return;
        const mismatched = payload?.runId && pending.runId && payload.runId !== pending.runId;
        if (mismatched || payload?.outcome !== 'ended') {
            pending = null;
            attempts.clear();
            return;
        }
        const record = pending;
        pending = null;
        attempts.clear();
        store.persist(record).catch(error => publishEvent('decision.failed', { runId: record.runId, message: `could not save the director run: ${error?.message ?? error}` }));
    }

    function onAborted(payload) {
        if (payload?.stage === DECIDE_STAGE) notify('error', 'Decision core: the director failed twice, so this generation was cancelled.');
        if (!payload?.runId || !pending || pending.runId === payload.runId) pending = null;
        attempts.delete(payload?.runId);
    }

    function onSuperseded(payload) {
        if (!payload?.runId || !pending || pending.runId === payload.runId) pending = null;
        attempts.delete(payload?.runId);
    }

    function onStagesChanged(payload) {
        if (registering) return;
        if (!stagesRegistered && settings.enabled) { registerStages().catch(() => {}); return; }
        if (payload?.pipelineId !== PAYLOAD_PIPELINE || !stagesRegistered) return;
        if (payload?.added === PM_STAGE && !rewriteNeedsPm) { rewriteNeedsPm = true; addStage(PAYLOAD_PIPELINE, rewriteStage(true)).catch(() => {}); }
        if (payload?.removed === PM_STAGE && rewriteNeedsPm) { rewriteNeedsPm = false; addStage(PAYLOAD_PIPELINE, rewriteStage(false)).catch(() => {}); }
    }

    function listen() {
        subscriptions.push(
            host.events.subscribe('generation.beforeSend', onBeforeSend),
            host.events.subscribe('generation.completed', onCompleted),
            host.events.subscribe('generation.superseded', onSuperseded),
            host.events.subscribe('generation.aborted', onAborted),
            host.events.subscribe('pipeline.stagesChanged', onStagesChanged),
            host.events.subscribe('model.workers.changed', () => { reload().catch(() => {}); }),
            host.events.subscribe('st.chatChanged', () => { pending = null; attempts.clear(); reload().catch(() => {}); }),
        );
    }

    async function load() {
        const stored = await call('storage.settings.get', { namespace: DECISION_NAMESPACE, key: 'settings', fallback: null });
        settings = clampDecisionSettings(stored ?? DEFAULT_SETTINGS);
        await reload();
        unregisters.push(
            host.own.register('decision.settings', () => ({ ...settings, decider: { ...settings.decider }, writer: { ...settings.writer } })),
            host.own.register('decision.configure', params => saveSettings(params?.patch ?? {})),
            host.own.register('decision.blocks', () => store.blocks().map(block => ({ ...block }))),
            host.own.register('decision.runs', () => ({ ...store.runs() })),
            host.own.register('decision.lastRun', () => store.lastRun()),
            host.own.register('decision.roster', () => store.roster()),
            host.own.register('decision.log', () => store.cycles()),
            host.own.register('decision.archive', () => store.archive()),
            host.own.register('decision.plan', () => store.plan()),
            host.own.register('decision.arcs', () => store.arcs()),
            host.own.register('decision.notes', () => store.notes()),
            host.own.register('decision.reload', () => reload()),
            host.own.register(DECIDE_CONTRACT, params => decide(params)),
            host.own.register(REWRITE_CONTRACT, params => rewrite(params)),
        );
        listen();
        if (settings.enabled) await registerStages();
        return settings;
    }

    return {
        load,
        configure: saveSettings,
        decide,
        rewrite,
        settings: () => ({ ...settings, decider: { ...settings.decider }, writer: { ...settings.writer } }),
        blocks: () => store.blocks().map(block => ({ ...block })),
        runs: () => ({ ...store.runs() }),
        roster: () => store.roster(),
        log: () => store.cycles(),
        archive: () => store.archive(),
        plan: () => store.plan(),
        arcs: () => store.arcs(),
        notes: () => store.notes(),
        unregister: async () => {
            for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
            await unregisterStages();
            for (const unregister of unregisters.splice(0)) unregister();
        },
    };
}
