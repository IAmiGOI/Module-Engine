import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { registerChatMetadataService } from '../services/chat-metadata.js';
import { registerStChatService } from '../services/st-chat.js';
import { createSettingsCore } from '../cores/settings/index.js';
import { createChatMemoryCore } from '../cores/memory/index.js';
import { createTrackingCore } from '../cores/tracking/index.js';
import { createNotificationsCore } from '../cores/ui/notifications.js';
import { createTimeModule, buildTimeLabel, buildTimeline, buildHistory, TIME_PRESETS, MODULE_ID } from '../modules/time/index.js';

// --- Чистые функции ---------------------------------------------------------

test('buildTimeLabel() fills the display template from the tracked fields', () => {
    const label = buildTimeLabel([{ name: 'time', value: '09:15' }, { name: 'period', value: 'Morning' }], '{time} ({period})');

    assert.equal(label, '09:15 (Morning)');
});

test('buildTimeLabel() still shows something when no template is set — a blank clock helps nobody', () => {
    assert.equal(buildTimeLabel([{ name: 'day', value: 3 }, { name: 'time', value: '20:00' }], ''), '3, 20:00');
});

test('a field with no value yet reads as a dash, not "undefined"', () => {
    assert.equal(buildTimeLabel([{ name: 'time' }], '{time}'), '—');
});

test('buildTimeline() shows the model where time has been GOING, not just where it is', () => {
    const timeline = buildTimeline(['08:00', '09:15', '09:40'], 'start');

    assert.equal(timeline, '"08:00" → "09:15" → "09:40"', 'один якорь не сообщает темпа — из-за этого в Alpha были рваные скачки');
});

test('buildTimeline() falls back to the configured start, so the model never has to invent a date', () => {
    assert.equal(buildTimeline([], 'Day 0, 08:00 (Morning)'), '"Day 0, 08:00 (Morning)"', 'в кавычках: внутри отметки бывают запятые');
});

test('buildTimeline() keeps only the recent few — a long tail is noise and wasted tokens', () => {
    const timeline = buildTimeline(['1', '2', '3', '4', '5', '6', '7'], 'start');

    assert.equal(timeline.split(' → ').length, 5);
    assert.match(timeline, /^"3" →/);
});

test('every preset is self-consistent — its template only references fields it actually declares', () => {
    for (const item of TIME_PRESETS) {
        const declared = new Set(item.fields.map(field => field.name));
        for (const token of item.displayTemplate.matchAll(/\{(\w+)\}/g)) {
            assert.ok(declared.has(token[1]), `preset "${item.id}" shows {${token[1]}} but never tracks it`);
        }
    }
});

// --- Сценарный уровень ------------------------------------------------------

function buildEngine({ replies, gate, fail = false } = {}) {
    const engine = createEngine();
    const settingsContext = { extensionSettings: {}, chatMetadata: {}, saveSettingsDebounced: () => {}, saveMetadataDebounced: () => {}, chat: [
        { is_user: true, is_system: false, mes: 'We ride out at dawn.' },
        { is_user: false, is_system: false, mes: 'The sun climbs as the road unwinds. Hours pass.' },
    ] };
    registerExtensionSettingsService(engine.buses.services, { getContext: () => settingsContext });
    registerChatMetadataService(engine.buses.services, { getContext: () => settingsContext });
    registerStChatService(engine.buses.services, { getContext: () => settingsContext });
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));
    createChatMemoryCore(engine.registerCaller('core.memory.chat', 'cores', { tier: 'official' }));

    const prompts = [];
    // По умолчанию модель ДВИГАЕТ время от вызова к вызову — как настоящая.
    // Тест на схлопывание повторов подсовывает свой, неподвижный ответ.
    const answers = replies ?? ['{"time": "11:40", "period": "Morning"}', '{"time": "13:05", "period": "Afternoon"}'];
    const modelHost = engine.registerCaller('core.models.internal', 'cores', { tier: 'official' });
    modelHost.own.register('model.generate', async params => {
        prompts.push(params.prompt);
        // `gate` даёт тесту застать Модуль СРЕДИ опроса — без него промежуточное
        // состояние невидимо и проверить пульсацию нечем.
        if (gate) await gate;
        if (fail) throw new Error('worker unreachable');
        return answers[Math.min(prompts.length - 1, answers.length - 1)];
    });
    modelHost.own.register('model.workers.get', () => [{ id: 'main' }]);

    const macroWrites = [];
    const trackingCore = createTrackingCore(engine.registerCaller('core.tracking', 'cores', { tier: 'official' }), {
        onUserFieldRegistered: entry => macroWrites.push(entry),
    });
    createNotificationsCore(engine.registerCaller('core.ui.notifications', 'cores', { tier: 'official' }), { mount: node => node });

    const claims = [];
    // Живое сообщение — то, что настоящее Ядро подвала вычислило бы САМО из
    // `stChat.renderedIds` прямо сейчас; тест просто выставляет его напрямую,
    // не поднимая настоящий DOM ради одного числа.
    const live = { mesid: null };
    const footerHost = engine.registerCaller('core.ui.messageFooter', 'cores', { tier: 'official' });
    footerHost.own.register('ui.messageFooter.claim', params => { claims.push(params); return params.slot; });
    footerHost.own.register('ui.messageFooter.release', () => true);
    footerHost.own.register('ui.messageFooter.liveMesid', () => live.mesid);

    const moduleHost = engine.registerCaller(MODULE_ID, 'modules', {
        tier: 'community',
        allowedContracts: [
            'tracking.trackers', 'tracking.configure', 'tracking.poll', 'tracking.reset',
            'storage.settings.get', 'storage.settings.set', 'storage.chatMemory.get', 'storage.chatMemory.set',
            'model.workers.get', 'ui.notify', 'ui.messageFooter.claim', 'ui.messageFooter.release',
            'ui.messageFooter.liveMesid',
        ],
    });
    return { engine, trackingCore, prompts, macroWrites, claims, live, module: createTimeModule(moduleHost) };
}

test('the module owns NO tracking of its own — it registers one tracker in the shared Ядро', async () => {
    const { module, trackingCore } = buildEngine();

    await module.load();

    const tracker = trackingCore.trackers().find(item => item.id === 'rp-time');
    assert.ok(tracker, 'трекер заведён в общем Ядре');
    assert.deepEqual(tracker.fields.map(field => field.name), ['year', 'month', 'day', 'time', 'period']);
});

test('advancing sends the TIMELINE to the model — that is the whole specialisation', async () => {
    const { module, prompts } = buildEngine();
    await module.load();
    module.startTime.set('Day 0, 08:00 (Morning)');

    await module.advance();

    assert.match(prompts.at(-1), /"Day 0, 08:00 \(Morning\)"/, 'начальная точка ушла модели');
    assert.match(prompts.at(-1), /Recent known in-world time, oldest to most recent/);
    assert.match(prompts.at(-1), /The sun climbs as the road unwinds/, 'и переписка тоже');
});

test('each advance extends the timeline, so the model sees the PACE and not just a point', async () => {
    const { module, prompts, live } = buildEngine();
    await module.load();
    module.applyPreset('clock-only'); // поддельная модель отвечает только временем и периодом
    // Каждый шаг относится к СВОЕМУ сообщению — именно это настоящее Ядро
    // подвала вычислило бы для Модуля прямо в момент опроса.
    const liveAt = mesid => { live.mesid = String(mesid); };

    liveAt(1);
    await module.advance();
    liveAt(2);
    await module.advance();

    // Вторая просьба к модели уже содержит первую отметку — именно этого и не
    // хватало Alpha, пока она посылала один голый «текущий момент».
    assert.match(prompts.at(1), /oldest to most recent: "11:40 \(Morning\)"/);

    liveAt(3);
    await module.advance();

    // А к третьей набралась настоящая ЛИНИЯ, по которой виден темп.
    assert.match(prompts.at(2), /"11:40 \(Morning\)" → "13:05 \(Afternoon\)"/);
});

test('the same value twice does not pad the timeline with duplicates', async () => {
    const { module, live } = buildEngine({ replies: ['{"time": "11:40", "period": "Morning"}'] });
    await module.load();
    module.applyPreset('clock-only');

    live.mesid = '1';
    await module.advance();
    live.mesid = '2';
    await module.advance();

    assert.deepEqual(module.history(), ['11:40 (Morning)']);
});

test('the worked-out time reaches the macro — through the Ядро, exactly like any other tracker', async () => {
    const { module, macroWrites } = buildEngine();
    await module.load();

    await module.advance();

    assert.deepEqual(macroWrites.map(entry => [entry.fieldName, entry.value]), [['time', '11:40'], ['period', 'Morning']]);
});

test('the module shows itself in the message footer, not in the prompt', async () => {
    const { module, claims, prompts } = buildEngine();

    await module.load();
    await module.advance();

    assert.equal(claims[0].slot, 'left');
    assert.equal(claims[0].ownerId, MODULE_ID);
    // Промпт основной модели не собирается этим Модулем вовсе — он только
    // спрашивает СВОЮ модель и кладёт ответ на шину.
    assert.equal(prompts.length, 1, 'ровно один запрос — к своей модели, и ни одного вклада в чужой промпт');
});

test('disabled, it advances nothing at all', async () => {
    const { module, prompts } = buildEngine();
    await module.load();
    module.enabled.set(false);

    await module.advance();

    assert.deepEqual(prompts, []);
});

test('resetting clears this chat\'s timeline — a new story starts from the configured beginning', async () => {
    const { module, live } = buildEngine();
    await module.load();
    live.mesid = '1';
    await module.advance();
    assert.equal(module.history().length, 1);

    await module.reset();

    assert.deepEqual(module.history(), []);
    assert.equal(module.label(), '');
});

test('the timeline is remembered per CHAT, not in settings — another chat has its own clock', async () => {
    const { module, engine, live } = buildEngine();
    await module.load();
    module.applyPreset('clock-only');
    live.mesid = '4';
    await module.advance();

    const probe = engine.registerCaller('probe', 'cores', { tier: 'official' });
    const stored = await new Promise(resolve => probe.own.subscribe('storage.chatMemory.get', { params: { namespace: MODULE_ID, key: 'badges', fallback: {} } }, resolve));

    assert.deepEqual(stored.value, { 4: '11:40 (Morning)' }, 'лежит в памяти ЧАТА, отметкой на сообщение');
});

test('applying a preset swaps fields, start and template together — they must never drift apart', async () => {
    const { module } = buildEngine();
    await module.load();

    module.applyPreset('day-counter');

    assert.deepEqual(module.fields().map(field => field.name), ['day', 'time', 'period']);
    assert.equal(module.startTime(), 'Day 0, 08:00 (Morning)');
    assert.equal(module.displayTemplate(), 'Day {day}, {time} ({period})');
});

test('while a step is running the reading goes BLANK — a stale clock shown as current is a lie', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const { module } = buildEngine({ gate });
    await module.load();
    module.applyPreset('clock-only');
    module.label.set('08:00 (Morning)');

    const running = module.advance();
    // Пустое значение — именно то, что переводит StatBlock в пульсирующее ожидание.
    assert.equal(module.label(), '', 'старое время убрано на время опроса');

    release();
    await running;

    assert.equal(module.label(), '11:40 (Morning)');
});

test('a FAILED step brings the previous reading back — it must not pulse into an empty card forever', async () => {
    const { module } = buildEngine({ fail: true });
    await module.load();
    module.applyPreset('clock-only');
    module.history.set(['08:00 (Morning)']);
    module.label.set('08:00 (Morning)');

    assert.equal(await module.advance(), null);

    assert.equal(module.label(), '08:00 (Morning)');
});

// --- Бейдж под сообщением ---------------------------------------------------

/** Читает значение StatBlock'а так же, как это делает сам виджет. */
function badgeValue(node) {
    const found = [];
    (function walk(item) {
        if (!item || typeof item !== 'object') return;
        if (item.props?.class === 'stme-stat-value') found.push(item);
        for (const child of item.children ?? []) walk(child);
    })(node);
    const source = found[0].children[0];
    return typeof source === 'function' ? source() : source;
}

test('the badge declines a USER message outright — time is worked out from the reply, not from the line before it', async () => {
    const { module, claims } = buildEngine();
    await module.load();
    const build = claims[0].node;

    assert.equal(build({ mesid: '4', isUser: true, live: true }), null);
    assert.equal(build({ mesid: '4', isSystem: true, live: true }), null);
    assert.ok(build({ mesid: '4', isUser: false, live: true }), 'а под ответом бейдж есть');
});

test('a message with no reading yet shows BLANK — that is the pulsing "still working it out", not a stale time', async () => {
    const { module, claims } = buildEngine();
    await module.load();
    module.applyPreset('clock-only');
    const build = claims[0].node;

    // Предыдущее сообщение уже посчитано, новое — ещё нет.
    module.badges.set({ 3: '08:00 (Morning)' });

    assert.equal(badgeValue(build({ mesid: '3', isUser: false, live: false })), '08:00 (Morning)');
    assert.equal(badgeValue(build({ mesid: '4', isUser: false, live: true })), '', 'новое сообщение ждёт своего времени');
});

test('advancing marks the message it was LIVE under, and leaves the ones before it alone', async () => {
    const { module, live } = buildEngine();
    await module.load();
    module.applyPreset('clock-only');
    module.badges.set({ 3: '08:00 (Morning)' });
    live.mesid = '4'; // так настоящее Ядро подвала сообщило бы, где живой бейдж

    await module.advance();

    assert.deepEqual(module.badges(), { 3: '08:00 (Morning)', 4: '11:40 (Morning)' });
});

test('a reroll clears that message\'s reading — the discarded reply\'s time must not stand', async () => {
    const { engine, module, live } = buildEngine();
    await module.load();
    module.applyPreset('clock-only');
    live.mesid = '4';
    await module.advance();
    assert.equal(module.badges()['4'], '11:40 (Morning)');

    engine.events.emit('st.messageSwiped');
    engine.events.emit('generation.beforeSend');
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(module.badges()['4'], undefined, 'бейдж вернулся в пустое пульсирующее ожидание');
});

test('merely BROWSING existing swipes changes nothing — ST fires the same event, but there is no new reply to time', async () => {
    const { engine, module, live } = buildEngine();
    await module.load();
    module.applyPreset('clock-only');
    live.mesid = '4';
    await module.advance();

    // Настоящая ST шлёт MESSAGE_SWIPED и когда просто листают готовые
    // варианты — генерации за этим не следует. Стереть отметку здесь значило
    // бы оставить бейдж пустым и пульсирующим навсегда.
    engine.events.emit('st.messageSwiped');
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(module.badges()['4'], '11:40 (Morning)');
});

test('a reroll ROLLS THE CLOCK BACK — the timeline and the card return to the previous message', async () => {
    const { engine, module, live, prompts } = buildEngine();
    await module.load();
    module.applyPreset('clock-only');
    const liveAt = mesid => { live.mesid = String(mesid); };

    liveAt(1);
    await module.advance();          // 11:40
    liveAt(2);
    await module.advance();          // 13:05
    assert.deepEqual(module.history(), ['11:40 (Morning)', '13:05 (Afternoon)']);

    // Реролл сообщения 2: свайп + начавшаяся генерация.
    engine.events.emit('st.messageSwiped');
    engine.events.emit('generation.beforeSend');
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.deepEqual(module.history(), ['11:40 (Morning)'], 'отброшенный вариант ушёл и из шкалы, а не только из бейджа');
    assert.equal(module.label(), '11:40 (Morning)', 'карточка вернулась к времени предыдущего сообщения');

    await module.advance();

    // И новый опрос отсчитывает от 11:40, а не от отброшенного 13:05.
    assert.match(prompts.at(-1), /oldest to most recent: "11:40 \(Morning\)"\./);
});

test('buildHistory() reads the timeline off the message marks, in message order and without repeats', () => {
    assert.deepEqual(buildHistory({ 10: 'c', 2: 'b', 1: 'a' }), ['a', 'b', 'c'], 'порядок ЧИСЛОВОЙ: иначе «10» встало бы между «1» и «2»');
    assert.deepEqual(buildHistory({ 1: 'a', 2: 'a', 3: 'b' }), ['a', 'b'], 'подряд идущий повтор не даёт второй точки');
    assert.deepEqual(buildHistory({}), []);
});

test('the "Regenerate" menu action clears the reading too — real ST deletes the last message instead of swiping it, no MESSAGE_SWIPED involved at all', async () => {
    const { engine, module, live } = buildEngine();
    await module.load();
    module.applyPreset('clock-only');
    live.mesid = '4';
    await module.advance();
    assert.equal(module.badges()['4'], '11:40 (Morning)');

    // Настоящая ST здесь шлёт MESSAGE_DELETED(newLength) — а newLength ЕСТЬ
    // индекс только что удалённого сообщения (script.js: `chat.length -= 1;
    // ...emit(MESSAGE_DELETED, chat.length)`), без единого MESSAGE_SWIPED.
    engine.events.emit('st.messageDeleted', { event: 'MESSAGE_DELETED', args: [4] });

    assert.equal(module.badges()['4'], undefined, 'иначе новый ответ под тем же mesid унаследовал бы чужое время');
});

test('deleting an UNRELATED message does not touch a badge that belongs to a different one', async () => {
    const { engine, module } = buildEngine();
    await module.load();
    module.badges.set({ 2: '08:00 (Morning)', 5: '09:00 (Morning)' });

    engine.events.emit('st.messageDeleted', { event: 'MESSAGE_DELETED', args: [2] });

    assert.deepEqual(module.badges(), { 5: '09:00 (Morning)' });
});

test('advance() asks for the live message FRESH at write time, not from a value cached back when the footer last rendered — a ToolCalls round can move it in between', async () => {
    const { module, live } = buildEngine();
    await module.load();
    module.applyPreset('clock-only');
    // В момент, когда подвал рисовался в последний раз, «живым» было
    // сообщение 4 — например, черновик с вызовом инструмента, который ST
    // потом удалила и пересобрала. К моменту, когда опрос действительно
    // закончился, по-настоящему последним стало сообщение 6.
    live.mesid = '4';

    const running = module.advance();
    live.mesid = '6'; // так выглядела бы пересборка ToolCalls, случившаяся ПОКА шёл опрос
    await running;

    assert.deepEqual(module.badges(), { 6: '11:40 (Morning)' }, 'ушло на настоящее последнее сообщение, а не на то, что запомнилось раньше');
});
