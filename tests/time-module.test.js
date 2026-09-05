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
import { createTimeModule, buildTimeLabel, buildTimeline, TIME_PRESETS, MODULE_ID } from '../modules/time/index.js';

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

function buildEngine({ replies } = {}) {
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
    modelHost.own.register('model.generate', params => {
        prompts.push(params.prompt);
        return answers[Math.min(prompts.length - 1, answers.length - 1)];
    });
    modelHost.own.register('model.workers.get', () => [{ id: 'main' }]);

    const macroWrites = [];
    const trackingCore = createTrackingCore(engine.registerCaller('core.tracking', 'cores', { tier: 'official' }), {
        onUserFieldRegistered: entry => macroWrites.push(entry),
    });
    createNotificationsCore(engine.registerCaller('core.ui.notifications', 'cores', { tier: 'official' }), { mount: node => node });

    const claims = [];
    const footerHost = engine.registerCaller('core.ui.messageFooter', 'cores', { tier: 'official' });
    footerHost.own.register('ui.messageFooter.claim', params => { claims.push(params); return params.slot; });
    footerHost.own.register('ui.messageFooter.release', () => true);

    const moduleHost = engine.registerCaller(MODULE_ID, 'modules', {
        tier: 'community',
        allowedContracts: [
            'tracking.trackers', 'tracking.configure', 'tracking.poll', 'tracking.reset',
            'storage.settings.get', 'storage.settings.set', 'storage.chatMemory.get', 'storage.chatMemory.set',
            'model.workers.get', 'ui.notify', 'ui.messageFooter.claim', 'ui.messageFooter.release',
        ],
    });
    return { engine, trackingCore, prompts, macroWrites, claims, module: createTimeModule(moduleHost) };
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
    const { module, prompts } = buildEngine();
    await module.load();
    module.applyPreset('clock-only'); // поддельная модель отвечает только временем и периодом

    await module.advance();
    await module.advance();

    // Вторая просьба к модели уже содержит первую отметку — именно этого и не
    // хватало Alpha, пока она посылала один голый «текущий момент».
    assert.match(prompts.at(1), /oldest to most recent: "11:40 \(Morning\)"/);

    await module.advance();

    // А к третьей набралась настоящая ЛИНИЯ, по которой виден темп.
    assert.match(prompts.at(2), /"11:40 \(Morning\)" → "13:05 \(Afternoon\)"/);
});

test('the same value twice does not pad the timeline with duplicates', async () => {
    const { module } = buildEngine({ replies: ['{"time": "11:40", "period": "Morning"}'] });
    await module.load();
    module.applyPreset('clock-only');

    await module.advance();
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
    const { module } = buildEngine();
    await module.load();
    await module.advance();
    assert.equal(module.history().length, 1);

    await module.reset();

    assert.deepEqual(module.history(), []);
    assert.equal(module.label(), '');
});

test('the timeline is remembered per CHAT, not in settings — another chat has its own clock', async () => {
    const { module, engine } = buildEngine();
    await module.load();
    module.applyPreset('clock-only');
    await module.advance();

    const probe = engine.registerCaller('probe', 'cores', { tier: 'official' });
    const stored = await new Promise(resolve => probe.own.subscribe('storage.chatMemory.get', { params: { namespace: MODULE_ID, key: 'timeline', fallback: [] } }, resolve));

    assert.deepEqual(stored.value, ['11:40 (Morning)'], 'лежит в памяти ЧАТА');
});

test('applying a preset swaps fields, start and template together — they must never drift apart', async () => {
    const { module } = buildEngine();
    await module.load();

    module.applyPreset('day-counter');

    assert.deepEqual(module.fields().map(field => field.name), ['day', 'time', 'period']);
    assert.equal(module.startTime(), 'Day 0, 08:00 (Morning)');
    assert.equal(module.displayTemplate(), 'Day {day}, {time} ({period})');
});
