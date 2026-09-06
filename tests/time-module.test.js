import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { registerChatMetadataService } from '../services/chat-metadata.js';
import { registerStChatService } from '../services/st-chat.js';
import { createSettingsCore } from '../cores/settings/index.js';
import { createChatMemoryCore } from '../cores/memory/index.js';
import { createChatHistoryCore } from '../cores/chat-history/index.js';
import { createTrackingCore } from '../cores/tracking/index.js';
import { createNotificationsCore } from '../cores/ui/notifications.js';
import { createTimeModule, buildTimeLabel, buildAnnotatedHistory, buildHistory, TIME_PRESETS, MODULE_ID } from '../modules/time/index.js';

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

test('buildAnnotatedHistory() puts a time label BEFORE each reply, tied by mesid, not a list floating next to the text', () => {
    const messages = [
        { mesid: '1', isUser: true, text: 'I ride out at dawn.' },
        { mesid: '2', isUser: false, text: 'The sun climbs as the road unwinds.' },
    ];

    const built = buildAnnotatedHistory(messages, { 2: '09:15 (Morning)' });

    assert.equal(built, '[unknown] Player: I ride out at dawn.\n[09:15 (Morning)] Character: The sun climbs as the road unwinds.');
});

test('buildAnnotatedHistory() marks a reply "unknown" when this SPECIFIC mesid has no recorded time yet, not the nearest one', () => {
    const messages = [{ mesid: '5', isUser: false, text: 'It creaks.' }];

    assert.match(buildAnnotatedHistory(messages, { 3: '08:00' }), /^\[unknown\] Character: It creaks\.$/);
});

test('buildAnnotatedHistory() drops system messages — noise for a time tracker exactly like it is for a generic tracker\'s {context}', () => {
    const messages = [
        { mesid: '1', isSystem: true, text: 'System: chat renamed' },
        { mesid: '2', isUser: false, text: 'A real reply.' },
    ];

    assert.equal(buildAnnotatedHistory(messages, {}), '[unknown] Character: A real reply.');
});

test('buildAnnotatedHistory() on an empty chat says so plainly instead of an empty string', () => {
    assert.equal(buildAnnotatedHistory([], {}), '(no messages yet)');
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
    createChatHistoryCore(engine.registerCaller('core.chatHistory', 'cores', { tier: 'official' }));

    const prompts = [];
    const calls = []; // весь params.generate целиком — для проверок systemPrompt/сэмплера/ризонинга
    // По умолчанию модель ДВИГАЕТ время от вызова к вызову — как настоящая.
    // Тест на схлопывание повторов подсовывает свой, неподвижный ответ.
    const answers = replies ?? ['{"time": "11:40", "period": "Morning"}', '{"time": "13:05", "period": "Afternoon"}'];
    const modelHost = engine.registerCaller('core.models.internal', 'cores', { tier: 'official' });
    modelHost.own.register('model.generate', async params => {
        prompts.push(params.prompt);
        calls.push(params);
        // `gate` даёт тесту застать Модуль СРЕДИ опроса — без него промежуточное
        // состояние невидимо и проверить пульсацию нечем.
        if (gate) await gate;
        if (fail) throw new Error('worker unreachable');
        return answers[Math.min(prompts.length - 1, answers.length - 1)];
    });
    let workerList = [{ id: 'main' }];
    modelHost.own.register('model.workers.get', () => workerList);
    // Свои пресеты — тот же контракт, что у настоящего Ядра моделей, и тот
    // же общий список, что видит Модуль «Трекер».
    let customPresets = [];
    modelHost.own.register('model.presets.get', () => customPresets);
    modelHost.own.register('model.presets.set', params => {
        customPresets = params?.presets ?? [];
        engine.events.emit('model.presets.changed', { count: customPresets.length });
        return customPresets;
    });

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
            'storage.settings.get', 'storage.settings.set',
            'chatHistory.messages', 'chatHistory.annotate', 'chatHistory.annotations', 'chatHistory.clearAnnotations',
            'model.workers.get', 'model.presets.get', 'model.presets.set', 'ui.notify', 'ui.messageFooter.claim', 'ui.messageFooter.release',
            'ui.messageFooter.liveMesid',
        ],
    });
    const setWorkers = list => { workerList = list; };
    return { engine, trackingCore, prompts, calls, macroWrites, claims, live, module: createTimeModule(moduleHost), setWorkers, settingsContext };
}

test('the module owns NO tracking of its own — it registers one tracker in the shared Ядро', async () => {
    const { module, trackingCore } = buildEngine();

    await module.load();

    const tracker = trackingCore.trackers().find(item => item.id === 'rp-time');
    assert.ok(tracker, 'трекер заведён в общем Ядре');
    assert.deepEqual(tracker.fields.map(field => field.name), ['year', 'month', 'day', 'time', 'period']);
});

test('advancing sends the ANNOTATED HISTORY to the model, each reply marked with its own time — that is the whole specialisation', async () => {
    const { module, calls } = buildEngine();
    await module.load();
    module.startTime.set('Day 0, 08:00 (Morning)');

    await module.advance();

    const call = calls.at(-1);
    // Ничего ещё не насчитано — последнее известное время это стартовая
    // точка, и она идёт ЯКОРЕМ в системное сообщение, а не в пользовательское.
    assert.match(call.systemPrompt, /The last known in-world time is: Day 0, 08:00 \(Morning\)/, 'начальная точка ушла модели якорем');
    assert.match(call.prompt, /\[unknown\] Player: We ride out at dawn\./, 'реплика игрока — с честной пометкой "ещё не посчитано"');
    assert.match(call.prompt, /\[unknown\] Character: The sun climbs as the road unwinds\. Hours pass\./, 'и переписка тоже, той же пометкой — до опроса время неизвестно для ОБЕИХ реплик');
});

test('the instruction and the history travel as TWO separate messages — system carries the instruction + anchor, user carries the annotated history', async () => {
    const { module, calls } = buildEngine();
    await module.load();

    await module.advance();

    const call = calls.at(-1);
    assert.match(call.systemPrompt, /You are an in-world time tracker/, 'инструкция — в системном сообщении');
    assert.match(call.systemPrompt, /Return ONLY a JSON object/, 'и формат ответа тоже там');
    assert.match(call.systemPrompt, /The last known in-world time is:/, 'и последнее известное время как якорь');
    assert.doesNotMatch(call.systemPrompt, /MESSAGE HISTORY/, 'а не сама история');
    assert.match(call.prompt, /MESSAGE HISTORY/, 'история — в пользовательском');
    assert.doesNotMatch(call.prompt, /You are an in-world time tracker/, 'а не инструкция');
});

test('a reply already annotated by an EARLIER poll keeps its OWN recorded time in the history — the next poll does not overwrite it with "unknown" or the newest reply\'s time', async () => {
    const { module, calls, live, settingsContext } = buildEngine({ replies: ['{"time": "11:40", "period": "Morning"}', '{"time": "13:05", "period": "Afternoon"}'] });
    await module.load();
    module.applyPreset('clock-only');
    live.mesid = '1'; // первый ответ ("The sun climbs...") посчитан на mesid "1"
    await module.advance();
    assert.equal(module.badges()['1'], '11:40 (Morning)');

    // Чат стал длиннее — новый ответ персонажа приписан в конец.
    settingsContext.chat.push({ is_user: false, is_system: false, mes: 'The road forks ahead.' });
    live.mesid = '2';
    await module.advance();

    const call = calls.at(-1);
    assert.match(call.prompt, /\[11:40 \(Morning\)\] Character: The sun climbs as the road unwinds\. Hours pass\./, 'старая метка mesid "1" осталась ЕГО, не стала "unknown" и не съехала на новую реплику');
    assert.match(call.prompt, /\[unknown\] Character: The road forks ahead\./, 'а у новой реплики честно "unknown" — время для неё ещё считается');
});

test('a Generation preset applied to RP Time reaches the model call — chosen for THIS tracker, not tied to whichever worker executes it', async () => {
    const { module, calls } = buildEngine();
    await module.load();
    module.applySampler('deterministic');
    await module.save();

    await module.advance();

    const call = calls.at(-1);
    assert.equal(call.temperature, 0);
    assert.equal(call.reasoningMode, 'disabled');
});

test('the Generation settings card is a real collapsible <details>, same widget the Tracker module uses — the block must not stand loose in the middle of the screen', async () => {
    const { module } = buildEngine();
    await module.load();

    function findAll(node, predicate, found = []) {
        if (Array.isArray(node)) { for (const item of node) findAll(item, predicate, found); return found; }
        if (typeof node === 'function') return findAll(node(), predicate, found);
        if (!node || typeof node !== 'object') return found;
        if (predicate(node)) found.push(node);
        for (const child of node.children ?? []) findAll(child, predicate, found);
        return found;
    }

    const details = findAll(module.tree(), node => node.tag === 'details');
    const generationDetails = details.find(node => JSON.stringify(node.children).includes('Generation settings (advanced)'));
    assert.ok(generationDetails, 'сэмплер/ризонинг завёрнуты в <details>, не голым блоком, ровно как у Модуля «Трекер»');
});

test('"Save as preset" saves the current tuning to the SHARED preset list, selects it, and clears the name field', async () => {
    const { module } = buildEngine();
    await module.load();
    module.temperature.set(0.33);
    module.newPresetName.set('My RP Preset');

    await module.savePreset(module.newPresetName.peek());

    assert.deepEqual(module.customPresets().map(item => item.name), ['My RP Preset']);
    assert.equal(module.customPresets()[0].temperature, 0.33);
    assert.equal(module.samplerPreset(), 'custom:my-rp-preset', 'сразу выбран, как только сохранён');
    assert.equal(module.newPresetName(), '', 'поле имени очищено');
});

test('"Delete preset" removes it from the shared list and returns to Custom, without touching the current slider values', async () => {
    const { module } = buildEngine();
    await module.load();
    await module.savePreset('Temporary');
    const keptTemperature = module.temperature();

    await module.deletePreset();

    assert.deepEqual(module.customPresets(), []);
    assert.equal(module.samplerPreset(), '', 'выбор вернулся к Custom');
    assert.equal(module.temperature(), keptTemperature, 'значения не тронуты');
});

test('a preset saved elsewhere (the Tracker module, sharing the same Ядро) reaches RP Time through model.presets.changed — no reload needed', async () => {
    const { engine, module } = buildEngine();
    await module.load();
    assert.deepEqual(module.customPresets(), []);

    // «Где-то ещё» здесь — прямая запись через тот же контракт, что и любой
    // другой держатель прав: сам факт, что Модуль обновился ПО СОБЫТИЮ, а не
    // потому что дёрнул тест, и есть то, что проверяется.
    const writer = engine.registerCaller('module.other-writer', 'modules', { tier: 'community', allowedContracts: ['model.presets.set'] });
    await new Promise(resolve => writer.cores.subscribe('model.presets.set', { params: { presets: [{ id: 'custom:elsewhere', name: 'Elsewhere', custom: true, temperature: 0.5 }] } }, resolve));
    // Обновление по событию — fire-and-forget внутри подписки Модуля (см. её
    // подписку на `model.presets.changed`): сама запись уже случилась синхронно
    // выше, а вот `refreshCustomPresets()` внутри неё довершает свой `await`
    // ЕЩЁ одним отдельным циклом микрозадач — реальный макротик даёт им всем стечь.
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.deepEqual(module.customPresets().map(item => item.name), ['Elsewhere']);
});

test('a connection added or removed in the worker panel reaches the "Model connection" dropdown through model.workers.changed — no page reload needed', async () => {
    const { module, setWorkers, engine } = buildEngine();
    await module.load();
    assert.deepEqual(module.workers(), [{ value: 'main', label: 'main' }]);

    setWorkers([{ id: 'main' }, { id: 'new-connection' }]);
    engine.events.emit('model.workers.changed', { count: 2 });
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.deepEqual(module.workers(), [{ value: 'main', label: 'main' }, { value: 'new-connection', label: 'new-connection' }]);
});

test('each advance grows the REAL annotated history, so the model sees the pace from actual marked replies, not a floating list', async () => {
    const { module, calls, live, settingsContext } = buildEngine();
    await module.load();
    module.applyPreset('clock-only'); // поддельная модель отвечает только временем и периодом
    // Каждый шаг относится к СВОЕМУ сообщению — именно это настоящее Ядро
    // подвала вычислило бы для Модуля прямо в момент опроса.
    live.mesid = '1';
    await module.advance(); // mesid "1" -> 11:40

    settingsContext.chat.push({ is_user: false, is_system: false, mes: 'The road forks ahead.' });
    live.mesid = '2';
    await module.advance(); // mesid "2" -> 13:05

    // Вторая просьба к модели видит ОБЕ реплики, каждую с её СОБСТВЕННОЙ
    // меткой — не список отметок в отрыве от текста.
    const secondCall = calls.at(1);
    assert.match(secondCall.prompt, /\[11:40 \(Morning\)\] Character: The sun climbs as the road unwinds\. Hours pass\./);
    assert.match(secondCall.prompt, /\[unknown\] Character: The road forks ahead\./, 'вторая реплика ещё не досчитана в момент, когда за ней пошли к модели');
    // И якорь в системном сообщении подхватил САМОЕ свежее известное время.
    assert.match(secondCall.systemPrompt, /The last known in-world time is: 11:40 \(Morning\)/);

    settingsContext.chat.push({ is_user: false, is_system: false, mes: 'Camp is made at dusk.' });
    live.mesid = '3';
    await module.advance(); // mesid "3" -> следующее значение

    // К третьему опросу в истории — уже ТРИ реплики персонажа, каждая со
    // своей меткой: настоящая линия, а не голый «текущий момент».
    const thirdCall = calls.at(2);
    assert.match(thirdCall.prompt, /\[11:40 \(Morning\)\] Character: The sun climbs/);
    assert.match(thirdCall.prompt, /\[13:05 \(Afternoon\)\] Character: The road forks ahead\./);
    assert.match(thirdCall.prompt, /\[unknown\] Character: Camp is made at dusk\./);
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
    const stored = await new Promise(resolve => probe.own.subscribe('chatHistory.annotations', { params: { namespace: MODULE_ID } }, resolve));

    assert.deepEqual(stored.value, { 4: '11:40 (Morning)' }, 'лежит в памяти ЧАТА (через Ядро истории чата), отметкой на сообщение');
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

test('a badge appears only where there is a recorded value or a poll is actually pending for THAT mesid — role (user/system/ToolCall) plays no part in the decision', async () => {
    const { module, claims } = buildEngine();
    await module.load();
    const build = claims[0].node;

    // Ничего не насчитано, опрос не идёт — неважно, какая у сообщения роль,
    // бейджа нет ни у кого, включая настоящий ответ.
    assert.equal(build({ mesid: '4', isUser: true, live: true }), null);
    assert.equal(build({ mesid: '4', isSystem: true, live: true }), null);
    assert.equal(build({ mesid: '4', isToolCall: true, live: true }), null);
    assert.equal(build({ mesid: '4', isUser: false, live: true }), null, 'настоящий ответ без записи и без идущего опроса — тоже ничего');

    // А раз для mesid есть запись — бейдж покажется, и роль сообщения на это
    // не влияет вовсе (механизм её даже не читает).
    module.badges.set({ 4: '11:40 (Morning)' });
    assert.ok(build({ mesid: '4', isUser: true, live: true }), 'решает факт записи, не роль');
});

test('while advance() is actually polling, the message it targets shows a BLANK pulsing badge, and nothing else does — pulsing is tied to the fact of the poll (tracking.poll.started/completed), not to DOM role', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const { module, claims, live } = buildEngine({ gate });
    await module.load();
    module.applyPreset('clock-only');
    const build = claims[0].node;
    live.mesid = '4';

    const running = module.advance();
    // Дать tracking.poll.started долететь до подписки Модуля — сама подписка
    // асинхронно спрашивает currentMesid() внутри обработчика.
    await new Promise(resolve => setTimeout(resolve, 0));

    const pulsing = build({ mesid: '4', isUser: false, live: true });
    assert.ok(pulsing, 'сообщение, под которым идёт опрос, получает бейдж');
    assert.equal(badgeValue(pulsing), '', 'но пока пустой — опрос ещё не закончился');
    assert.equal(build({ mesid: '5', isUser: false, isToolCall: true, live: false }), null, 'соседний ToolCall-черновик — ничего, опрос не под ним');
    assert.equal(build({ mesid: '0', isUser: true, live: false }), null, 'реплика пользователя — тоже ничего');

    release();
    await running;

    assert.equal(badgeValue(build({ mesid: '4', isUser: false, live: true })), '11:40 (Morning)', 'опрос закончился — настоящее значение');
});

test('a FAILED poll clears the pulsing entirely — no badge left stuck forever, the error already went out as a toast', async () => {
    const { module, claims, live } = buildEngine({ fail: true });
    await module.load();
    const build = claims[0].node;
    live.mesid = '4';

    assert.equal(await module.advance(), null);

    assert.equal(build({ mesid: '4', isUser: false, live: true }), null, 'провалившийся опрос не оставляет вечно пустой пульсации');
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
    const { engine, module, live, calls } = buildEngine();
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

    // И новый опрос якорится на 11:40, а не на отброшенном 13:05.
    assert.match(calls.at(-1).systemPrompt, /The last known in-world time is: 11:40 \(Morning\)/);
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
