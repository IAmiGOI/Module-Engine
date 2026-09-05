import test from 'node:test';
import assert from 'node:assert/strict';
import { createContractBus } from '../libraries/shared/contract-bus.js';
import { request } from '../libraries/shared/request.js';
import { registerStGenerationService, isGenerationRequest, GENERATION_ENDPOINTS } from '../services/st-generation.js';

/**
 * Поддельный «глобальный объект» ровно той формы, что нужна обеим точкам
 * перехвата: место под именованную функцию перехватчика и собственный
 * `fetch`, который мы подменяем. Настоящий globalThis в тестах не трогаем —
 * иначе один тест ломал бы остальные.
 */
function fakeGlobal() {
    const sent = [];
    const target = {
        fetch: async (input, init) => {
            sent.push({ url: typeof input === 'string' ? input : input.url, body: init?.body });
            return new Response(JSON.stringify({ choices: [{ message: { content: 'real backend reply' } }] }), { status: 200 });
        },
    };
    return { target, sent };
}

function build() {
    const bus = createContractBus();
    const { target, sent } = fakeGlobal();
    const dispose = registerStGenerationService(bus, { target });
    return { bus, target, sent, dispose };
}

const call = (bus, contract, params) => request(bus, contract, { params });

test('isGenerationRequest() recognises every real SillyTavern generation endpoint', () => {
    for (const endpoint of GENERATION_ENDPOINTS) {
        assert.equal(isGenerationRequest(endpoint, { method: 'POST' }), true, endpoint);
    }
});

test('isGenerationRequest() ignores the status/props endpoints sharing the same prefix, and any non-POST', () => {
    assert.equal(isGenerationRequest('/api/backends/text-completions/status', { method: 'POST' }), false);
    assert.equal(isGenerationRequest('/api/backends/chat-completions/generate', { method: 'GET' }), false);
    assert.equal(isGenerationRequest('/api/chats/save', { method: 'POST' }), false);
});

test('isGenerationRequest() matches an absolute URL too — ST builds some requests with a full origin', () => {
    assert.equal(isGenerationRequest('http://127.0.0.1:8000/api/novelai/generate', { method: 'POST' }), true);
});

test('the interceptor is installed under the manifest name, and SillyTavern awaiting it really waits for us', async () => {
    const { bus, target } = build();
    const order = [];
    await call(bus, 'stGeneration.installInterceptor', {
        name: 'stmeBetaIntercept',
        handler: async () => { await new Promise(resolve => setTimeout(resolve, 20)); order.push('engine finished'); },
    });

    // Ровно то, что делает runGenerationInterceptors() в ST.
    await target.stmeBetaIntercept([], 4096, () => {}, 'normal');
    order.push('ST continued');

    assert.deepEqual(order, ['engine finished', 'ST continued']);
});

test('the interceptor receives ST\'s own chat copy, context size, abort and type', async () => {
    const { bus, target } = build();
    const seen = [];
    await call(bus, 'stGeneration.installInterceptor', { name: 'stmeBetaIntercept', handler: params => { seen.push(params); } });
    const chat = [{ mes: 'hi' }];
    const abort = () => {};

    await target.stmeBetaIntercept(chat, 4096, abort, 'quiet');

    assert.equal(seen[0].chat, chat, 'the very array ST will build the prompt from — editing it is how we contribute');
    assert.equal(seen[0].contextSize, 4096);
    assert.equal(seen[0].type, 'quiet');
    assert.equal(seen[0].abort, abort);
});

test('installing the interceptor without a name is refused — a name that does not match the manifest would be silently ignored by ST', async () => {
    const { bus } = build();

    const result = await call(bus, 'stGeneration.installInterceptor', { handler: () => {} });

    assert.equal(result.ok, false);
    assert.match(result.error.message, /"name" is required/);
});

test('uninstalling removes the global, so ST stops finding anything to call', async () => {
    const { bus, target } = build();
    await call(bus, 'stGeneration.installInterceptor', { name: 'stmeBetaIntercept', handler: () => {} });

    await call(bus, 'stGeneration.uninstallInterceptor', {});

    assert.equal('stmeBetaIntercept' in target, false);
});

test('a generation request is handed to the hook and sent on with the payload the hook returned', async () => {
    const { bus, target, sent } = build();
    const seen = [];
    await call(bus, 'stGeneration.installSendHook', {
        handler: params => { seen.push(params); return { payload: { ...params.payload, injected: true } }; },
    });

    await target.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify({ messages: [] }) });

    assert.deepEqual(seen[0].payload, { messages: [] });
    assert.equal(seen[0].endpoint, '/api/backends/chat-completions/generate');
    assert.deepEqual(JSON.parse(sent[0].body), { messages: [], injected: true }, 'ST must send OUR payload, not its own');
});

test('anything that is not a generation request passes through completely untouched', async () => {
    const { bus, target, sent } = build();
    let called = false;
    await call(bus, 'stGeneration.installSendHook', { handler: () => { called = true; return {}; } });

    await target.fetch('/api/chats/save', { method: 'POST', body: '{"chat":[]}' });

    assert.equal(called, false, 'the hook must never see unrelated traffic');
    assert.deepEqual(sent[0], { url: '/api/chats/save', body: '{"chat":[]}' });
});

test('a cancelled send never reaches the backend, and ST sees an ordinary not-ok response instead of a crash', async () => {
    const { bus, target, sent } = build();
    await call(bus, 'stGeneration.installSendHook', { handler: () => ({ cancel: true, reason: 'beforeSend pipeline aborted' }) });

    const response = await target.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: '{}' });

    assert.deepEqual(sent, [], 'nothing may reach the provider');
    assert.equal(response.ok, false);
    assert.equal((await response.json()).error.message, 'beforeSend pipeline aborted');
});

test('the hook can answer the request itself — the engine serving a generation without ST reaching any backend', async () => {
    const { bus, target, sent } = build();
    await call(bus, 'stGeneration.installSendHook', {
        handler: () => ({ replyWith: { choices: [{ message: { content: 'answered by the engine' } }] } }),
    });

    const response = await target.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: '{}' });

    assert.deepEqual(sent, []);
    assert.equal(response.ok, true);
    assert.equal((await response.json()).choices[0].message.content, 'answered by the engine');
});

test('a body that is not the JSON we expect is passed through untouched rather than breaking the user\'s generation', async () => {
    const { bus, target, sent } = build();
    let called = false;
    await call(bus, 'stGeneration.installSendHook', { handler: () => { called = true; return { cancel: true }; } });

    await target.fetch('/api/backends/kobold/generate', { method: 'POST', body: 'not json at all' });

    assert.equal(called, false);
    assert.deepEqual(sent[0].body, 'not json at all');
});

test('installing a second send hook is refused instead of quietly nesting one wrapper inside another', async () => {
    const { bus } = build();
    await call(bus, 'stGeneration.installSendHook', { handler: () => ({}) });

    const result = await call(bus, 'stGeneration.installSendHook', { handler: () => ({}) });

    assert.equal(result.ok, false);
    assert.match(result.error.message, /already installed/);
});

test('uninstalling restores the ORIGINAL fetch, so removing the engine leaves SillyTavern exactly as it was', async () => {
    const { bus, target } = build();
    const before = target.fetch;
    await call(bus, 'stGeneration.installSendHook', { handler: () => ({ cancel: true }) });
    assert.notEqual(target.fetch, before, 'installed');

    await call(bus, 'stGeneration.uninstallSendHook', {});

    assert.equal(target.fetch, before);
});

test('disposing the whole service undoes both hooks at once', async () => {
    const { bus, target, dispose } = build();
    const before = target.fetch;
    await call(bus, 'stGeneration.installInterceptor', { name: 'stmeBetaIntercept', handler: () => {} });
    await call(bus, 'stGeneration.installSendHook', { handler: () => ({}) });

    dispose();

    assert.equal(target.fetch, before);
    assert.equal('stmeBetaIntercept' in target, false);
});

test('the service reports what is actually installed, so the panel never has to guess', async () => {
    const { bus } = build();
    assert.deepEqual((await call(bus, 'stGeneration.installed', {})).value, { interceptor: null, sendHook: false });

    await call(bus, 'stGeneration.installInterceptor', { name: 'stmeBetaIntercept', handler: () => {} });
    await call(bus, 'stGeneration.installSendHook', { handler: () => ({}) });

    assert.deepEqual((await call(bus, 'stGeneration.installed', {})).value, { interceptor: 'stmeBetaIntercept', sendHook: true });
});
