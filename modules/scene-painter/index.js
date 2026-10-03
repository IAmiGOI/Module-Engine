/*@module
id: module.scenePainter
title: Scene Painter
description: Paints a picture of the current scene into the Picture window: a model writes the image prompt from the chat, an image backend draws it.
version: 0.2.1
engine: ^0.2
factory: createScenePainterModule
rights: storage.settings.get, storage.settings.set, ui.notify,
# Отрывок чата для промпта и привязка картинки к сообщению — через Ядро истории чата; текст сообщения не трогается.
chatHistory.messages, chatHistory.annotate, chatHistory.annotations,
# Промпт пишет текстовая модель, рисует Ядро diffusion; сети у Модуля нет вовсе.
model.generate, model.workers.get, image.generate, image.workers.get, image.workers.set,
# Картинка выводится в окно «Картинка» движка; старые — убираются из хранилища.
ui.picture.show, image.delete,
# Аватары персонажей и персоны — референсы для бэкендов, которые их принимают (только адреса, байты читает Ядро diffusion).
stCharacter.avatars,
ui.messageFooter.claim, ui.messageFooter.release, ui.messageFooter.attach
*/
import { signal } from '../../cores/ui/reactive.js';
import { supportsReferences } from '../../libraries/core/image-provider-request.js';
import { request } from '../../libraries/shared/request.js';
import { createScenePainterView } from './view.js';
import { DEFAULT_INSTRUCTION, buildWriterSystemPrompt, looksLikeRefusal, buildSceneTranscript, sanitizeImagePrompt, buildFinalPrompt } from './prompting.js';

export { DEFAULT_INSTRUCTION, MATURE_RULE, referenceRule, buildWriterSystemPrompt, looksLikeRefusal, buildSceneTranscript, sanitizeImagePrompt, buildFinalPrompt } from './prompting.js';

export const MODULE_ID = 'module.scenePainter';

/**
 * Модуль «Scene Painter» — картинка к сцене: модель читает последние сообщения и пишет промпт для картинки, Ядро diffusion рисует
 * (`image.generate`), картинка выводится в окно «Картинка» движка (`ui.picture.show`, cores/ui/picture-panel.js) — своего окна у Модуля
 * нет. В подвале сообщения — только кнопки: нарисовать, показать в окне, перерисовать, убрать. По мотивам Contextual Scene Painter и
 * IkarusAutoImage, но на контрактах движка: ни одного импорта из ST, ни `fetch`, ни `Blob`, ни права на сеть — сеть и байты у Ядра.
 *
 * Текст сообщения не трогается: картинка — пометка к сообщению (`chatHistory.annotate`), живёт в памяти чата и в модель не уходит.
 * Реролл и удаление сообщения пометку не ломают: она по `mesid`, а подвал перерисовывается сам.
 *
 * Запуск — кнопкой «Paint» под любым ответом модели или автоматически после каждого ответа (`autoPaint`).
 */

const SETTINGS_NAMESPACE = MODULE_ID;
const ANNOTATIONS_NAMESPACE = MODULE_ID;


export const DEFAULT_SETTINGS = Object.freeze({
    autoPaint: false,
    contextMessages: 6,
    promptWorkerId: '',
    // Запасной писатель: когда первый отказался (или вернул пусто) — часто так бывает на откровенных сценах.
    backupPromptWorkerId: '',
    imageWorkerId: '',
    style: 'detailed digital painting, cinematic lighting',
    negativePrompt: 'text, watermark, signature, lowres, blurry',
    width: 1024,
    height: 768,
    instruction: DEFAULT_INSTRUCTION,
    openWindow: true,
    // Фото персонажей как основа (только для бэкендов, принимающих референсы — NanoGPT): аватары участников чата, по желанию — персоны.
    useReferences: true,
    includePersona: false,
    // Откровенные сцены описываются как написаны, без смягчения и отказов (правило в prompting.js).
    matureContent: true,
});

/** Защитное чтение настроек: мусор с диска превращается в допустимые значения. */
export function sanitizeSettings(value = {}) {
    const source = value ?? {};
    const number = (raw, min, max, fallback) => (Number.isFinite(Number(raw)) ? Math.max(min, Math.min(max, Math.round(Number(raw)))) : fallback);
    const text = (raw, fallback) => (typeof raw === 'string' ? raw : fallback);
    return {
        autoPaint: source.autoPaint === true,
        contextMessages: number(source.contextMessages, 1, 20, DEFAULT_SETTINGS.contextMessages),
        promptWorkerId: text(source.promptWorkerId, ''),
        backupPromptWorkerId: text(source.backupPromptWorkerId, ''),
        imageWorkerId: text(source.imageWorkerId, ''),
        style: text(source.style, DEFAULT_SETTINGS.style),
        negativePrompt: text(source.negativePrompt, DEFAULT_SETTINGS.negativePrompt),
        width: number(source.width, 256, 2048, DEFAULT_SETTINGS.width),
        height: number(source.height, 256, 2048, DEFAULT_SETTINGS.height),
        instruction: text(source.instruction, DEFAULT_INSTRUCTION).trim() || DEFAULT_INSTRUCTION,
        openWindow: source.openWindow !== false,
        useReferences: source.useReferences !== false,
        includePersona: source.includePersona === true,
        matureContent: source.matureContent !== false,
    };
}

/** Аватары из `stCharacter.avatars` → референсы для `image.generate`: персонажи, затем (по желанию) персона; имя — подпись картинки. */
export function buildReferences(avatars, { includePersona = false } = {}) {
    const list = (avatars?.characters ?? []).map(character => ({ url: character.url, label: character.name }));
    if (includePersona && avatars?.persona?.url) list.push({ url: avatars.persona.url, label: avatars.persona.name });
    return list.filter(reference => reference.url);
}

export function createScenePainterModule(host) {
    const call = (contract, params) => request(host.cores, contract, { params });
    const callService = (contract, params) => request(host.services, contract, { params });

    const settings = signal({ ...DEFAULT_SETTINGS });
    const images = signal({});        // mesid → { assetId, prompt, width, height, createdAt }
    const busy = signal({});          // mesid → 'writing' | 'painting'
    const errors = signal({});        // mesid → текст ошибки
    const textWorkers = signal([]);
    const imageWorkers = signal([]);

    const patch = (store, key, value) => {
        const next = { ...store.peek() };
        if (value === undefined) delete next[key]; else next[key] = value;
        store.set(next);
    };
    const refreshFooter = () => call('ui.messageFooter.attach', {});

    /** Вывести картинку сообщения в окно «Картинка» движка. */
    async function showInWindow(mesid) {
        const entry = images.peek()[String(mesid)];
        if (!entry) return false;
        const result = await call('ui.picture.show', { assetId: entry.assetId, caption: entry.prompt });
        if (!result.ok) await call('ui.notify', { tone: 'error', text: `Scene Painter: ${result.error.message}` });
        return result.ok;
    }

    /** Референсы к этой картинке — только если их примет хоть один бэкенд, куда уйдёт запрос; иначе незачем читать аватары. */
    async function collectReferences(current) {
        if (!current.useReferences) return [];
        const pool = imageWorkers.peek().filter(worker => !current.imageWorkerId || worker.id === current.imageWorkerId);
        if (!pool.some(supportsReferences)) return [];
        const avatars = await callService('stCharacter.avatars');
        return avatars.ok ? buildReferences(avatars.value, { includePersona: current.includePersona }) : [];
    }

    async function writeScenePrompt(mesid, references = []) {
        const current = settings.peek();
        const history = await call('chatHistory.messages', { limit: Math.max(50, current.contextMessages * 4) });
        if (!history.ok) throw new Error(history.error.message);
        const transcript = buildSceneTranscript(history.value, mesid, current.contextMessages);
        if (!transcript) throw new Error('There is nothing in the chat to paint yet.');
        const systemPrompt = buildWriterSystemPrompt({
            instruction: current.instruction, matureContent: current.matureContent,
            names: references.map(reference => reference.label).filter(Boolean),
        });
        const ask = async workerId => {
            const reply = await call('model.generate', {
                systemPrompt, prompt: `${transcript}\n\nWrite the image prompt for the last moment above.`,
                temperature: 0.6, maxTokens: 300, stream: false, reasoningMode: 'disabled', ...(workerId ? { workerId } : {}),
            });
            if (!reply.ok) throw new Error(`Prompt writer: ${reply.error.message}`);
            return looksLikeRefusal(reply.value) ? '' : sanitizeImagePrompt(reply.value);
        };
        // Отказ или пустой ответ — один повтор у запасного писателя, если он задан и это другая модель.
        let prompt = await ask(current.promptWorkerId);
        const backup = current.backupPromptWorkerId;
        if (!prompt && backup && backup !== current.promptWorkerId) prompt = await ask(backup);
        if (!prompt) throw new Error(backup ? 'Both prompt writers refused this scene or answered empty.' : 'The prompt writer refused this scene or answered empty — set a backup prompt writer in the settings.');
        return prompt;
    }

    /** Нарисовать сцену к сообщению `mesid`. `prompt` — готовый промпт (перерисовка с тем же), иначе его пишет модель. */
    async function paint(mesid, { prompt: givenPrompt } = {}) {
        const key = String(mesid);
        if (busy.peek()[key]) return false;
        patch(errors, key, undefined);
        const current = settings.peek();
        try {
            patch(busy, key, 'writing');
            await refreshFooter();
            const references = await collectReferences(current);
            const finalPrompt = givenPrompt || buildFinalPrompt(await writeScenePrompt(key, references), current.style);
            patch(busy, key, 'painting');
            await refreshFooter();
            const generated = await call('image.generate', {
                prompt: finalPrompt, negativePrompt: current.negativePrompt, width: current.width, height: current.height, references,
                ...(current.imageWorkerId ? { workerId: current.imageWorkerId } : {}),
            });
            if (!generated.ok) throw new Error(`Image: ${generated.error.message}`);
            const previous = images.peek()[key];
            const entry = {
                assetId: generated.value.assetId, prompt: finalPrompt, width: generated.value.width, height: generated.value.height,
                references: generated.value.referencesUsed ?? 0, createdAt: Date.now(),
            };
            await call('chatHistory.annotate', { namespace: ANNOTATIONS_NAMESPACE, mesid: key, value: entry });
            patch(images, key, entry);
            if (current.openWindow) await showInWindow(key);
            if (previous?.assetId) await callService('image.delete', { id: previous.assetId });
            return true;
        } catch (error) {
            patch(errors, key, error.message);
            await call('ui.notify', { tone: 'error', text: `Scene Painter: ${error.message}` });
            return false;
        } finally {
            patch(busy, key, undefined);
            await refreshFooter();
        }
    }

    async function removeImage(mesid) {
        const key = String(mesid);
        const entry = images.peek()[key];
        await call('chatHistory.annotate', { namespace: ANNOTATIONS_NAMESPACE, mesid: key, value: null });
        patch(images, key, undefined);
        if (entry?.assetId) await callService('image.delete', { id: entry.assetId });
        await refreshFooter();
    }

    async function loadImages() {
        const result = await call('chatHistory.annotations', { namespace: ANNOTATIONS_NAMESPACE });
        const map = result.ok && result.value ? result.value : {};
        images.set(map);
        errors.set({});
        await refreshFooter();
    }

    async function refreshWorkers() {
        const [text, image] = await Promise.all([call('model.workers.get', {}), call('image.workers.get', {})]);
        if (text.ok) textWorkers.set(text.value ?? []);
        if (image.ok) imageWorkers.set(image.value ?? []);
    }

    async function saveSettings(next) {
        const clean = sanitizeSettings(next ?? settings.peek());
        settings.set(clean);
        await call('storage.settings.set', { namespace: SETTINGS_NAMESPACE, key: 'settings', value: clean });
        return true;
    }

    async function saveImageWorkers(list) {
        const result = await call('image.workers.set', { workers: list });
        if (!result.ok) { await call('ui.notify', { tone: 'error', text: `Scene Painter: ${result.error.message}` }); return false; }
        await refreshWorkers();
        return true;
    }

    /** Автоматически — только к свежему ответу модели, не к реплике пользователя. */
    async function onGenerationCompleted() {
        if (!settings.peek().autoPaint) return;
        const last = await call('chatHistory.messages', { limit: 1 });
        const message = last.ok ? last.value?.[0] : null;
        if (!message || message.isUser || message.isSystem || message.isToolCall) return;
        await paint(message.mesid);
    }

    const view = createScenePainterView({ settings, images, busy, errors, textWorkers, imageWorkers, paint, removeImage, showInWindow, saveSettings, saveImageWorkers });

    const subscriptions = [
        host.events.subscribe('generation.completed', () => { void onGenerationCompleted(); }),
        host.events.subscribe('st.chatChanged', () => { void loadImages(); }),
        host.events.subscribe('model.workers.changed', () => { void refreshWorkers(); }),
        host.events.subscribe('image.workers.changed', () => { void refreshWorkers(); }),
    ];

    /**
     * Слотов в подвале три, и они эксклюзивны (`ui.messageFooter.claim` отказывает, если слот чужой): «left» обычно у RP Time, «center» —
     * у Post-Turn Processor. Берём первый свободный, начиная справа; нет ни одного — говорим об этом, а не остаёмся молча невидимыми.
     */
    async function claimFooterSlot() {
        for (const slot of ['right', 'center', 'left']) {
            const result = await call('ui.messageFooter.claim', { slot, ownerId: MODULE_ID, node: view.footerWidget });
            if (result.ok) return slot;
        }
        await call('ui.notify', { tone: 'error', text: 'Scene Painter: all three message footer slots are taken by other modules — the Paint button has nowhere to go.' });
        return null;
    }

    async function load() {
        const saved = await call('storage.settings.get', { namespace: SETTINGS_NAMESPACE, key: 'settings', fallback: null });
        settings.set(sanitizeSettings(saved.ok ? saved.value : null));
        await refreshWorkers();
        await claimFooterSlot();
        await loadImages();
    }

    return {
        id: MODULE_ID,
        title: 'Scene Painter',
        description: 'Paints a picture of the current scene into the Picture window: a model writes the image prompt from the chat, an image backend draws it.',
        load,
        tree: view.tree,
        settings,
        images,
        paint,
        removeImage,
        showInWindow,
        saveSettings,
        saveImageWorkers,
        guideSettings: () => {
            const spec = (key, label, type, extra = {}) => ({ key, label, type, ...extra, get: () => settings.peek()[key], set: value => settings.set({ ...settings.peek(), [key]: value }) });
            return {
                specs: [
                    spec('autoPaint', 'Paint automatically after every reply', 'boolean'),
                    spec('contextMessages', 'Scene depth (last messages)', 'number', { min: 1, max: 20, step: 1 }),
                    spec('width', 'Width', 'number', { min: 256, max: 2048, step: 64 }),
                    spec('height', 'Height', 'number', { min: 256, max: 2048, step: 64 }),
                    spec('openWindow', 'Open the Picture window when a picture is ready', 'boolean'),
                    spec('useReferences', 'Use character avatars as reference photos', 'boolean'),
                    spec('includePersona', 'Also send the persona avatar', 'boolean'),
                    spec('matureContent', 'Describe mature scenes as written', 'boolean'),
                ],
                save: async () => { await saveSettings(settings.peek()); view.syncDraft(); },
            };
        },
        onGenerationCompleted,
        stop: () => {
            for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
            void call('ui.messageFooter.release', { ownerId: MODULE_ID });
        },
    };
}
