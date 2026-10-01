import { signal, effect } from '../ui/reactive.js';
import { request } from '../../libraries/shared/request.js';
import { parseArticle, selectArticles, buildGuideSystemPrompt, trimHistory } from '../../libraries/core/guide-knowledge.js';
import { plainText, splitAutoActions, isUnkeptPromise, extractAnchors, hasChoice, stripChoices, stripBlocks } from '../../libraries/core/guide-markup.js';
import { describeProposal } from '../../libraries/core/guide-proposals.js';
import { createGuideWindow } from './window.js';
import { createGuideActions } from './actions.js';
import { createCreateActions } from './create-actions.js';
import { createEditActions } from './edit-actions.js';
import { createCharacterActions } from './character-actions.js';
import { createWebActions } from './web-actions.js';
import { createWhatsNew } from './whats-new.js';
import { createGuideContext } from './context.js';
import { createGuideAvatar } from './avatar.js';
import { NEUTRAL, nextFocus, detectFocus, isClosing, isTaskRequest, sanitizeFocus, COMPLETING_ACTIONS } from '../../libraries/core/guide-relevance.js';
import { cutAfterDigest, planHistoryFold, buildDigestPrompt, clampDigest, DIGEST_MAX_TOKENS } from '../../libraries/core/guide-digest.js';
import { computeRepetitionCut } from '../../libraries/core/guide-repetition.js';
import { createDebugLog } from '../../libraries/core/guide-debug.js';
import { splitThinking, streamingText, streamingStage, insertPlan, formatEngineResult, MAX_PLAN_CHARS } from '../../libraries/core/guide-thinking.js';

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
const HISTORY_LIMIT = 150;
/**
 * Бюджет токенов гида: 15 тысяч на историю и ответ вместе. История режется до 10 тысяч (верх просто отрезается, в самом чате всё остаётся), остальные 5 тысяч — под ответ
 * с рассуждением (`<think>` + видимый текст + карточки): 1800 не хватало, длинный ответ обрывался на полуслове. Системный промпт (правила, состояние, статьи) — сверх этого.
 */
export const TOKEN_BUDGET = 15000;
export const HISTORY_TOKEN_LIMIT = 10000;
export const COMPLETION_TOKEN_LIMIT = TOKEN_BUDGET - HISTORY_TOKEN_LIMIT;
/** Работа над карточкой персонажа: канон из сети, правки, пробы — история длиннее. Выше порога старое сворачивается в выжимку (guide-digest.js), свежие ~25 тысяч остаются дословно. */
export const CHARACTER_HISTORY_TOKEN_LIMIT = 50000;
const CHARACTER_KEEP_TOKENS = 25000;

export const DEFAULT_PERSONA = Object.freeze({
    name: 'Mea',
    avatar: '',
    personality: 'Mischievous, naughty, precise and slightly smug engineer who lives inside the engine. Friendly without being sugary; enjoys order and things that work.',
    style: 'Short sentences, jokes, no emoji spam. Explains the why in one line, then points to the exact place. She can be soft or mean to the user, but always does her job.',
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

/** Сколько блоков гид открывает за одну реплику и пауза между ними: больше — скачки экрана, а не помощь. */
const REVEAL_LIMIT = 4;
const REVEAL_GAP_MS = 900;
const STREAM_PAINT_MS = 60;
/** Сколько раз подряд гид может сама «зайти в блок и продолжить» за один запрос человека, и сколько ждать, пока блок раскроется на экране. */
const MAX_CONTINUES = 3;
const REVEAL_SETTLE_MS = 800;
/** Сколько раз подряд действия-«узнать» (поиск, чтение, проверка) дают гиду ещё один ход на один запрос человека: больше — это уже петля. */
/** Автоходов после действий — без предела (решение владельца: цепочка исследования длинная, и лимит обрывал её на середине); остановить можно кнопкой «Стоп». */
const MAX_ACTION_CONTINUES = Infinity;
/** Предохранитель только от БЕСПРОГРЕССНОЙ петли: столько подсказок подряд («пришли действие», «исправь вызов») без единого удавшегося шага — и она останавливается и говорит об этом. */
const MAX_IDLE_NUDGES = 3;
/** Полный текст результата для модели хранится вместе с заметкой, но не бесконечно: он живёт в сохранённом чате. */
const MAX_NOTE_DETAIL_CHARS = 14000;
const FABRICATION_FOLLOW_UP = 'Your last reply contained text that looked like a tool result — it was thrown away, you never see results that way. If you still need information, send the action block now (web.page, web.find, web.read…) and stop right after it; the engine will give you the real result. If you already have what you need, continue from the real results above.';
const FAILED_CHANGE_FOLLOW_UP = 'The change you sent could not be applied; the reason is in the last note. Fix it (a different value, a field that exists, the right avatar) and send the corrected change, or ask the user if you need something from them.';
const PLAN_OPEN_FOLLOW_UP = 'Your plan still has open steps, and your last reply ended with no action and no question to the user, so the work stopped. Do the next step of the plan now (send its action block and stop right after it). Only if you truly need something from the user, ask them plainly with a question.';
const END_OF_TURN_RULE = ' Keep working through the task step by step on your own: after each result send the next action block. Stop only when the whole task is finished or you need the user\'s answer — then end your reply with <done/>. A reply with no action block and no <done/> is treated as unfinished.';
const UNKEPT_PROMISE_FOLLOW_UP ='You said you would look something up or read something, but your reply has no action block, so nothing happened. Send the action block now (web.page, web.find, web.read…) and stop right after it.';
const DEAD_LINK_FOLLOW_UP = 'The link you wrote does not open anything: [Label](stme:…) is only for blocks of the interface from the anchor list, and <continue/> only waits for such a block. A web page is read with an action block: web.read {"url": …} (or {"ref": …}), then web.page / web.find. Send the action block now and stop right after it.';
const FAILED_ACTION_FOLLOW_UP = 'The action you sent failed; the reason and the right way to send it are in the last result. Send it again correctly, or take another route, or tell the user plainly what is not working.';
/** Подсказки без шага работы: считаются подряд (MAX_IDLE_NUDGES). */
const NUDGE_FOLLOW_UPS = new Set([FABRICATION_FOLLOW_UP, FAILED_CHANGE_FOLLOW_UP, PLAN_OPEN_FOLLOW_UP, UNKEPT_PROMISE_FOLLOW_UP, DEAD_LINK_FOLLOW_UP, FAILED_ACTION_FOLLOW_UP]);
const REPEAT_FOLLOW_UP = 'Your previous reply got stuck repeating one sentence, so it was cut off. Do NOT write any introduction or announcement. Reply with ONLY the action block for the next step (or, if the task is finished, the final answer in a few lines).';
const ACTION_FOLLOW_UP = 'The result of the action you ran is in the last note. Continue the task: use it to answer the user or to take the next step. Do not run the same action again unless the result was empty or wrong. If the next step is an action, begin your reply with its action block — no introduction, no announcement.';
const FOLLOW_UP = '(automatic — the user did not type this) The block(s) you opened are on screen now; their fields and current values are in the state below. Continue the task.';
/** Имена автоходов для журнала отладки. */
const FOLLOW_UP_NAMES = new Map([[FABRICATION_FOLLOW_UP, 'fabricated-result'], [FAILED_CHANGE_FOLLOW_UP, 'failed-change'], [PLAN_OPEN_FOLLOW_UP, 'plan-open'], [UNKEPT_PROMISE_FOLLOW_UP, 'unkept-promise'], [DEAD_LINK_FOLLOW_UP, 'dead-link'], [FAILED_ACTION_FOLLOW_UP, 'failed-action'], [ACTION_FOLLOW_UP, 'action-result'], [FOLLOW_UP, 'block-opened'], [REPEAT_FOLLOW_UP, 'repeat-recovery']]);

export function createGuideCore(host, { publish, mount, loadText = async () => null, modules = null, now = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    const emit = publish ?? ((event, payload) => host.events.emit(event, payload));
    const call = (contract, params) => request(host.own, contract, { params });
    const callService = (contract, params) => request(host.services, contract, { params });
    const persona = signal({ ...DEFAULT_PERSONA });
    const messages = signal([]);
    const mode = signal('scenario');      // 'scenario' | 'chat'
    const busy = signal(false);
    const debugLog = createDebugLog({ now });   // последние ходы с сырым ответом провайдера: кнопка «Copy debug log» в настройках окна
    const streamStage = signal(null);   // что она делает сейчас, пока ответ идёт: `{ label }` или `null` (см. streamingStage)
    const streamDraft = signal(null);   // текст ответа, который ещё идёт (стриминг): строка — показываем, `null` — ничего не идёт
    const visible = signal(false);
    const view = signal('chat');          // 'chat' | 'settings'
    const manualDone = signal(new Set());
    let scenario = { start: 'hello', nodes: {} };
    let articles = [];
    let chibiPoses = []; // задаёт владелец (guide/chibi-poses.json) — пусто по умолчанию, чиби никогда не включится сама по себе
    let tierMessages = {}; // задаёт владелец (guide/tier-messages.json): текст, который она сама пишет первой при открытии нового тира одежды
    let counter = 0;

    const saveSetting = (key, value) => call('storage.settings.set', { namespace: NAMESPACE, key, value });
    // Липкий фокус разговора (guide-relevance.js): какие списки и настройки идут в промпт полностью. Живёт вместе с чатом.
    let focus = { ...NEUTRAL };
    // Рабочие заметки гида к длинной задаче (guide-thinking.js): живут, пока задача не закончена или тема не сменилась.
    let plan = '';
    // Выжимка свёрнутой старой истории: `text` и id последнего свёрнутого сообщения (`upTo`). Живёт вместе с чатом.
    let digest = { text: '', upTo: '' };
    const saveChat = () => saveSetting('chat', { messages: messages.peek().slice(-HISTORY_LIMIT), mode: mode.peek(), focus, plan, digest });
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
    const ACTIONS = {
        ...createGuideActions({ host, call, modules, reveal: anchor => reveal(anchor), hide: anchor => hide(anchor), checklist: CHECKLIST, markDone: async id => { manualDone.set(new Set([...manualDone.peek(), id])); await saveSetting('checklist', [...manualDone.peek()]); } }),
        ...createCreateActions({ call, modules }),
        ...createEditActions({ call, modules }),
        ...createCharacterActions({ call }),
        ...createWebActions({ callService }),
    };

    async function runAction(action, params) {
        const entry = ACTIONS[action];
        if (!entry) { push({ role: 'note', text: `Unknown action "${action}".`, ok: false }); return { ok: false }; }
        let result;
        try { result = await entry.run(params ?? {}); } catch (error) { result = { ok: false, message: error.message }; }
        // В чат — короткая заметка; полный текст (страница, найденное, переписка теста) идёт только модели: `detail`.
        if (result.message) push({ role: 'note', text: result.message, ok: result.ok, ...(result.detail ? { detail: String(result.detail).slice(0, MAX_NOTE_DETAIL_CHARS) } : {}) });
        // Действие, чей результат гид должна прочитать сразу (поиск, чтение, проверка, тест карточки), даёт ей ещё один ход без участия человека.
        // Внутри её же ответа (`busy`) продолжение ставит сам `ask`, после того как выполнит все действия реплики.
        if (result.ok && entry.thenContinue && !busy.peek() && actionContinues < actionLimit()) { actionContinues += 1; void ask(null, { internal: true, followUp: entry.followUp ?? ACTION_FOLLOW_UP }); }
        if (result.ok && COMPLETING_ACTIONS.has(action)) { focus = { ...focus, done: true }; void saveChat(); }   // факт завершения: на следующей реплике — нейтральный режим, если не назовут новую тему
        changed();
        return result;
    }

    /** Кнопка выбора внутри блока: с действием — выполняется сразу (клик и есть согласие, второй кнопки нет), без — уходит вопросом. */
    async function pick(option) {
        if (busy.peek()) return false;
        if (!option?.action) return ask(option?.send || option?.label);
        push({ role: 'user', text: option.label });
        return (await runAction(option.action, option.params)).ok;
    }

    /** Карточка предложения: что реально будет создано (по той же нормализации, что и при создании). */
    const preview = (action, params) => describeProposal(action, params, { settingsOf: id => modules?.guideSettings?.(id)?.specs ?? null, titleOf: id => modules?.list?.().find(item => item.id === id)?.title });

    /** Открывает блоки, на которые сослалась реплика, — сама, без нажатий (чипы в окне остаются информацией). Не ждём: реплика уже показана. */
    /** Открывает блоки, на которые сослалась реплика; возвращает, сколько действительно открылось (0 — ссылки ни на что не вели). */
    async function openLinked(text) {
        const anchors = extractAnchors(text).slice(0, REVEAL_LIMIT);
        let opened = 0;
        for (const [index, anchor] of anchors.entries()) {
            if (index) await sleep(REVEAL_GAP_MS);
            if (await reveal(anchor)) opened += 1;
        }
        return opened;
    }

    async function reveal(anchor) {
        const result = await call('ui.reveal', { anchor });
        return result.ok && result.value !== false;
    }

    async function hide(anchor) {
        const result = await call('ui.hide', { anchor });
        return result.ok && result.value !== false;
    }

    // --- Сценарий без модели -----------------------------------------------
    function sayNode(id) {
        const node = scenario.nodes[id];
        if (!node) return;
        const say = String(node.say ?? '').replaceAll('{{name}}', nameOf());
        push({ role: 'assistant', text: say, node: id, options: (node.options ?? []).map(option => ({ ...option })) });
        void openLinked(say).catch(() => {});
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
    const context = createGuideContext({ call, callService, modules });
    // Динамическая аватарка (ROADMAP): здоровье воркеров ME, накопленное открытое время, её последний СЫРОЙ ответ (для чиби), чек-лист (4/4 = neko).
    // onTierUp: она сама пишет первой в момент открытия нового тира — текст владельца (guide/tier-messages.json), пустой/отсутствующий тир — молчание.
    const avatar = createGuideAvatar(host, {
        chibiPoses: () => chibiPoses, getNekoUnlocked: async () => (await checklistState()).every(item => item.done),
        onTierUp: tier => { const text = tierMessages[tier]; if (text) push({ role: 'assistant', text: text.replaceAll('{{name}}', nameOf()) }); },
    });
    let avatarLoaded = false;
    const unsubscribeAvatar = effect(() => { avatar.url(); if (avatarLoaded) changed(); }); // первый прогон effect() — ещё не загружено, событие не нужно

    async function liveContext(screenText = '', { focus, query = '' } = {}) {
        const workers = await workerStatus();
        const list = modules?.list?.() ?? [];
        const enabled = new Set(modules?.enabled?.() ?? []);
        const checklist = await checklistState();
        return [
            `Model connections: ${workers.length ? workers.map(worker => `${worker.workerId} — ${worker.state}${worker.lastError ? ` (last error: ${worker.lastError.message})` : ''}`).join('; ') : 'none configured'}.`,
            `Modules: ${list.map(item => `${item.title} (${item.id}) — ${enabled.has(item.id) ? 'on' : 'off'}`).join('; ') || 'none'}.`,
            `First-start checklist: ${checklist.map(item => `${item.title} — ${item.done ? 'done' : 'not yet'}`).join('; ')}.`,
            await context.editable({ focus, query }),
            screenText,
        ].filter(Boolean).join('\n');
    }

    // Стриминг: чанки приходят событием ядра моделей `model.generate.chunk` с нашим `requestId`; в окно идёт видимая часть (без рассуждений и недописанных карточек),
    // не чаще раза в STREAM_PAINT_MS — перерисовывать список на каждый токен незачем.
    let streaming = null;
    // Почему ответ оборван: `'user'` — кнопка «Стоп», `'repeat'` — модель зациклилась. `chainStopped` обрывает и цепочку автоходов до следующей реплики человека.
    let stopReason = null;
    let chainStopped = false;
    let repeatKeep = '';
    const cancelStreaming = () => { if (streaming) void call('model.generate.cancel', { requestId: streaming.requestId }); };
    /** Кнопка «Стоп»: оборвать ответ и всю цепочку автоматических ходов. */
    function stop() {
        if (!busy.peek()) return false;
        stopReason = 'user';
        chainStopped = true;
        cancelStreaming();
        return true;
    }
    const unsubscribeRaw = host.events?.subscribe?.('model.generate.raw', payload => { if (String(payload?.requestId ?? '').startsWith('guide-')) debugLog.attachRaw(payload.requestId, payload); });
    const unsubscribeChunks = host.events?.subscribe?.('model.generate.chunk', payload => {
        if (!streaming || payload?.requestId !== streaming.requestId) return;
        streaming.lastText = payload.text;
        // Модель зациклилась (одна и та же фраза снова и снова): обрываем, оставив один экземпляр; остальное — мусор, который тянул бы токены до конца лимита.
        if (!stopReason) {
            const cut = computeRepetitionCut(payload.text);
            if (cut >= 0) { stopReason = 'repeat'; repeatKeep = payload.text.slice(0, cut); chainStopped = true; cancelStreaming(); return; }
        }
        const at = now();
        if (at - streaming.painted < STREAM_PAINT_MS) return;
        streaming.painted = at;
        streamDraft.set(streamingText(payload.text));
        streamStage.set(streamingStage(payload.text));
    });

    let continues = 0;
    let actionContinues = 0;
    const actionLimit = () => MAX_ACTION_CONTINUES;
    let idleNudges = 0;
    let repeatRetries = 0;
    let doneNudged = false;

    /** `internal` — автоматический ход после того, как гид открыла блок и попросила `<continue/>`: без реплики человека, в разгар её же запроса. */
    async function ask(text, { echo = true, internal = false, followUp = FOLLOW_UP } = {}) {
        const question = internal ? '' : String(text ?? '').trim();
        if (internal ? false : (!question || busy.peek())) return false;
        if (internal && chainStopped) return false;
        if (!internal) { continues = 0; actionContinues = 0; idleNudges = 0; repeatRetries = 0; doneNudged = false; chainStopped = false; stopReason = null; }
        if (echo && !internal) push({ role: 'user', text: question });
        if (!(await hasModel())) {
            mode.set('scenario');
            push({ role: 'assistant', text: 'I can\'t think freely without a model yet — let\'s connect one first.' });
            sayNode(scenario.start);
            return false;
        }
        mode.set('chat');
        busy.set(true);
        streamDraft.set('');
        changed();
        let trail = null;
        let retryAfterRepeat = false;
        try {
            const anchorsResult = await call('ui.anchors.list');
            let screen = await context.screen();
            const known = modules?.list?.() ?? [];
            focus = nextFocus(focus, { query: question, anchors: screen.anchors, modules: known });
            // Задача про Модуль: сначала ЗАЙТИ в его блок — она видит поля и значения только у раскрытых блоков, и полагаться на то, что модель сама вспомнит об этом, нельзя.
            // Именно «названные в ЭТОЙ реплике», а не «попавшие в фокус впервые»: фокус липкий, и повторная просьба в той же теме не должна оставлять закрытое окно закрытым.
            const named = internal ? [] : detectFocus({ query: question, modules: known })?.modules ?? [];
            const target = named.find(id => (modules?.enabled?.() ?? []).includes(id) && !screen.anchors.includes(`module:${id}`));
            if (target && isTaskRequest(question) && await reveal(`module:${target}`)) {
                await sleep(REVEAL_SETTLE_MS);
                screen = await context.screen();
                focus = { ...focus, anchors: screen.anchors };
            }
            // План к задаче ведёт сама модель (пустой <plan> = закончено): завершение одного шага — не конец длинной задачи. Стираем только когда человек закрыл разговор.
            if (isClosing(question) && !detectFocus({ query: question, modules: known })) plan = '';
            let history = cutAfterDigest(messages.peek().filter(message => message.role === 'user' || message.role === 'assistant' || message.role === 'note'), digest.upTo);
            // Результат действия — рамка движка от лица «пользователя», не её реплика (см. formatEngineResult): иначе она подражает формату и выдумывает результаты сама.
            const toTurn = message => ({ role: message.role === 'user' || message.role === 'note' ? 'user' : 'assistant', content: message.role === 'note' ? formatEngineResult(message.detail ?? message.text) : message.text });
            if (focus.characters) history = await foldLongHistory(history, toTurn);
            const query = history.slice(-4).map(message => message.text).join(' ');
            const system = buildGuideSystemPrompt({
                persona: persona.peek(), context: await liveContext(screen.text, { focus, query }),
                anchors: anchorsResult.ok ? anchorsResult.value ?? [] : [],
                actions: Object.entries(ACTIONS).map(([id, entry]) => ({ id, description: entry.description })),
                digest: digest.text,
                articles: selectArticles([...articles, ...customArticles()], query, { openAnchors: [...screen.anchors, ...focus.modules.map(id => `module:${id}`)], topics: focus.characters ? ['characters'] : [] }),
            });
            const turns = trimHistory(history.map(toTurn), focus.characters ? CHARACTER_HISTORY_TOKEN_LIMIT : HISTORY_TOKEN_LIMIT);
            if (internal) turns.push({ role: 'user', content: `(automatic — the user did not type this) ${followUp.replace(/^\(automatic[^)]*\)\s*/, '')}${END_OF_TURN_RULE}` });
            // Её план (guide-thinking.js) — всегда четвёртым сообщением с конца, считая вместе с автоматическим ходом, если он есть.
            const sent = insertPlan(turns, plan);
            const requestId = `guide-${now()}-${(counter += 1)}`;
            streaming = { requestId, painted: 0 };
            trail = debugLog.begin({ requestId, kind: internal ? 'automatic' : 'user', because: internal ? (FOLLOW_UP_NAMES.get(followUp) ?? 'custom') : 'user message', question: question.slice(0, 200), plan: plan.slice(0, 600), focus: focus.characters ? 'characters' : 'general', actionContinues, idleNudges });
            const reply = await call('model.generate', {
                messages: [{ role: 'system', content: system }, ...sent],
                systemPrompt: system, prompt: sent.map(turn => `${turn.role === 'user' ? 'User' : turn.role === 'system' ? 'Plan' : nameOf()}: ${turn.content}`).join('\n\n'),
                temperature: internal ? 0.4 : 0.7, ...(internal ? { frequencyPenalty: 0.3 } : {}), maxTokens: COMPLETION_TOKEN_LIMIT, stream: true, requestId,
                ...(persona.peek().workerId ? { workerId: persona.peek().workerId } : {}),
            });
            if (!reply.ok) throw new Error(reply.error.message);
            trail.reply = reply.value;
            avatar.noteReply(reply.value); // её чиби-поза смотрит на СЫРОЙ текст этого ответа целиком (think + видимое) — не на историю и не на реплику юзера
            // Безопасные действия, которые модель пометила «auto», выполняются сразу; результат — заметкой в чате.
            const thought = splitThinking(reply.value);
            if (thought.plan !== undefined) { plan = thought.plan.slice(0, MAX_PLAN_CHARS); void saveChat(); }
            // Предохранитель: варианты ответа — не на каждом ходу. Была ли в прошлой реплике гида кнопка выбора — в этой её нет.
            const lastReply = [...messages.peek()].reverse().find(message => message.role === 'assistant');
            const quiet = lastReply && hasChoice(lastReply.text) ? stripChoices(thought.visible) : thought.visible;
            // «Сначала посмотри, потом отвечай»: реплика, которая уходит смотреть блок (`<continue/>` + ссылка), не несёт готовой карточки и вариантов — настоящий ответ будет на следующем ходу.
            const looking = thought.more && extractAnchors(quiet).length > 0 && continues < MAX_CONTINUES;
            const calm = looking ? stripBlocks(quiet, ['proposal', 'choice']) : quiet;
            const { text: shown, actions: autoRuns } = splitAutoActions(calm, id => ACTIONS[id]?.safe === true, id => ACTIONS[id]?.autoApply === true);
            if (shown || !autoRuns.length) push({ role: 'assistant', text: shown || '…' });
            trail.visible = shown;
            trail.flags = { fabricated: thought.fabricated, more: thought.more, looking, openPlan: Boolean(plan.trim()) };
            trail.actions = autoRuns.map(run => ({ action: run.action, params: JSON.stringify(run.params).slice(0, 240) }));
            const opening = openLinked(shown).catch(() => 0);
            let autoFollowUp = thought.fabricated && !autoRuns.length ? FABRICATION_FOLLOW_UP : null;
            // Пообещала посмотреть, а блока действия нет: без этого она замирала на словах, и человек писал «ну?».
            if (!autoFollowUp && !autoRuns.length && !looking && !thought.more && isUnkeptPromise(shown)) autoFollowUp = UNKEPT_PROMISE_FOLLOW_UP;
            // Рабочая цепочка (после действия или с открытым планом) идёт, пока она сама не скажет `<done/>` (готово или нужен ответ человека) и не задаст вопрос; один пинок на безмолвную остановку, дальше — конец без шума.
            if (!autoFollowUp && !autoRuns.length && !looking && !thought.more && !thought.done && !doneNudged && (actionContinues > 0 || plan.trim()) && !/\?\s*$/.test(shown.trim()) && !calm.includes('```')) { autoFollowUp = UNKEPT_PROMISE_FOLLOW_UP; doneNudged = true; }
            if (autoRuns.length) doneNudged = false;
            // `<continue/>` без единой настоящей ссылки на блок: ждать нечего — чаще всего это попытка «открыть» веб-страницу ссылкой.
            if (!autoFollowUp && !autoRuns.length && thought.more && !extractAnchors(quiet).length && !calm.includes('```')) autoFollowUp = DEAD_LINK_FOLLOW_UP;
            // Пока открыт её план (она стирает его, когда закончила), реплика без действия и без вопроса человеку — это остановка на полпути, а не конец работы.
            if (!autoFollowUp && !autoRuns.length && !looking && !thought.more && plan.trim() && !/\?\s*$/.test(shown.trim()) && !calm.includes('```')) autoFollowUp = PLAN_OPEN_FOLLOW_UP;
            for (const run of autoRuns) {
                const done = await runAction(run.action, run.params);
                trail.results = [...(trail.results ?? []), { action: run.action, ok: done.ok }];
                if (done.ok && ACTIONS[run.action]?.thenContinue) autoFollowUp = ACTIONS[run.action].followUp ?? ACTION_FOLLOW_UP;
                // Правка, которую не удалось применить (поле не подошло, нет карточки), — тоже повод для хода: ошибка в заметке, она исправляет.
                else if (!done.ok && ACTIONS[run.action]?.autoApply) autoFollowUp = FAILED_CHANGE_FOLLOW_UP;
                // Безопасное действие, которое не удалось (не те параметры, страница не открылась), тоже даёт ход: причина в заметке, она поправляет вызов или говорит человеку — а не замирает.
                else if (!done.ok && ACTIONS[run.action]?.safe) autoFollowUp = FAILED_ACTION_FOLLOW_UP;
            }
            // Ей нужно посмотреть блок, чтобы продолжить: ждём, пока он раскроется, и даём ещё один ход без участия человека (не больше MAX_CONTINUES подряд).
            if (looking) {
                continues += 1;
                // Ссылка ни на что не вела (не якорь интерфейса — например, адрес вики): это не «смотрю блок», и повторять тот же ход бессмысленно; она узнаёт, чем читать страницу.
                if (!(await opening) && actionContinues < actionLimit()) { actionContinues += 1; trail.next = 'follow-up: dead-link'; return await ask(null, { internal: true, followUp: DEAD_LINK_FOLLOW_UP }); }
                await sleep(REVEAL_SETTLE_MS);
                trail.next = 'continue: block opened';
                return await ask(null, { internal: true });
            }
            // Результат поиска или проверки, который она сама запустила, она читает сразу же, а не ждёт, пока человек напишет ещё раз.
            if (autoFollowUp && actionContinues < actionLimit()) {
                // Подсказка («пришли действие», «исправь вызов») — не шаг работы: подряд без единого удавшегося действия они считаются, а удавшееся действие счёт обнуляет.
                idleNudges = NUDGE_FOLLOW_UPS.has(autoFollowUp) ? idleNudges + 1 : 0;
                if (idleNudges > MAX_IDLE_NUDGES) { trail.next = 'stopped: no progress'; push({ role: 'note', text: 'I keep getting stuck without making progress, so I stopped. Tell me how to go on.', ok: false }); return true; }
                actionContinues += 1;
                trail.next = `follow-up: ${FOLLOW_UP_NAMES.get(autoFollowUp) ?? 'custom'}`;
                return await ask(null, { internal: true, followUp: autoFollowUp });
            }
            trail.next = autoFollowUp ? 'ended: follow-up skipped' : 'ended: the reply is final (no action, no nudge needed)';
            return true;
        } catch (error) {
            if (trail) { trail.error = error.message; trail.stopReason = stopReason; trail.partial = (streaming?.lastText ?? '').slice(-1500); }
            // Модель зациклилась на одной фразе: повтор не показываем, а просим заново — только блок действия, без вступления (не больше двух раз на запрос).
            if (stopReason === 'repeat' && repeatRetries < 2) {
                repeatRetries += 1;
                chainStopped = false;
                stopReason = null;
                if (trail) trail.next = 'retry after repeat';
                retryAfterRepeat = true;
            } else if (stopReason) {
                // Оборвано нами: то, что успело прийти (без блоков и мыслей), остаётся в чате, дальше — короткая пометка.
                const kept = streamingText(stopReason === 'repeat' ? repeatKeep : (streaming?.lastText ?? '')).trim();
                if (kept) push({ role: 'assistant', text: kept });
                push({ role: 'note', text: stopReason === 'repeat' ? 'The model started repeating itself, so I stopped it. Rephrase or ask again.' : 'Stopped.', ok: stopReason !== 'repeat' });
                return false;
            } else {
                push({ role: 'note', text: `I couldn't answer: ${error.message}`, ok: false });
                return false;
            }
        } finally {
            stopReason = null;
            streaming = null;
            streamDraft.set(null);
            streamStage.set(null);
            busy.set(false);
            changed();
        }
        // Повтор — уже после того, как этот ход полностью закрыт (не из блока catch): новый ход чистый.
        return retryAfterRepeat ? await ask(null, { internal: true, followUp: REPEAT_FOLLOW_UP }) : false;
    }

    /**
     * Работа над карточкой: когда история перевалила за порог, самые старые ходы сворачиваются в выжимку (одним вызовом модели), свежее окно остаётся дословно.
     * Сбой сворачивания не страшен: история просто обрежется по бюджету, как раньше, и в следующий раз попробуем снова.
     */
    async function foldLongHistory(history, toTurn) {
        const turns = history.map(toTurn);
        const count = planHistoryFold(turns, { limitTokens: CHARACTER_HISTORY_TOKEN_LIMIT, keepTokens: CHARACTER_KEEP_TOKENS });
        if (!count) return history;
        try {
            const prompt = buildDigestPrompt(digest.text, turns.slice(0, count));
            const result = await call('model.generate', { prompt, messages: [{ role: 'user', content: prompt }], maxTokens: DIGEST_MAX_TOKENS, temperature: 0.3, ...(persona.peek().workerId ? { workerId: persona.peek().workerId } : {}) });
            const text = result.ok ? clampDigest(splitThinking(result.value).visible) : '';
            if (!text) return history;
            digest = { text, upTo: history[count - 1].id };
            void saveChat();
            return history.slice(count);
        } catch { return history; }
    }

    function customArticles() {
        return String(persona.peek().knowledge ?? '').split(/\n-{3,}\n/).map((text, index) => text.trim() && parseArticle(text.startsWith('---') ? text : `---\ntitle: Note ${index + 1}\nalways: true\n---\n${text}`, `custom-${index}`)).filter(Boolean);
    }

    // --- Жизненный цикл ------------------------------------------------------
    const readSetting = async (key, fallback) => { const result = await call('storage.settings.get', { namespace: NAMESPACE, key, fallback }); return result.ok ? result.value ?? fallback : fallback; };
    const whatsNew = createWhatsNew({ host, call, read: readSetting, write: saveSetting });

    async function load() {
        const read = readSetting;
        persona.set({ ...DEFAULT_PERSONA, ...(await read('settings', {})) });
        const chat = await read('chat', {});
        messages.set(Array.isArray(chat.messages) ? chat.messages : []);
        mode.set(chat.mode === 'chat' ? 'chat' : 'scenario');
        focus = sanitizeFocus(chat.focus);
        const savedPlan = chat.plan ?? chat.notes; // `notes` — прежнее имя поля
        plan = typeof savedPlan === 'string' ? savedPlan.slice(0, MAX_PLAN_CHARS) : '';
        digest = typeof chat.digest?.text === 'string' ? { text: clampDigest(chat.digest.text), upTo: String(chat.digest.upTo ?? '') } : { text: '', upTo: '' };
        manualDone.set(new Set(await read('checklist', [])));
        try { scenario = JSON.parse(await loadText('setup-scenario.json')) ?? scenario; } catch { /* сценарий не загрузился — чат всё равно работает */ }
        try {
            const index = JSON.parse(await loadText('knowledge/index.json'));
            articles = (await Promise.all((index.articles ?? []).map(async file => parseArticle(await loadText(`knowledge/${file}`), file.replace(/\.md$/, ''))))).filter(article => article.text);
        } catch { articles = []; }
        try { chibiPoses = JSON.parse(await loadText('chibi-poses.json'))?.poses ?? []; } catch { chibiPoses = []; }
        try { tierMessages = JSON.parse(await loadText('tier-messages.json'))?.messages ?? {}; } catch { tierMessages = {}; }
        await avatar.load();
        avatarLoaded = true;
        // «Что нового» после обновления — в фоне и молча, если сказать нечего.
        void whatsNew.check({ hasChat: messages.peek().length > 0 }).then(text => { if (text) push({ role: 'assistant', text }); }).catch(() => {});
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
        focus = { ...NEUTRAL };
        plan = '';
        digest = { text: '', upTo: '' };
        await saveChat();
        if (withScenario) sayNode(scenario.start); else await open();
    }

    function status() {
        const last = [...messages.peek()].reverse().find(message => message.role === 'assistant');
        return {
            // Явный аватар в настройках (своя картинка вместо Меа целиком) главнее динамики; динамика — главнее статичного дефолта.
            name: nameOf(), avatar: persona.peek().avatar || avatar.url.peek() || DEFAULT_AVATAR_URL, visible: visible.peek(), busy: busy.peek(), mode: mode.peek(),
            lastLine: last ? plainText(last.text).split('\n')[0].slice(0, 140) : '',
        };
    }

    const ui = createGuideWindow({ defaultAvatar: DEFAULT_AVATAR_URL, avatarUrl: avatar.url, avatarFallback: avatar.normalFallbackFor, persona, messages, busy, visible, view, mode, ask, chooseOption, pick, preview, streamDraft, streamStage, stop, debugText: () => debugLog.toText({ worker: persona.peek().workerId || 'any', focus: focus.characters ? 'characters' : 'general', planOpen: Boolean(plan.trim()), plan: plan.slice(0, 600), actionContinues, idleNudges, chainStopped }), runAction, reveal, close, saveSettings, resetChat, checklistState, workersList: async () => ((await call('model.workers.get')).value ?? []) });

    const unregisters = [
        host.own.register('guide.open', () => open()),
        host.own.register('guide.close', () => close()),
        host.own.register('guide.settings', () => { visible.set(true); view.set('settings'); changed(); return true; }),
        host.own.register('guide.toggle', () => (visible.peek() ? close() : open())),
        host.own.register('guide.status', async () => ({ ...status(), checklist: await checklistState() })),
        host.own.register('guide.send', params => ask(params?.text)),
    ];

    return {
        load, open, close, ask, stop, chooseOption, pick, runAction, saveSettings, resetChat, status, checklistState,
        persona, messages, mode, visible, streamDraft, streamStage,
        debugText: () => debugLog.toText({ worker: persona.peek().workerId || 'any', focus: focus.characters ? 'characters' : 'general', planOpen: Boolean(plan.trim()), plan: plan.slice(0, 600), actionContinues, idleNudges, chainStopped }),
        mountWindow: async () => { const finalUi = mount(ui.tree()); await finalUi.settled?.(); return finalUi; },
        unregister: () => { unsubscribeRaw?.(); unsubscribeChunks?.(); unsubscribeAvatar?.(); avatar.unregister(); for (const unregister of unregisters) unregister(); },
    };
}
