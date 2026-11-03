import { request } from '../../libraries/shared/request.js';
import { clampDecisionSettings, DECISION_NAMESPACE, DEFAULT_SETTINGS } from '../../libraries/core/decision-settings.js';
import { createDecisionStore } from './store.js';
import { createDecisionCycle } from './cycle.js';
import { createCardTurn } from './card-turn.js';
import { createResearcher } from '../../libraries/core/decision-researcher.js';
import { captureReasoning } from './capture.js';
import { createRollback } from './rollback.js';
import { createDecisionEvents } from './events.js';
import { registerDecisionContracts } from './contracts.js';
import { previewSection } from './prompt-sections.js';
import { createWriterRewrite } from './rewrite.js';
import { createCharacterBanks } from './banks.js';
import { migratePromptSections, sectionsAreEmpty } from '../../libraries/core/decision-prompt-model.js';

const BEFORE_SEND_PIPELINE = 'generation.beforeSend';
const PAYLOAD_PIPELINE = 'generation.payload';
const DECIDE_STAGE = 'decision:decide';
const REWRITE_STAGE = 'decision:rewrite';
const DECIDE_CONTRACT = 'decision.decide';
const REWRITE_CONTRACT = 'decision.rewrite';
const RETRY_DELAY_MS = 500;

/** Ядро «директор + прозаик»: директива перед отправкой, прозаик на `generation.payload`, банки персонажей. */
export function createDecisionCore(host, { publish, retryDelayMs = RETRY_DELAY_MS } = {}) {
    const publishEvent = publish ?? ((event, payload) => host.events.emit(event, payload));
    let settings = clampDecisionSettings(DEFAULT_SETTINGS);
    let workers = [];
    let pending = null; // текущий прогон директора: { runId, type, chat, decision, form, push, … }
    let lastFailure = null; // последняя неудача: нужна, чтобы отличить ошибку настройки от сбоя модели
    let stagesRegistered = false;
    let registering = false;
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
    const callService = async (contract, params) => {
        const result = await request(host.services, contract, { params });
        if (!result.ok) throw new Error(result.error.message);
        return result.value;
    };
    // Веб-инструменты — Сервис (`stWebSearch.*`), а не контракт Ядра: через `call` их не было вовсе («No supplier registered»).
    const researcher = createResearcher({
        call: callStrict,
        callService,
        getSettings: () => settings,
        getWorkers: () => workers,
        store,
        publishEvent,
    });
    const banks = createCharacterBanks({ call, callService, getSettings: () => settings, getWorkers: () => workers, store, researcher, publishEvent });
    const cycle = createDecisionCycle({
        call: callStrict,
        callTool: async (name, args) => callStrict('generation.callTool', { name, args }),
        getSettings: () => settings,
        getWorkers: () => workers,
        store,
        researcher,
        banks,
        publishEvent,
    });
    const cardTurn = createCardTurn({ call: callStrict, getSettings: () => settings, getWorkers: () => workers });
    const rollback = createRollback({ store, getSettings: () => settings, publishEvent });
    const { snapshotState, restoreState, restoreSnapshotFor } = rollback;

    async function reload() {
        await store.reload();
        await banks.reload().catch(() => {});
        workers = (await call('model.workers.get')) ?? [];
        return { runs: store.runs() };
    }

    async function saveSettings(patch = {}) {
        const next = { ...settings, ...patch };
        // Совместимость с частями 1–3: старый API правит `prompts`, а разделов
        // ещё нет. Как только у раздела появилось содержимое, миграция больше
        // не повторяется — очищенный пользователем блок остаётся пустым.
        if (patch.prompts !== undefined && patch.promptSections === undefined && sectionsAreEmpty(settings.promptSections)) {
            next.promptSections = migratePromptSections(null, { ...settings.prompts, ...patch.prompts });
        }
        settings = clampDecisionSettings(next);
        await call('storage.settings.set', { namespace: DECISION_NAMESPACE, key: 'settings', value: settings });
        return settings;
    }

    function rewriteStage() {
        return {
            id: REWRITE_STAGE,
            contract: REWRITE_CONTRACT,
            params: { payload: { $from: '$value' }, signal: { $from: '$context.signal' }, endpoint: { $from: '$context.endpoint' } },
            onExhausted: 'abort',
        };
    }

    async function addStage(pipelineId, stage) {
        return Boolean(await call('pipeline.stages.add', { pipelineId, stage }).then(value => value !== undefined));
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
            const rewritten = await addStage(PAYLOAD_PIPELINE, rewriteStage());
            stagesRegistered = Boolean(decided && rewritten);
        } finally {
            registering = false;
        }
    }

    async function unregisterStages() {
        if (!stagesRegistered) return;
        stagesRegistered = false;
        await call('pipeline.stages.remove', { pipelineId: BEFORE_SEND_PIPELINE, stageId: DECIDE_STAGE });
        await call('pipeline.stages.remove', { pipelineId: PAYLOAD_PIPELINE, stageId: REWRITE_STAGE });
    }

    function recordStep(runId, step) {
        const list = attempts.get(runId) ?? [];
        list.push(step);
        attempts.set(runId, list);
        return list;
    }

    async function decide(input = {}) {
        lastFailure = null;
        const runId = input.runId ?? `decision_${(runCounter += 1)}`;
        const type = input.type ?? 'normal';
        const chat = Array.isArray(input.chat) ? input.chat : [];
        if (type === 'regenerate' || type === 'swipe') {
            await cycle.removeLastWindowTurn?.().catch(() => {});
        }
        if ((type === 'regenerate' || type === 'swipe') && settings.regen === 'writer') {
            const last = store.lastRun();
            if (last) {
                const push = last.push ?? last.decision;
                pending = { runId, type, chat, chatLength: chat.length, decision: push, push, form: last.form ?? null, reasoning: last.reasoning ?? '', steps: [], workerId: last.workerId ?? null, reused: true, sourceRunId: last.id };
                publishEvent('decision.started', { runId, type, reused: true });
                publishEvent('decision.completed', { runId, reused: true, workerId: pending.workerId });
                return { reused: true, decision: push };
            }
        }
        await banks.ensureColdStart().catch(error => publishEvent('decision.bank.failed', { runId, message: error?.message ?? String(error) }));
        const attempt = (attempts.get(runId)?.length ?? 0) + 1;
        publishEvent('decision.started', { runId, type, attempt });
        const startedAt = Date.now();
        const journal = store.beginTurn(Boolean(settings.snapshots));
        const beforeSnapshot = settings.snapshots ? snapshotState(runId, journal) : null;
        const captured = captureReasoning(host, `${runId}:`, {
            onThinking: text => publishEvent('decision.cycle.thinking', { runId, text }),
            onAnswer: text => publishEvent('decision.cycle.answer', { runId, text }),
        });
        try {
            const result = await cycle.run({ chat, runId, type, thinking: () => captured.value, usage: () => captured.usage });
            if (!result.ok) throw new Error(`The director did not submit the turn: ${result.reason ?? 'no form'}.`);
            const steps = recordStep(runId, { attempt, workerId: result.workerId ?? null, durationMs: Date.now() - startedAt, error: null });
            pending = {
                runId, type, chat, chatLength: chat.length, decision: result.decision,
                push: result.push ?? result.decision, form: result.form, reasoning: captured.value,
                warnings: [...(result.warnings ?? [])], steps,
                workerId: result.workerId ?? null, trace: result.trace ?? [], snapshot: beforeSnapshot,
            };
            publishEvent('decision.completed', { runId, workerId: pending.workerId });
            // Пассивный цикл — ПОСЛЕ формы и НЕ ожидается: прозаик не должен
            // ждать планов персонажей. Если планов к разбору нет, модели не
            // будет вовсе.
            cycle.runPassive({ runId }).catch(error => publishEvent('decision.failed', { runId, message: `passive cycle: ${error?.message ?? error}` }));
            return { decision: result.decision };
        } catch (error) {
            // Неудачная попытка не должна оставлять полу-состояние: откат к
            // снимку до хода, иначе повтор/свайп увидят чужие правки.
            if (beforeSnapshot) await restoreState(beforeSnapshot).catch(() => {});
            recordStep(runId, { attempt, workerId: settings.decider.workerId || null, durationMs: Date.now() - startedAt, error: error?.message ?? String(error) });
            lastFailure = { runId, kind: error?.code === 'decision-config' ? 'config' : 'runtime', message: error?.message ?? String(error) };
            publishEvent('decision.failed', { runId, message: error?.message ?? String(error) });
            throw error;
        } finally {
            captured.stop();
        }
    }

    const rewrite = createWriterRewrite({ host, call, getSettings: () => settings, getWorkers: () => workers, store, getPending: () => pending, banks });

    /** Предпросмотр раздела: собирает блок и плашки данных для окна промптов. */
    const preview = input => previewSection({ input, settings, call, store });

    /** Отбросить ход и, если включены снимки, вернуть состояние до него. */
    function discardPending() {
        const record = pending;
        pending = null;
        attempts.clear();
        if (record?.runId) store.markRejected(record.runId).catch(() => {});
        if (record?.snapshot) restoreState(record.snapshot).catch(() => {});
    }

    const events = createDecisionEvents({
        host,
        getSettings: () => settings,
        getPending: () => pending,
        setPending: value => { pending = value; },
        clearAttempts: () => attempts.clear(),
        deleteAttempt: runId => attempts.delete(runId),
        persist: record => store.persist(record),
        discardPending,
        getLastFailure: () => lastFailure,
        noteCorrection: params => cycle.noteCorrection(params),
        notify,
        revealCard: () => request(host.own, 'ui.reveal', { params: { anchor: 'card:decision' } }),
        restoreSnapshotFor,
        lastMesid: () => call('chatHistory.messages', { limit: 1, includeSystem: true }).then(messages => messages?.at?.(-1)?.mesid),
        cycle,
        reload,
        startDraft: () => cycle.runDraft({ runId: `typing_${(runCounter += 1)}` }).catch(error => publishEvent('decision.failed', { runId: null, message: `typing draft: ${error?.message ?? error}` })),
        canReregister: () => !registering && !stagesRegistered,
        registerStages,
        publishEvent,
        decideStage: DECIDE_STAGE,
    });

    async function load() {
        const stored = await call('storage.settings.get', { namespace: DECISION_NAMESPACE, key: 'settings', fallback: null });
        settings = clampDecisionSettings(stored ?? DEFAULT_SETTINGS);
        await reload();
        await cycle.syncWindow().catch(error => publishEvent('decision.log.warning', { reason: `window sync failed: ${error?.message ?? error}` }));
        unregisters.push(...registerDecisionContracts(host, {
            getSettings: () => settings,
            configure: saveSettings,
            store,
            researcher,
            banks,
            cycle,
            cardTurn,
            decide,
            rewrite,
            preview,
            reload,
            decideContract: DECIDE_CONTRACT,
            rewriteContract: REWRITE_CONTRACT,
        }));
        subscriptions.push(...events.listen());
        await registerStages();
        return settings;
    }

    const publicSettings = () => ({
        ...settings, decider: { ...settings.decider }, writer: { ...settings.writer }, prompts: { ...settings.prompts },
        promptSections: structuredClone(settings.promptSections ?? {}),
    });
    return {
        load,
        configure: saveSettings,
        decide,
        rewrite,
        preview,
        settings: publicSettings,
        runs: () => ({ ...store.runs() }),
        roster: () => store.roster(),
        log: () => store.cycles(),
        archive: () => store.archive(),
        digests: () => store.frozen(),
        window: () => store.window(),
        frozen: () => store.frozen(),
        plan: () => store.plan(),
        arcs: () => store.arcs(),
        notes: () => store.notes(),
        library: () => store.library(),
        plans: () => store.plans(),
        clock: () => store.clock(),
        bank: () => store.bank(),
        research: () => researcher.tasks(),
        names: () => store.names(),
        draft: () => store.draft(),
        message: params => cycle.sendMessage(params),
        waiting: () => cycle.waiting(),
        banks: () => banks.records(),
        bankProgress: () => banks.progress(),
        unregister: async () => {
            for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
            await unregisterStages();
            for (const unregister of unregisters.splice(0)) unregister();
        },
    };
}
