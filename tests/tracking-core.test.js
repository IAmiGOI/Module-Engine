import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { request } from '../libraries/shared/request.js';
import { registerHttpService } from '../services/http.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { createInternalEngineModelsCore } from '../cores/models/internal-engine.js';
import { createSettingsCore } from '../cores/settings/index.js';
import { registerStChatService } from '../services/st-chat.js';
import { registerChatMetadataService } from '../services/chat-metadata.js';
import { createChatMemoryCore } from '../cores/memory/index.js';
import { createTrackingCore, buildTrackerPrompt, buildTrackerSystemPrompt } from '../cores/tracking/index.js';

// --- Unit level: prompt-building, independent of any Ядро/Сервис ----------

test('buildTrackerPrompt() lists every field\'s name, prompt, and current value', () => {
    const tracker = { id: 't1' };
    const fields = [{ name: 'health', prompt: 'Current health 0-100', value: 80 }, { name: 'mood', prompt: 'Current mood', value: 'calm' }];

    const prompt = buildTrackerPrompt(tracker, fields);

    assert.match(prompt, /health: Current health 0-100 \(current: 80\)/);
    assert.match(prompt, /mood: Current mood \(current: "calm"\)/);
});

test('buildTrackerPrompt() uses a tracker\'s own promptTemplate when given, via the {fields} placeholder', () => {
    const tracker = { id: 't1', promptTemplate: 'CUSTOM: {fields}' };

    const prompt = buildTrackerPrompt(tracker, [{ name: 'x', prompt: 'p', value: 1 }]);

    assert.match(prompt, /^CUSTOM: - x: p \(current: 1\)$/);
});

test('buildTrackerSystemPrompt() is empty when the tracker has no systemPromptTemplate — a plain, hand-configured user tracker gets no system message at all', () => {
    const tracker = { id: 't1', promptTemplate: 'CUSTOM: {fields}' };

    assert.equal(buildTrackerSystemPrompt(tracker, [{ name: 'x', prompt: 'p', value: 1 }]), '');
});

test('buildTrackerSystemPrompt() fills the SAME substitutions as the user prompt, just into a separate template — the two see one consistent set of fields/context/vars', () => {
    const tracker = { id: 't1', systemPromptTemplate: 'Track: {fieldsJson}. Timeline: {timeline}.' };

    const prompt = buildTrackerSystemPrompt(tracker, [{ name: 'x', prompt: 'p', value: 1 }], [], { timeline: '"a" → "b"' });

    assert.equal(prompt, 'Track: "x". Timeline: "a" → "b".');
});

// --- Scenario level (TESTING.md "Уровень 2") -------------------------------

function fakeFetchReplying(reply) {
    const calls = [];
    return {
        calls,
        fetch: async (url, init) => {
            calls.push({ url, ...init });
            return { status: 200, ok: true, headers: { entries: () => [] }, text: async () => JSON.stringify({ choices: [{ message: { content: reply } }] }) };
        },
    };
}

function buildEngine({ fetchReply = '{"health": 90}' } = {}) {
    const engine = createEngine();
    const { fetch, calls } = fakeFetchReplying(fetchReply);
    registerHttpService(engine.buses.network, { fetch });
    // configureWorkers()/configureTrackers() now really persist via
    // storage.settings — a Settings Core must be wired for them to have
    // anywhere to write to, same as a real engine (harness/engine-wiring.js).
    const settingsContext = { extensionSettings: {}, saveSettingsDebounced: () => {} };
    registerExtensionSettingsService(engine.buses.services, { getContext: () => settingsContext });
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));
    const modelsHost = engine.registerCaller('core.models.internal', 'cores', { tier: 'official', networkAccess: true });
    const modelsCore = createInternalEngineModelsCore(modelsHost);
    modelsCore.configureWorkers([
        { id: 'fast', endpoint: 'https://fast.example.com', model: 'm1', format: 'openai' },
        { id: 'slow', endpoint: 'https://slow.example.com', model: 'm2', format: 'openai' },
    ]);
    const registeredMacros = [];
    const trackingHost = engine.registerCaller('core.tracking', 'cores', { tier: 'official' });
    const trackingCore = createTrackingCore(trackingHost, { onUserFieldRegistered: entry => registeredMacros.push(entry) });
    return { engine, calls, trackingCore, registeredMacros };
}

test('tracking.poll dispatches to the tracker\'s OWN pinned worker, parses the JSON reply, and updates fields', async () => {
    const { engine, calls, trackingCore } = buildEngine();
    trackingCore.configureTrackers([{ id: 'char', kind: 'user', workerId: 'slow', fields: [{ name: 'health', prompt: 'HP', default: 100 }] }]);
    const module = engine.registerCaller('module.ui', 'modules', { tier: 'official' });

    const result = await new Promise(resolve => module.cores.subscribe('tracking.poll', { params: { trackerId: 'char' } }, resolve));

    assert.equal(result.ok, true);
    assert.deepEqual(result.value, [{ name: 'health', prompt: 'HP', default: 100, value: 90 }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://slow.example.com/chat/completions', 'must land on the pinned worker, not the other configured one');
});

test('a tracker with a systemPromptTemplate really sends TWO messages to the model — system with the instruction, user with the rest', async () => {
    const { engine, calls, trackingCore } = buildEngine();
    trackingCore.configureTrackers([{
        id: 'char', kind: 'user', workerId: 'fast',
        systemPromptTemplate: 'Track fields: {fieldsJson}.',
        promptTemplate: 'History goes here.',
        fields: [{ name: 'health', prompt: 'HP', default: 100 }],
    }]);
    const module = engine.registerCaller('module.ui', 'modules', { tier: 'official' });

    await new Promise(resolve => module.cores.subscribe('tracking.poll', { params: { trackerId: 'char' } }, resolve));

    const body = JSON.parse(calls[0].body);
    assert.deepEqual(body.messages, [
        { role: 'system', content: 'Track fields: "health".' },
        { role: 'user', content: 'History goes here.' },
    ]);
});

test('a plain tracker with no systemPromptTemplate still sends just ONE message, exactly as before — nothing changes for the generic hand-configured tracker', async () => {
    const { engine, calls, trackingCore } = buildEngine();
    trackingCore.configureTrackers([{ id: 'char', kind: 'user', workerId: 'fast', fields: [{ name: 'health', prompt: 'HP', default: 100 }] }]);
    const module = engine.registerCaller('module.ui', 'modules', { tier: 'official' });

    await new Promise(resolve => module.cores.subscribe('tracking.poll', { params: { trackerId: 'char' } }, resolve));

    const body = JSON.parse(calls[0].body);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].role, 'user');
});

test('a tracker\'s OWN sampler/reasoning settings reach the provider — chosen per tracker, not tied to the worker it happens to run on', async () => {
    const { engine, calls, trackingCore } = buildEngine();
    trackingCore.configureTrackers([{
        id: 'char', kind: 'user', workerId: 'fast',
        temperature: 0.1, topP: 0.8, topK: 5, maxTokens: 200,
        fields: [{ name: 'health', prompt: 'HP', default: 100 }],
    }]);
    const module = engine.registerCaller('module.ui', 'modules', { tier: 'official' });

    await new Promise(resolve => module.cores.subscribe('tracking.poll', { params: { trackerId: 'char' } }, resolve));

    const body = JSON.parse(calls[0].body);
    assert.equal(body.temperature, 0.1);
    assert.equal(body.top_p, 0.8);
    assert.equal(body.top_k, 5);
    assert.equal(body.max_tokens, 200);
});

test('two trackers pinned to the SAME worker keep their OWN, different sampler settings — one is not bleeding into the other', async () => {
    const { engine, calls, trackingCore } = buildEngine();
    trackingCore.configureTrackers([
        { id: 'precise-one', kind: 'user', workerId: 'fast', temperature: 0.1, fields: [{ name: 'a', prompt: '', default: 1 }] },
        { id: 'creative-one', kind: 'user', workerId: 'fast', temperature: 1.2, fields: [{ name: 'a', prompt: '', default: 1 }] },
    ]);
    const module = engine.registerCaller('module.ui', 'modules', { tier: 'official' });
    const poll = trackerId => new Promise(resolve => module.cores.subscribe('tracking.poll', { params: { trackerId } }, resolve));

    await poll('precise-one');
    await poll('creative-one');

    assert.equal(JSON.parse(calls[0].body).temperature, 0.1);
    assert.equal(JSON.parse(calls[1].body).temperature, 1.2);
});

test('a tracker with NO sampler settings of its own falls back to the engine\'s defaults — nothing is forced on a tracker that never asked for a preset', async () => {
    const { engine, calls, trackingCore } = buildEngine();
    trackingCore.configureTrackers([{ id: 'char', kind: 'user', workerId: 'fast', fields: [{ name: 'health', prompt: '', default: 100 }] }]);
    const module = engine.registerCaller('module.ui', 'modules', { tier: 'official' });

    await new Promise(resolve => module.cores.subscribe('tracking.poll', { params: { trackerId: 'char' } }, resolve));

    assert.equal(JSON.parse(calls[0].body).temperature, 0.7, 'обычный движковый дефолт, а не что-то навязанное трекеру');
});

test('a tracker\'s configured trigger event automatically polls it — no manual tracking.poll call needed', async () => {
    const { engine, calls, trackingCore } = buildEngine();
    trackingCore.configureTrackers([{ id: 'char', kind: 'user', workerId: 'fast', triggers: ['generation.completed'], fields: [{ name: 'health', prompt: 'HP', default: 100 }] }]);
    const module = engine.registerCaller('module.ui', 'modules', { tier: 'official' });

    engine.events.emit('generation.completed');

    const read = () => new Promise(resolve => module.cores.subscribe('tracking.value', { params: { trackerId: 'char', fieldName: 'health' } }, resolve));
    await until(async () => (await read()).value === 90);
    assert.equal(calls.length, 1, 'the configured trigger event must have fired a real poll');
});

test('a tracker can have MULTIPLE simultaneous triggers — either one fires a poll', async () => {
    const { engine, calls, trackingCore } = buildEngine();
    trackingCore.configureTrackers([{ id: 'char', kind: 'user', workerId: 'fast', triggers: ['generation.beforeSend', 'generation.completed'], fields: [{ name: 'health', prompt: 'HP', default: 100 }] }]);

    engine.events.emit('generation.beforeSend');
    await flushMicrotasks();
    assert.equal(calls.length, 1);

    engine.events.emit('generation.completed');
    await flushMicrotasks();
    assert.equal(calls.length, 2, 'the SECOND, different configured trigger must also fire its own poll');
});

test('tracking.set writes a value directly (no model call) and publishes tracking.blocks.changed for a USER tracker', async () => {
    const { engine, calls, trackingCore } = buildEngine();
    trackingCore.configureTrackers([{ id: 'char', kind: 'user', workerId: 'fast', fields: [{ name: 'health', prompt: 'HP', default: 100 }] }]);
    const module = engine.registerCaller('module.ui', 'modules', { tier: 'official' });
    const events = [];
    engine.events.subscribe('tracking.blocks.changed', payload => events.push(payload));

    const result = await new Promise(resolve => module.cores.subscribe('tracking.set', { params: { trackerId: 'char', fieldName: 'health', value: 50 } }, resolve));

    assert.deepEqual(result, { ok: true, value: true });
    assert.equal(calls.length, 0, 'a manual set() must never trigger a model call');
    assert.deepEqual(events, [{ trackerId: 'char' }]);
});

test('a SYSTEM tracker\'s update publishes to tracking.systemBlocks.changed, never tracking.blocks.changed — kept structurally separate', async () => {
    const { engine, trackingCore } = buildEngine();
    trackingCore.configureTrackers([{ id: 'engineStats', kind: 'system', workerId: 'fast', fields: [{ name: 'turns', prompt: '', default: 0 }] }]);
    const module = engine.registerCaller('module.ui', 'modules', { tier: 'official' });
    const userEvents = [];
    const systemEvents = [];
    engine.events.subscribe('tracking.blocks.changed', p => userEvents.push(p));
    engine.events.subscribe('tracking.systemBlocks.changed', p => systemEvents.push(p));

    await new Promise(resolve => module.cores.subscribe('tracking.set', { params: { trackerId: 'engineStats', fieldName: 'turns', value: 5 } }, resolve));

    assert.deepEqual(systemEvents, [{ trackerId: 'engineStats' }]);
    assert.deepEqual(userEvents, [], 'a system tracker update must never appear on the user trackers\' event stream');
});

test('a USER tracker field update calls the macro-registration hook; a SYSTEM tracker never does', async () => {
    const { engine, trackingCore, registeredMacros } = buildEngine();
    trackingCore.configureTrackers([
        { id: 'char', kind: 'user', workerId: 'fast', fields: [{ name: 'health', prompt: '', default: 100 }] },
        { id: 'engineStats', kind: 'system', workerId: 'fast', fields: [{ name: 'turns', prompt: '', default: 0 }] },
    ]);
    const module = engine.registerCaller('module.ui', 'modules', { tier: 'official' });

    await new Promise(resolve => module.cores.subscribe('tracking.set', { params: { trackerId: 'char', fieldName: 'health', value: 50 } }, resolve));
    await new Promise(resolve => module.cores.subscribe('tracking.set', { params: { trackerId: 'engineStats', fieldName: 'turns', value: 1 } }, resolve));

    assert.deepEqual(registeredMacros, [{ trackerId: 'char', fieldName: 'health', value: 50 }]);
});

test('tracking.value/set/fields/poll against an unrecognized trackerId fail through the normal error envelope', async () => {
    const { engine } = buildEngine();
    const module = engine.registerCaller('module.ui', 'modules', { tier: 'official' });

    const result = await new Promise(resolve => module.cores.subscribe('tracking.value', { params: { trackerId: 'ghost', fieldName: 'x' } }, resolve));

    assert.equal(result.ok, false);
    assert.match(result.error.message, /unknown tracker/);
});

test('tracking.set against an unconfigured field name on a real tracker is refused, not silently accepted', async () => {
    const { engine, trackingCore } = buildEngine();
    trackingCore.configureTrackers([{ id: 'char', kind: 'user', workerId: 'fast', fields: [{ name: 'health', prompt: '', default: 100 }] }]);
    const module = engine.registerCaller('module.ui', 'modules', { tier: 'official' });

    const result = await new Promise(resolve => module.cores.subscribe('tracking.set', { params: { trackerId: 'char', fieldName: 'notAField', value: 1 } }, resolve));

    assert.equal(result.ok, false);
    assert.match(result.error.message, /no field/);
});

test('re-configureTrackers() tears down the OLD triggers — a stale trigger must never keep firing after reconfiguration', async () => {
    const { engine, calls, trackingCore } = buildEngine();
    trackingCore.configureTrackers([{ id: 'char', kind: 'user', workerId: 'fast', triggers: ['generation.completed'], fields: [{ name: 'health', prompt: '', default: 100 }] }]);

    trackingCore.configureTrackers([]); // reconfigured to nothing
    engine.events.emit('generation.completed');
    await flushMicrotasks();

    assert.equal(calls.length, 0, 'the old tracker\'s trigger subscription must have been torn down, not left dangling');
});

test('a Module without the right to tracking.poll is refused before the Ядро — and any model call — is ever reached', async () => {
    const { engine, calls, trackingCore } = buildEngine();
    trackingCore.configureTrackers([{ id: 'char', kind: 'user', workerId: 'fast', fields: [{ name: 'health', prompt: '', default: 100 }] }]);
    const module = engine.registerCaller('module.untrusted', 'modules', { tier: 'community', allowedContracts: [] });

    const result = await new Promise(resolve => module.cores.subscribe('tracking.poll', { params: { trackerId: 'char' } }, resolve));

    assert.equal(result.ok, false);
    assert.equal(calls.length, 0);
});

test('a trigger can carry the Директор\'s own delivery modifiers — "every 2nd turn" needs ZERO code in Ядро трекинга', async () => {
    const { engine, calls, trackingCore } = buildEngine();
    await trackingCore.configureTrackers([{
        id: 'char', kind: 'user', workerId: 'fast',
        triggers: [{ event: 'st.messageReceived', every: 2 }],
        fields: [{ name: 'health', prompt: 'HP', default: 100 }],
    }]);

    engine.events.emit('st.messageReceived');
    await flushMicrotasks();
    assert.equal(calls.length, 0, 'the first turn must not poll — the tracker asked for every SECOND one');

    engine.events.emit('st.messageReceived');
    await flushMicrotasks();
    assert.equal(calls.length, 1);
});

test('tracker config really persists via storage.settings — restoreTrackers() on a FRESH Ядро instance recovers what a previous one configured, simulating a reload', async () => {
    const { engine } = buildEngine();
    const firstInstance = createTrackingCore(engine.registerCaller('core.tracking.first', 'cores', { tier: 'official' }));
    const trackerConfig = [{ id: 'char', kind: 'user', workerId: 'fast', fields: [{ name: 'health', prompt: 'HP', default: 100 }] }];
    await firstInstance.configureTrackers(trackerConfig);

    // A brand new Ядро instance — nothing hands it the config directly; it
    // only shares the SAME underlying storage.settings.
    const secondInstance = createTrackingCore(engine.registerCaller('core.tracking.second', 'cores', { tier: 'official' }));
    const restored = await secondInstance.restoreTrackers();

    assert.deepEqual(restored, trackerConfig);
});

async function flushMicrotasks(rounds = 10) {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/**
 * Ждёт УСЛОВИЯ, а не фиксированного числа тиков. Счёт тиков ломается от любой
 * новой асинхронной ступени внутри проверяемого кода — так и вышло, когда
 * опрос стал сперва запрашивать контекст чата: сам запрос к модели уходил, а
 * присвоение значения отставало на один круг.
 */
async function until(condition, { tries = 50 } = {}) {
    for (let i = 0; i < tries; i++) {
        if (await condition()) return true;
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    throw new Error("until(): condition never became true");
}

// --- Контекст переписки -----------------------------------------------------
//
// Дыра, которую эти тесты закрывают: шаблон по умолчанию ГОВОРИЛ «based on the
// current context», но самого контекста в него не подставлялось ничего. Модель
// просили обновить поля по переписке, которой она не видела.

test('the default prompt actually CARRIES the conversation — it used to promise context and send none', () => {
    const prompt = buildTrackerPrompt(
        { id: 'status' },
        [{ name: 'health', prompt: 'HP left', value: 100 }],
        [
            { isUser: true, text: 'I take a swing at the bandit and catch a blade on my arm.' },
            { isUser: false, text: 'The blade bites deep. You stagger back, bleeding.' },
        ],
    );

    assert.match(prompt, /catch a blade on my arm/);
    assert.match(prompt, /You stagger back, bleeding/);
    assert.match(prompt, /- health: HP left/);
});

test('speakers are labelled, so the model can tell who did what', () => {
    const prompt = buildTrackerPrompt({}, [], [{ isUser: true, text: 'I run' }, { isUser: false, text: 'It follows' }]);

    assert.match(prompt, /Player: I run/);
    assert.match(prompt, /Character: It follows/);
});

test('an empty chat says so plainly instead of leaving a bare "Recent conversation:" heading', () => {
    assert.match(buildTrackerPrompt({}, [{ name: 'health', value: 1 }], []), /\(no messages yet\)/);
});

test('a very long message is truncated — one wall of text must not crowd out the rest of the conversation', () => {
    const prompt = buildTrackerPrompt({}, [], [{ isUser: true, text: 'x'.repeat(5000) }]);

    assert.ok(prompt.length < 2000, `context should be trimmed, got ${prompt.length} chars`);
});

test('a custom template can place the conversation where its author wants it', () => {
    const prompt = buildTrackerPrompt(
        { promptTemplate: 'FIELDS {fieldsJson}\nNOW {current}\nSCENE {context}' },
        [{ name: 'health', value: 90 }],
        [{ isUser: true, text: 'hello' }],
    );

    assert.equal(prompt, 'FIELDS "health"\nNOW {"health":90}\nSCENE Player: hello');
});

test('a real poll reads the chat over the bus and sends it to the model', async () => {
    const { engine, calls, trackingCore } = buildEngine();
    registerStChatService(engine.buses.services, {
        getContext: () => ({ chat: [
            { is_user: true, is_system: false, mes: 'I drink the potion.' },
            { is_user: false, is_system: false, mes: 'Warmth spreads through you.' },
            { is_user: false, is_system: true, mes: 'System: chat renamed' },
        ] }),
    });
    trackingCore.configureTrackers([{ id: 'char', kind: 'user', workerId: 'fast', triggers: [], fields: [{ name: 'health', default: 100 }] }]);

    await trackingCore.reset('char');
    await request(engine.buses.cores, 'tracking.poll', { params: { trackerId: 'char' } });

    const sent = JSON.parse(calls.at(-1).body).messages.at(-1).content;
    assert.match(sent, /I drink the potion/);
    assert.match(sent, /Warmth spreads through you/);
    assert.doesNotMatch(sent, /chat renamed/, 'системные строки в контекст не идут — это шум');
});

test('ownership of a tracker cannot be taken away by whoever rewrites the set next', async () => {
    const { trackingCore } = buildEngine();
    await trackingCore.configureTrackers([{ id: 'rp-time', kind: 'user', ownerId: 'module.time', fields: [] }]);

    // Так выглядит сохранение из Модуля трекеров: чужое перечитано и отдано
    // обратно ЕГО собственной формой, которая про `ownerId` ничего не знает.
    await trackingCore.configureTrackers([{ id: 'rp-time', kind: 'user', fields: [] }]);

    assert.equal(trackingCore.trackers()[0].ownerId, 'module.time', 'иначе трекер Модуля становится обычным пользовательским');
});

test('every rewrite of the set is announced — a list drawn elsewhere must not depend on module load order', async () => {
    const { engine, trackingCore } = buildEngine();
    const seen = [];
    engine.events.subscribe('tracking.trackersChanged', payload => seen.push(payload));

    await trackingCore.configureTrackers([{ id: 'char', kind: 'user', fields: [] }]);

    assert.equal(seen.length, 1);
    assert.equal(seen[0].count, 1);
});

// --- Значения трекера — привязаны к ЧАТУ, не к движку целиком --------------
//
// Раньше `values` жили голым Map в памяти процесса: ни персистентности, ни
// привязки к чату. Переключение чата в ST не перезагружает страницу (SPA) —
// трекер продолжал невозмутимо показывать значения ПРЕДЫДУЩЕГО разговора.
// Эти тесты поднимают настоящее Ядро памяти чата (`storage.chatMemory`) —
// то же самое, которым уже пользуется шкала «RP Time» — и настоящий Сервис
// chatMetadata, а не голый Map теста.

function buildEngineWithChatMemory({ fetchReply = '{"health": 90}' } = {}) {
    const engine = createEngine();
    const { fetch, calls } = fakeFetchReplying(fetchReply);
    registerHttpService(engine.buses.network, { fetch });
    const settingsContext = { extensionSettings: {}, chatMetadata: {}, saveSettingsDebounced: () => {}, saveMetadataDebounced: () => {} };
    registerExtensionSettingsService(engine.buses.services, { getContext: () => settingsContext });
    registerChatMetadataService(engine.buses.services, { getContext: () => settingsContext });
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));
    createChatMemoryCore(engine.registerCaller('core.memory.chat', 'cores', { tier: 'official' }));
    const modelsHost = engine.registerCaller('core.models.internal', 'cores', { tier: 'official', networkAccess: true });
    const modelsCore = createInternalEngineModelsCore(modelsHost);
    modelsCore.configureWorkers([{ id: 'fast', endpoint: 'https://fast.example.com', model: 'm1', format: 'openai' }]);
    const trackingCore = createTrackingCore(engine.registerCaller('core.tracking', 'cores', { tier: 'official' }));
    return { engine, calls, trackingCore, settingsContext };
}

test('a tracked value is written to storage.chatMemory, not to settings — proof it is per-chat state, not engine-wide config', async () => {
    const { engine, trackingCore } = buildEngineWithChatMemory();
    await trackingCore.configureTrackers([{ id: 'char', kind: 'user', workerId: 'fast', fields: [{ name: 'health', default: 100 }] }]);

    await request(engine.buses.cores, 'tracking.poll', { params: { trackerId: 'char' } });

    const probe = engine.registerCaller('probe', 'cores', { tier: 'official' });
    const stored = await new Promise(resolve => probe.own.subscribe('storage.chatMemory.get', { params: { namespace: 'core.tracking', key: 'values', fallback: {} } }, resolve));
    assert.equal(stored.value['char:health'], 90, 'настоящее значение лежит в памяти ЧАТА');
});

test('switching to a DIFFERENT chat shows that chat\'s OWN values, not the previous chat\'s — the bug the user actually hit', async () => {
    const { engine, trackingCore, settingsContext } = buildEngineWithChatMemory();
    await trackingCore.configureTrackers([{ id: 'char', kind: 'user', workerId: 'fast', fields: [{ name: 'health', default: 100 }] }]);
    await request(engine.buses.cores, 'tracking.poll', { params: { trackerId: 'char' } }); // health -> 90 в чате А

    // Другой чат — другая chatMetadata, ровно как отдаёт настоящий ST при
    // переключении (SPA, страница не перезагружается).
    settingsContext.chatMetadata = {};
    engine.events.emit('st.chatChanged');
    await new Promise(resolve => setTimeout(resolve, 0)); // подписка в Ядре — fire-and-forget, см. её же doc-comment

    const result = await request(engine.buses.cores, 'tracking.fields', { params: { trackerId: 'char' } });
    assert.equal(result.value.find(field => field.name === 'health').value, 100, 'в НОВОМ чате трекер ещё ничего не насчитал — дефолт, а не 90 из старого чата');
});

test('switching BACK to a chat with its own saved metadata restores that chat\'s values — nothing bleeds between chats in either direction', async () => {
    const { engine, trackingCore, settingsContext } = buildEngineWithChatMemory();
    await trackingCore.configureTrackers([{ id: 'char', kind: 'user', workerId: 'fast', fields: [{ name: 'health', default: 100 }] }]);
    const chatA = settingsContext.chatMetadata;
    await request(engine.buses.cores, 'tracking.poll', { params: { trackerId: 'char' } }); // chatA: health -> 90

    settingsContext.chatMetadata = {}; // chat B, свежий
    engine.events.emit('st.chatChanged');
    await new Promise(resolve => setTimeout(resolve, 0));

    settingsContext.chatMetadata = chatA; // обратно в chat A
    engine.events.emit('st.chatChanged');
    await new Promise(resolve => setTimeout(resolve, 0));

    const result = await request(engine.buses.cores, 'tracking.fields', { params: { trackerId: 'char' } });
    assert.equal(result.value.find(field => field.name === 'health').value, 90, 'chat A помнит свои 90, они никуда не делись');
});

test('a chat switch announces tracking.blocks.changed for every tracker, so the floating panel and the footer redraw without a manual reload', async () => {
    const { engine, trackingCore, settingsContext } = buildEngineWithChatMemory();
    await trackingCore.configureTrackers([{ id: 'char', kind: 'user', fields: [{ name: 'health', default: 100 }] }]);
    const seen = [];
    engine.events.subscribe('tracking.blocks.changed', payload => seen.push(payload));

    settingsContext.chatMetadata = {};
    engine.events.emit('st.chatChanged');
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.deepEqual(seen, [{ trackerId: 'char' }]);
});
