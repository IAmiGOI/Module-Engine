import { wireEngine } from './engine-wiring.js';
import { INTERCEPTOR_NAME } from '../cores/generation/index.js';

// --- Fake ST context (the only thing standing in for real SillyTavern) -----
//
// Backed by localStorage (real ST would back it with its own on-disk
// settings file) rather than a plain in-memory object — otherwise a real
// browser reload could never actually demonstrate that worker/tracker/
// program config survives one, only unit tests within a single page load
// could (see tests/persisted-list.test.js).

function loadJson(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
    catch { return fallback; }
}
function saveJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch { /* private browsing / storage disabled — harmless for a dev harness */ }
}

// Фейковая событийная система ST — той же формы, что настоящая
// (`eventTypes` переводит КЛЮЧ в реальное имя, `eventSource.on/off`), чтобы
// харнесс гонял ТОТ ЖЕ мост, что и реальный ST, а не его имитацию.
const ST_EVENT_TYPES = Object.freeze({
    CHAT_CHANGED: 'chat_id_changed',
    MESSAGE_SENT: 'message_sent',
    MESSAGE_RECEIVED: 'message_received',
    GENERATION_STARTED: 'generation_started',
    GENERATION_ENDED: 'generation_ended',
    MESSAGE_SWIPED: 'message_swiped',
    MESSAGE_EDITED: 'message_edited',
    MESSAGE_UPDATED: 'message_updated',
    MESSAGE_DELETED: 'message_deleted',
    CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
    USER_MESSAGE_RENDERED: 'user_message_rendered',
    STREAM_TOKEN_RECEIVED: 'stream_token_received',
    // Настоящие значения из ST (scripts/events.js), не выдуманные — Ядро
    // работы с WI подписывается на них через `eventsCore.bridge()`, а тот
    // мостит только то, что `eventTypes` вообще заявляет о себе.
    WORLDINFO_UPDATED: 'worldinfo_updated',
    WORLDINFO_SETTINGS_UPDATED: 'worldinfo_settings_updated',
    WORLD_INFO_ACTIVATED: 'world_info_activated',
    WORLDINFO_ENTRIES_LOADED: 'worldinfo_entries_loaded',
    WORLDINFO_SCAN_DONE: 'worldinfo_scan_done',
});
const stListeners = new Map();

function fireStEvent(key, ...args) {
    for (const handler of stListeners.get(ST_EVENT_TYPES[key] ?? key) ?? []) handler(...args);
}

const stContext = {
    // Настоящий ST держит сообщения в `context.chat` — держим и мы, иначе
    // трекеру неоткуда взять контекст, и проверка была бы ненастоящей.
    chat: loadJson('stmeBetaHarness.chat', [
        { is_user: true, is_system: false, name: 'Player', mes: 'I take a swing at the bandit and catch a blade on my arm.' },
        { is_user: false, is_system: false, name: 'Narrator', mes: 'The blade bites deep. You stagger back into the tavern doorway, bleeding.' },
    ]),
    // BasicSummary скрывает старые сообщения через `is_system=true` и зовёт
    // это же (`context.saveChat`) — без фейка правка держалась бы только в
    // памяти вкладки и пропадала бы при перезагрузке харнесса, в отличие от
    // настоящей ST.
    async saveChat() { saveJson('stmeBetaHarness.chat', stContext.chat); },
    chatMetadata: loadJson('stmeBetaHarness.chatMetadata', {
        // Реальная ST кладёт книгу чата именно сюда (`chatMetadata.world_info`)
        // — заводим демо-книгу с порога, иначе Ядру работы с WI нечего
        // сканировать без ручной настройки харнесса.
        world_info: 'Demo Lore',
    }),
    extensionSettings: loadJson('stmeBetaHarness.extensionSettings', {}),
    saveMetadataDebounced: () => saveJson('stmeBetaHarness.chatMetadata', stContext.chatMetadata),
    saveSettingsDebounced: () => saveJson('stmeBetaHarness.extensionSettings', stContext.extensionSettings),
    // Настоящая ST хранит книги мира на бэкенде — здесь так же за
    // localStorage, тем же приёмом, что и остальной харнесс. Форма
    // `{ entries: { uid: entry } }` — ровно то, что отдаёт настоящий
    // `loadWorldInfo()`.
    async loadWorldInfo(name) {
        const books = loadJson('stmeBetaHarness.worldInfo', {});
        return books[name] ?? null;
    },
    async saveWorldInfo(name, data) {
        const books = loadJson('stmeBetaHarness.worldInfo', {});
        books[name] = data;
        saveJson('stmeBetaHarness.worldInfo', books);
    },
    macros: { register: () => {}, registry: { unregisterMacro: () => {} } },
    // Настоящая ST держит инструменты по имени, и умеет позвать action()
    // напрямую — тем же путём, каким это в итоге делает сама модель. Без
    // этой пары харнесс не мог бы проверить ни один Модуль, заводящий
    // настоящий инструмент (Notebook — первый такой).
    functionTools: new Map(),
    registerFunctionTool(definition) { stContext.functionTools.set(definition.name, definition); },
    unregisterFunctionTool(name) { stContext.functionTools.delete(name); },
    eventTypes: ST_EVENT_TYPES,
    eventSource: {
        on: (name, handler) => stListeners.set(name, [...(stListeners.get(name) ?? []), handler]),
        off: (name, handler) => stListeners.set(name, (stListeners.get(name) ?? []).filter(item => item !== handler)),
        // Настоящая ST эмитит УЖЕ РЕЗОЛВЛЕННЫМ именем (не ключом) — та же
        // форма, что `stme-beta`'s services/st-chat.js ждёт от
        // `context.eventSource.emit(context.eventTypes.MESSAGE_EDITED, ...)`.
        async emit(name, ...args) { for (const handler of stListeners.get(name) ?? []) await handler(...args); },
    },
    // --- Демо-заглушки для Chat Viewport (план `chat-viewport`) — настоящая
    // ST экспортирует эти же имена через getContext() (st-context.js);
    // здесь достаточно, чтобы они реально двигали `stContext.chat`, не
    // воспроизводя markdown/swipe-механику ST один в один.
    async deleteMessage(index) {
        stContext.chat.splice(index, 1);
        await stContext.saveChat();
    },
    async swipe_left(_event, { message } = {}) { await demoSwipe(message); },
    async swipe_right(_event, { message } = {}) { await demoSwipe(message); },
    async generate(type) {
        if (type !== 'regenerate' || !stContext.chat.length) return;
        const last = stContext.chat[stContext.chat.length - 1];
        last.mes = `(regenerated) ${DEMO_REPLIES[Math.floor(Math.random() * DEMO_REPLIES.length)]}`;
        await stContext.saveChat();
    },
    messageFormatting(mes, name, _isSystem, isUser, _messageId) {
        // Не настоящий markdown ST — верность формата уже отдельно проверена
        // живым спайком (`scratchpad/rasterize-spike.html`) на реальном
        // `foreignObject`; здесь достаточно честного HTML с именем/текстом.
        const safe = String(mes ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `<p><strong>${isUser ? 'You' : (name || 'Narrator')}:</strong> ${safe}</p>`;
    },
    updateMessageBlock() {},
    async saveChatConditional() { await stContext.saveChat(); },
};

const DEMO_REPLIES = [
    'The wind shifts, carrying the smell of rain toward the tavern.',
    'Someone in the corner laughs at a joke you did not hear.',
    'The bartender eyes the door, waiting for the next patron.',
];

let demoSwipeCounter = 0;
async function demoSwipe(message) {
    if (!message) return;
    demoSwipeCounter += 1;
    message.mes = `${DEMO_REPLIES[demoSwipeCounter % DEMO_REPLIES.length]} (swipe #${demoSwipeCounter})`;
    await stContext.saveChat();
}

// Затравка демо-книги — один раз, если её ещё вообще не было (не
// перетираем то, что харнесс уже накопил за прошлые сеансы).
if (!localStorage.getItem('stmeBetaHarness.worldInfo')) {
    saveJson('stmeBetaHarness.worldInfo', {
        'Demo Lore': {
            entries: {
                0: { uid: 0, key: ['tavern', 'inn'], comment: 'Tavern Doorway', content: 'A weathered oak door leads into a warm, noisy tavern.', disable: false, constant: false, order: 100, probability: 100 },
            },
        },
    });
}

// --- Demo-aware fetch: "demo://..." endpoints get a canned reply so the
// harness works with zero setup; anything else hits the real network, so a
// real API can be tested here too. Ядро трекинга's own poll prompt always
// asks for "ONLY a JSON object" (see cores/tracking/index.js's default
// template) — replying with plain text there would always fail to parse,
// so the canned reply detects that ask and answers with real JSON built
// from whatever fields the prompt actually listed (a defensive `{"health":
// 90}` fallback if none parsed) instead of one fixed string for everything.
// ------------------------------------------

/**
 * Правдоподобные значения ПО ИМЕНИ поля, а не «90» на всё подряд. Иначе
 * определитель времени показывал бы «90 (90)», и по такой картинке нельзя
 * понять, работает он или нет.
 */
let demoMinutes = 8 * 60 + 5;
function demoValueFor(name) {
    if (name === 'time') {
        demoMinutes = (demoMinutes + 35) % (24 * 60);
        return `${String(Math.floor(demoMinutes / 60)).padStart(2, '0')}:${String(demoMinutes % 60).padStart(2, '0')}`;
    }
    if (name === 'period') {
        const hour = Math.floor(demoMinutes / 60);
        return hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : hour < 22 ? 'Evening' : 'Night';
    }
    if (name === 'year') return 1;
    if (name === 'month') return 3;
    if (name === 'day') return 15;
    if (name === 'location') return 'the tavern doorway';
    return 90;
}

function demoTrackerReply(prompt) {
    const fields = [...prompt.matchAll(/^- (\w+):/gm)].map(match => match[1]);
    if (!fields.length) return '{"health": 90}';
    return JSON.stringify(Object.fromEntries(fields.map(name => [name, demoValueFor(name)])));
}

async function demoAwareFetch(url, init) {
    if (url.startsWith('demo://')) {
        await new Promise(r => setTimeout(r, 300));
        const prompt = JSON.parse(init.body)?.messages?.at(-1)?.content ?? '';
        const content = /ONLY a JSON object/.test(prompt)
            ? demoTrackerReply(prompt)
            : '(demo reply) Hello from the harness\'s fake model worker.';
        return {
            status: 200, ok: true,
            headers: { entries: () => [] },
            text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
        };
    }
    const response = await fetch(url, init);
    return { status: response.status, ok: response.ok, headers: { entries: () => [...response.headers.entries()] }, text: () => response.text() };
}

// --- Поддельный «глобальный объект» ST для перехвата генерации --------------
//
// В реальном ST это window: туда встаёт именованная функция перехватчика и там
// подменяется `fetch`. Здесь — отдельный объект, чтобы харнесс не трогал
// настоящий fetch страницы, а поддельный бэкенд отвечал сам.

const backendCalls = [];
const interceptTarget = {
    fetch: async (url, init) => {
        backendCalls.push({ url, payload: JSON.parse(init.body) });
        return new Response(JSON.stringify({ choices: [{ message: { content: '(demo) backend reply' } }] }), { status: 200 });
    },
};

const wired = await wireEngine({ getContext: () => stContext, fetch: demoAwareFetch, interceptTarget });
const { engine } = wired;

// Только для харнесса: с консоли удобно зарегистрировать этап и посмотреть,
// что реально ушло «провайдеру». В реальном ST наружу выставляется сам движок
// (см. ../index.js), а не эта отладочная обвязка.
// `invokeTool(name, args)` — тот же вызов, который в реальной ST делает
// сама модель, доступный из консоли для проверки любого зарегистрированного
// инструмента без настоящей LLM под рукой.
window.stmeBetaHarness = {
    ...wired, interceptTarget, backendCalls, stContext,
    invokeTool: (name, args) => stContext.functionTools.get(name)?.action(args),
};

// Настоящий экран движка — тот же, что монтируется внутри реального ST.
// Смонтирован уже сборщиком (реестру Модулей нужно уметь дождаться его
// перерисовки), здесь остаётся только положить корень на страницу.
document.getElementById('app').append(wired.panelUi.getRoot());

// --- Полоска харнесса: сыграть событие ST -----------------------------------
const eventSelect = document.getElementById('harnessEvent');
for (const key of Object.keys(ST_EVENT_TYPES)) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = key;
    eventSelect.append(option);
}
const last = document.getElementById('harnessLast');
engine.events.subscribe('events.any', ({ event, source }) => { last.textContent = `· ${event} (${source})`; });
document.getElementById('harnessFire').addEventListener('click', () => fireStEvent(eventSelect.value, { from: 'harness' }));

// --- Полоска харнесса: сыграть ЦЕЛУЮ генерацию ------------------------------
//
// Ровно в том порядке, в каком это делает настоящий ST 1.16.0 (проверено по
// public/script.js): GENERATION_STARTED → `await` перехватчика → и только если
// он не отменил, сама отправка. Отменённый прогон намеренно не эмитит
// GENERATION_ENDED — ST на этой ветке просто разблокирует интерфейс и выходит.

const generationResult = document.getElementById('harnessGenerationResult');

async function playGeneration() {
    const before = backendCalls.length;
    fireStEvent('GENERATION_STARTED');
    let aborted = false;
    await interceptTarget[INTERCEPTOR_NAME]?.([{ mes: 'hello from the harness' }], 4096, () => { aborted = true; }, 'normal');
    if (aborted) return 'aborted by the engine — nothing sent';

    const response = await interceptTarget.fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    fireStEvent('GENERATION_ENDED');
    if (backendCalls.length === before) return `cancelled at send (HTTP ${response.status})`;
    return `sent: ${JSON.stringify(backendCalls.at(-1).payload)}`;
}

document.getElementById('harnessGenerate').addEventListener('click', async () => {
    generationResult.textContent = '· running…';
    try { generationResult.textContent = `· ${await playGeneration()}`; }
    catch (error) { generationResult.textContent = `· failed: ${error.message}`; }
});

// --- Полоса под сообщением: три независимых виджета --------------------------
//
// Демонстрационные виджеты — часть харнесса, а не движка: в реальном ST слоты
// займут Модули. Здесь важно другое — что полоса переживает реролл и правку.

const { signal } = await import('../cores/ui/reactive.js');
const { StatBlock } = await import('../libraries/shared/widgets.js');

const footerHealth = signal('90');

// Слот `left` намеренно оставлен свободным: его занимает настоящий Модуль
// «RP Time», когда его включают. Демо-виджеты харнесса — только для двух
// оставшихся мест.
wired.messageFooter.claim({ slot: 'center', ownerId: 'harness.tracker', node: StatBlock('Health', footerHealth, { icon: '♥' }) });
wired.messageFooter.claim({ slot: 'right', ownerId: 'harness.notes', node: StatBlock('Scene', signal('Tavern doorway'), { icon: '◈' }) });
await wired.messageFooter.render();

const footerState = document.getElementById('harnessFooterState');
const describeFooter = () => {
    const footer = document.querySelector('.stme-message-footer');
    const under = footer?.closest('.mes')?.getAttribute('mesid');
    footerState.textContent = footer ? `· footer present under message ${under}` : '· footer LOST';
};
describeFooter();

/** Ровно то, что делает реролл: содержимое сообщения заменяется целиком. */
document.getElementById('harnessReroll').addEventListener('click', async () => {
    const block = document.querySelector('#chat .mes[mesid="1"] .mes_block');
    block.innerHTML = '<div class="mes_text">Narrator: (rerolled) The bandit\'s blade misses you by a hair.</div>';
    fireStEvent('MESSAGE_SWIPED', 1);
    await new Promise(r => setTimeout(r, 150));
    describeFooter();
});

/** Правка сообщения руками — ST при этом НЕ всегда шлёт событие, ловит наблюдатель. */
document.getElementById('harnessEditMsg').addEventListener('click', async () => {
    const block = document.querySelector('#chat .mes[mesid="1"] .mes_block');
    block.innerHTML = '<div class="mes_text">Narrator: (edited by hand) You stagger back into the doorway.</div>';
    await new Promise(r => setTimeout(r, 250));
    describeFooter();
});

// --- Chat Viewport (план `chat-viewport`) — живая проверка гибридного
// WebGL/DOM рендера в настоящем браузере, а не только `node --test`. ---

const cvState = document.getElementById('cvState');
const cvCanvas = document.getElementById('stme-chat-viewport-canvas');
const cvMirror = document.getElementById('stme-chat-viewport-mirror');
const cvChrome = document.getElementById('stme-chat-viewport-chrome');
let cvEnabled = true;

function describeChatViewport() {
    cvState.textContent = wired.chatViewport.isAttached()
        ? `· attached, visible mesids: [${wired.chatViewport.visibleMesids().join(', ')}]`
        : '· detached';
}

document.getElementById('cvAttach').addEventListener('click', async () => {
    const ok = await wired.chatViewport.attach({
        canvas: cvCanvas,
        mirrorContainer: cvMirror,
        chromeContainer: cvChrome,
        width: cvCanvas.width,
        height: cvCanvas.height,
        // Тема ST в харнессе не грузится по-настоящему — берём то же
        // минимальное подмножество, что styles/ уже определяет как
        // запасные значения для автономного рига.
        css: 'body{margin:0} p{margin:0 0 8px;font:14px/1.4 system-ui,sans-serif;color:#e0e0e0}',
    });
    cvState.textContent = ok ? '· attached' : '· NO WebGL available on this device/browser';
    if (ok) describeChatViewport();
});

document.getElementById('cvDetach').addEventListener('click', async () => {
    await wired.chatViewport.detach();
    describeChatViewport();
});

document.getElementById('cvToggleEnabled').addEventListener('click', async () => {
    cvEnabled = !cvEnabled;
    await wired.chatViewport.setEnabled({ enabled: cvEnabled });
    describeChatViewport();
});

document.getElementById('cvAddMessage').addEventListener('click', async () => {
    stContext.chat.push({ is_user: stContext.chat.length % 2 === 0, is_system: false, name: stContext.chat.length % 2 === 0 ? 'Player' : 'Narrator', mes: `Message #${stContext.chat.length}: ${DEMO_REPLIES[stContext.chat.length % DEMO_REPLIES.length]}` });
    await stContext.saveChat();
    await wired.chatViewport.render();
    describeChatViewport();
});

document.getElementById('cvEditLast').addEventListener('click', async () => {
    const mesid = String(stContext.chat.length - 1);
    await wired.chatViewport.editMessage({ mesid, text: `(edited via Chat Viewport) ${stContext.chat.at(-1)?.mes ?? ''}` });
    describeChatViewport();
});

document.getElementById('cvDeleteLast').addEventListener('click', async () => {
    await wired.chatViewport.deleteMessage({ mesid: String(stContext.chat.length - 1) });
    describeChatViewport();
});

document.getElementById('cvSwipeLast').addEventListener('click', async () => {
    await wired.chatViewport.swipe({ mesid: String(stContext.chat.length - 1), direction: 'right' });
    describeChatViewport();
});

document.getElementById('cvRegenerate').addEventListener('click', async () => {
    await wired.chatViewport.regenerate();
    describeChatViewport();
});
