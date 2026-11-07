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
import { setAfterTurnDefault } from '../libraries/core/decision-settings.js';
setAfterTurnDefault(false); // эти тесты считают вызовы модели; работа после хода проверяется отдельно

/**
 * Сценарный уровень 2 (TESTING.md): настоящий движок, настоящие Шины/Гейты/
 * Ядра генерации, пайплайна, саммари, истории и решения. Подделан только
 * слой Сервисов: ST, его чат, chatMetadata и extensionSettings.
 *
 * Главное, что доказывается: на `generation.payload` в ИСХОДЯЩЕЕ тело
 * попадает контекст прозаика (заметки, ровно 20 сообщений, саммари, решение),
 * ризонинга нет, а без воркера директора генерация не отправляется.
 */

const SUMMARY_TEXT = 'They met at the keep and agreed to leave at dawn.';
const DECISION_TEXT = 'She opens the east door and steps into the rain.';

function makeChat() {
    const chat = [];
    for (let index = 0; index < 12; index += 1) {
        chat.push({ is_user: true, name: 'Sasha', mes: `user ${index}` });
        chat.push({ is_user: false, name: 'Lena', mes: `char ${index}` });
    }
    chat.push({ is_user: true, name: 'Sasha', mes: 'What now?' });
    return chat;
}

async function build({ directorFails = false, deciderWorkerId = 'director' } = {}) {
    const engine = createEngine();
    const chat = makeChat();
    const sent = [];
    const directorCalls = [];
    const notifications = [];
    const reveals = [];
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
    engine.buses.cores.register('ui.reveal', params => { reveals.push(params); return true; });
    engine.buses.cores.register('model.generate', async params => {
        directorCalls.push(params);
        if (directorFails) throw new Error('the director is down');
        eventsCore.publish('model.generate.raw', {
            requestId: params.requestId, format: 'openai',
            body: JSON.stringify({ choices: [{ message: { reasoning_content: 'the door is the only way' } }] }),
        }, { source: 'core.models.internal' });
        return {
            text: '',
            toolCalls: [
                { id: 'plan', name: 'set_plan', arguments: { comment: 'The turn needs a direction.', direction: 'Leave through the east door.' } },
                { id: 'turn', name: 'inscribe', arguments: { comment: 'The turn is decided.', scene: { duration: 'a few minutes' }, stop: DECISION_TEXT, userResult: 'The user waited.', characters: [] } },
            ],
        };
    });

    const summaryCore = createBasicSummaryCore(engine.registerCaller('core.summary', 'cores', { tier: 'official' }), {
        publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.summary' }),
    });
    await summaryCore.load();

    const decisionCore = createDecisionCore(engine.registerCaller('core.decision', 'cores', { tier: 'official' }), {
        publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.decision' }),
        retryDelayMs: 0,
    });
    await decisionCore.load();
    await decisionCore.configure({ prompts: { director: 'Never kill a named character.' }, decider: { workerId: deciderWorkerId } });

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

    return { engine, chat, sent, directorCalls, notifications, reveals, decisionCore, summaryCore, generationCore, send };
}

test('the writer body really reaches the outgoing request: exactly 20 history messages, summaries, the decision, and no reasoning', async () => {
    const { directorCalls, send } = await build();
    const result = await send();
    assert.equal(result.aborted, false);

    assert.equal(directorCalls.length, 1, 'the director ran exactly once');
    const director = directorCalls[0];
    assert.equal(director.stream, true);
    assert.equal(director.workerId, 'director');
    const directorText = JSON.stringify(director.messages);
    assert.doesNotMatch(directorText, new RegExp(SUMMARY_TEXT), 'summary.core summaries no longer reach the director');
    assert.match(directorText, /Never kill a named character/);
    // Резолверу план на ходу не нужен: он видит Указ и шаблон, а не свой план.
    assert.doesNotMatch(directorText, /YOUR PLAN/);
    assert.match(directorText, /No Decree yet — play from the bank/);
    assert.match(directorText, /What now\?/, 'the current user message is the pending window cycle');
    assert.doesNotMatch(directorText, /char 2/, 'the director no longer reads the raw chat history');

    const body = JSON.parse(result.sent.body);
    const history = body.messages.filter(message => message.role === 'user' || message.role === 'assistant');
    assert.equal(history.length, 20, 'exactly the last 20 history messages');
    assert.equal(history[0].content, 'char 2');
    assert.equal(history.at(-1).content, 'What now?');
    const all = body.messages.map(message => message.content).join('\n');
    assert.match(all, /You are the Writer of a roleplay/);
    assert.match(all, new RegExp(SUMMARY_TEXT));
    assert.match(all, new RegExp(DECISION_TEXT));
    assert.equal('reasoning_effort' in body, false, 'ST reasoning is gone');
    assert.equal('reasoning' in body, false);
    assert.equal(body.stream, true, 'streaming is untouched');
    assert.equal(body.model, 'st-model');
});

test('a director that fails twice aborts the real generation before anything leaves, and the user is told', async () => {
    const { send, sent, notifications, decisionCore, directorCalls } = await build({ directorFails: true });
    const result = await send();
    assert.equal(result.aborted, true);
    assert.equal(sent.length, 0, 'no request reaches the backend');
    assert.equal(directorCalls.length, 2, 'one retry before giving up');
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].text, /failed twice/);
    assert.deepEqual(decisionCore.runs(), {});
});

test('a Text Completion request gets a flat writer prompt instead of messages, and still has no reasoning keys', async () => {
    const { send } = await build();
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


test('without a director worker no request leaves the engine, the run closes, and the Director / Writer card opens', async () => {
    const { send, sent, notifications, reveals, directorCalls, decisionCore, generationCore } = await build({ deciderWorkerId: '' });
    const result = await send();
    assert.equal(result.aborted, true, 'the interceptor cancels before ST builds and sends');
    assert.equal(sent.length, 0, 'nothing reaches the backend');
    assert.equal(directorCalls.length, 0);
    assert.equal(generationCore.current(), null, 'the run is closed, nothing is left open');
    assert.deepEqual(decisionCore.runs(), {});
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].text, /no director worker is configured/);
    assert.match(notifications[0].text, /was not sent/);
    assert.deepEqual(reveals[0], { anchor: 'card:decision' });
});
