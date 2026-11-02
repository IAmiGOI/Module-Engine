import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { request } from '../libraries/shared/request.js';
import { registerStGenerationService } from '../services/st-generation.js';
import { registerStChatService } from '../services/st-chat.js';
import { registerChatMetadataService } from '../services/chat-metadata.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { createSettingsCore } from '../cores/settings/index.js';
import { createChatMemoryCore } from '../cores/memory/index.js';
import { createChatHistoryCore } from '../cores/chat-history/index.js';
import { createEventsCore } from '../cores/events/index.js';
import { createPipelineCore } from '../cores/pipeline/index.js';
import { createGenerationCore, INTERCEPTOR_NAME } from '../cores/generation/index.js';
import { createBasicSummaryCore } from '../cores/summary/index.js';
import { createDecisionCore } from '../cores/decision/index.js';

/**
 * Сценарный уровень 2 (TESTING.md): настоящий движок, настоящие Шины/Гейты/
 * Ядра генерации, пайплайна, саммари, истории и решения. Подделан только
 * слой Сервисов: ST, его чат, chatMetadata и extensionSettings.
 *
 * Главное, что доказывается: на `generation.payload` в ИСХОДЯЩЕЕ тело
 * попадает контекст прозаика (блоки, ровно 20 сообщений, саммари, решение),
 * ризонинга нет, а при выключенном ядре тело уходит байт в байт таким, каким
 * его отправил ST.
 */

const SUMMARY_TEXT = 'They met at the keep and agreed to leave at dawn.';
const DECISION_TEXT = 'She opens the east door and steps into the rain.';
const BLOCK_TEXT = 'The east door is the only way out.';

function makeChat() {
    const chat = [];
    for (let index = 0; index < 12; index += 1) {
        chat.push({ is_user: true, name: 'Sasha', mes: `user ${index}` });
        chat.push({ is_user: false, name: 'Lena', mes: `char ${index}` });
    }
    chat.push({ is_user: true, name: 'Sasha', mes: 'What now?' });
    return chat;
}

async function build({ enabled = true, withPm = false, directorFails = false } = {}) {
    const engine = createEngine();
    const chat = makeChat();
    const sent = [];
    const directorCalls = [];
    const notifications = [];
    const context = {
        chat,
        mainApi: 'openai',
        chatCompletionSettings: { chat_completion_source: 'openai' },
        getChatCompletionModel: () => 'st-model',
        chatMetadata: {
            stme_memory: {
                'core.summary': {
                    summaries: [{ id: 'sum_1', level: 1, coveredIds: ['0', '1'], startIndex: 0, endIndex: 1, text: SUMMARY_TEXT, folded: false, createdAt: 1 }],
                },
            },
        },
        saveMetadataDebounced() {},
        saveMetadata() {},
        extensionSettings: {
            stme_settings: {
                'core.summary': { settings: { levels: [{ batchSize: 100 }], protectedWindow: 1000 } },
            },
        },
        saveSettingsDebounced() {},
        saveSettings() {},
        getCurrentChatId: () => 'chat-1',
    };
    const target = {
        fetch: async (url, init) => {
            sent.push({ url, body: init.body });
            return new Response(JSON.stringify({ choices: [{ message: { content: 'written' } }] }), { status: 200 });
        },
    };

    registerStGenerationService(engine.buses.services, { target, getContext: () => context });
    registerStChatService(engine.buses.services, { getContext: () => context });
    registerChatMetadataService(engine.buses.services, { getContext: () => context });
    registerExtensionSettingsService(engine.buses.services, { getContext: () => context });

    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));
    createChatMemoryCore(engine.registerCaller('core.memory.chat', 'cores', { tier: 'official' }));
    createChatHistoryCore(engine.registerCaller('core.chatHistory', 'cores', { tier: 'official' }));
    const eventsCore = createEventsCore(engine.registerCaller('core.events', 'cores', { tier: 'official' }));
    const pipelineCore = createPipelineCore(engine.registerCaller('core.pipeline', 'cores', { tier: 'official' }), {
        resolveAs: engine.resolveAs,
        publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.pipeline' }),
    });
    const generationCore = createGenerationCore(engine.registerCaller('core.generation', 'cores', { tier: 'official' }), {
        publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.generation' }),
        pipelines: pipelineCore,
    });
    engine.buses.cores.register('model.workers.get', () => [
        { id: 'director', model: 'director/model', format: 'openai' },
        { id: 'writer', model: 'writer/model', format: 'openai' },
    ]);
    engine.buses.cores.register('ui.notify', params => { notifications.push(params); return true; });
    engine.buses.cores.register('model.generate', async params => {
        directorCalls.push(params);
        if (directorFails) throw new Error('the director is down');
        eventsCore.publish('model.generate.raw', {
            requestId: params.requestId, format: 'openai',
            body: JSON.stringify({ choices: [{ message: { reasoning_content: 'the door is the only way' } }] }),
        }, { source: 'core.models.internal' });
        return JSON.stringify({ decision: DECISION_TEXT, blocks: [{ op: 'add', title: 'Exit', text: BLOCK_TEXT }] });
    });

    const summaryCore = createBasicSummaryCore(engine.registerCaller('core.summary', 'cores', { tier: 'official' }), {
        publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.summary' }),
    });
    await summaryCore.load();

    if (withPm) {
        const pmHost = engine.registerCaller('core.promptManager', 'cores', { tier: 'official' });
        pmHost.own.register('promptManager.takesOver', () => false);
        pmHost.own.register('promptManager.rewrite', ({ payload }) => ({ ...payload, messages: [{ role: 'system', content: 'PM assembled' }] }));
        await request(pmHost.own, 'pipeline.stages.add', { params: { pipelineId: 'generation.payload', stage: { id: 'prompt-manager:rewrite', contract: 'promptManager.rewrite', params: { payload: { $from: '$value' } } } } });
    }

    const decisionCore = createDecisionCore(engine.registerCaller('core.decision', 'cores', { tier: 'official' }), {
        publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.decision' }),
        retryDelayMs: 0,
    });
    await decisionCore.load();
    if (enabled) await decisionCore.configure({ enabled: true, rules: 'Never kill a named character.', decider: { workerId: 'director' } });

    await generationCore.install();

    async function send(payload = { model: 'st-model', temperature: 0.7, max_tokens: 700, stream: true, chat_completion_source: 'openai', reasoning_effort: 'high', messages: [{ role: 'system', content: 'ST assembled' }] }) {
        engine.events.emit('st.generationStarted', { args: [] });
        const interceptor = target[INTERCEPTOR_NAME];
        let aborted = false;
        await interceptor(chat, 4096, () => { aborted = true; }, 'normal');
        if (aborted) return { aborted: true };
        const response = await target.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(payload) });
        engine.events.emit('st.generationEnded', {});
        await new Promise(resolve => setTimeout(resolve, 0));
        await new Promise(resolve => setTimeout(resolve, 0));
        return { aborted: false, sent: sent.at(-1), response, original: JSON.stringify(payload) };
    }

    return { engine, chat, sent, directorCalls, notifications, decisionCore, summaryCore, send };
}

test('the writer body really reaches the outgoing request: blocks, exactly 20 history messages, summaries, the decision, and no reasoning', async () => {
    const { directorCalls, send, decisionCore } = await build({ enabled: true });
    const result = await send();
    assert.equal(result.aborted, false);

    assert.equal(directorCalls.length, 1, 'the director ran exactly once');
    const director = directorCalls[0];
    assert.equal(director.stream, false);
    assert.equal(director.workerId, 'director');
    const directorText = JSON.stringify(director.messages);
    assert.match(directorText, new RegExp(SUMMARY_TEXT));
    assert.match(directorText, /Never kill a named character/);
    assert.match(directorText, /char 2/, 'the last 20 history messages reach the director');
    assert.doesNotMatch(directorText, /user 1"/, 'the oldest messages are outside the 20');

    const body = JSON.parse(result.sent.body);
    const history = body.messages.filter(message => message.role === 'user' || message.role === 'assistant');
    assert.equal(history.length, 20, 'exactly the last 20 history messages');
    assert.equal(history[0].content, 'char 2');
    assert.equal(history.at(-1).content, 'What now?');
    const all = body.messages.map(message => message.content).join('\n');
    assert.match(all, /You write the character's next reply/);
    assert.match(all, new RegExp(SUMMARY_TEXT));
    assert.match(all, new RegExp(BLOCK_TEXT));
    assert.match(all, new RegExp(DECISION_TEXT));
    assert.equal('reasoning_effort' in body, false, 'ST reasoning is gone');
    assert.equal('reasoning' in body, false);
    assert.equal(body.stream, true, 'streaming is untouched');
    assert.equal(body.model, 'st-model');
    assert.deepEqual(decisionCore.blocks().map(block => [block.title, block.text]), [['Exit', BLOCK_TEXT]], 'the block is committed after the completed run');
});

test('with the core off the outgoing body is byte-for-byte the one ST sent, and the director is never called', async () => {
    const { send, directorCalls } = await build({ enabled: false });
    const result = await send();
    assert.equal(result.sent.body, result.original, 'nothing in the body changed');
    assert.equal(directorCalls.length, 0);
    const body = JSON.parse(result.sent.body);
    assert.deepEqual(body.messages, [{ role: 'system', content: 'ST assembled' }]);
    assert.equal(body.reasoning_effort, 'high', 'off means exactly as before, including reasoning');
});

test('when the Prompt Manager is registered, it runs first but the writer body is what really leaves', async () => {
    const { send } = await build({ enabled: true, withPm: true });
    const result = await send();
    const body = JSON.parse(result.sent.body);
    assert.equal(body.messages.some(message => message.content === 'PM assembled'), false);
    assert.match(body.messages[0].content, /You write the character's next reply/);
});

test('a Text Completion request gets a flat writer prompt instead of messages, and still has no reasoning keys', async () => {
    const { send } = await build({ enabled: true });
    const result = await send({ prompt: 'ST prompt', max_new_tokens: 500, temperature: 0.8, stream: true, reasoning_effort: 'low' });
    const body = JSON.parse(result.sent.body);
    assert.equal(typeof body.prompt, 'string');
    assert.equal('messages' in body, false);
    assert.match(body.prompt, new RegExp(SUMMARY_TEXT));
    assert.match(body.prompt, new RegExp(DECISION_TEXT));
    assert.match(body.prompt, /What now\?/);
    assert.equal('reasoning_effort' in body, false);
    assert.equal(body.max_new_tokens, 500);
});
