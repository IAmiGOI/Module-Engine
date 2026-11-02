import { request } from '../../libraries/shared/request.js';
import { clampDecisionSettings, DECISION_NAMESPACE, DEFAULT_SETTINGS } from '../../libraries/core/decision-settings.js';
import { buildWriterContext } from '../../libraries/core/decision-context.js';
import { computeWriterPayload } from '../../libraries/core/decision-body.js';
import { extractReasoning } from '../../libraries/core/decision-reasoning.js';
import { extractCachedTokens } from '../../libraries/core/decision-cache.js';
import { createDecisionStore } from './store.js';
import { createDecisionCycle } from './cycle.js';
import { createCardTurn } from './card-turn.js';
import { createResearcher } from '../../libraries/core/decision-researcher.js';

const BEFORE_SEND_PIPELINE = 'generation.beforeSend';
const PAYLOAD_PIPELINE = 'generation.payload';
const DECIDE_STAGE = 'decision:decide';
const REWRITE_STAGE = 'decision:rewrite';
const DECIDE_CONTRACT = 'decision.decide';
const REWRITE_CONTRACT = 'decision.rewrite';
const RETRY_DELAY_MS = 500;

/**
 * Ядро «директор + прозаик» (docs/research-decision/DESIGN.md).
 *
 * Директор думает и решает на `generation.beforeSend`; прозаик пишет тот же
 * основной запрос ST на `generation.payload`, но с телом, заменённым его
 * контекстом. Ядро всегда включено: выключателя нет, запасного пути через
 * сборку ST тоже. Без воркера директора генерация не отправляется — вместо
 * этого пользователь получает понятное уведомление и карточку настройки.
 *
 * На `generation.payload` `decision:rewrite` — единственный этап: тело ST
 * целиком заменяется контекстом прозаика. Prompt Manager удалён (часть 3),
 * поэтому зависимостей по `needs` у этапа больше нет.
 *
 * Запись прогона живёт в памяти до успешного конца прогона
 * (`generation.completed` с `outcome: 'ended'`). Вытесненный/отменённый/
 * остановленный прогон ничего не коммитит — полузаписанных ходов не бывает.
 */
export function createDecisionCore(host, { publish, retryDelayMs = RETRY_DELAY_MS } = {}) {
    const publishEvent = publish ?? ((event, payload) => host.events.emit(event, payload));
    let settings = clampDecisionSettings(DEFAULT_SETTINGS);
    let workers = [];
    let pending = null; // текущий прогон директора: { runId, type, chat, decision, form, push, … }
    let lastFailure = null; // последняя неудача: нужна, чтобы отличить ошибку настройки от сбоя модели
    let stagesRegistered = false;
    let registering = false;
    let runCounter = 0;
    let typingActive = false;
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
    const researcher = createResearcher({
        call: callStrict,
        getSettings: () => settings,
        getWorkers: () => workers,
        store,
        publishEvent,
    });
    const cycle = createDecisionCycle({
        call: callStrict,
        callTool: async (name, args) => callStrict('generation.callTool', { name, args }),
        getSettings: () => settings,
        getWorkers: () => workers,
        store,
        researcher,
        publishEvent,
    });
    const cardTurn = createCardTurn({ call: callStrict, getSettings: () => settings, getWorkers: () => workers });

    async function reload() {
        await store.reload();
        workers = (await call('model.workers.get')) ?? [];
        return { runs: store.runs() };
    }

    async function saveSettings(patch = {}) {
        settings = clampDecisionSettings({ ...settings, ...patch });
        await call('storage.settings.set', { namespace: DECISION_NAMESPACE, key: 'settings', value: settings });
        return settings;
    }

    function rewriteStage() {
        return {
            id: REWRITE_STAGE,
            contract: REWRITE_CONTRACT,
            params: { payload: { $from: '$value' } },
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

    /**
     * Захват ризонинга провайдера за ВЕСЬ цикл: у агента несколько вызовов,
     * их requestId начинаются с `${runId}:`. Текст копится по порядку — это
     * то, что лог хранит как thinking цикла.
     */
    function captureReasoning(prefix) {
        const state = { value: '', usage: { prompt: 0, completion: 0, cached: 0, total: 0 } };
        const unsubscribe = host.events.subscribe('model.generate.raw', payload => {
            if (!String(payload?.requestId ?? '').startsWith(prefix)) return;
            const extracted = extractReasoning(payload.format, payload.body);
            if (extracted) state.value = state.value ? `${state.value}\n\n${extracted}` : extracted;
            try {
                const usage = JSON.parse(payload.body)?.usage;
                if (usage) {
                    state.usage.prompt += Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
                    state.usage.completion += Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
                    state.usage.cached += Number(extractCachedTokens(usage) ?? 0) || 0;
                    state.usage.total = state.usage.prompt + state.usage.completion;
                }
            } catch { /* тело без usage — не ошибка */ }
        });
        return { get value() { return state.value; }, get usage() { return { ...state.usage }; }, stop: unsubscribe };
    }

    /** Снимок состояния до хода: форма/решения, ростер, планы, заметки, библиотека, план, арки, часы. */
    function snapshotState() {
        return {
            roster: store.roster(), plan: store.plan(), arcs: store.arcs(),
            notes: store.notes(), library: store.library(), plans: store.plans(), clock: store.clock(),
        };
    }

    async function restoreState(state) {
        if (!state) return;
        await Promise.all([
            store.saveRoster(state.roster ?? { active: [] }),
            store.savePlan(state.plan ?? null), store.saveArcs(state.arcs ?? []),
            store.saveNotes(state.notes ?? {}), store.saveLibrary(state.library ?? {}),
            store.savePlans(state.plans ?? []), store.saveClock(state.clock ?? { minutes: 0 }),
        ]);
    }

    async function restoreSnapshotFor(mesid, { remove = false } = {}) {
        if (!settings.snapshots || mesid === null || mesid === undefined) return false;
        const state = store.snapshot(mesid);
        if (!state) return false;
        await restoreState(state);
        if (remove) await store.deleteSnapshot(mesid);
        publishEvent('decision.snapshot.restored', { mesid: String(mesid) });
        return true;
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
        if ((type === 'regenerate' || type === 'swipe') && settings.regen === 'writer') {
            const last = store.lastRun();
            if (last) {
                const push = last.push ?? last.decision;
                pending = { runId, type, chat, chatLength: chat.length, decision: push, push, form: last.form ?? null, reasoning: last.reasoning ?? '', steps: [], workerId: last.workerId ?? null, reused: true };
                publishEvent('decision.started', { runId, type, reused: true });
                publishEvent('decision.completed', { runId, reused: true, workerId: pending.workerId });
                return { reused: true, decision: push };
            }
        }
        const attempt = (attempts.get(runId)?.length ?? 0) + 1;
        publishEvent('decision.started', { runId, type, attempt });
        const startedAt = Date.now();
        const beforeSnapshot = settings.snapshots ? snapshotState() : null;
        const captured = captureReasoning(`${runId}:`);
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

    async function rewrite(input = {}) {
        const payload = input.payload ?? input;
        if (!pending || !payload) return payload;
        const summaries = (await call('summary.list')) ?? [];
        const context = buildWriterContext({ notes: store.notes(), summaries, chat: pending.chat, decision: pending.push ?? pending.decision });
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

    /** Отбросить ход и, если включены снимки, вернуть состояние до него. */
    function discardPending() {
        const record = pending;
        pending = null;
        attempts.clear();
        if (record?.snapshot) restoreState(record.snapshot).catch(() => {});
    }

    function onCompleted(payload) {
        if (!pending) return;
        const mismatched = payload?.runId && pending.runId && payload.runId !== pending.runId;
        if (mismatched || payload?.outcome !== 'ended') {
            discardPending();
            return;
        }
        const record = pending;
        pending = null;
        attempts.clear();
        store.persist(record).catch(error => publishEvent('decision.failed', { runId: record.runId, message: `could not save the director run: ${error?.message ?? error}` }));
    }

    function onAborted(payload) {
        if (payload?.stage === DECIDE_STAGE) {
            if (lastFailure?.kind === 'config') {
                notify('error', `Director: ${lastFailure.message} The generation was not sent.`);
                request(host.own, 'ui.reveal', { params: { anchor: 'card:decision' } });
            } else {
                notify('error', 'Decision core: the director failed twice, so this generation was cancelled.');
            }
        }
        if (!payload?.runId || !pending || pending.runId === payload.runId) discardPending();
        attempts.delete(payload?.runId);
    }

    function onSuperseded(payload) {
        if (!payload?.runId || !pending || pending.runId === payload.runId) discardPending();
        attempts.delete(payload?.runId);
    }

    function onStagesChanged() {
        if (registering) return;
        if (!stagesRegistered) registerStages().catch(() => {});
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
            host.events.subscribe('decision.researcher.report', payload => {
                cycle.onResearcherReport(payload).catch(error => publishEvent('decision.failed', { runId: null, message: `researcher wake: ${error?.message ?? error}` }));
            }),
            // Свайп и удаление: вернуть состояние к снимку до этого хода.
            host.events.subscribe('st.messageSwiped', () => {
                call('chatHistory.messages', { limit: 1, includeSystem: true }).then(messages => restoreSnapshotFor(messages?.at?.(-1)?.mesid)).catch(() => {});
            }),
            host.events.subscribe('st.messageDeleted', payload => {
                restoreSnapshotFor(payload?.args?.[0], { remove: true }).catch(() => {});
            }),
            // Старт по набору текста — только когда включены и настройка, и заготовка.
            host.events.subscribe('ui.inputBar.changed', payload => {
                const active = Boolean(payload?.active);
                if (!active) { typingActive = false; return; }
                if (typingActive) return;
                typingActive = true;
                if (!settings.startOnTyping || !settings.turnDraft || pending) return;
                cycle.runDraft({ runId: `typing_${(runCounter += 1)}` }).catch(error => publishEvent('decision.failed', { runId: null, message: `typing draft: ${error?.message ?? error}` }));
            }),
        );
    }

    async function load() {
        const stored = await call('storage.settings.get', { namespace: DECISION_NAMESPACE, key: 'settings', fallback: null });
        settings = clampDecisionSettings(stored ?? DEFAULT_SETTINGS);
        await reload();
        unregisters.push(
            host.own.register('decision.settings', () => ({ ...settings, decider: { ...settings.decider }, writer: { ...settings.writer } })),
            host.own.register('decision.configure', params => saveSettings(params?.patch ?? {})),
            host.own.register('decision.runs', () => ({ ...store.runs() })),
            host.own.register('decision.lastRun', () => store.lastRun()),
            host.own.register('decision.roster', () => store.roster()),
            host.own.register('decision.log', () => store.cycles()),
            host.own.register('decision.archive', () => store.archive()),
            host.own.register('decision.plan', () => store.plan()),
            host.own.register('decision.arcs', () => store.arcs()),
            host.own.register('decision.notes', () => store.notes()),
            host.own.register('decision.library', () => store.library()),
            host.own.register('decision.plans', () => store.plans()),
            host.own.register('decision.clock', () => store.clock()),
            host.own.register('decision.bank', () => store.bank()),
            host.own.register('decision.forcedMemory', params => cycle.judgeForcedMemory(params)),
            host.own.register('decision.research', () => researcher.tasks()),
            host.own.register('decision.names', () => store.names()),
            host.own.register('decision.draft', () => store.draft()),
            host.own.register('decision.reload', () => reload()),
            host.own.register('decision.cardTurn', params => cardTurn(params)),
            host.own.register(DECIDE_CONTRACT, params => decide(params)),
            host.own.register(REWRITE_CONTRACT, params => rewrite(params)),
        );
        listen();
        await registerStages();
        return settings;
    }

    return {
        load,
        configure: saveSettings,
        decide,
        rewrite,
        settings: () => ({ ...settings, decider: { ...settings.decider }, writer: { ...settings.writer } }),
        runs: () => ({ ...store.runs() }),
        roster: () => store.roster(),
        log: () => store.cycles(),
        archive: () => store.archive(),
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
        unregister: async () => {
            for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
            await unregisterStages();
            for (const unregister of unregisters.splice(0)) unregister();
        },
    };
}
