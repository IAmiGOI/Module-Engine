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
    chatMetadata: loadJson('stmeBetaHarness.chatMetadata', {}),
    extensionSettings: loadJson('stmeBetaHarness.extensionSettings', {}),
    saveMetadataDebounced: () => saveJson('stmeBetaHarness.chatMetadata', stContext.chatMetadata),
    saveSettingsDebounced: () => saveJson('stmeBetaHarness.extensionSettings', stContext.extensionSettings),
    macros: { register: () => {}, registry: { unregisterMacro: () => {} } },
    eventTypes: ST_EVENT_TYPES,
    eventSource: {
        on: (name, handler) => stListeners.set(name, [...(stListeners.get(name) ?? []), handler]),
        off: (name, handler) => stListeners.set(name, (stListeners.get(name) ?? []).filter(item => item !== handler)),
    },
};

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
window.stmeBetaHarness = { ...wired, interceptTarget, backendCalls };

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
