import { request } from '../../libraries/shared/request.js';
import { buildRequest } from '../../libraries/core/pm-run.js';
import { compareRequests, analyzeStability } from '../../libraries/core/pm-cache.js';
import { createPresetStore } from './presets.js';
import { createContributionRegistry, placeContribution, resetContribution } from './contributions.js';

const NAMESPACE = 'core.promptManager';
const BEFORE_SEND_PIPELINE = 'generation.beforeSend';
const PAYLOAD_PIPELINE = 'generation.payload';
const CAPTURE_CONTRACT = 'promptManager.capture';
const REWRITE_CONTRACT = 'promptManager.rewrite';
const CAPTURE_TTL_MS = 60_000;
const DEFAULT_SETTINGS = { enabled: true, activePresetId: null, headroom: 0.1, freezeRandom: true, applyParams: true, logSize: 20, autoPrepared: false };

/**
 * Ядро Prompt Manager (PROMPT_MANAGER_PLAN.md). Заменяет сборку промпта ST, когда включено и есть активный пресет:
 * на `generation.beforeSend` запоминает `chat` (со вставками модулей), на `generation.payload` собирает запрос сам
 * (`buildRequest`) и подменяет `messages` и параметры. Только Chat Completion и не групповой чат — иначе
 * пропускает запрос как есть и сообщает `promptManager.unsupported` (владелец: «выключаем PM и предупреждаем»).
 */
export function createPromptManagerCore(host, { publish = () => {}, now = () => Date.now() } = {}) {
    const store = createPresetStore(host, { now });
    const contributions = createContributionRegistry();
    let settings = { ...DEFAULT_SETTINGS };
    let captured = null; // { chat, at }
    const log = [];
    const globals = new Map();
    let warnedUnsupported = null;

    const own = async (contract, params) => {
        const result = await request(host.own, contract, { params });
        return result.ok ? result.value : undefined;
    };
    const service = async (contract, params) => {
        const result = await request(host.services, contract, { params });
        return result.ok ? result.value : undefined;
    };

    /**
     * Родное окно Prompt Manager у ST прячем, пока PM включён; кнопка ST открывает наше окно. Не нашли разметку —
     * PM выключается с предупреждением (запасного варианта нет — решение владельца).
     */
    async function syncNativeWindow() {
        if (!settings.enabled) { await service('stPmUi.uninstall', {}); return; }
        const answer = await service('stPmUi.install', { handler: () => publish('promptManager.openRequested', {}) });
        if (answer && answer.found === false) {
            settings = { ...settings, enabled: false };
            await request(host.own, 'storage.settings.set', { params: { namespace: NAMESPACE, key: 'settings', value: settings } });
            publish('promptManager.unsupported', { reason: 'Could not find the Prompt Manager window of this SillyTavern version to replace it. The Prompt Manager is switched off.' });
        }
    }

    async function saveSettings(patch) {
        const wasEnabled = settings.enabled;
        settings = { ...settings, ...patch };
        await request(host.own, 'storage.settings.set', { params: { namespace: NAMESPACE, key: 'settings', value: settings } });
        if (settings.enabled !== wasEnabled) await syncNativeWindow();
        return settings;
    }

    async function load() {
        const stored = await own('storage.settings.get', { namespace: NAMESPACE, key: 'settings', fallback: {} });
        settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
        await registerStages();
        await syncNativeWindow();
        return settings;
    }

    /** Первый запуск: внутренние копии всех пресетов ST, активным становится выбранный в ST. */
    async function autoPrepare() {
        const stPresets = await service('stPromptData.presets', {});
        if (!stPresets) return [];
        const created = await store.prepareFromSt(stPresets);
        const info = await service('stPromptData.read', {});
        if (!settings.activePresetId && info?.selectedPresetName) {
            const match = (await store.list()).find(item => item.sourceName === info.selectedPresetName);
            if (match) await saveSettings({ activePresetId: match.id });
        }
        await saveSettings({ autoPrepared: true });
        publish('promptManager.prepared', { created: created.length });
        return created;
    }

    async function gatherMaterials(chat, info) {
        const [entries, macros] = await Promise.all([own('lorebook.entries', {}), own('macros.snapshot', {})]);
        return {
            ...info, chat, macros: macros ?? {}, loreEntries: entries ?? [],
            tracker: (id, field) => (macros ?? {})[`${id}_${field}`],
        };
    }

    async function loadChatState() {
        return (await own('storage.chatMemory.get', { namespace: NAMESPACE, key: 'state', fallback: {} })) ?? {};
    }

    /** Одна сборка: и для настоящей отправки, и для превью. Ничего не отправляет. */
    async function assemble(chat, { commit = false } = {}) {
        const record = settings.activePresetId ? await store.get(settings.activePresetId) : null;
        if (!record) return { skipped: 'no active preset' };
        const info = await service('stPromptData.read', {});
        if (!info) return { skipped: 'no ST data' };
        const chatState = await loadChatState();
        const timed = { ...(chatState.timed ?? {}) };
        const materials = await gatherMaterials(chat, info);
        let changed = false;
        for (const contribution of contributions.list()) changed = placeContribution(record.preset.tree, contribution) || changed;
        if (changed) await store.save(record, { label: 'new module contribution' });
        const result = buildRequest(record.preset, materials, {
            contributions: contributions.asContext(), globals, timed, prevCut: chatState.cut ?? 0, headroom: settings.headroom,
            seed: settings.freezeRandom ? (info.chatId ?? 'chat') : undefined,
        });
        if (commit) await request(host.own, 'storage.chatMemory.set', { params: { namespace: NAMESPACE, key: 'state', value: { cut: result.cut, timed } } });
        return { record, info, result };
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
            const assembled = await assemble(fresh.chat, { commit: true });
            if (assembled.skipped) return payload;
            const { result, record } = assembled;
            const body = settings.applyParams ? result.body : {};
            pushLog({ at: now(), presetId: record.id, presetName: record.name, messages: result.messages, withMarkers: result.withMarkers, tokens: result.tokens.total, budget: result.budget, dropped: result.dropped, report: result.report, macros: result.macros, lore: result.lore, overBudget: result.overBudget });
            contributions.clear();
            publish('promptManager.assembled', { tokens: result.tokens.total, dropped: result.dropped.length });
            return { ...payload, ...body, messages: result.messages };
        } catch (error) {
            publish('promptManager.failed', { message: error?.message ?? String(error) });
            return payload; // осечка PM не должна ломать генерацию
        }
    }

    /** Берёт ли PM сборку на себя прямо сейчас: включён, есть активный пресет, режим поддерживается. Вкладчики решают по этому, что делать. */
    async function takesOver() {
        if (!settings.enabled || !settings.activePresetId) return false;
        const info = await service('stPromptData.read', {});
        return Boolean(info) && !unsupported(info);
    }

    async function registerStages() {
        host.own.register('promptManager.takesOver', () => takesOver());
        host.own.register('promptManager.reset', () => { contributions.clear(); return true; });
        await request(host.own, 'pipeline.stages.add', { params: { pipelineId: 'generation.prepare', stage: { id: 'prompt-manager:reset', contract: 'promptManager.reset', onExhausted: 'flag' } } });
        host.own.register(CAPTURE_CONTRACT, params => { captured = { chat: params?.chat ?? [], at: now() }; return true; });
        host.own.register(REWRITE_CONTRACT, params => rewrite(params ?? {}));
        await request(host.own, 'pipeline.stages.add', { params: { pipelineId: BEFORE_SEND_PIPELINE, stage: { id: 'prompt-manager:capture', contract: CAPTURE_CONTRACT, params: { chat: { $from: '$input.chat' } }, onExhausted: 'flag' } } });
        await request(host.own, 'pipeline.stages.add', { params: { pipelineId: PAYLOAD_PIPELINE, stage: { id: 'prompt-manager:rewrite', contract: REWRITE_CONTRACT, params: { payload: { $from: '$value' } }, onExhausted: 'flag' } } });
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
        return { messages: assembled.result.messages, report: assembled.result.report, tokens: { total: assembled.result.tokens.total, byBlock: [...assembled.result.tokens.byBlock].map(([id, tokens]) => [nameOfBlock(assembled.record.preset, id), tokens]) }, dropped: assembled.result.dropped, budget: assembled.result.budget, macros: assembled.result.macros };
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
        host.own.register('promptManager.log', () => log.map(({ withMarkers, messages, ...rest }) => rest)),
        host.own.register('promptManager.stability', () => analyzeStability(log.map(item => item.withMarkers))),
        host.own.register('promptManager.preview', () => preview()),
    ];

    const logView = () => log.map(({ withMarkers, messages, ...rest }) => rest);
    return { load, autoPrepare, log: logView, configure: saveSettings, rewrite, assemble, preview, store, contributions, settings: () => ({ ...settings }), unregister: () => { for (const unregister of registrations) unregister(); } };
}
