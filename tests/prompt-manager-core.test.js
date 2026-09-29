import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEngine } from '../libraries/shared/engine.js';
import { request } from '../libraries/shared/request.js';
import { registerStEventsService } from '../services/st-events.js';
import { registerStGenerationService } from '../services/st-generation.js';
import { registerChatMetadataService } from '../services/chat-metadata.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { registerPmPresetsService } from '../services/pm-presets.js';
import { registerStPromptDataService } from '../services/st-prompt-data.js';
import { createEventsCore } from '../cores/events/index.js';
import { createGenerationCore, INTERCEPTOR_NAME } from '../cores/generation/index.js';
import { createPipelineCore } from '../cores/pipeline/index.js';
import { createSettingsCore } from '../cores/settings/index.js';
import { createChatMemoryCore } from '../cores/memory/index.js';
import { createPromptManagerCore } from '../cores/prompt-manager/index.js';

/** Сценарный уровень: настоящий движок, поддельны только ST и хранилище indexedDB. */
const amigoJson = readFileSync(new URL('./fixtures/pm-amigo-polished.st.json', import.meta.url), 'utf8');

function memoryStore() {
    const tables = { presets: new Map(), versions: new Map() };
    const keyOf = (name, record) => (name === 'presets' ? record.id : record.key);
    return {
        all: async name => [...tables[name].values()],
        get: async (name, key) => tables[name].get(String(key)),
        put: async (name, record) => { tables[name].set(String(keyOf(name, record)), record); },
        delete: async (name, key) => { tables[name].delete(String(key)); },
    };
}

async function build({ mainApi = 'openai', groupId = null } = {}) {
    const engine = createEngine();
    const chat = [{ is_user: false, name: 'Lena', mes: 'Greetings.' }, { is_user: true, name: 'Sasha', mes: 'Tell me about the dragon.' }];
    const backendCalls = [];
    const target = { fetch: async (url, init) => { backendCalls.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }); } };
    const context = {
        eventTypes: {}, eventSource: { on() {}, off() {} }, mainApi, groupId, chat, name1: 'Sasha', name2: 'Lena', characterId: 0,
        characters: [{ name: 'Lena', description: 'Lena is a Handler.', personality: 'Kind.', scenario: '', mes_example: '' }],
        powerUserSettings: { persona_description: '18 yo Male' }, chatMetadata: {}, saveMetadataDebounced() {},
        extensionSettings: {}, saveSettingsDebounced() {}, getCurrentChatId: () => 'chat-1',
        getPresetManager: () => ({ getSelectedPresetName: () => 'AmiGO' }), getRequestHeaders: () => ({}),
    };
    const fetchImpl = async () => new Response(JSON.stringify({ openai_setting_names: ['AmiGO'], openai_settings: [amigoJson] }), { status: 200 });
    registerStEventsService(engine.buses.services, { getContext: () => context });
    registerStGenerationService(engine.buses.services, { target });
    registerChatMetadataService(engine.buses.services, { getContext: () => context });
    registerExtensionSettingsService(engine.buses.services, { getContext: () => context });
    registerPmPresetsService(engine.buses.services, { store: memoryStore() });
    registerStPromptDataService(engine.buses.services, { getContext: () => context, fetchImpl });
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));
    createChatMemoryCore(engine.registerCaller('core.memory.chat', 'cores', { tier: 'official' }));
    const eventsCore = createEventsCore(engine.registerCaller('core.events', 'cores', { tier: 'official' }));
    const pipelineCore = createPipelineCore(engine.registerCaller('core.pipeline', 'cores', { tier: 'official' }), { resolveAs: engine.resolveAs, publish: (e, p) => eventsCore.publish(e, p, { source: 'core.pipeline' }) });
    const generationCore = createGenerationCore(engine.registerCaller('core.generation', 'cores', { tier: 'official' }), { publish: (e, p) => eventsCore.publish(e, p, { source: 'core.generation' }), pipelines: pipelineCore });
    const lore = engine.registerCaller('core.lorebook', 'cores', { tier: 'official' });
    lore.own.register('lorebook.entries', () => [{ uid: 1, key: ['dragon'], content: 'Dragons guard castles.', position: 0, order: 100, book: 'w' }]);
    const macros = engine.registerCaller('core.macros', 'cores', { tier: 'official' });
    macros.own.register('macros.snapshot', () => ({ 'rp-time_year': '2148', 'rp-time_month': 'May', 'rp-time_day': '22', 'rp-time_time': '23:10', 'rp-time_period': 'night' }));
    const warnings = [];
    const pm = createPromptManagerCore(engine.registerCaller('core.promptManager', 'cores', { tier: 'official' }), { publish: (event, payload) => { warnings.push({ event, payload }); } });
    await generationCore.install();
    await pm.load();
    const send = async (payload = { model: 'm', temperature: 1, messages: [{ role: 'system', content: 'ST assembled' }] }) => {
        await target[INTERCEPTOR_NAME](chat, 4096, () => {}, 'normal');
        await target.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(payload) });
        return backendCalls.at(-1);
    };
    /** Поддельный модуль-вкладчик: объявляет вклад на этапе beforeSend, как настоящий. */
    const contribute = async contribution => {
        lore.own.register('test.contribute', () => { pm.contributions.set(contribution); return true; });
        await request(lore.own, 'pipeline.stages.add', { params: { pipelineId: 'generation.beforeSend', stage: { id: 'test:contribute', contract: 'test.contribute', onExhausted: 'flag' } } });
    };
    return { pm, send, warnings, chat, context, backendCalls, contribute };
}

test('the first run turns every ST preset into an internal copy and activates the one selected in ST', async () => {
    const { pm } = await build();
    const created = await pm.autoPrepare();
    assert.equal(created.length, 1);
    assert.equal(pm.settings().activePresetId, created[0].id);
    assert.equal((await pm.autoPrepare()).length, 0, 'a second run creates nothing new');
});

test('with an active preset the outgoing request is assembled by the Prompt Manager instead of ST', async () => {
    const { pm, send } = await build();
    await pm.autoPrepare();
    const body = await send();
    const text = body.messages.map(m => m.content).join('\n');
    assert.ok(text.includes('Lena is a Handler.') && text.includes('Dragons guard castles.'));
    assert.ok(text.includes('2148 May 22 23:10 (night)'));
    assert.equal(body.temperature, 0.85, 'sampler values come from the preset');
    assert.equal(body.model, 'm', 'everything else in the body stays as ST built it');
    assert.equal(body.messages.some(m => m.content === 'ST assembled'), false);
});

test('without an active preset or when switched off the request goes out untouched', async () => {
    const { pm, send } = await build();
    assert.equal((await send()).messages[0].content, 'ST assembled');
    await pm.autoPrepare();
    await pm.configure({ enabled: false });
    assert.equal((await send()).messages[0].content, 'ST assembled');
    await pm.configure({ enabled: true });
    assert.equal((await send()).messages[0].content === 'ST assembled', false);
});

test('group chats and Text Completion are passed through and the user is warned once', async () => {
    const group = await build({ groupId: 'g1' });
    await group.pm.autoPrepare();
    assert.equal((await group.send()).messages[0].content, 'ST assembled');
    assert.equal(group.warnings.filter(w => w.event === 'promptManager.unsupported').length, 1);
    const text = await build({ mainApi: 'textgenerationwebui' });
    await text.pm.autoPrepare();
    assert.equal((await text.send()).messages[0].content, 'ST assembled');
});

test('a module contribution appears in the request at its default place and the node is saved into the preset', async () => {
    const { pm, send, contribute } = await build();
    await pm.autoPrepare();
    await contribute({ id: 'graph', name: 'Memory graph', role: 'assistant', content: 'MEMORY GRAPH TEXT', defaultPlacement: 'before-history' });
    const body = await send();
    const contents = body.messages.map(m => m.content);
    assert.equal(contents.indexOf('MEMORY GRAPH TEXT'), contents.indexOf('<char instructions>') + 2, 'in the history start: after the depth-injected char instructions, before the greeting');
    assert.ok(contents.indexOf('MEMORY GRAPH TEXT') < contents.indexOf('Greetings.'));
    const record = await pm.store.get(pm.settings().activePresetId);
    assert.ok(record.preset.tree.some(node => node.type === 'inject' && node.contribution === 'graph'));
});

test('a failure inside the assembler never breaks the generation: the original request is sent', async () => {
    const { pm, send, warnings } = await build();
    await pm.autoPrepare();
    const record = await pm.store.get(pm.settings().activePresetId);
    record.preset.tree = null;
    await pm.store.save(record, { version: false });
    assert.equal((await send()).messages[0].content, 'ST assembled');
    assert.ok(warnings.some(w => w.event === 'promptManager.failed'));
});

test('every request is logged with its size and the second one is compared with the first for the prefix cache', async () => {
    const { pm, send, chat } = await build();
    await pm.autoPrepare();
    await send();
    chat.push({ is_user: false, name: 'Lena', mes: 'A new answer.' }, { is_user: true, name: 'Sasha', mes: 'And then?' });
    await send();
    const log = pm.log();
    assert.equal(log.length, 2);
    assert.equal(log[0].cache, null);
    // Инструкции пресета после истории (~3000 токенов) стоят ПОСЛЕ неё, поэтому новое сообщение сдвигает их и кеш
    // держится только до конца прежней истории — ровно то, что режим кеша обязан показывать (PROMPT_MANAGER_PLAN.md, 11.5).
    assert.ok(log[1].cache.sharedTokens >= 200);
    assert.ok(log[1].cache.ratio < 0.2);
    assert.equal(log[1].cache.culprit.block, 'history #2');
});
