import { signal } from '../../cores/ui/reactive.js';
import { request } from '../../libraries/shared/request.js';
import { createScenePainterView } from './view.js';

export const MODULE_ID = 'module.scenePainter';

/**
 * Модуль «Scene Painter» — картинка к сцене: модель читает последние сообщения и пишет промпт для картинки, Ядро diffusion рисует
 * (`image.generate`), картинка встаёт в подвал сообщения. По мотивам Contextual Scene Painter и IkarusAutoImage, но на контрактах движка:
 * ни одного импорта из ST, ни `fetch`, ни `Blob`, ни права на сеть — сеть и байты у Ядра, показ картинки — у Сервиса хранилища (`image.url`).
 *
 * Текст сообщения не трогается: картинка — пометка к сообщению (`chatHistory.annotate`), живёт в памяти чата и в модель не уходит.
 * Реролл и удаление сообщения пометку не ломают: она по `mesid`, а подвал перерисовывается сам.
 *
 * Запуск — кнопкой «Paint» под любым ответом модели или автоматически после каждого ответа (`autoPaint`).
 */

const SETTINGS_NAMESPACE = MODULE_ID;
const ANNOTATIONS_NAMESPACE = MODULE_ID;
const MAX_PROMPT_LENGTH = 900;

export const DEFAULT_INSTRUCTION = [
    'You write prompts for an image generator.',
    'Read the roleplay excerpt and describe ONE picture of the latest moment: who is in it, what they look like, what they are doing, where, the lighting and the mood.',
    'Use concrete visual words, comma-separated phrases, no dialogue, no names the generator would not know unless you also describe the person.',
    'Answer with the prompt only — no preface, no quotes, no explanations.',
].join(' ');

export const DEFAULT_SETTINGS = Object.freeze({
    autoPaint: false,
    contextMessages: 6,
    promptWorkerId: '',
    imageWorkerId: '',
    style: 'detailed digital painting, cinematic lighting',
    negativePrompt: 'text, watermark, signature, lowres, blurry',
    width: 1024,
    height: 768,
    instruction: DEFAULT_INSTRUCTION,
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
        imageWorkerId: text(source.imageWorkerId, ''),
        style: text(source.style, DEFAULT_SETTINGS.style),
        negativePrompt: text(source.negativePrompt, DEFAULT_SETTINGS.negativePrompt),
        width: number(source.width, 256, 2048, DEFAULT_SETTINGS.width),
        height: number(source.height, 256, 2048, DEFAULT_SETTINGS.height),
        instruction: text(source.instruction, DEFAULT_INSTRUCTION).trim() || DEFAULT_INSTRUCTION,
    };
}

/** Отрывок для модели: последние `count` сообщений ДО `mesid` включительно, «Имя: текст», без разметки HTML. */
export function buildSceneTranscript(messages, mesid, count) {
    const upTo = messages.filter(message => !message.isSystem && Number(message.mesid) <= Number(mesid));
    return upTo.slice(-count).map(message => `${message.name || (message.isUser ? 'User' : 'Character')}: ${String(message.text ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`).join('\n\n');
}

/** Ответ модели → промпт: без кода-заборов, «Prompt:», кавычек и переводов строк, не длиннее `MAX_PROMPT_LENGTH`. */
export function sanitizeImagePrompt(text) {
    let prompt = String(text ?? '').replace(/```[a-z]*\n?|```/gi, ' ');
    prompt = prompt.replace(/^\s*(image\s+)?prompt\s*:\s*/i, '').replace(/\s+/g, ' ').trim();
    prompt = prompt.replace(/^["'«“]+|["'»”]+$/g, '').trim();
    return prompt.length > MAX_PROMPT_LENGTH ? prompt.slice(0, MAX_PROMPT_LENGTH).replace(/[,\s]+[^,]*$/, '') : prompt;
}

export function buildFinalPrompt(scenePrompt, style) {
    const styleText = String(style ?? '').trim();
    return styleText ? `${scenePrompt}, ${styleText}` : scenePrompt;
}

export function createScenePainterModule(host) {
    const call = (contract, params) => request(host.cores, contract, { params });
    const callService = (contract, params) => request(host.services, contract, { params });

    const settings = signal({ ...DEFAULT_SETTINGS });
    const images = signal({});        // mesid → { assetId, prompt, width, height, createdAt }
    const urls = signal({});          // assetId → object URL
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

    async function ensureUrl(assetId) {
        if (!assetId || urls.peek()[assetId]) return;
        const result = await callService('image.url', { id: assetId });
        if (result.ok && result.value) patch(urls, assetId, result.value);
    }

    async function writeScenePrompt(mesid) {
        const current = settings.peek();
        const history = await call('chatHistory.messages', { limit: Math.max(50, current.contextMessages * 4) });
        if (!history.ok) throw new Error(history.error.message);
        const transcript = buildSceneTranscript(history.value, mesid, current.contextMessages);
        if (!transcript) throw new Error('There is nothing in the chat to paint yet.');
        const reply = await call('model.generate', {
            systemPrompt: current.instruction,
            prompt: `${transcript}\n\nWrite the image prompt for the last moment above.`,
            temperature: 0.7, maxTokens: 300, stream: false, reasoningMode: 'disabled',
            ...(current.promptWorkerId ? { workerId: current.promptWorkerId } : {}),
        });
        if (!reply.ok) throw new Error(`Prompt writer: ${reply.error.message}`);
        const prompt = sanitizeImagePrompt(reply.value);
        if (!prompt) throw new Error('The prompt writer returned an empty prompt.');
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
            const finalPrompt = givenPrompt || buildFinalPrompt(await writeScenePrompt(key), current.style);
            patch(busy, key, 'painting');
            await refreshFooter();
            const generated = await call('image.generate', {
                prompt: finalPrompt, negativePrompt: current.negativePrompt, width: current.width, height: current.height,
                ...(current.imageWorkerId ? { workerId: current.imageWorkerId } : {}),
            });
            if (!generated.ok) throw new Error(`Image: ${generated.error.message}`);
            const previous = images.peek()[key];
            const entry = { assetId: generated.value.assetId, prompt: finalPrompt, width: generated.value.width, height: generated.value.height, createdAt: Date.now() };
            await call('chatHistory.annotate', { namespace: ANNOTATIONS_NAMESPACE, mesid: key, value: entry });
            patch(images, key, entry);
            await ensureUrl(entry.assetId);
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
        await Promise.all(Object.values(map).map(entry => ensureUrl(entry?.assetId)));
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

    const view = createScenePainterView({ settings, images, urls, busy, errors, textWorkers, imageWorkers, paint, removeImage, saveSettings, saveImageWorkers, ensureUrl });

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
        description: 'Paints a picture of the current scene under a reply: a model writes the image prompt from the chat, an image backend draws it.',
        load,
        tree: view.tree,
        settings,
        images,
        paint,
        removeImage,
        saveSettings,
        saveImageWorkers,
        onGenerationCompleted,
        stop: () => {
            for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
            void call('ui.messageFooter.release', { ownerId: MODULE_ID });
        },
    };
}
