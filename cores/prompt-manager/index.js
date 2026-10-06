import { request } from '../../libraries/shared/request.js';
import { buildRequest } from '../../libraries/core/pm-run.js';
import { compareRequests, analyzeStability } from '../../libraries/core/pm-cache.js';
import { assemblePrompt } from '../../libraries/core/pm-assemble.js';
import { joinWrappers } from '../../libraries/core/pm-wrap-join.js';
import { regroupTree } from '../../libraries/core/pm-wrapper-groups.js';
import { shouldRunCot, runCot, buildCotInjection, cotRecord, normalizeCot, CotStepError } from '../../libraries/core/pm-cot.js';
import { resolveParams, setOverride, DEFAULT_OVERRIDES } from '../../libraries/core/pm-overrides.js';
import { collectJevLeaves, groupJevCalls, computeJevQuestionKey } from '../../libraries/core/jev-question.js';
import { createPluginRegistry } from '../../libraries/core/pm-plugins.js';
import { cacheVerdict, extractCachedTokens } from '../../libraries/core/pm-cache-hints.js';
import { createPresetStore } from './presets.js';
import { createContributionRegistry, placeContribution, resetContribution } from './contributions.js';

const NAMESPACE = 'core.promptManager';
const BEFORE_SEND_PIPELINE = 'generation.beforeSend';
const PAYLOAD_PIPELINE = 'generation.payload';
const CAPTURE_CONTRACT = 'promptManager.capture';
const REWRITE_CONTRACT = 'promptManager.rewrite';
const CAPTURE_TTL_MS = 60_000;
const DEFAULT_SETTINGS = { enabled: true, activePresetId: null, headroom: 0.1, freezeRandom: true, applyParams: true, applyStreaming: true, logSize: 20, autoPrepared: false, jevWaitMs: 4000, overrides: DEFAULT_OVERRIDES };

/**
 * Ядро Prompt Manager (PROMPT_MANAGER_PLAN.md). Заменяет сборку промпта ST, когда включено и есть активный пресет:
 * на `generation.beforeSend` запоминает `chat` (со вставками модулей), на `generation.payload` собирает запрос сам
 * (`buildRequest`) и подменяет `messages` и параметры. Только Chat Completion и не групповой чат — иначе
 * пропускает запрос как есть и сообщает `promptManager.unsupported` (владелец: «выключаем PM и предупреждаем»).
 */
export function createPromptManagerCore(host, { publish = () => {}, now = () => Date.now() } = {}) {
    const store = createPresetStore(host, { now });
    const contributions = createContributionRegistry();
    const plugins = createPluginRegistry({ onDisable: info => publish('promptManager.pluginDisabled', info) });
    let settings = { ...DEFAULT_SETTINGS };
    let captured = null; // { chat, at }
    const log = [];
    const globals = new Map();
    let warnedUnsupported = null;
    let pendingCot = null; // запись CoT текущей генерации: сохраняется в метаданные чата, когда готово сообщение
    let manualCot = false;
    let streamRestore = null; // прежнее значение стриминга ST, если мы его временно меняли
    let lastCotSteps = null; // шаги последнего CoT — для режима «только финал» при перегенерации

    const own = async (contract, params) => {
        const result = await request(host.own, contract, { params });
        return result.ok ? result.value : undefined;
    };
    const service = async (contract, params) => {
        const result = await request(host.services, contract, { params });
        return result.ok ? result.value : undefined;
    };

    /**
     * Родная панель ST («AI Response Configuration» — пресеты, сэмплер, Seed, Quick/Utility Prompts, порядок
     * промптов) убрана ПОЛНОСТЬЮ и НАВСЕГДА, независимо от `enabled` (решение владельца после живого скриншота:
     * сжатая иконка внутри PM не годится — сама иконка ОТКРЫТИЯ панели у ST перехватывается и зовёт наше окно
     * вместо штатного тоггла; панель ST не открывается вообще никаким кликом). Переключатель `enabled` никогда не
     * возвращает панель ST, он только решает, берёт ли PM на себя сборку запроса. Не нашли иконку (`found: false`)
     * — вот это настоящий запасной случай: перехватывать нечего, PM выключается с предупреждением.
     */
    async function syncNativeWindow() {
        const answer = await service('stPmUi.install', { onOpen: () => publish('promptManager.openRequested', {}) });
        if (answer && answer.found === false && settings.enabled) {
            settings = { ...settings, enabled: false };
            await request(host.own, 'storage.settings.set', { params: { namespace: NAMESPACE, key: 'settings', value: settings } });
            publish('promptManager.unsupported', { reason: 'Could not find the "AI Response Configuration" button of this SillyTavern version to take over. The Prompt Manager is switched off.' });
        }
    }

    async function saveSettings(patch) {
        settings = { ...settings, ...patch };
        await request(host.own, 'storage.settings.set', { params: { namespace: NAMESPACE, key: 'settings', value: settings } });
        return settings;
    }

    async function load() {
        const stored = await own('storage.settings.get', { namespace: NAMESPACE, key: 'settings', fallback: {} });
        settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
        await registerStages();
        await syncNativeWindow();
        // Подготовка пресетов — при загрузке, а не только при открытии окна: «включён по умолчанию» без активного пресета
        // молча отдавал сборку ST (проверено на живом ST 1.18). В фоне — загрузку движка не держим.
        // Активный пресет может отсутствовать в ЭТОМ браузере: настройки PM лежат в settings.json ST (общие), а пресеты —
        // в indexedDB браузера. Тогда активный выбирается заново, как при первом запуске (живой ST 1.18: другой браузер).
        if (settings.enabled) {
            activeMissing().then(missing => { if (missing || !settings.autoPrepared) return autoPrepare(); return null; })
                .catch(error => publish('promptManager.failed', { message: `Could not prepare presets: ${error?.message ?? error}` }));
        }
        return settings;
    }

    async function activeMissing() {
        return !settings.activePresetId || !(await store.get(settings.activePresetId));
    }

    /**
     * Первый запуск: внутренние копии всех пресетов ST, активным становится выбранный в ST. Один прогон за раз:
     * фоновая подготовка при загрузке и открытие окна PM, пересекшись, иначе оба видели пустой список и плодили копии.
     */
    let preparing = null;
    function autoPrepare() {
        preparing ??= prepareOnce().finally(() => { preparing = null; });
        return preparing;
    }

    async function prepareOnce() {
        const stPresets = await service('stPromptData.presets', {});
        if (!stPresets) return [];
        const created = await store.prepareFromSt(stPresets);
        const info = await service('stPromptData.read', {});
        if (await activeMissing()) {
            const list = await store.list();
            const match = list.find(item => item.sourceName === info?.selectedPresetName) ?? list[0];
            await saveSettings({ activePresetId: match?.id ?? null });
        }
        await saveSettings({ autoPrepared: true });
        publish('promptManager.prepared', { created: created.length });
        return created;
    }

    async function gatherMaterials(chat, info, { isolated = false } = {}) {
        const [entries, macros] = await Promise.all([isolated ? [] : own('lorebook.entries', {}), own('macros.snapshot', {})]);
        return {
            ...info, chat, macros: macros ?? {}, loreEntries: entries ?? [],
            tracker: (id, field) => (macros ?? {})[`${id}_${field}`],
        };
    }

    async function loadChatState() {
        return (await own('storage.chatMemory.get', { namespace: NAMESPACE, key: 'state', fallback: {} })) ?? {};
    }

    /**
     * Ответы Jev на вопросы из условий дерева, добытые ДО сборки: условия считаются синхронно, а ответ классификатора — сетевой вызов. Один запрос на срез чата;
     * ждём не дольше `jevWaitMs` — потом отправляется без ответа (условие без ответа истинно, см. pm-conditions.js). Нет классификатора, нет вопросов, сбой — `undefined`.
     */
    async function prefetchJev(tree, chat) {
        const calls = groupJevCalls(collectJevLeaves(tree), chat);
        if (!calls.length) return undefined;
        let timer = null;
        const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(null), Math.max(500, Number(settings.jevWaitMs) || 4000)); });
        try {
            const answered = await Promise.race([request(host.own, 'classifier.decide', { params: { calls } }).catch(() => null), deadline]);
            const answers = answered?.ok ? answered.value?.answers ?? {} : {};
            return leaf => answers[computeJevQuestionKey(leaf)];
        } finally {
            clearTimeout(timer);
        }
    }

    /** Одна сборка: и для настоящей отправки, и для превью. Ничего не отправляет. */
    async function assemble(chat, { commit = false, model, infoOverride = null, isolated = false } = {}) {
        const record = settings.activePresetId ? await store.get(settings.activePresetId) : null;
        if (!record) return { skipped: 'no active preset' };
        const live = await service('stPromptData.read', {});
        if (!live) return { skipped: 'no ST data' };
        const info = { ...live, ...(infoOverride ?? {}) };
        // Состояние открытого чата (обрезка, таймеры лорбука) к изолированной сборке не относится: оно сдвинуло бы тест по чужой истории.
        const chatState = isolated ? {} : await loadChatState();
        const timed = { ...(chatState.timed ?? {}) };
        const materials = await gatherMaterials(chat, info, { isolated });
        materials.macros = { ...plugins.macros(), ...materials.macros }; // наши макросы (rp-time…) важнее одноимённых из плагинов
        // Пресеты, подготовленные до 5.140: пары-обёртки на глубине досклеиваются в группы (одно сообщение, пустая — не уходит).
        const regrouped = regroupTree(record.preset.tree, new Map(record.preset.blocks.map(block => [block.id, block])));
        if (regrouped.changed) { record.preset.tree = regrouped.tree; await store.save(record, { label: 'wrapper tags grouped' }); }
        let changed = false;
        for (const contribution of isolated ? [] : contributions.list()) changed = placeContribution(record.preset.tree, contribution) || changed;
        if (changed) await store.save(record, { label: 'new module contribution' });
        const { params, sources } = resolveParams(record.preset.params, settings.overrides, { model: model ?? info.model, char: info.char, chatId: info.chatId });
        const jev = isolated ? undefined : await prefetchJev(record.preset.tree, chat);
        const result = buildRequest({ ...record.preset, params }, materials, {
            jev, contributions: isolated ? {} : contributions.asContext(), globals, timed, plugins: plugins.conditions(), transform: (messages, env) => plugins.transform(messages, env),
            onPluginError: () => {}, prevCut: chatState.cut ?? 0,
            // Бюджет, при котором граница поставлена; у состояния до этой правки его нет — `0`: граница пересчитывается один раз (pm-trim.js).
            prevBudget: (chatState.cut ?? 0) > 0 ? (chatState.cutBudget ?? 0) : undefined, headroom: settings.headroom,
            seed: settings.freezeRandom ? (info.chatId ?? 'chat') : undefined,
        });
        if (commit) await request(host.own, 'storage.chatMemory.set', { params: { namespace: NAMESPACE, key: 'state', value: { cut: result.cut, cutBudget: result.cutBudget ?? null, timed } } });
        return { record, info, result, overrideSources: sources, params };
    }

    /**
     * «Сбросить обрезку» этого чата: граница, поставленная прежней обрезкой, стирается, и со следующей сборки история берётся целиком, а режется заново по нынешнему бюджету.
     * Нужна, когда граница осталась от ошибочной настройки или от удалённой части чата; кеш префикса один раз начнётся заново.
     */
    async function resetCut() {
        const chatState = await loadChatState();
        const was = chatState.cut ?? 0;
        await request(host.own, 'storage.chatMemory.set', { params: { namespace: NAMESPACE, key: 'state', value: { ...chatState, cut: 0, cutBudget: null } } });
        return { was };
    }

    function pushLog(entry) {
        const previous = log.at(-1);
        const cache = previous ? compareRequests(previous.withMarkers, entry.withMarkers) : null;
        log.push({ ...entry, cache });
        while (log.length > settings.logSize) log.shift();
        return cache;
    }

    function unsupported(info) {
        if (info.mainApi !== 'openai') return 'Prompt Manager works only with Chat Completion.';
        if (info.isGroup) return 'Prompt Manager does not support group chats yet.';
        return null;
    }

    /** Этап `generation.payload`: подмена сообщений и параметров. Любая осечка — запрос уходит как есть. */
    async function rewrite({ payload }) {
        const fresh = captured && now() - captured.at < CAPTURE_TTL_MS ? captured : null;
        captured = null;
        if (!settings.enabled || !fresh || !payload || !Array.isArray(payload.messages)) return payload;
        try {
            const info = await service('stPromptData.read', {});
            const reason = info && unsupported(info);
            if (reason) {
                if (warnedUnsupported !== reason) { warnedUnsupported = reason; publish('promptManager.unsupported', { reason }); }
                return payload;
            }
            warnedUnsupported = null;
            const assembled = await assemble(fresh.chat, { commit: true, model: payload.model });
            if (assembled.skipped) return payload;
            const { result, record } = assembled;
            const cotSteps = await runGuidedCot({ ...record.preset, params: assembled.params }, result, fresh.type);
            if (cotSteps) result.messages.push(buildCotInjection(cotSteps, { injectAs: normalizeCot(record.preset.cot).injectAs }));
            const body = settings.applyParams ? result.body : {};
            pushLog({ at: now(), source: assembled.info.chatCompletionSource, presetId: record.id, presetName: record.name, messages: result.messages, withMarkers: result.withMarkers, tokens: result.tokens.total, budget: result.budget, dropped: result.dropped, report: result.report, macros: result.macros, lore: result.lore, overBudget: result.overBudget });
            contributions.clear();
            publish('promptManager.assembled', { tokens: result.tokens.total, dropped: result.dropped.length });
            return { ...payload, ...body, messages: result.messages };
        } catch (error) {
            if (error instanceof CotStepError) { publish('promptManager.cotFailed', { message: error.message, step: error.stepIndex + 1 }); throw error; } // второй сбой шага — генерацию не отправляем
            publish('promptManager.failed', { message: error?.message ?? String(error) });
            return payload; // осечка PM не должна ломать генерацию
        }
    }

    /** Промпты шагов: каждый шаг раздела CoT собирается теми же макросами и условиями и уходит одним сообщением USER. */
    function stepPrompts(preset, env) {
        const cot = normalizeCot(preset.cot);
        return cot.steps.map((node, index) => {
            const built = assemblePrompt({ ...preset, tree: [node] }, { markers: {}, history: [], ...env });
            const text = joinWrappers(built.messages).map(message => message.content).join('\n\n').trim();
            return { id: node.id ?? node.block ?? `step${index + 1}`, name: node.name ?? preset.blocks.find(block => block.id === node.block)?.name ?? `Step ${index + 1}`, prompt: text };
        }).filter(step => step.prompt);
    }

    /** Один запрос шага: основное подключение ST или выбранный воркер моделей (`model.generate`). */
    async function sendStep(messages, { maxTokens, workerId }) {
        if (workerId) {
            const answer = await request(host.own, 'model.generate', { params: { workerId, messages, maxTokens, stream: false } });
            if (!answer.ok) throw new Error(answer.error.message);
            return { text: String(answer.value ?? ''), reasoning: '' };
        }
        const answer = await request(host.services, 'stGeneration.direct', { params: { messages, maxTokens } });
        if (!answer.ok) throw new Error(answer.error.message);
        if (!answer.value?.ok) throw new Error(answer.value?.error ?? 'the model did not answer');
        return { text: answer.value.text, reasoning: answer.value.reasoning ?? '' };
    }

    /** Guided CoT (раздел 7 плана): шаги идут отдельными запросами ДО основного; null — CoT в этой генерации не нужен. */
    async function runGuidedCot(preset, result, type) {
        const manual = manualCot;
        manualCot = false;
        if (!shouldRunCot(preset.cot, result.stepEnv.facts, { manual })) return null;
        const steps = stepPrompts(preset, result.stepEnv);
        if (!steps.length) return null;
        const cot = normalizeCot(preset.cot);
        // «Только финал» при перегенерации/свайпе: прошлые шаги берём как есть, заново идёт лишь основной ответ.
        if (cot.regen === 'final' && (type === 'regenerate' || type === 'swipe') && lastCotSteps) return lastCotSteps;
        const done = await runCot({
            baseMessages: result.messages, steps, cot, sendStep,
            onProgress: progress => publish('promptManager.cotProgress', { ...progress, display: cot.display }),
        });
        pendingCot = cotRecord(done, { at: now() });
        lastCotSteps = done;
        publish('promptManager.cotDone', { steps: done.length });
        return done;
    }

    /** Готово сообщение — запись CoT уходит в память чата под номером этого сообщения (живёт с чатом, в историю не попадает). */
    async function persistCot() {
        if (!pendingCot) return;
        const record = pendingCot;
        pendingCot = null;
        const chat = await service('stPromptData.chat', {});
        const index = (chat?.length ?? 0) - 1;
        if (index < 0) return;
        const all = (await own('storage.chatMemory.get', { namespace: NAMESPACE, key: 'cot', fallback: {} })) ?? {};
        await request(host.own, 'storage.chatMemory.set', { params: { namespace: NAMESPACE, key: 'cot', value: { ...all, [index]: record } } });
    }

    /**
     * Стриминг задаёт ST по СВОЕЙ настройке, а не по телу запроса (тело переписывать нельзя — ответ разберётся не так), поэтому
     * значение из пресета ставится настройкой ST на время генерации и возвращается по её окончании.
     */
    async function applyStreaming() {
        if (!settings.enabled || !settings.applyStreaming || !settings.activePresetId || streamRestore !== null) return;
        const info = await service('stPromptData.read', {});
        if (!info || unsupported(info)) return;
        const record = await store.get(settings.activePresetId);
        const { params } = resolveParams(record?.preset?.params, settings.overrides, { model: info.model, char: info.char, chatId: info.chatId });
        if (typeof params.stream_openai !== 'boolean') return;
        const answer = await service('stPromptData.streaming', { value: params.stream_openai });
        if (answer && answer.previous !== params.stream_openai) streamRestore = answer.previous;
    }

    /**
     * «Function calling» пресета: включено в пресете — значит, в ST включается вызов функций (без него инструменты не уходят в запрос).
     * Выключенное значение настройку ST НЕ выключает: человек мог включить её в ST сам, а у импортированного пресета флаг ложный просто
     * потому, что был таким в момент импорта. Инструменты движка включают её сами (cores/generation).
     */
    async function applyFunctionCalling() {
        if (!settings.enabled || !settings.applyParams || !settings.activePresetId) return;
        const info = await service('stPromptData.read', {});
        if (!info || unsupported(info)) return;
        const record = await store.get(settings.activePresetId);
        const { params } = resolveParams(record?.preset?.params, settings.overrides, { model: info.model, char: info.char, chatId: info.chatId });
        if (params.function_calling === true) await service('stPromptData.functionCalling', { value: true });
    }

    async function restoreStreaming() {
        if (streamRestore === null) return;
        const value = streamRestore;
        streamRestore = null;
        await service('stPromptData.streaming', { value });
    }

    /** Берёт ли PM сборку на себя прямо сейчас: включён, есть активный пресет, режим поддерживается. Вкладчики решают по этому, что делать. */
    async function takesOver() {
        if (!settings.enabled || !settings.activePresetId) return false;
        const info = await service('stPromptData.read', {});
        return Boolean(info) && !unsupported(info);
    }

    async function registerStages() {
        host.own.register('promptManager.takesOver', () => takesOver());
        host.events.subscribe('generation.completed', () => { persistCot().catch(() => {}); });
        host.own.register('promptManager.reset', () => { contributions.clear(); return true; });
        await request(host.own, 'pipeline.stages.add', { params: { pipelineId: 'generation.prepare', stage: { id: 'prompt-manager:reset', contract: 'promptManager.reset', onExhausted: 'flag' } } });
        host.own.register(CAPTURE_CONTRACT, async params => {
            captured = { chat: params?.chat ?? [], type: params?.type ?? 'normal', at: now() };
            await applyStreaming().catch(() => {});
            await applyFunctionCalling().catch(() => {});
            return true;
        });
        for (const event of ['generation.completed', 'generation.aborted']) host.events.subscribe(event, () => { restoreStreaming().catch(() => {}); });
        host.own.register(REWRITE_CONTRACT, params => rewrite(params ?? {}));
        await request(host.own, 'pipeline.stages.add', { params: { pipelineId: BEFORE_SEND_PIPELINE, stage: { id: 'prompt-manager:capture', contract: CAPTURE_CONTRACT, params: { chat: { $from: '$input.chat' }, type: { $from: '$input.type' } }, onExhausted: 'flag' } } });
        await request(host.own, 'pipeline.stages.add', { params: { pipelineId: PAYLOAD_PIPELINE, stage: { id: 'prompt-manager:rewrite', contract: REWRITE_CONTRACT, params: { payload: { $from: '$value' } }, onExhausted: 'abort' } } });
    }

    /** Понятное имя источника сообщения для таблиц: имя блока пресета, вклад модуля, лорбук или история. */
    function nameOfBlock(preset, id) {
        if (id === 'history') return 'Chat history';
        if (id === 'newChat') return 'New chat line';
        if (String(id).startsWith('lore:')) return `Lorebook entry ${String(id).slice(5)} (depth)`;
        if (String(id).startsWith('inject:')) return `Module: ${String(id).slice(7)}`;
        return preset.blocks.find(block => block.id === id)?.name ?? id;
    }

    /** Превью «что уйдёт модели» по текущему чату ST — без отправки. */
    async function preview() {
        const chat = (await service('stPromptData.chat', {})) ?? captured?.chat ?? [];
        const assembled = await assemble(chat);
        if (assembled.skipped) return { skipped: assembled.skipped };
        return { messages: assembled.result.messages, report: assembled.result.report, tokens: { total: assembled.result.tokens.total, byBlock: [...assembled.result.tokens.byBlock].map(([id, tokens]) => [nameOfBlock(assembled.record.preset, id), tokens]) }, dropped: assembled.result.dropped, budget: assembled.result.budget, budgetInvalid: assembled.result.budgetInvalid, cutReleased: assembled.result.cutReleased, macros: assembled.result.macros };
    }

    /**
     * Запрос, каким он ушёл бы модели, если бы чат шёл с ЭТОЙ карточкой: активный пресет, её текст и её собственные промпты, а история — данная (для теста карточки).
     * Изолированно: без лорбука и вкладов Модулей открытого чата, иначе чужая память попадала бы в проверку карточки; ничего не сохраняет и не отправляет.
     */
    async function assembleForCard({ card, chat = [], model } = {}) {
        if (!card) throw new Error('promptManager.assembleForCard: "card" is required.');
        const assembled = await assemble(chat, {
            model, isolated: true,
            infoOverride: {
                char: card.name, description: card.description, personality: card.personality, scenario: card.scenario, mesExamples: card.mes_example,
                systemPrompt: card.system_prompt, postHistoryInstructions: card.post_history_instructions, depthPrompt: card.depth_prompt,
                chatLength: chat.length, chatId: 'card-test', isGroup: false,
            },
        });
        if (assembled.skipped) return { skipped: assembled.skipped };
        return { messages: assembled.result.messages, tokens: assembled.result.tokens.total, presetName: assembled.record.name };
    }

    const registrations = [
        host.own.register('promptManager.settings', () => ({ ...settings })),
        host.own.register('promptManager.configure', params => saveSettings(params?.patch ?? {})),
        host.own.register('promptManager.autoPrepare', () => autoPrepare()),
        host.own.register('promptManager.presets', () => store.list()),
        host.own.register('promptManager.preset', params => store.get(params?.id)),
        host.own.register('promptManager.savePreset', params => store.save(params?.record, { label: params?.label })),
        host.own.register('promptManager.importSt', params => store.importSt(params?.json, params)),
        host.own.register('promptManager.importNative', params => store.importNative(params?.file)),
        host.own.register('promptManager.exportSt', params => store.exportSt(params?.id)),
        host.own.register('promptManager.exportNative', params => store.exportNative(params?.id)),
        host.own.register('promptManager.duplicatePreset', params => store.duplicate(params?.id, params?.name)),
        host.own.register('promptManager.deletePreset', params => store.remove(params?.id)),
        host.own.register('promptManager.versions', params => store.versions(params?.presetId)),
        host.own.register('promptManager.rollback', params => store.rollback(params?.presetId, params?.key)),
        host.own.register('promptManager.contribute', params => contributions.set(params)),
        host.own.register('promptManager.retract', params => contributions.remove(params?.id)),
        host.own.register('promptManager.resetContribution', async params => {
            const record = await store.get(params?.presetId ?? settings.activePresetId);
            const contribution = contributions.list().find(item => item.id === params?.id) ?? params?.contribution;
            if (!record || !contribution) return false;
            resetContribution(record.preset.tree, contribution);
            await store.save(record, { label: 'reset contribution position' });
            return true;
        }),
        host.own.register('promptManager.setOverride', params => saveSettings({ overrides: setOverride(settings.overrides, params?.scope, params?.key, params?.params) })),
        host.own.register('promptManager.context', async () => { const info = await service('stPromptData.read', {}); return info ? { char: info.char, chatId: info.chatId, model: info.model } : null; }),
        host.own.register('promptManager.plugins', () => plugins.list()),
        host.own.register('promptManager.registerPlugin', params => plugins.register(params?.plugin)),
        host.own.register('promptManager.unregisterPlugin', params => plugins.unregister(params?.id)),
        host.own.register('promptManager.setPluginEnabled', params => plugins.setEnabled(params?.id, params?.enabled)),
        host.own.register('promptManager.conditionTypes', () => plugins.conditionTypes()),
        host.own.register('promptManager.runCotNext', () => { manualCot = true; return true; }),
        host.own.register('promptManager.cotRecords', async () => (await own('storage.chatMemory.get', { namespace: NAMESPACE, key: 'cot', fallback: {} })) ?? {}),
        host.own.register('promptManager.log', () => log.map(({ withMarkers, messages, ...rest }) => rest)),
        host.own.register('promptManager.stability', () => {
            const last = log.at(-1);
            return { ...analyzeStability(log.map(item => item.withMarkers)), verdict: last ? cacheVerdict(last.source, last.cache) : null, cachedTokens: last?.usageCached ?? null };
        }),
        /** Ответ провайдера с `usage` (например, от расширения-наблюдателя): запоминаем, сколько токенов взял кеш, у последнего запроса. */
        host.own.register('promptManager.reportUsage', params => { const last = log.at(-1); if (last) last.usageCached = extractCachedTokens(params?.usage); return last?.usageCached ?? null; }),
        host.own.register('promptManager.preview', () => preview()),
        host.own.register('promptManager.assembleForCard', params => assembleForCard(params)),
        host.own.register('promptManager.resetCut', () => resetCut()),
    ];

    const logView = () => log.map(({ withMarkers, messages, ...rest }) => rest);
    return { load, autoPrepare, whenPrepared: () => preparing ?? Promise.resolve([]), log: logView, configure: saveSettings, rewrite, assemble, preview, store, contributions, settings: () => ({ ...settings }), unregister: () => { for (const unregister of registrations) unregister(); } };
}
