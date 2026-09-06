import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { createSettingsCore } from '../cores/settings/index.js';
import { createTrackingCore } from '../cores/tracking/index.js';
import { createNotificationsCore } from '../cores/ui/notifications.js';
import { createPipelineCore } from '../cores/pipeline/index.js';
import { createTrackerModule, computeTriggers, resolveTriggerMode, buildLabel, MODULE_ID } from '../modules/tracker/index.js';

// --- Чистые функции: перевод выбора пользователя в условие Директора --------

test('computeTriggers() turns "every N replies" into the Директор condition, not into a counter the module keeps itself', () => {
    assert.deepEqual(computeTriggers('everyNReplies', 5), [{ event: 'generation.completed', every: 5 }]);
});

test('computeTriggers() turns "every N minutes" into a real timer condition for the Директор', () => {
    assert.deepEqual(computeTriggers('everyNMinutes', 3), [{ every: { ms: 180000 } }]);
});

test('computeTriggers() for manual polling produces NO trigger at all — nothing subscribes, nothing fires', () => {
    assert.deepEqual(computeTriggers('manual', 5), []);
});

test('computeTriggers() refuses a nonsense count instead of subscribing to "every 0 replies"', () => {
    assert.deepEqual(computeTriggers('everyNReplies', 0), [{ event: 'generation.completed', every: 1 }]);
});

test('resolveTriggerMode() reads a saved condition back into the form that produced it', () => {
    assert.deepEqual(resolveTriggerMode([{ event: 'generation.completed', every: 4 }]), { mode: 'everyNReplies', count: 4, blocking: true });
    assert.deepEqual(resolveTriggerMode([{ every: { ms: 600000 } }]), { mode: 'everyNMinutes', count: 10, blocking: true });
    assert.deepEqual(resolveTriggerMode([]), { mode: 'manual', count: 3, blocking: true });
});

test('resolveTriggerMode() keeps a condition the form cannot show instead of silently downgrading it to "manual"', () => {
    const exotic = { event: 'st.chatChanged', debounceMs: 500 };

    const resolved = resolveTriggerMode([exotic]);

    assert.equal(resolved.mode, 'custom');
    assert.deepEqual(resolved.custom, exotic);
});

test('buildLabel() falls back to a readable "name: value" list when no display template is set', () => {
    assert.equal(buildLabel([{ name: 'health', value: 90 }, { name: 'location', value: 'inn' }], ''), 'health: 90 · location: inn');
});

test('buildLabel() fills the display template, and a field with no value yet reads as a dash rather than "undefined"', () => {
    assert.equal(buildLabel([{ name: 'health', value: 90 }, { name: 'mood' }], '❤ {health} · {mood}'), '❤ 90 · —');
});

test('buildLabel() says so plainly when a tracker has no fields at all', () => {
    assert.equal(buildLabel([], '{health}'), '(no fields configured)');
});

// --- Сценарный уровень: настоящий движок, настоящие Гейты -------------------

function buildEngine({ rights } = {}) {
    const engine = createEngine();
    const settingsContext = { extensionSettings: {}, saveSettingsDebounced: () => {} };
    registerExtensionSettingsService(engine.buses.services, { getContext: () => settingsContext });
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));

    const generations = [];
    const modelHost = engine.registerCaller('core.models.internal', 'cores', { tier: 'official' });
    modelHost.own.register('model.generate', params => {
        generations.push(params);
        return '{"health": 42, "location": "the inn"}';
    });
    // Изменяемый, а не голый массив: тест на «список обновился по событию»
    // должен мочь подменить его и эмитнуть `model.workers.changed` сам,
    // без настоящей панели воркеров рядом.
    let workerList = [{ id: 'main' }, { id: 'backup' }];
    modelHost.own.register('model.workers.get', () => workerList);
    // Свои пресеты — тот же контракт, что у настоящего Ядра моделей, только
    // без клэмпа/санитации: сохранённое тестом здесь и без того валидно.
    let customPresets = [];
    modelHost.own.register('model.presets.get', () => customPresets);
    modelHost.own.register('model.presets.set', params => {
        customPresets = params?.presets ?? [];
        engine.events.emit('model.presets.changed', { count: customPresets.length });
        return customPresets;
    });

    const trackingCore = createTrackingCore(engine.registerCaller('core.tracking', 'cores', { tier: 'official' }));
    // Настоящее Ядро уведомлений: словесные результаты уходят туда, и проверять
    // их надо там же, где их увидит пользователь.
    const notifications = createNotificationsCore(engine.registerCaller('core.ui.notifications', 'cores', { tier: 'official' }), { mount: node => node });
    // Настоящее Ядро пайплайнов: «до отправки, ждать» — это его этап, и
    // проверять надо на нём, а не на нашем представлении о нём.
    const pipelineCore = createPipelineCore(engine.registerCaller('core.pipeline', 'cores', { tier: 'official' }), { resolveAs: engine.resolveAs });
    pipelineCore.define({ id: 'generation.prepare', mode: 'collect' });
    pipelineCore.define({ id: 'generation.beforeSend', mode: 'collect' });

    const moduleHost = engine.registerCaller(MODULE_ID, 'modules', rights ?? {
        tier: 'community',
        allowedContracts: [
            'tracking.trackers', 'tracking.configure', 'tracking.fields', 'tracking.poll', 'tracking.reset',
            'model.workers.get', 'model.presets.get', 'model.presets.set', 'storage.settings.get', 'storage.settings.set', 'ui.notify',
            // «Обновиться до ответа» регистрируется этапом пайплайна
            // `generation.prepare` — значит Модулю нужно право трогать его состав.
            'pipeline.stages', 'pipeline.stages.add', 'pipeline.stages.remove',
        ],
    });
    const setWorkers = list => { workerList = list; };
    return { engine, trackingCore, generations, notifications, pipelineCore, module: createTrackerModule(moduleHost), moduleHost, settingsContext, setWorkers };
}

/** Находит в дереве все узлы, удовлетворяющие предикату — дерево это данные, никакого DOM для проверки не нужно. */
function findAll(node, predicate, found = []) {
    if (Array.isArray(node)) { for (const item of node) findAll(item, predicate, found); return found; }
    if (typeof node === 'function') return findAll(node(), predicate, found);
    if (!node || typeof node !== 'object') return found;
    if (predicate(node)) found.push(node);
    for (const child of node.children ?? []) findAll(child, predicate, found);
    return found;
}

const textOf = node => findAll(node, item => typeof item === 'object' && item.tag).length;

test('the module renders the trackers the Ядро actually has, read over the bus', async () => {
    const { trackingCore, module } = buildEngine();
    await trackingCore.configureTrackers([
        { id: 'status', kind: 'user', workerId: 'main', fields: [{ name: 'health', prompt: 'HP left' }], triggers: [] },
    ]);

    await module.load();

    assert.deepEqual(module.trackers().map(record => record.id.peek()), ['status']);
    assert.deepEqual(module.trackers()[0].fields.peek().map(field => field.name), ['health']);
    assert.equal(module.trackers()[0].prompts.get('health').peek(), 'HP left');
});

test('a system tracker is not offered for editing — those are the engine\'s own, not the user\'s', async () => {
    const { trackingCore, module } = buildEngine();
    await trackingCore.configureTrackers([
        { id: 'mine', kind: 'user', fields: [], triggers: [] },
        { id: 'engine-owned', kind: 'system', fields: [], triggers: [] },
    ]);

    await module.load();

    assert.deepEqual(module.trackers().map(record => record.id.peek()), ['mine']);
});

test('saving writes the tracker through to the Ядро, and the poll condition arrives as a Директор condition', async () => {
    const { trackingCore, module } = buildEngine();
    await trackingCore.configureTrackers([{ id: 'status', kind: 'user', fields: [{ name: 'health' }], triggers: [] }]);
    await module.load();
    const record = module.trackers()[0];
    record.triggerMode.set('everyNReplies');
    record.triggerCount.set(4);

    await module.save();

    assert.deepEqual(trackingCore.trackers()[0].triggers, [{ event: 'generation.completed', every: 4 }]);
});

test('"Poll now" saves first, then really asks the model, and the parsed values land in the UI', async () => {
    const { module, trackingCore, generations } = buildEngine();
    await trackingCore.configureTrackers([
        { id: 'status', kind: 'user', workerId: 'main', fields: [{ name: 'health' }, { name: 'location' }], triggers: [] },
    ]);
    await module.load();
    const record = module.trackers()[0];

    await module.pollNow(record);

    assert.equal(generations.length, 1, 'exactly one model call');
    assert.equal(generations[0].workerId, 'main', 'asked through the worker the tracker is pinned to');
    assert.deepEqual(record.values().map(field => [field.name, field.value]), [['health', 42], ['location', 'the inn']]);
    assert.equal(record.flash(), 'ok', 'блок трекера вспыхивает подтверждением');
});

test('a Generation preset applied to ONE tracker reaches the model call for that tracker — chosen per tracker, not tied to the worker it runs on', async () => {
    const { module, trackingCore, generations } = buildEngine();
    await trackingCore.configureTrackers([
        { id: 'status', kind: 'user', workerId: 'main', fields: [{ name: 'health' }], triggers: [] },
    ]);
    await module.load();
    const record = module.trackers()[0];

    module.applySamplerPreset(record, 'deterministic');
    await module.pollNow(record);

    assert.equal(generations[0].temperature, 0);
    assert.equal(generations[0].reasoningMode, 'disabled');
});

test('two trackers pinned to the SAME worker keep independent sampler settings — the preset lives on the tracker, not the worker', async () => {
    const { module, trackingCore, generations } = buildEngine();
    await trackingCore.configureTrackers([
        { id: 'status', kind: 'user', workerId: 'main', fields: [{ name: 'health' }], triggers: [] },
        { id: 'mood', kind: 'user', workerId: 'main', fields: [{ name: 'health' }], triggers: [] },
    ]);
    await module.load();
    const [status, mood] = module.trackers();

    module.applySamplerPreset(status, 'deterministic');
    module.applySamplerPreset(mood, 'creative');
    await module.pollNow(status);
    await module.pollNow(mood);

    assert.equal(generations[0].temperature, 0, 'status stayed deterministic');
    assert.equal(generations[1].temperature, 1.1, 'mood stayed creative, same worker, different call');
});

test('the Generation settings card is a real collapsible <details>, same as any other advanced section — the block must not stand loose in the middle of the card', async () => {
    const { module, trackingCore } = buildEngine();
    await trackingCore.configureTrackers([{ id: 'status', kind: 'user', fields: [{ name: 'health' }], triggers: [] }]);
    await module.load();

    const tree = module.tree();

    const details = findAll(tree, node => node.tag === 'details');
    const generationDetails = details.find(node => JSON.stringify(node.children).includes('Generation settings (advanced)'));
    assert.ok(generationDetails, 'сэмплер/ризонинг завёрнуты в <details>, не голым блоком');
});

test('"Save as preset" adds a new preset to the SHARED list, selects it, and clears the name field', async () => {
    const { module, trackingCore } = buildEngine();
    await trackingCore.configureTrackers([{ id: 'status', kind: 'user', fields: [{ name: 'health' }], triggers: [] }]);
    await module.load();
    const record = module.trackers()[0];
    record.temperature.set(0.33);
    record.newPresetName.set('My Strict JSON');

    await module.savePreset(record, record.newPresetName.peek());

    assert.deepEqual(module.customPresets().map(item => item.name), ['My Strict JSON']);
    assert.equal(module.customPresets()[0].temperature, 0.33);
    assert.equal(record.samplerPreset(), 'custom:my-strict-json', 'сразу выбран, как только сохранён');
    assert.equal(record.newPresetName(), '', 'поле имени очищено');
});

test('saving a preset under a name already in use UPDATES it in place instead of adding a duplicate', async () => {
    const { module, trackingCore } = buildEngine();
    await trackingCore.configureTrackers([{ id: 'status', kind: 'user', fields: [{ name: 'health' }], triggers: [] }]);
    await module.load();
    const record = module.trackers()[0];
    await module.savePreset(record, 'Mine');

    record.temperature.set(1.5);
    await module.savePreset(record, 'Mine');

    assert.equal(module.customPresets().length, 1, 'не появился второй рядом');
    assert.equal(module.customPresets()[0].temperature, 1.5, 'а обновлён тот же самый');
});

test('"Delete preset" removes a custom preset from the shared list and returns the tracker to Custom, without touching its current slider values', async () => {
    const { module, trackingCore } = buildEngine();
    await trackingCore.configureTrackers([{ id: 'status', kind: 'user', fields: [{ name: 'health' }], triggers: [] }]);
    await module.load();
    const record = module.trackers()[0];
    await module.savePreset(record, 'Temporary');
    const keptTemperature = record.temperature();

    await module.deletePreset(record);

    assert.deepEqual(module.customPresets(), []);
    assert.equal(record.samplerPreset(), '', 'выбор вернулся к Custom');
    assert.equal(record.temperature(), keptTemperature, 'значения на самом трекере не тронуты');
});

test('a preset saved from ONE tracker reaches a SECOND tracker\'s dropdown through model.presets.changed — the list is shared, not per-tracker', async () => {
    const { module, trackingCore } = buildEngine();
    await trackingCore.configureTrackers([
        { id: 'status', kind: 'user', fields: [{ name: 'health' }], triggers: [] },
        { id: 'mood', kind: 'user', fields: [{ name: 'health' }], triggers: [] },
    ]);
    await module.load();
    const [status, mood] = module.trackers();

    await module.savePreset(status, 'Shared Preset');

    assert.deepEqual(module.customPresets().map(item => item.name), ['Shared Preset'], 'виден и трекеру mood — список один на весь Модуль');
    module.applySamplerPreset(mood, 'custom:shared-preset');
    assert.equal(mood.samplerPreset(), 'custom:shared-preset');
});

test('a connection added or removed in the worker panel reaches the tracker\'s "Model connection" dropdown through model.workers.changed — no page reload needed', async () => {
    const { engine, module, setWorkers } = buildEngine();
    await module.load();
    assert.deepEqual(module.workers(), [{ value: 'main', label: 'main' }, { value: 'backup', label: 'backup' }]);

    setWorkers([{ id: 'main' }, { id: 'new-connection' }]);
    engine.events.emit('model.workers.changed', { count: 2 });
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.deepEqual(module.workers(), [{ value: 'main', label: 'main' }, { value: 'new-connection', label: 'new-connection' }]);
});

test('a chosen preset survives a reload — it is remembered per tracker, not lost or forced back to a worker default', async () => {
    const { module: first, moduleHost } = buildEngine();
    await first.load();
    first.addTracker();
    const record = first.trackers()[0];
    record.id.set('status');
    first.applySamplerPreset(record, 'precise');
    await first.save();

    // Второй экземпляр Модуля на том же хосте — как перезагрузка страницы:
    // своей памяти между ними нет, всё восстанавливается через шину.
    const second = createTrackerModule(moduleHost);
    await second.load();
    const reloaded = second.trackers()[0];

    assert.equal(reloaded.samplerPreset.peek(), 'precise', 'подпись пресета пережила перезагрузку');
    assert.equal(reloaded.temperature.peek(), 0.2, 'а не значения по умолчанию движка');
});

test('"Poll now" on an unnamed tracker says so instead of asking the model for nothing', async () => {
    const { module, generations, notifications } = buildEngine();
    await module.load();
    module.addTracker();
    const record = module.trackers()[0];
    record.id.set('   ');

    await module.pollNow(record);

    assert.deepEqual(generations, []);
    assert.equal(record.flash(), 'error');
    assert.match(notifications.items().at(-1).text, /name/i);
    assert.equal(notifications.items().at(-1).tone, 'error');
});

test('"Reset" clears the tracked values back to their defaults without touching the configuration', async () => {
    const { module, trackingCore } = buildEngine();
    await trackingCore.configureTrackers([
        { id: 'status', kind: 'user', workerId: 'main', fields: [{ name: 'health', default: 100 }], triggers: [] },
    ]);
    await module.load();
    const record = module.trackers()[0];
    await module.pollNow(record);
    assert.equal(record.values()[0].value, 42);

    await module.resetTracker(record);

    assert.equal(record.values()[0].value, 100);
    assert.deepEqual(trackingCore.trackers()[0].fields.map(field => field.name), ['health'], 'config untouched');
});

test('adding a field normalises its name, so "Current Mood" cannot become a JSON key nobody can address', async () => {
    const { module } = buildEngine();
    await module.load();
    module.addTracker();
    const record = module.trackers()[0];
    record.newFieldName.set('Current Mood');
    record.newFieldPrompt.set('how they feel');

    module.addField(record);

    assert.deepEqual(record.fields().map(field => field.name), ['current_mood']);
    assert.equal(record.prompts.get('current_mood').peek(), 'how they feel');
});

test('adding a field that already exists is refused instead of silently producing a duplicate JSON key', async () => {
    const { module, notifications } = buildEngine();
    await module.load();
    module.addTracker();
    const record = module.trackers()[0];
    record.newFieldName.set('health');
    module.addField(record);
    record.newFieldName.set('health');

    module.addField(record);

    assert.equal(record.fields().length, 1);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(notifications.items().at(-1).text, /already exists/);
});

test('removing a field drops its prompt too — a stale prompt for a field nobody tracks would just be re-saved forever', async () => {
    const { module } = buildEngine();
    await module.load();
    module.addTracker();
    const record = module.trackers()[0];
    record.newFieldName.set('health');
    module.addField(record);

    module.removeField(record, 'health');

    assert.deepEqual(record.fields(), []);
    assert.equal(record.prompts.has('health'), false);
});

test('display templates are the MODULE\'s own setting, stored in its own namespace — not mixed into the Ядро\'s config', async () => {
    const { trackingCore, module, settingsContext } = buildEngine();
    await trackingCore.configureTrackers([{ id: 'status', kind: 'user', fields: [{ name: 'health' }], triggers: [] }]);
    await module.load();
    module.trackers()[0].displayTemplate.set('❤ {health}');

    await module.save();

    assert.deepEqual(settingsContext.extensionSettings.stme_settings[MODULE_ID].display, { status: '❤ {health}' });
    assert.equal('displayTemplate' in trackingCore.trackers()[0], false, 'presentation must not leak into the tracking config');
});

test('a display template survives a reload of the module — it is read back from the module\'s own settings', async () => {
    const { trackingCore, module, settingsContext } = buildEngine();
    await trackingCore.configureTrackers([{ id: 'status', kind: 'user', fields: [{ name: 'health' }], triggers: [] }]);
    await module.load();
    module.trackers()[0].displayTemplate.set('❤ {health}');
    await module.save();

    await module.load();

    assert.equal(module.trackers()[0].displayTemplate.peek(), '❤ {health}');
});

test('the module cannot reach a contract it was not granted — being a Module means going through the Gate like anyone else', async () => {
    const { module, trackingCore } = buildEngine({ rights: { tier: 'community', allowedContracts: ['tracking.trackers'] } });
    await trackingCore.configureTrackers([{ id: 'status', kind: 'user', fields: [], triggers: [] }]);
    await module.load();
    module.trackers()[0].id.set('renamed');

    await module.save();

    assert.equal(module.saveState().ok, false);
    assert.match(module.saveState().error.message, /Access denied/);
    assert.deepEqual(trackingCore.trackers().map(tracker => tracker.id), ['status'], 'the Ядро must be untouched');
});

test('the module builds a tree without touching the DOM — it is data, like every other UI in the engine', async () => {
    const { trackingCore, module } = buildEngine();
    await trackingCore.configureTrackers([{ id: 'status', kind: 'user', fields: [{ name: 'health' }], triggers: [] }]);
    await module.load();

    const tree = module.tree();

    assert.equal(typeof tree, 'object');
    assert.ok(textOf(tree) > 0);
});

// --- Моменты прогона: до отправки, во время, после --------------------------

test('the tracker can poll at every real moment of a run, not only after the reply', () => {
    assert.deepEqual(computeTriggers('onUserMessage'), [{ event: 'st.messageSent' }]);
    assert.deepEqual(computeTriggers('onToolCall'), [{ event: 'generation.toolCall' }]);
    assert.deepEqual(computeTriggers('everyReply'), [{ event: 'generation.completed' }]);
});

test('"before the reply, and WAIT" produces no trigger at all — waiting is a pipeline stage, not a subscription', () => {
    assert.deepEqual(computeTriggers('beforeSend', 3, { blocking: true }), []);
});

test('"before the reply, do NOT wait" is an ordinary trigger on the same moment — it starts and nobody waits', () => {
    assert.deepEqual(computeTriggers('beforeSend', 3, { blocking: false }), [{ event: 'generation.beforeSend' }]);
});

test('a registered pipeline stage reads back as "before the reply, waiting" — the pipeline is the source of truth, not our memory', () => {
    assert.deepEqual(resolveTriggerMode([], { hasStage: true }), { mode: 'beforeSend', count: 3, blocking: true });
    assert.deepEqual(resolveTriggerMode([{ event: 'generation.beforeSend' }]), { mode: 'beforeSend', count: 3, blocking: false });
});

test('choosing "hold the generation" registers the tracker in the REFRESH pipeline, never in prompt assembly', async () => {
    const { module, trackingCore, pipelineCore } = buildEngine();
    await trackingCore.configureTrackers([{ id: 'status', kind: 'user', workerId: 'main', fields: [{ name: 'health' }], triggers: [] }]);
    await module.load();
    const record = module.trackers()[0];
    record.triggerMode.set('beforeSend');
    record.blocking.set(true);

    await module.save();

    const stage = pipelineCore.stages('generation.prepare')[0];
    assert.equal(stage.id, 'tracker:status');
    assert.equal(stage.contract, 'tracking.poll');
    assert.equal(stage.owner, MODULE_ID, 'этап исполняется под правами Модуля, а не Ядра пайплайнов');
    assert.deepEqual(pipelineCore.stages('generation.beforeSend'), [], 'трекер не вкладчик в промпт — в сборке промпта его быть не должно');
});

test('the refresh stage really polls, and its product goes to the BUS — the pipeline output is incidental', async () => {
    const { engine, module, trackingCore, pipelineCore, generations } = buildEngine();
    await trackingCore.configureTrackers([{ id: 'status', kind: 'user', workerId: 'main', fields: [{ name: 'health' }], triggers: [] }]);
    await module.load();
    module.trackers()[0].triggerMode.set('beforeSend');
    module.trackers()[0].blocking.set(true);
    await module.save();
    generations.length = 0;

    const published = [];
    engine.events.subscribe('tracking.blocks.changed', payload => published.push(payload.trackerId));

    const run = await pipelineCore.run({ pipelineId: 'generation.prepare' });

    assert.equal(run.ok, true);
    assert.equal(generations.length, 1, 'опрос случился ДО того, как ST начал собирать промпт');
    assert.deepEqual(published, ['status'], 'продукт трекера — публикация на шину, а не возврат в пайплайн');
});

test('a failing tracker stage does NOT cancel the user\'s generation — it is flagged, not fatal', async () => {
    const { module, trackingCore, pipelineCore } = buildEngine();
    await trackingCore.configureTrackers([{ id: 'broken', kind: 'user', workerId: 'nope', fields: [], triggers: [] }]);
    await module.load();
    module.trackers()[0].triggerMode.set('beforeSend');
    module.trackers()[0].blocking.set(true);
    await module.save();

    const stage = pipelineCore.stages('generation.prepare')[0];

    assert.equal(stage.onExhausted, 'flag', 'упавший трекер не повод оставить пользователя без ответа');
});

test('switching a tracker away from "hold the generation" takes its refresh stage back out', async () => {
    const { module, trackingCore, pipelineCore } = buildEngine();
    await trackingCore.configureTrackers([{ id: 'status', kind: 'user', fields: [], triggers: [] }]);
    await module.load();
    module.trackers()[0].triggerMode.set('beforeSend');
    module.trackers()[0].blocking.set(true);
    await module.save();
    assert.equal(pipelineCore.stages('generation.prepare').length, 1);

    module.trackers()[0].triggerMode.set('everyReply');
    await module.save();

    assert.deepEqual(pipelineCore.stages('generation.prepare'), []);
});

// --- Чужие трекеры ----------------------------------------------------------

test('a tracker owned by ANOTHER Module is not in the user\'s list, and not in the floating panel either', async () => {
    const { module, trackingCore } = buildEngine();
    trackingCore.configureTrackers([
        { id: 'mine', kind: 'user', workerId: 'main', triggers: [], fields: [{ name: 'health', prompt: 'HP' }] },
        // Ровно тот случай, что вылез живьём: специализированный трекер Модуля
        // «RP Time» — полноценный `user` (макрос писаться обязан), но правит
        // его свой Модуль, а не человек.
        { id: 'rp-time', kind: 'user', ownerId: 'module.time', workerId: 'main', triggers: [], fields: [{ name: 'time', prompt: 'clock' }] },
        { id: 'engine', kind: 'system', workerId: 'main', triggers: [], fields: [{ name: 'x', prompt: 'x' }] },
    ]);

    await module.load();

    // Список и плавающая панель рисуются из одного и того же набора, поэтому
    // проверка одного покрывает оба.
    assert.deepEqual(module.trackers().map(record => record.id.peek()), ['mine']);
});

test('saving the user\'s trackers does NOT wipe the ones other Modules own — configure replaces the WHOLE set', async () => {
    const { module, trackingCore } = buildEngine();
    trackingCore.configureTrackers([
        { id: 'mine', kind: 'user', workerId: 'main', triggers: [], fields: [{ name: 'health', prompt: 'HP' }] },
        { id: 'rp-time', kind: 'user', ownerId: 'module.time', workerId: 'main', triggers: [], fields: [{ name: 'time', prompt: 'clock' }] },
        { id: 'engine', kind: 'system', workerId: 'main', triggers: [], fields: [{ name: 'x', prompt: 'x' }] },
    ]);
    await module.load();

    await module.save();

    assert.deepEqual(trackingCore.trackers().map(tracker => tracker.id).sort(), ['engine', 'mine', 'rp-time']);
    assert.equal(trackingCore.trackers().find(tracker => tracker.id === 'rp-time').ownerId, 'module.time', 'чужой трекер вернулся в Ядро нетронутым');
});

// --- Плавающая панель: показание, а не строка лога --------------------------

/** Пары «подпись → значение» из плавающей панели. Дерево — данные, DOM для этого не нужен. */
function hudReadings(module) {
    const rows = findAll(module.hud(), node => node.props?.class === 'stme-hud-row');
    const text = node => {
        const child = node.children[0];
        return typeof child === 'function' ? child() : child;
    };
    return rows.map(row => {
        const name = findAll(row, node => node.props?.class === 'stme-hud-name')[0];
        const value = findAll(row, node => String(node.props?.class ?? '').startsWith('stme-hud-value'))[0];
        return [text(name), text(value)];
    });
}

test('each tracked FIELD is its own reading in the floating panel — one run-on line is not something you read at a glance', async () => {
    const { trackingCore, module } = buildEngine();
    await trackingCore.configureTrackers([
        { id: 'hero', kind: 'user', workerId: 'main', triggers: [], fields: [
            { name: 'health', prompt: 'HP', default: '87 / 100' },
            { name: 'location', prompt: 'where', default: 'Tavern doorway' },
        ] },
    ]);
    await module.load();

    assert.deepEqual(hudReadings(module), [['health', '87 / 100'], ['location', 'Tavern doorway']]);
});

test('a tracker WITH a display template keeps its own one-line form — the user said how it should look', async () => {
    const { trackingCore, module } = buildEngine();
    await trackingCore.configureTrackers([
        { id: 'hero', kind: 'user', workerId: 'main', triggers: [], fields: [
            { name: 'health', prompt: 'HP', default: 87 },
            { name: 'location', prompt: 'where', default: 'Tavern' },
        ] },
    ]);
    await module.load();
    module.trackers()[0].displayTemplate.set('❤ {health} · 📍 {location}');

    assert.deepEqual(hudReadings(module), [['hero', '❤ 87 · 📍 Tavern']]);
});

test('with SEVERAL trackers each gets a heading, so two "health" readings are not mistaken for one another', async () => {
    const { trackingCore, module } = buildEngine();
    await trackingCore.configureTrackers([
        { id: 'hero', kind: 'user', workerId: 'main', triggers: [], fields: [{ name: 'health', prompt: '', default: 87 }] },
        { id: 'rival', kind: 'user', workerId: 'main', triggers: [], fields: [{ name: 'health', prompt: '', default: 12 }] },
    ]);
    await module.load();

    const groups = findAll(module.hud(), node => node.props?.class === 'stme-hud-group')
        .map(node => (typeof node.children[0] === 'function' ? node.children[0]() : node.children[0]));
    assert.deepEqual(groups, ['hero', 'rival']);
});

test('a SINGLE tracker gets no heading — it would only repeat the window\'s own title', async () => {
    const { trackingCore, module } = buildEngine();
    await trackingCore.configureTrackers([
        { id: 'hero', kind: 'user', workerId: 'main', triggers: [], fields: [{ name: 'health', prompt: '', default: 87 }] },
    ]);
    await module.load();

    assert.deepEqual(findAll(module.hud(), node => node.props?.class === 'stme-hud-group'), []);
});
