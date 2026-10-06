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
import { registerStPmUiService } from '../services/st-pm-ui.js';
import { makeFakeDocument, FakeElement } from './helpers/fake-document.js';
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

/** Поддельный документ с иконкой ST «AI Response Configuration», для проверки, что родная панель ST убрана. */
function makeStDocument({ withButton = true } = {}) {
    const doc = makeFakeDocument();
    doc.head = new FakeElement('head');
    if (withButton) {
        const button = new FakeElement('div');
        button.id = 'ai-config-button';
        button.append(new FakeElement('div'));
        doc.body.append(button);
    }
    const find = (node, id) => {
        if (node.id === id) return node;
        for (const child of node.children ?? []) { const hit = find(child, id); if (hit) return hit; }
        return null;
    };
    doc.getElementById = id => find(doc.head, id) ?? find(doc.body, id);
    doc.addEventListener = () => {};
    doc.removeEventListener = () => {};
    return doc;
}

async function build({ mainApi = 'openai', groupId = null, stDoc = makeStDocument() } = {}) {
    const engine = createEngine();
    const chat = [{ is_user: false, name: 'Lena', mes: 'Greetings.' }, { is_user: true, name: 'Sasha', mes: 'Tell me about the dragon.' }];
    const backendCalls = [];
    const listeners = new Map();
    const stepCalls = [];
    const stepBehavior = { failTimes: 0 };
    const target = {
        fetch: async (url, init) => {
            const body = JSON.parse(init.body);
            if (body.max_tokens === 1500) { // запрос шага Guided CoT
                stepCalls.push(body);
                if (stepBehavior.failTimes > 0) { stepBehavior.failTimes--; return new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 }); }
                return new Response(JSON.stringify({ choices: [{ message: { content: `answer ${stepCalls.length}`, reasoning_content: `thought ${stepCalls.length}` } }] }), { status: 200 });
            }
            backendCalls.push(body);
            return new Response('{}', { status: 200 });
        },
    };
    const context = {
        eventTypes: { GENERATION_ENDED: 'generation_ended' },
        eventSource: { on: (name, handler) => listeners.set(name, [...(listeners.get(name) ?? []), handler]), off() {} }, mainApi, groupId, chat, name1: 'Sasha', name2: 'Lena', characterId: 0,
        characters: [{ name: 'Lena', description: 'Lena is a Handler.', personality: 'Kind.', scenario: '', mes_example: '' }],
        powerUserSettings: { persona_description: '18 yo Male' }, chatMetadata: {}, saveMetadataDebounced() {},
        extensionSettings: {}, saveSettingsDebounced() {}, getCurrentChatId: () => 'chat-1',
        chatCompletionSettings: { chat_completion_source: 'openai' }, getPresetManager: () => ({ getSelectedPresetName: () => 'AmiGO' }), getRequestHeaders: () => ({}),
    };
    const fetchImpl = async () => new Response(JSON.stringify({ openai_setting_names: ['AmiGO'], openai_settings: [amigoJson] }), { status: 200 });
    registerStEventsService(engine.buses.services, { getContext: () => context });
    registerStGenerationService(engine.buses.services, { target, getContext: () => context });
    registerChatMetadataService(engine.buses.services, { getContext: () => context });
    registerExtensionSettingsService(engine.buses.services, { getContext: () => context });
    registerPmPresetsService(engine.buses.services, { store: memoryStore() });
    registerStPromptDataService(engine.buses.services, { getContext: () => context, fetchImpl });
    registerStPmUiService(engine.buses.services, { document: stDoc });
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
    await eventsCore.bridge();
    await generationCore.install();
    await pm.load();
    const send = async (payload = { model: 'm', temperature: 1, messages: [{ role: 'system', content: 'ST assembled' }] }, type = 'normal') => {
        await target[INTERCEPTOR_NAME](chat, 4096, () => {}, type);
        await target.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(payload) });
        return backendCalls.at(-1);
    };
    /** Поддельный модуль-вкладчик: объявляет вклад на этапе beforeSend, как настоящий. */
    const contribute = async contribution => {
        lore.own.register('test.contribute', () => { pm.contributions.set(contribution); return true; });
        await request(lore.own, 'pipeline.stages.add', { params: { pipelineId: 'generation.beforeSend', stage: { id: 'test:contribute', contract: 'test.contribute', onExhausted: 'flag' } } });
    };
    const fire = name => { for (const handler of listeners.get(name) ?? []) handler(); };
    const call = (contract, params) => request(lore.own, contract, { params });
    return { pm, send, warnings, chat, context, backendCalls, contribute, stepCalls, stepBehavior, fire, call, stDoc, lore };
}

test('loading the core by itself turns every ST preset into an internal copy and activates the one selected in ST — without anyone opening the Prompt Manager window (live ST 1.18: "on by default" without an active preset silently left the assembly to ST)', async () => {
    const { pm } = await build();
    const created = await pm.whenPrepared();
    assert.equal(created.length, 1);
    assert.equal(pm.settings().activePresetId, created[0].id);
    assert.equal((await pm.autoPrepare()).length, 0, 'a second run creates nothing new');
});

test('an active preset that does not exist in this browser (settings are shared through ST, presets live in the browser) is replaced by the one selected in ST', async () => {
    const { pm } = await build();
    const [created] = await pm.whenPrepared();
    await pm.configure({ activePresetId: 'pm_from_another_browser' });
    await pm.autoPrepare();
    assert.equal(pm.settings().activePresetId, created.id);
});

test('two preparations running at the same time share one run and do not duplicate presets', async () => {
    const { pm, call } = await build();
    await pm.whenPrepared();
    await pm.configure({ activePresetId: null });
    await Promise.all([pm.autoPrepare(), pm.autoPrepare()]);
    assert.equal((await call('promptManager.presets')).value.length, 1);
    assert.ok(pm.settings().activePresetId, 'the preset selected in ST becomes active again');
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

test('SillyTavern\'s "AI Response Configuration" panel is hidden as soon as the core loads and NEVER comes back while switching `enabled` on and off — owner: "убрать полностью", no coexistence in any state', async () => {
    const { pm, stDoc } = await build();
    const suppressed = () => Boolean(stDoc.getElementById('stme-pm-suppress'));
    assert.equal(suppressed(), true, 'hidden immediately on load, before any preset exists');

    await pm.configure({ enabled: false });
    assert.equal(suppressed(), true, 'turning PM off must NOT bring ST\'s own panel back');

    await pm.configure({ enabled: true });
    assert.equal(suppressed(), true, 'turning it back on keeps it hidden — was already hidden, nothing to redo');
});

test('when SillyTavern\'s "AI Response Configuration" icon cannot be found, PM disables itself and warns — there is nothing to intercept, so this is the one real fallback case', async () => {
    const { pm, warnings } = await build({ stDoc: makeStDocument({ withButton: false }) });
    assert.equal(pm.settings().enabled, false);
    assert.ok(warnings.some(w => w.event === 'promptManager.unsupported'));
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
    assert.equal(contents.indexOf('MEMORY GRAPH TEXT'), contents.findIndex(text => String(text).includes('[Start a new Chat]')) + 1, 'in the history start: right after the new chat line (the empty <char instructions> group sends nothing), before the greeting');
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
    assert.ok(log[1].cache.sharedTokens >= 150); // группы-обёртки идут одним сообщением — служебных токенов на сообщение меньше, чем при тегах отдельно

    assert.ok(log[1].cache.ratio < 0.2);
    assert.equal(log[1].cache.culprit.block, 'history #2');
});

async function withCot(cot, options) {
    const env = await build(options);
    await env.pm.autoPrepare();
    const record = await env.pm.store.get(env.pm.settings().activePresetId);
    record.preset.blocks.push({ id: 's1', name: 'Plan', role: 'system', content: 'Plan the scene for {{char}}.' }, { id: 's2', name: 'Check', role: 'system', content: 'Check the plan.' });
    record.preset.cot = { enabled: true, mode: 'always', steps: [{ type: 'item', block: 's1', enabled: true }, { type: 'item', block: 's2', enabled: true }], ...cot };
    await env.pm.store.save(record, { version: false });
    return env;
}

test('Guided CoT runs its steps before the main request and hands the result to the final prompt', async () => {
    const { send, stepCalls } = await withCot({});
    const body = await send();
    assert.equal(stepCalls.length, 2);
    assert.equal(stepCalls[0].messages.at(-1).role, 'user', 'a step is sent as a user message');
    assert.equal(stepCalls[0].messages.at(-1).content, 'Plan the scene for Lena.');
    assert.equal(stepCalls[1].messages.at(-2).content, 'answer 1', 'the second step sees the first answer');
    assert.equal(stepCalls[1].messages.at(-2).reasoning_content, 'thought 1', 'and its reasoning is kept between steps');
    assert.ok(body.messages.at(-1).content.includes('answer 2'), 'the final request carries the thinking after the whole history');
});

test('Guided CoT is off unless the preset switches it on', async () => {
    const { send, stepCalls } = await withCot({ enabled: false });
    await send();
    assert.equal(stepCalls.length, 0);
});

test('a CoT step that fails once is retried and a second failure cancels the generation', async () => {
    const retry = await withCot({});
    retry.stepBehavior.failTimes = 1;
    await retry.send();
    assert.equal(retry.stepCalls.length, 3, 'one failed attempt plus two steps');
    const abort = await withCot({});
    abort.stepBehavior.failTimes = 5;
    await abort.send().catch(() => {});
    assert.equal(abort.backendCalls.length, 0, 'the main request must not be sent after a failed chain');
    assert.ok(abort.warnings.some(w => w.event === 'promptManager.cotFailed'));
});

test('the finished thinking is stored with the chat under the number of the new message', async () => {
    const { send, chat, fire, call } = await withCot({});
    await send();
    chat.push({ is_user: false, name: 'Lena', mes: 'Answer.' });
    fire('generation_ended');
    await new Promise(resolve => setTimeout(resolve, 20));
    const records = (await call('promptManager.cotRecords', {})).value;
    assert.equal(records[chat.length - 1].steps.length, 2);
    assert.equal(records[chat.length - 1].steps[0].text, 'answer 1');
});

test('on a regenerate with the final-only mode the earlier steps are reused instead of running the chain again', async () => {
    const { send, stepCalls } = await withCot({ regen: 'final' });
    await send();
    assert.equal(stepCalls.length, 2);
    const body = await send(undefined, 'regenerate');
    assert.equal(stepCalls.length, 2, 'no new step requests');
    assert.ok(body.messages.at(-1).content.includes('answer 2'));
    const all = await withCot({ regen: 'all' });
    await all.send();
    await all.send(undefined, 'regenerate');
    assert.equal(all.stepCalls.length, 4, 'the default reruns the whole chain');
});

test('parameter overrides are ignored until switched on and then the chat beats the preset', async () => {
    const { pm, send, call } = await build();
    await pm.autoPrepare();
    await call('promptManager.setOverride', { scope: 'chat', key: 'chat-1', params: { temperature: 1.3 } });
    assert.equal((await send()).temperature, 0.85, 'overrides are off by default');
    await pm.configure({ overrides: { ...pm.settings().overrides, enabled: true } });
    assert.equal((await send()).temperature, 1.3);
});

test('streaming from the preset is set in ST for the generation and given back afterwards, never written into the request body', async () => {
    const { pm, send, context, fire } = await build();
    context.chatCompletionSettings.stream_openai = false;
    await pm.autoPrepare();
    const body = await send();
    assert.equal(context.chatCompletionSettings.stream_openai, true, 'the preset says stream');
    assert.equal('stream' in body && body.stream !== undefined, false, 'the request body keeps what ST built');
    fire('generation_ended');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(context.chatCompletionSettings.stream_openai, false, 'the user setting is restored');
});

test('"Function calling" in the preset turns ST function calling on for the request; an off flag never turns the ST setting off', async () => {
    const { pm, send, context, call } = await build();
    await pm.autoPrepare();
    const record = (await call('promptManager.preset', { id: (await call('promptManager.presets', {})).value[0].id })).value;
    const withFlag = value => call('promptManager.savePreset', { record: { ...record, preset: { ...record.preset, params: { ...record.preset.params, function_calling: value } } } });
    context.chatCompletionSettings.function_calling = false;
    await withFlag(true);
    await send();
    assert.equal(context.chatCompletionSettings.function_calling, true, 'the preset asks for tools');
    await withFlag(false);
    await send();
    assert.equal(context.chatCompletionSettings.function_calling, true, 'an off flag in the preset leaves ST\'s own choice alone');
});

test('a plugin registered while running takes part in the very next request and a broken one is switched off without breaking it', async () => {
    const { pm, send, call } = await build();
    await pm.autoPrepare();
    await call('promptManager.registerPlugin', { plugin: { id: 'shout', provides: { transform: messages => messages.map(m => (m.role === 'user' ? { ...m, content: m.content.toUpperCase() } : m)) } } });
    const body = await send();
    assert.ok(body.messages.some(m => m.role === 'user' && m.content === 'TELL ME ABOUT THE DRAGON.'));
    await call('promptManager.registerPlugin', { plugin: { id: 'bad', provides: { transform: () => { throw new Error('boom'); } } } });
    const again = await send();
    assert.ok(again.messages.length > 5, 'the request still went out');
    const list = (await call('promptManager.plugins', {})).value;
    assert.equal(list.find(p => p.id === 'bad').enabled, false);
    assert.equal(list.find(p => p.id === 'shout').enabled, true);
    await call('promptManager.unregisterPlugin', { id: 'shout' });
    assert.ok((await send()).messages.some(m => m.content === 'Tell me about the dragon.'));
});

test('the log tells whether the shared start is enough for the cache of the provider and remembers reported usage', async () => {
    const { pm, send, chat, call, context } = await build();
    context.chatCompletionSettings.chat_completion_source = 'openai';
    await pm.autoPrepare();
    await send();
    chat.push({ is_user: false, name: 'Lena', mes: 'A new answer.' }, { is_user: true, name: 'Sasha', mes: 'And then?' });
    await send();
    await call('promptManager.reportUsage', { usage: { prompt_tokens_details: { cached_tokens: 1234 } } });
    const advice = (await call('promptManager.stability', {})).value;
    assert.ok(['broken', 'short', 'good'].includes(advice.verdict.verdict));
    assert.equal(advice.cachedTokens, 1234);
    assert.match(advice.verdict.text, /OpenAI|shared/);
});

test('with the Prompt Manager active, the open character\'s own prompts (system prompt, post-history instructions, depth prompt) reach the model like they do in SillyTavern\'s manager — the preset leaves those blocks empty for the card to fill', async () => {
    const { pm, send, context } = await build();
    await pm.autoPrepare();
    context.characters[0].data = { system_prompt: 'LENA SYSTEM', post_history_instructions: 'LENA PHI', extensions: { depth_prompt: { prompt: 'LENA DEPTH', depth: 0, role: 'system' } } };
    const texts = (await send()).messages.map(message => message.content);
    assert.ok(texts.some(text => text.includes('LENA SYSTEM')), 'the card\'s system prompt fills the empty main block');
    assert.ok(texts.some(text => text.startsWith('<char instructions>') && text.includes('LENA PHI')), 'the card\'s post-history text lands inside the <char instructions> group');
    assert.ok(texts.includes('LENA DEPTH'), 'the depth prompt is injected as the card says');
    context.characters[0].data = {};
    assert.ok(!(await send()).messages.some(message => /LENA (SYSTEM|PHI|DEPTH)/.test(message.content)), 'a card without them adds nothing');
});

test('a card test is assembled in isolation: the named card and the given turns only — no lorebook entry and no history of the open chat — with the same preset and the card\'s own prompts', async () => {
    const { pm, call } = await build();
    await pm.autoPrepare();
    const card = { name: 'Aria', description: 'Aria is a scout.', personality: '', scenario: '', mes_example: '', system_prompt: 'ARIA SYSTEM', post_history_instructions: 'ARIA PHI', depth_prompt: { prompt: '', depth: 4, role: 'system' } };
    const chat = [{ name: 'Aria', is_user: false, mes: 'Who goes there?' }, { name: 'Sasha', is_user: true, mes: 'A dragon, tell me about the dragon.' }];
    const assembled = (await call('promptManager.assembleForCard', { card, chat })).value;
    const text = assembled.messages.map(message => message.content).join('\n');
    assert.ok(text.includes('Aria is a scout.') && text.includes('ARIA SYSTEM') && text.includes('ARIA PHI'));
    assert.ok(text.includes('Who goes there?') && text.includes('A dragon, tell me about the dragon.'));
    assert.ok(!text.includes('Lena is a Handler.'), 'the open character\'s card is not mixed in');
    assert.ok(!text.includes('Dragons guard castles.'), 'the lorebook of the open chat is not mixed in');
    assert.ok(!text.includes('Tell me about the dragon.') && !text.includes('Greetings.'), 'the history of the open chat is not mixed in');
    assert.ok(assembled.tokens > 0 && assembled.presetName);
});

test('a card test with no active preset says so instead of building something else', async () => {
    const { pm, call } = await build();
    await pm.autoPrepare();
    await pm.configure({ activePresetId: null });
    assert.deepEqual((await call('promptManager.assembleForCard', { card: { name: 'Aria' }, chat: [] })).value, { skipped: 'no active preset' });
});

async function withJevRegion(world, { question = 'The player is in danger.', minChance = 70 } = {}) {
    const { createTextBlock } = await import('../cores/ui/prompt-manager/tree-model.js');
    const { createDividerPair } = await import('../libraries/core/pm-dividers.js');
    await world.pm.autoPrepare();
    const record = (await world.call('promptManager.preset', { id: world.pm.settings().activePresetId })).value;
    const { block, node } = createTextBlock({ name: 'Danger rules', content: 'DANGER RULES TEXT' });
    const [begin, end] = createDividerPair({ name: 'danger' });
    record.preset.blocks.push(block);
    record.preset.tree.push({ ...begin, condition: { type: 'jev', question, minChance, user: 1, assistant: 0 } }, node, end);
    await world.call('promptManager.savePreset', { record });
    return world;
}
const outgoing = body => body.messages.map(message => message.content).join('\n');
const answering = (chance, seen = []) => params => {
    seen.push(params);
    return { answers: Object.fromEntries(params.calls.flatMap(call => Object.keys(call.questions)).map(key => [key, chance])), failed: [] };
};

test('a Jev-conditioned region between two dividers is sent when the chance reaches the threshold and dropped below it, and the question carries the player’s newest message', async () => {
    const world = await withJevRegion(await build());
    const seen = [];
    let unregister = world.lore.own.register('classifier.decide', answering(0.7, seen));
    assert.ok(outgoing(await world.send()).includes('DANGER RULES TEXT'), 'exactly at the threshold: sent');
    assert.equal(seen[0].calls[0].state.player_message, 'Tell me about the dragon.');
    assert.equal(Object.keys(seen[0].calls[0].questions).length, 1);
    unregister();
    unregister = world.lore.own.register('classifier.decide', answering(0.69));
    world.chat.push({ is_user: true, name: 'Sasha', mes: 'Another message, so the answer is asked again.' });
    assert.ok(!outgoing(await world.send()).includes('DANGER RULES TEXT'), 'below the threshold: dropped');
    unregister();
});

test('when there is no classifier, it fails, or it is too slow, the Jev condition counts as true and the region is sent — and a slow classifier never holds the generation longer than the wait setting', async () => {
    const world = await withJevRegion(await build());
    assert.ok(outgoing(await world.send()).includes('DANGER RULES TEXT'), 'no classifier registered at all');
    const unregister = world.lore.own.register('classifier.decide', () => { throw new Error('boom'); });
    assert.ok(outgoing(await world.send()).includes('DANGER RULES TEXT'), 'a failing classifier');
    unregister();
    await world.pm.configure({ jevWaitMs: 500 });
    world.lore.own.register('classifier.decide', () => new Promise(() => {}));
    const started = Date.now();
    assert.ok(outgoing(await world.send()).includes('DANGER RULES TEXT'), 'a classifier that never answers');
    assert.ok(Date.now() - started < 3000, 'the wait is bounded');
});

test('a card test never calls the classifier (its Jev conditions count as true), and a preset without Jev conditions never asks anything', async () => {
    const world = await withJevRegion(await build());
    const seen = [];
    world.lore.own.register('classifier.decide', answering(0, seen));
    const assembled = (await world.call('promptManager.assembleForCard', { card: { name: 'Aria', description: 'Aria is a scout.' }, chat: [{ is_user: true, name: 'Sasha', mes: 'Hello' }] })).value;
    assert.equal(seen.length, 0);
    assert.ok(assembled.messages.some(message => message.content === 'DANGER RULES TEXT'));
    const plain = await build();
    const asked = [];
    plain.lore.own.register('classifier.decide', answering(0, asked));
    await plain.pm.autoPrepare();
    await plain.send();
    assert.equal(asked.length, 0);
});

test('the function-calling service reads and turns on the ST setting, keeps ST\'s own checkbox in step (ST re-reads every field from the page on any settings change) and saves', async () => {
    const { createEngine } = await import('../libraries/shared/engine.js');
    const { registerStPromptDataService } = await import('../services/st-prompt-data.js');
    const engine = createEngine();
    let saved = 0;
    const box = { checked: false };
    const context = { chatCompletionSettings: { function_calling: false }, saveSettingsDebounced: () => { saved += 1; } };
    const originalDocument = globalThis.document;
    globalThis.document = { getElementById: id => (id === 'openai_function_calling' ? box : null) };
    try {
        registerStPromptDataService(engine.buses.services, { getContext: () => context });
        const ask = params => new Promise(resolve => engine.buses.services.subscribe('stPromptData.functionCalling', { params }, resolve));
        assert.deepEqual((await ask({})).value, { previous: false, current: false }, 'a plain read changes nothing');
        assert.equal(saved, 0);
        assert.deepEqual((await ask({ value: true })).value, { previous: false, current: true });
        assert.equal(context.chatCompletionSettings.function_calling, true);
        assert.equal(box.checked, true, 'the checkbox of ST\'s panel follows');
        assert.equal(saved, 1);
        await ask({ value: true });
        assert.equal(saved, 1, 'nothing is saved when nothing changed');
    } finally { globalThis.document = originalDocument; }
});

// --- Граница обрезки привязана к бюджету, при котором её поставили (жалоба тестера: «stable cut» не откатывался после исправления бюджета) ---

const STATE = { namespace: 'core.promptManager', key: 'state' };
async function longChatBuild() {
    const built = await build();
    await built.pm.whenPrepared();
    built.chat.length = 0;
    for (let index = 0; index < 60; index += 1) built.chat.push({ is_user: index % 2 === 1, name: index % 2 ? 'Sasha' : 'Lena', mes: index === 0 ? 'GREETING-AT-THE-START' : `turn ${index} ${'filler words '.repeat(40)}` });
    const setParams = async patch => {
        const record = await built.pm.store.get(built.pm.settings().activePresetId);
        await built.pm.store.save({ ...record, preset: { ...record.preset, params: { ...record.preset.params, ...patch } } }, { label: 'test' });
    };
    const state = async () => (await built.call('storage.chatMemory.get', { ...STATE, fallback: {} })).value;
    const sentText = body => body.messages.map(message => (typeof message.content === 'string' ? message.content : '')).join('\n');
    return { ...built, setParams, state, sentText };
}

test('when the budget grows by a quarter or more the old cut is released and the history comes back, with the cut counted again for the new budget', async () => {
    const { send, setParams, state, sentText } = await longChatBuild();
    await setParams({ openai_max_context: 9000, openai_max_tokens: 100 });
    let body = await send();
    assert.ok(!sentText(body).includes('GREETING-AT-THE-START'), 'the start was cut for a small budget');
    const first = await state();
    assert.ok(first.cut > 0);
    assert.equal(first.cutBudget, 8900, 'the budget the cut was made for is remembered');
    body = await send();
    assert.equal((await state()).cut, first.cut, 'while the budget stays the cut stays: the same prefix every turn');
    assert.equal((await state()).cutBudget, 8900);
    await setParams({ openai_max_context: 9500, openai_max_tokens: 100 });   // +5%: not enough
    await send();
    assert.equal((await state()).cut, first.cut);
    await setParams({ openai_max_context: 60000, openai_max_tokens: 100 });
    body = await send();
    assert.ok(sentText(body).includes('GREETING-AT-THE-START'), 'everything fits again, so the greeting is back');
    assert.deepEqual(await state(), { cut: 0, cutBudget: null, timed: {} });
});

test('a chat that got a cut before the budget was remembered (the tester\'s stuck chat) is released once, even though nothing else changed', async () => {
    const { send, call, state, setParams, sentText } = await longChatBuild();
    await setParams({ openai_max_context: 68000, openai_max_tokens: 4000 });
    await call('storage.chatMemory.set', { ...STATE, value: { cut: 12, timed: {} } });   // what the old code left behind after "Max response > Max context"
    const body = await send();
    assert.ok(sentText(body).includes('GREETING-AT-THE-START'));
    assert.equal((await state()).cut, 0);
});

test('a budget that is not usable (Max response not below Max context) switches trimming off instead of cutting the whole history, and never writes a cut into the chat', async () => {
    const { send, pm, setParams, state, sentText } = await longChatBuild();
    await setParams({ openai_max_context: 8000, openai_max_tokens: 8000 });
    const body = await send();
    assert.ok(sentText(body).includes('GREETING-AT-THE-START'), 'the history is intact');
    assert.ok(sentText(body).includes('turn 59'));
    assert.equal((await state()).cut ?? 0, 0, 'nothing was written');
    const preview = await pm.preview();
    assert.deepEqual(preview.budgetInvalid, { maxContext: 8000, reserved: 8000 });
    assert.equal(preview.dropped.length, 0);
    await setParams({ openai_max_context: 9000, openai_max_tokens: 100 });
    assert.equal((await pm.preview()).budgetInvalid, null);
});

test('"Reset trimming" erases the cut of this chat on demand and says what was there', async () => {
    const { call, state } = await longChatBuild();
    await call('storage.chatMemory.set', { ...STATE, value: { cut: 5, cutBudget: 1000, timed: { x: 1 } } });
    const reset = await call('promptManager.resetCut');
    assert.deepEqual(reset.value, { was: 5 });
    assert.deepEqual(await state(), { cut: 0, cutBudget: null, timed: { x: 1 } }, 'only the cut goes; the lorebook timers stay');
    assert.deepEqual((await call('promptManager.resetCut')).value, { was: 0 });
});
