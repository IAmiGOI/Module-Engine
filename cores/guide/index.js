import { signal } from '../ui/reactive.js';
import { request } from '../../libraries/shared/request.js';
import { parseArticle, selectArticles, buildGuideSystemPrompt } from '../../libraries/core/guide-knowledge.js';
import { plainText } from '../../libraries/core/guide-markup.js';
import { createGuideWindow } from './window.js';
import { createGuideActions } from './actions.js';

/**
 * Ядро гида — маскот движка и его отдельный чат (замена старого окна онбординга). Чат НЕ чат SillyTavern: история лежит в настройках
 * движка, в списке чатов ST её нет. Отвечает модель через Ядро моделей (по умолчанию — основное подключение ST, добавляемое одной
 * кнопкой), а пока ни одна модель не работает — сценарий настройки (`guide/setup-scenario.json`), без модели вообще.
 *
 * Что умеет в ответах (libraries/core/guide-markup.js): ссылки на любой блок интерфейса (`ui.anchors.list` / `ui.reveal`), выбор кнопками,
 * карточки, шаги, живой чек-лист и кнопки действий (`ACTIONS` ниже — белый список; нажатие пользователя и есть согласие).
 * Знает: статьи `guide/knowledge/*.md` (+ свои из настроек), живое состояние (модели, модули, чек-лист) — libraries/core/guide-knowledge.js.
 *
 * Контракты: `guide.open` / `guide.close` / `guide.toggle`, `guide.status` (для виджета рабочего стола), `guide.send({ text })`.
 * Событие: `guide.changed` — после каждой реплики, смены состояния и настроек.
 */

const NAMESPACE = 'core.guide';
/** Аватар по умолчанию — картинка, выбранная владельцем (`assets/guide-avatar.png`); своя в настройках заменяет её. */
export const DEFAULT_AVATAR_URL = new URL('../../assets/guide-avatar.png', import.meta.url).href;
const HISTORY_LIMIT = 80;
const CONTEXT_TURNS = 16;

export const DEFAULT_PERSONA = Object.freeze({
    name: 'Guide',
    avatar: '',
    personality: 'Calm, precise and slightly smug engineer who lives inside the engine. Friendly without being sugary; enjoys order, permissions and things that work. A dry joke now and then.',
    style: 'Short sentences, plain words, no emoji spam. Explains the why in one line, then points to the exact place.',
    instructions: '',
    greeting: 'Hi again. Ask me anything about Module Engine — or pick something to set up.',
    workerId: '',
    knowledge: '',
});

export const CHECKLIST = Object.freeze([
    { id: 'model', title: 'Connect a model', anchor: 'card:models' },
    { id: 'module', title: 'Turn on your first module', anchor: 'card:modules' },
    { id: 'tracker', title: 'Add your first tracker', anchor: 'card:modules' },
    { id: 'hello', title: 'Ask the guide a question' },
]);

export function createGuideCore(host, { publish, mount, loadText = async () => null, modules = null, now = () => Date.now() } = {}) {
    const emit = publish ?? ((event, payload) => host.events.emit(event, payload));
    const call = (contract, params) => request(host.own, contract, { params });
    const persona = signal({ ...DEFAULT_PERSONA });
    const messages = signal([]);
    const mode = signal('scenario');      // 'scenario' | 'chat'
    const busy = signal(false);
    const visible = signal(false);
    const view = signal('chat');          // 'chat' | 'settings'
    const manualDone = signal(new Set());
    let scenario = { start: 'hello', nodes: {} };
    let articles = [];
    let counter = 0;

    const saveSetting = (key, value) => call('storage.settings.set', { namespace: NAMESPACE, key, value });
    const saveChat = () => saveSetting('chat', { messages: messages.peek().slice(-HISTORY_LIMIT), mode: mode.peek() });
    const changed = () => emit('guide.changed', status());
    const nameOf = () => persona.peek().name || DEFAULT_PERSONA.name;

    function push(message) {
        counter += 1;
        messages.set([...messages.peek(), { id: `${now()}-${counter}`, at: now(), ...message }].slice(-HISTORY_LIMIT));
        void saveChat();
        changed();
    }

    // --- Модель и чек-лист --------------------------------------------------
    async function workerStatus() {
        const result = await call('model.workers.status');
        return result.ok && Array.isArray(result.value) ? result.value : [];
    }
    async function hasModel() {
        const list = await workerStatus();
        return list.some(worker => worker.state === 'up' || worker.state === 'unknown' || worker.state === 'degraded');
    }
    async function checklistState() {
        const workers = await workerStatus();
        const enabled = modules?.enabled?.() ?? [];
        const auto = new Set();
        if (workers.some(worker => worker.state === 'up')) auto.add('model');
        if (enabled.length) auto.add('module');
        if (enabled.includes('module.tracker')) auto.add('tracker');
        if (messages.peek().some(message => message.role === 'user')) auto.add('hello');
        const done = new Set([...auto, ...manualDone.peek()]);
        return CHECKLIST.map(item => ({ ...item, done: done.has(item.id) }));
    }

    // Действия — белый список (actions.js); нажатие кнопки в чате пользователем и есть согласие.
    const ACTIONS = createGuideActions({ host, call, modules, reveal: anchor => reveal(anchor), checklist: CHECKLIST, markDone: async id => { manualDone.set(new Set([...manualDone.peek(), id])); await saveSetting('checklist', [...manualDone.peek()]); } });

    async function runAction(action, params) {
        const entry = ACTIONS[action];
        if (!entry) { push({ role: 'note', text: `Unknown action "${action}".`, ok: false }); return { ok: false }; }
        let result;
        try { result = await entry.run(params ?? {}); } catch (error) { result = { ok: false, message: error.message }; }
        if (result.message) push({ role: 'note', text: result.message, ok: result.ok });
        changed();
        return result;
    }

    async function reveal(anchor) {
        const result = await call('ui.reveal', { anchor });
        return result.ok && result.value !== false;
    }

    // --- Сценарий без модели -----------------------------------------------
    function sayNode(id) {
        const node = scenario.nodes[id];
        if (!node) return;
        push({ role: 'assistant', text: String(node.say ?? '').replaceAll('{{name}}', nameOf()), node: id, options: (node.options ?? []).map(option => ({ ...option })) });
        if (id === 'ready') { mode.set('chat'); void saveChat(); }
    }

    async function chooseOption(messageId, index) {
        const message = messages.peek().find(item => item.id === messageId);
        const option = message?.options?.[index];
        if (!option || busy.peek()) return;
        push({ role: 'user', text: option.label, scripted: true });
        if (option.send) { mode.set('chat'); await ask(option.send, { echo: false }); return; }
        if (option.action) {
            busy.set(true);
            const result = await runAction(option.action, option.params);
            busy.set(false);
            sayNode(result.ok ? option.onSuccess : option.onFailure);
            return;
        }
        if (option.next) sayNode(option.next);
    }

    // --- Свободный чат -------------------------------------------------------
    async function liveContext() {
        const workers = await workerStatus();
        const list = modules?.list?.() ?? [];
        const enabled = new Set(modules?.enabled?.() ?? []);
        const checklist = await checklistState();
        return [
            `Model connections: ${workers.length ? workers.map(worker => `${worker.workerId} — ${worker.state}${worker.lastError ? ` (last error: ${worker.lastError.message})` : ''}`).join('; ') : 'none configured'}.`,
            `Modules: ${list.map(item => `${item.title} (${item.id}) — ${enabled.has(item.id) ? 'on' : 'off'}`).join('; ') || 'none'}.`,
            `First-start checklist: ${checklist.map(item => `${item.title} — ${item.done ? 'done' : 'not yet'}`).join('; ')}.`,
        ].join('\n');
    }

    async function ask(text, { echo = true } = {}) {
        const question = String(text ?? '').trim();
        if (!question || busy.peek()) return false;
        if (echo) push({ role: 'user', text: question });
        if (!(await hasModel())) {
            mode.set('scenario');
            push({ role: 'assistant', text: 'I can\'t think freely without a model yet — let\'s connect one first.' });
            sayNode(scenario.start);
            return false;
        }
        mode.set('chat');
        busy.set(true);
        changed();
        try {
            const anchorsResult = await call('ui.anchors.list');
            const history = messages.peek().filter(message => message.role === 'user' || message.role === 'assistant' || message.role === 'note').slice(-CONTEXT_TURNS);
            const query = history.slice(-4).map(message => message.text).join(' ');
            const system = buildGuideSystemPrompt({
                persona: persona.peek(), context: await liveContext(),
                anchors: anchorsResult.ok ? anchorsResult.value ?? [] : [],
                actions: Object.entries(ACTIONS).map(([id, entry]) => ({ id, description: entry.description })),
                articles: selectArticles([...articles, ...customArticles()], query),
            });
            const turns = history.map(message => ({ role: message.role === 'user' ? 'user' : 'assistant', content: message.role === 'note' ? `(result: ${message.text})` : message.text }));
            const reply = await call('model.generate', {
                messages: [{ role: 'system', content: system }, ...turns],
                systemPrompt: system, prompt: turns.map(turn => `${turn.role === 'user' ? 'User' : nameOf()}: ${turn.content}`).join('\n\n'),
                temperature: 0.7, maxTokens: 900, stream: false,
                ...(persona.peek().workerId ? { workerId: persona.peek().workerId } : {}),
            });
            if (!reply.ok) throw new Error(reply.error.message);
            push({ role: 'assistant', text: String(reply.value ?? '').trim() || '…' });
            return true;
        } catch (error) {
            push({ role: 'note', text: `I couldn't answer: ${error.message}`, ok: false });
            return false;
        } finally {
            busy.set(false);
            changed();
        }
    }

    function customArticles() {
        return String(persona.peek().knowledge ?? '').split(/\n-{3,}\n/).map((text, index) => text.trim() && parseArticle(text.startsWith('---') ? text : `---\ntitle: Note ${index + 1}\nalways: true\n---\n${text}`, `custom-${index}`)).filter(Boolean);
    }

    // --- Жизненный цикл ------------------------------------------------------
    async function load() {
        const read = async (key, fallback) => { const result = await call('storage.settings.get', { namespace: NAMESPACE, key, fallback }); return result.ok ? result.value ?? fallback : fallback; };
        persona.set({ ...DEFAULT_PERSONA, ...(await read('settings', {})) });
        const chat = await read('chat', {});
        messages.set(Array.isArray(chat.messages) ? chat.messages : []);
        mode.set(chat.mode === 'chat' ? 'chat' : 'scenario');
        manualDone.set(new Set(await read('checklist', [])));
        try { scenario = JSON.parse(await loadText('setup-scenario.json')) ?? scenario; } catch { /* сценарий не загрузился — чат всё равно работает */ }
        try {
            const index = JSON.parse(await loadText('knowledge/index.json'));
            articles = (await Promise.all((index.articles ?? []).map(async file => parseArticle(await loadText(`knowledge/${file}`), file.replace(/\.md$/, ''))))).filter(article => article.text);
        } catch { articles = []; }
    }

    /** Открыть чат. Пустой чат начинается сценарием (нет модели) или приветствием. */
    async function open() {
        visible.set(true);
        view.set('chat');
        if (!messages.peek().length) {
            if (await hasModel()) { mode.set('chat'); push({ role: 'assistant', text: persona.peek().greeting.replaceAll('{{name}}', nameOf()) }); } else sayNode(scenario.start);
        }
        changed();
        return true;
    }
    function close() { visible.set(false); changed(); return true; }

    async function saveSettings(next) {
        persona.set({ ...DEFAULT_PERSONA, ...next });
        await saveSetting('settings', persona.peek());
        changed();
    }
    async function resetChat({ scenario: withScenario = false } = {}) {
        messages.set([]);
        mode.set('scenario');
        await saveChat();
        if (withScenario) sayNode(scenario.start); else await open();
    }

    function status() {
        const last = [...messages.peek()].reverse().find(message => message.role === 'assistant');
        return {
            name: nameOf(), avatar: persona.peek().avatar || DEFAULT_AVATAR_URL, visible: visible.peek(), busy: busy.peek(), mode: mode.peek(),
            lastLine: last ? plainText(last.text).split('\n')[0].slice(0, 140) : '',
        };
    }

    const ui = createGuideWindow({ defaultAvatar: DEFAULT_AVATAR_URL, persona, messages, busy, visible, view, mode, ask, chooseOption, runAction, reveal, close, saveSettings, resetChat, checklistState, workersList: async () => ((await call('model.workers.get')).value ?? []) });

    const unregisters = [
        host.own.register('guide.open', () => open()),
        host.own.register('guide.close', () => close()),
        host.own.register('guide.toggle', () => (visible.peek() ? close() : open())),
        host.own.register('guide.status', async () => ({ ...status(), checklist: await checklistState() })),
        host.own.register('guide.send', params => ask(params?.text)),
    ];

    return {
        load, open, close, ask, chooseOption, runAction, saveSettings, resetChat, status, checklistState,
        persona, messages, mode, visible,
        mountWindow: async () => { const finalUi = mount(ui.tree()); await finalUi.settled?.(); return finalUi; },
        unregister: () => { for (const unregister of unregisters) unregister(); },
    };
}
