import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { createPipelineCore } from '../cores/pipeline/index.js';
import { createGenerationCore } from '../cores/generation/index.js';
import { createDecisionCore } from '../cores/decision/index.js';
import { registerStGenerationService } from '../services/st-generation.js';
import { translateWriterFrame, writerSourceFormat } from '../libraries/core/writer-response.js';

const BEFORE_SEND = 'generation.beforeSend';
const PAYLOAD = 'generation.payload';
const memoryKey = (namespace, key) => `${namespace}:${key}`;
const clone = value => JSON.parse(JSON.stringify(value));
const FAKE_KEY = 'sk-fake-writer-key-never-print';
const ENDPOINT = 'https://nanogpt.example/v1';

const turnReply = () => ({
    text: '',
    toolCalls: [
        { id: 'plan', name: 'set_plan', arguments: { comment: 'The turn needs a direction.', direction: 'Wait by the door.' } },
        { id: 'turn', name: 'submit_turn', arguments: { comment: 'The form is ready.', scene: { minutes: 0 }, resolution: 'She waits.', userResult: 'The user waits.', characters: [] } },
    ],
});

function frame(content) {
    return { data: JSON.stringify({ choices: [{ delta: { content } }] }) };
}

function build({ writerId = 'writer', provider = null } = {}) {
    const engine = createEngine();
    const settingsStore = new Map();
    const chatMemory = new Map();
    const workerList = [
        { id: 'director', format: 'openai', model: 'director/model', endpoint: 'https://director.example/v1', apiKey: 'fake-director-key' },
        { id: 'writer', format: 'openai', model: 'nano/model', endpoint: ENDPOINT, apiKey: FAKE_KEY },
    ];
    const backendCalls = [];
    const providerCalls = [];
    const target = {
        fetch: async (input, init) => {
            backendCalls.push({ url: String(input), body: init?.body });
            return new Response(JSON.stringify({ choices: [{ message: { content: 'ST BACKEND' } }] }), { status: 200 });
        },
    };
    engine.buses.cores.register('storage.settings.get', ({ namespace, key, fallback }) => (settingsStore.has(memoryKey(namespace, key)) ? clone(settingsStore.get(memoryKey(namespace, key))) : fallback));
    engine.buses.cores.register('storage.settings.set', ({ namespace, key, value }) => { settingsStore.set(memoryKey(namespace, key), clone(value)); return true; });
    engine.buses.cores.register('storage.chatMemory.get', ({ namespace, key, fallback }) => (chatMemory.has(memoryKey(namespace, key)) ? clone(chatMemory.get(memoryKey(namespace, key))) : fallback));
    engine.buses.cores.register('storage.chatMemory.set', ({ namespace, key, value }) => { chatMemory.set(memoryKey(namespace, key), clone(value)); return true; });
    engine.buses.cores.register('model.workers.get', () => workerList);
    engine.buses.cores.register('summary.list', () => []);
    engine.buses.cores.register('chatHistory.messages', () => [{ mesid: '10' }]);
    engine.buses.cores.register('generation.tools', () => []);
    engine.buses.cores.register('generation.callTool', () => ({ ok: true }));
    engine.buses.cores.register('model.generate', async params => {
        if (params.workerId === 'director') return turnReply();
        return { text: 'writer', toolCalls: [] };
    });
    engine.buses.network.register('http.request', async params => {
        providerCalls.push(params);
        if (provider) return provider(params);
        return { status: 200, ok: true, text: JSON.stringify({ choices: [{ message: { content: 'Writer reply' } }] }) };
    });
    registerStGenerationService(engine.buses.services, { target });
    const pipelineCore = createPipelineCore(engine.registerCaller('core.pipeline', 'cores', { tier: 'official' }), {
        resolveAs: engine.resolveAs,
        publish: (event, payload) => engine.events.emit(event, payload),
    });
    pipelineCore.define({ id: BEFORE_SEND, mode: 'collect' });
    pipelineCore.define({ id: PAYLOAD, mode: 'fold' });
    const generation = createGenerationCore(engine.registerCaller('core.generation', 'cores', { tier: 'official' }), {
        resolveAs: engine.resolveAs, pipelines: pipelineCore,
        publish: (event, payload) => engine.events.emit(event, payload),
    });
    const decision = createDecisionCore(engine.registerCaller('core.decision', 'cores', { tier: 'official', networkAccess: true }), {
        publish: (event, payload) => engine.events.emit(event, payload),
    });
    return {
        engine, target, pipelineCore, generation, decision, providerCalls, backendCalls,
        async load() {
            await decision.load();
            await decision.configure({ decider: { workerId: 'director' }, writer: { workerId: writerId, applySampler: true, temperature: 0.5, maxTokens: 64 } });
            await generation.install();
        },
    };
}

async function pendingTurn(harness) {
    const result = await harness.pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'Hello?', is_user: true }], type: 'normal' } });
    assert.equal(result.ok, true, result.error?.message);
}

function stPayload(overrides = {}) {
    return {
        model: 'openrouter/model', chat_completion_source: 'openrouter', stream: false,
        temperature: 0.2, top_p: 0.9, max_tokens: 40,
        messages: [{ role: 'system', content: 'ST assembled body' }], ...overrides,
    };
}

const send = (harness, payload, options = {}) => harness.target.fetch('/api/backends/chat-completions/generate', {
    method: 'POST', body: JSON.stringify(payload), ...options,
});

test('the owner regression: ST uses OpenRouter while the writer connection is NanoGPT — the request goes to NanoGPT with its own key and model', async () => {
    const harness = build();
    await harness.load();
    await pendingTurn(harness);

    const response = await send(harness, stPayload());
    const body = await response.json();

    assert.equal(harness.backendCalls.length, 0, 'the ST backend must not be called at all');
    assert.equal(harness.providerCalls.length, 1);
    const sent = harness.providerCalls[0];
    assert.equal(sent.url, `${ENDPOINT}/chat/completions`);
    assert.equal(sent.headers.Authorization, `Bearer ${FAKE_KEY}`);
    const requestBody = JSON.parse(sent.body);
    assert.equal(requestBody.model, 'nano/model', 'the ST OpenRouter model is not reused');
    assert.equal(requestBody.model.includes('openrouter'), false);
    assert.equal(body.choices[0].message.content, 'Writer reply');
});

test('the writer request has the writer context, no tools and no reasoning, and applies the writer sampler', async () => {
    const harness = build();
    await harness.load();
    await pendingTurn(harness);
    await send(harness, stPayload());
    const body = JSON.parse(harness.providerCalls[0].body);
    assert.match(JSON.stringify(body.messages), /You are the Writer of a roleplay/);
    assert.match(JSON.stringify(body.messages), /PUSH — what happens this turn/);
    assert.equal('tools' in body, false);
    assert.equal('reasoning_effort' in body, false);
    assert.equal(body.temperature, 0.5, 'applySampler takes the writer settings');
    assert.equal(body.max_tokens, 64);
});

test('streaming: the provider SSE reaches ST as frames and ends with [DONE]; Claude gets its own delta shape', async () => {
    const harness = build({
        provider: params => {
            params.onChunk(frame('Hel'));
            params.onChunk(frame('lo'));
            params.onChunk({ data: '[DONE]' });
            return { status: 200, ok: true, text: 'data: x\n\ndata: [DONE]\n\n' };
        },
    });
    await harness.load();
    await pendingTurn(harness);

    const response = await send(harness, stPayload({ stream: true }));
    const text = await response.text();
    assert.equal(response.headers.get('Content-Type'), 'text/event-stream');
    assert.match(text, /data: \{"choices":\[\{"delta":\{"content":"Hel"\}\}\]\}/);
    assert.match(text, /data: \[DONE\]/);

    const claude = await send(harness, stPayload({ stream: true, chat_completion_source: 'claude' }));
    const claudeText = await claude.text();
    assert.match(claudeText, /content_block_delta/);
    assert.match(claudeText, /"text":"Hel"/);
});

test('Stop: the ST abort signal reaches the provider request and cuts it off', async () => {
    let aborted = false;
    const harness = build({
        provider: params => new Promise(resolve => {
            params.signal?.addEventListener('abort', () => {
                aborted = true;
                resolve({ status: 499, ok: false, text: JSON.stringify({ error: { message: 'aborted' } }) });
            });
        }),
    });
    await harness.load();
    await pendingTurn(harness);
    const controller = new AbortController();

    const response = send(harness, stPayload(), { signal: controller.signal });
    while (!harness.providerCalls.length) await new Promise(done => setTimeout(done, 1));
    controller.abort();
    await response;

    assert.equal(aborted, true, 'the provider request really saw the abort');
});

test('401, 429 and a network failure become a clear ST error with the connection name and no key', async () => {
    for (const [status, detail] of [[401, 'invalid key'], [429, 'slow down']]) {
        const harness = build({ provider: () => ({ status, ok: false, text: JSON.stringify({ error: { message: detail } }) }) });
        await harness.load();
        await pendingTurn(harness);
        const response = await send(harness, stPayload());
        const text = await response.text();
        const message = JSON.parse(text).error.message;
        assert.equal(response.status, status);
        assert.match(message, /Writer connection "writer"/);
        assert.match(message, new RegExp(detail));
        assert.equal(text.includes(FAKE_KEY), false, 'the key must never appear in an error');
    }

    const failing = build({ provider: () => { throw new Error('connection reset'); } });
    await failing.load();
    await pendingTurn(failing);
    const response = await send(failing, stPayload());
    assert.equal(response.status, 502);
    assert.match(JSON.parse(await response.text()).error.message, /Writer connection "writer"/);
});

test('no writer connection: the request goes to ST as before, with the body rewritten but the ST model kept', async () => {
    const harness = build({ writerId: '' });
    await harness.load();
    await pendingTurn(harness);
    const response = await send(harness, stPayload());
    assert.equal(harness.providerCalls.length, 0, 'the ME provider is not touched');
    assert.equal(harness.backendCalls.length, 1, 'ST still sends its own request');
    const body = JSON.parse(harness.backendCalls[0].body);
    assert.equal(body.model, 'openrouter/model');
    assert.match(JSON.stringify(body.messages), /You are the Writer of a roleplay/);
    assert.equal(response.ok, true);
});

test('writer response translation: openai passes through, Claude/Google/Cohere get their own shapes', () => {
    const data = JSON.stringify({ choices: [{ delta: { content: 'Hi' } }] });
    assert.equal(translateWriterFrame(data, 'openai'), data);
    assert.match(translateWriterFrame(data, 'anthropic'), /"text":"Hi"/);
    assert.match(translateWriterFrame(data, 'google'), /"parts":\[\{"text":"Hi"\}\]/);
    assert.match(translateWriterFrame(data, 'cohere'), /"content":\{"text":"Hi"\}/);
    assert.equal(translateWriterFrame('[DONE]', 'anthropic'), '[DONE]');
    assert.equal(writerSourceFormat('makersuite'), 'google');
    assert.equal(writerSourceFormat('nano-gpt'), 'openai');
});
