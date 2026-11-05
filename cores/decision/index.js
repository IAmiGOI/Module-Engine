import { request } from '../../libraries/shared/request.js';
import { clampDecisionSettings, DECISION_NAMESPACE, DEFAULT_SETTINGS, publicDecisionSettings } from '../../libraries/core/decision-settings.js';
import { createDecisionStore } from './store.js';
import { createDecisionCycle } from './cycle.js';
import { createCardTurn } from './card-turn.js';
import { createResearcher } from '../../libraries/core/decision-researcher.js';
import { createWebActions } from '../guide/web-actions.js';
import { captureReasoning } from './capture.js';
import { createRollback } from './rollback.js';
import { createDecisionEvents } from './events.js';
import { registerDecisionContracts, decisionRewriteStage } from './contracts.js';
import { previewSection } from './prompt-sections.js';
import { createWriterRewrite } from './rewrite.js';
import { createCharacterBanks } from './banks.js';
import { createBootstrap } from './bootstrap.js';
import { createBankSets } from './bank-sets.js';
import { migratePromptSections, sectionsAreEmpty } from '../../libraries/core/decision-prompt-model.js';
import { clampGameSettings, describeSettingsChange, modeOf, modeValues, patchGameSettings, resolveGameSettings, settingsLabel } from '../../libraries/core/game-settings.js';
import { buildRollLines } from '../../libraries/core/decision-push.js';
import { addGameMix, clampGameMixes, findGameMix, nextGameMixId, removeGameMix, renameGameMix, updateGameMix } from '../../libraries/core/game-mixes.js';
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
    const timedOutRuns = new Map(); // runId -> сообщение: ход истёк по сроку, повтор конвейера сразу отказывает
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
    // Настройки игры (часть 13): у чата свои, без записи — умолчание новых
    // чатов. Кэш синхронный: два быстрых клика по разным опциям не должны
    // оба прочитать старый набор и затереть правку друг друга.
    let gameValues = null;
    const gameSettingsValues = () => {
        if (!gameValues) gameValues = resolveGameSettings(store.gameSettings(), settings.gameDefaults);
        return { ...gameValues };
    };
    const gameMixes = () => clampGameMixes(settings.gameMixes);
    const gameSettingsState = () => {
        const values = gameSettingsValues();
        return { values, mode: modeOf(values), defaults: clampGameSettings(settings.gameDefaults), mixes: gameMixes() };
    };
    /** Строки броска для сообщения: только при «Show rolls: In the chat» и только броски его формы. */
    const messageRolls = mesid => {
        const showRolls = gameSettingsValues().showRolls;
        const run = store.runs()[String(mesid ?? '')] ?? null;
        if (!run || showRolls !== 'chat') return { showRolls, lines: [] };
        return { showRolls, lines: buildRollLines({ form: run.form, assessments: run.assessments ?? [] }) };
    };
    const callService = async (contract, params) => {
        const result = await request(host.services, contract, { params });
        if (!result.ok) throw new Error(result.error.message);
        return result.value;
    };
    // Веб-инструменты — Сервис (`stWebSearch.*`), а не контракт Ядра: через `call` их не было вовсе («No supplier registered»).
    // Веб-набор гида (базы персонажей, вики, поиск по смыслу) — и исследователю, и сборщикам банков.
    const webActions = createWebActions({
        callService: async (contract, params) => {
            try { return { ok: true, value: await callService(contract, params) }; } catch (error) { return { ok: false, error: { message: error?.message ?? String(error) } }; }
        },
    });
    const researcher = createResearcher({
        call: callStrict,
        callService,
        webActions,
        getSettings: () => settings,
        getWorkers: () => workers,
        store,
        publishEvent,
    });
    const banks = createCharacterBanks({ call, callService, getSettings: () => settings, getWorkers: () => workers, store, researcher, publishEvent });
    const cycle = createDecisionCycle({
        call: callStrict,
        callTool: async (name, args) => callStrict('generation.callTool', { name, args }),
        callService: async (contract, params) => {
            const result = await request(host.services, contract, { params });
            if (!result.ok) throw new Error(result.error.message);
            return result.value;
        },
        getSettings: () => settings,
        getGameSettings: gameSettingsValues,
        getWorkers: () => workers,
        store,
        researcher,
        banks,
        publishEvent,
        // Мысли и расход фоновых циклов (bootstrap, сообщения, пассивные) — тем же перехватом, что у хода.
        capture: (prefix, handlers) => captureReasoning(host, prefix, handlers),
    });
    const bootstrap = createBootstrap({ call: callStrict, store, cycle, getSettings: () => settings, getGameSettings: gameSettingsValues, publishEvent });
    const bankSets = createBankSets({ call: callStrict, banks, store, bootstrap, askUser: params => cycle.askUser(params), publishEvent });
    // Снимок «стартовых» банков — с паузой: событие «готов» приходит раньше, чем банк записан, а событий за bootstrap много.
    let snapshotTimer = null;
    const scheduleSnapshot = () => {
        if (snapshotTimer) clearTimeout(snapshotTimer);
        snapshotTimer = setTimeout(() => { snapshotTimer = null; bankSets.snapshot().catch(() => {}); }, 1500);
    };
    for (const name of ['decision.bootstrap.finished', 'decision.bank.ready', 'decision.bank.timeline']) host.events.subscribe(name, scheduleSnapshot);
    const cardTurn = createCardTurn({ call: callStrict, getSettings: () => settings, getWorkers: () => workers });
    const rollback = createRollback({ store, getSettings: () => settings, publishEvent, call: callStrict });
    const { snapshotState, restoreState, restoreSnapshotFor } = rollback;

    // Смена чата: всё, что делалось для старого, отменяется и больше ничего не пишет в новый —
    // фоновый цикл, вопросы, bootstrap, сборщики банков и задания исследователя.
    function chatChanged() {
        cycle.chatChanged();
        bootstrap.chatChanged();
        researcher.cancel({ all: true, reason: 'cancelled: the chat was changed' });
    }

    async function reload() {
        await store.reload();
        gameValues = null;
        await cycle.rebuildWindow().catch(error => publishEvent('decision.log.warning', { reason: `window rebuild failed: ${error?.message ?? error}` }));
        await banks.reload().catch(() => {});
        workers = (await call('model.workers.get')) ?? [];
        await bootstrap.load().catch(() => {});
        bootstrap.maybeStart().catch(error => publishEvent('decision.bootstrap.warning', { message: error?.message ?? String(error) }));
        // Новый чат: банки строятся сразу, параллельно bootstrap, а не с первым ходом.
        // Есть готовые банки прошлого bootstrap для этих книг — сначала вопрос «взять их?», потом сборка недостающих.
        bootstrap.isNewChat().then(async fresh => {
            if (!fresh) return;
            await bankSets.offer().catch(error => publishEvent('decision.bank.warning', { message: `Saved banks were not offered: ${error?.message ?? error}` }));
            await banks.ensureColdStart();
        }).catch(error => publishEvent('decision.bank.failed', { message: error?.message ?? String(error) }));
        publishEvent('decision.reloaded', { at: Date.now() });
        return { runs: store.runs() };
    }

    /** Правка настроек игры этого чата: событие после записи, режим пересчитывается по набору. */
    async function setGameSettings(patch = {}) {
        const previous = gameSettingsValues();
        const values = patchGameSettings(previous, patch);
        gameValues = values;
        try {
            await store.saveGameSettings(values);
        } catch (error) {
            gameValues = previous;
            throw error;
        }
        const state = { values, mode: modeOf(values), defaults: clampGameSettings(settings.gameDefaults) };
        publishEvent('decision.gameSettings.changed', { ...state, patch });
        // Смена правил видна в журнале — той же лентой, что сообщения директору.
        await cycle.logSettings({ text: describeSettingsChange(previous, values) }).catch(() => {});
        return state;
    }

    /** «Use for new chats»: текущий набор становится умолчанием для новых чатов. */
    async function useGameSettingsAsDefault() {
        const values = gameSettingsValues();
        await saveSettings({ gameDefaults: values });
        const state = { values, mode: modeOf(values), defaults: { ...values } };
        publishEvent('decision.gameSettings.changed', state);
        return state;
    }

    /** «Reset to Classic»: этот чат возвращается к набору Classic. */
    async function resetGameSettings() {
        return setGameSettings(modeValues('classic'));
    }

    async function saveGameMixes(next) {
        await saveSettings({ gameMixes: clampGameMixes(next) });
        return gameMixes();
    }

    /** «Save as mix…»: текущий набор под именем игрока; сохранённый набор — глобальный. */
    async function saveGameMix({ name, values } = {}) {
        const result = addGameMix(gameMixes(), { id: nextGameMixId(gameMixes(), name), name, values: values ?? gameSettingsValues() });
        if (!result.ok) throw new Error(result.error);
        await saveGameMixes(result.mixes);
        publishEvent('decision.gameMixes.changed', { mixes: result.mixes });
        return { ...gameSettingsState(), savedId: result.mix.id };
    }

    async function renameSavedMix({ id, name } = {}) {
        const result = renameGameMix(gameMixes(), id, name);
        if (!result.ok) throw new Error(result.error);
        await saveGameMixes(result.mixes);
        publishEvent('decision.gameMixes.changed', { mixes: result.mixes });
        return gameSettingsState();
    }

    async function removeSavedMix({ id } = {}) {
        const result = removeGameMix(gameMixes(), id);
        if (!result.ok) throw new Error(result.error);
        await saveGameMixes(result.mixes);
        publishEvent('decision.gameMixes.changed', { mixes: result.mixes });
        return gameSettingsState();
    }

    /** «Update mix»: явное обновление сохранённого набора текущим. */
    async function updateSavedMix({ id } = {}) {
        const result = updateGameMix(gameMixes(), id, gameSettingsValues());
        if (!result.ok) throw new Error(result.error);
        await saveGameMixes(result.mixes);
        publishEvent('decision.gameMixes.changed', { mixes: result.mixes });
        return gameSettingsState();
    }

    async function applySavedMix({ id } = {}) {
        const mix = findGameMix(gameMixes(), id);
        if (!mix) throw new Error('No such mix.');
        return setGameSettings(mix.values);
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
                timeoutMs: 0, // срок ведёт сам директор (formTimeoutMs) и отменяет запросы; 120 с конвейера рвали ход на ожидании банков
            });
            const rewritten = await addStage(PAYLOAD_PIPELINE, decisionRewriteStage({ id: REWRITE_STAGE, contract: REWRITE_CONTRACT }));
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
        if ((type === 'regenerate' || type === 'swipe') && settings.regen === 'writer') {
            const last = store.lastRun();
            if (last) {
                const push = last.push ?? last.decision;
                pending = {
                    runId, type, chat, chatLength: chat.length, decision: push, push, form: last.form ?? null,
                    assessments: Array.isArray(last.assessments) ? last.assessments : [],
                    game: last.game ?? settingsLabel(gameSettingsValues()),
                    reasoning: last.reasoning ?? '', steps: [], workerId: last.workerId ?? null, reused: true, sourceRunId: last.id,
                };
                publishEvent('decision.started', { runId, type, reused: true });
                publishEvent('decision.completed', { runId, reused: true, workerId: pending.workerId });
                return { reused: true, decision: push };
            }
        }
        if (timedOutRuns.has(runId)) throw new Error(timedOutRuns.get(runId)); // повтор после таймаута — сразу отказ
        const coldStart = banks.ensureColdStart().catch(error => publishEvent('decision.bank.failed', { runId, message: error?.message ?? String(error) }));
        await Promise.all([banks.hasAnyText() ? null : coldStart, // банки ждём только в чате без них; пересборка — в фоне, со старым текстом
            bootstrap.waitFirstTurn().catch(error => publishEvent('decision.bootstrap.warning', { message: error?.message ?? String(error) }))]);
        const attempt = (attempts.get(runId)?.length ?? 0) + 1;
        publishEvent('decision.started', { runId, type, attempt });
        const startedAt = Date.now();
        const journal = store.beginTurn(Boolean(settings.snapshots));
        const beforeSnapshot = settings.snapshots ? await snapshotState(runId, journal) : null;
        const captured = captureReasoning(host, `${runId}:`, {
            onThinking: text => publishEvent('decision.cycle.thinking', { runId, text }),
            onAnswer: text => publishEvent('decision.cycle.answer', { runId, text }),
        });
        try {
            const result = await cycle.run({ chat, runId, type, thinking: () => captured.value, usage: () => captured.usage });
            if (!result.ok) throw new Error(`The director did not submit the turn: ${result.reason ?? 'no form'}.`);
            const steps = recordStep(runId, { attempt, workerId: result.workerId ?? null, durationMs: Date.now() - startedAt, error: null });
            // В запись хода идут только броски, на которые сослалась его форма:
            // карта цикла живёт дольше хода и содержит чужие броски.
            const referenced = (Array.isArray(result.form?.characters) ? result.form.characters : [])
                .map(character => character?.assessId)
                .filter(Boolean);
            const row = cycle.assessments();
            const assessments = [...new Set(referenced)].map(id => row.get(id)).filter(Boolean).map(item => ({ ...item }));
            pending = {
                runId, type, chat, chatLength: chat.length, decision: result.decision,
                push: result.push ?? result.decision, form: result.form, assessments, game: settingsLabel(gameSettingsValues()), reasoning: captured.value,
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
            if (error?.code === 'decision-timeout') timedOutRuns.set(runId, error.message);
            lastFailure = { runId, kind: error?.code === 'decision-config' ? 'config' : 'runtime', message: error?.message ?? String(error) };
            publishEvent('decision.failed', { runId, message: error?.message ?? String(error) });
            throw error;
        } finally {
            captured.stop();
        }
    }

    const rewrite = createWriterRewrite({ host, call, getSettings: () => settings, getWorkers: () => workers, store, getPending: () => pending, banks, publishEvent });

    /** Предпросмотр раздела: собирает блок и плашки данных для окна промптов. */
    const preview = input => previewSection({ input, settings, call, store });

    /** Отбросить ход и, если включены снимки, вернуть состояние до него. */
    function discardPending() {
        const record = pending;
        pending = null;
        attempts.clear(); timedOutRuns.clear();
        if (record?.runId) store.markRejected(record.runId).catch(() => {});
        if (record?.snapshot) restoreState(record.snapshot).catch(() => {});
    }

    const events = createDecisionEvents({
        host,
        getSettings: () => settings,
        getPending: () => pending,
        setPending: value => { pending = value; },
        clearAttempts: () => { attempts.clear(); timedOutRuns.clear(); },
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
        chatChanged,
        startDraft: () => cycle.runDraft({ runId: `typing_${(runCounter += 1)}` }).catch(error => publishEvent('decision.failed', { runId: null, message: `typing draft: ${error?.message ?? error}` })),
        canReregister: () => !registering && !stagesRegistered,
        registerStages,
        publishEvent,
        decideStage: DECIDE_STAGE,
    });

    async function load() {
        const stored = await call('storage.settings.get', { namespace: DECISION_NAMESPACE, key: 'settings', fallback: null });
        settings = clampDecisionSettings(stored ?? DEFAULT_SETTINGS);
        // Подписки — до первого чтения: ST открывает чат, пока ядро грузится, и `st.chatChanged`, пришедший раньше
        // подписки, терялся — ядро оставалось с пустой памятью загрузки, а окно директора висело пустым.
        subscriptions.push(...events.listen());
        await reload();
        await cycle.syncWindow().catch(error => publishEvent('decision.log.warning', { reason: `window sync failed: ${error?.message ?? error}` }));
        unregisters.push(...registerDecisionContracts(host, {
            getSettings: () => settings,
            configure: saveSettings,
            store,
            researcher,
            banks,
            cycle,
            bootstrap,
            cardTurn,
            decide,
            rewrite,
            preview,
            reload,
            decideContract: DECIDE_CONTRACT,
            rewriteContract: REWRITE_CONTRACT,
            gameSettings: {
                get: gameSettingsState, set: setGameSettings, useDefault: useGameSettingsAsDefault, reset: resetGameSettings,
                saveMix: saveGameMix, renameMix: renameSavedMix, removeMix: removeSavedMix, updateMix: updateSavedMix, applyMix: applySavedMix,
            },
            messageRolls,
        }));
        await registerStages();
        return settings;
    }

    return {
        load,
        configure: saveSettings,
        decide,
        rewrite,
        preview,
        settings: () => publicDecisionSettings(settings),
        gameSettings: gameSettingsState,
        setGameSettings,
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
        bootstrap: () => bootstrap.state(),
        question: () => cycle.question(),
        answerQuestion: params => cycle.answerQuestion(params),
        unregister: async () => {
            for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
            await unregisterStages();
            for (const unregister of unregisters.splice(0)) unregister();
        },
    };
}
