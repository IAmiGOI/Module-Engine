import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMainConnectionRequest, describeMainConnection, extractMainConnectionText, stMainWorkerRecord } from '../libraries/core/st-main-request.js';

const chatContext = {
    mainApi: 'openai',
    chatCompletionSettings: { chat_completion_source: 'custom', custom_url: 'http://local/v1', custom_include_body: 'x: 1', reverse_proxy: '', proxy_password: '' },
    getChatCompletionModel: () => 'my-model',
};

test('the SillyTavern chat completion connection becomes a request to ST\'s own backend with its current source and model', () => {
    const { url, body } = buildMainConnectionRequest(chatContext, { prompt: 'hi', systemPrompt: 'be brief', maxTokens: 16, temperature: 0 });

    assert.equal(url, '/api/backends/chat-completions/generate');
    assert.equal(body.chat_completion_source, 'custom');
    assert.equal(body.model, 'my-model');
    assert.equal(body.custom_url, 'http://local/v1');
    assert.equal(body.custom_include_body, 'x: 1');
    assert.equal(body.stream, false);
    assert.deepEqual(body.messages, [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }]);
});

test('a text completion connection gets one joined prompt and the api type from ST settings', () => {
    const context = { mainApi: 'textgenerationwebui', textCompletionSettings: { type: 'koboldcpp' }, getTextGenServer: () => 'http://127.0.0.1:5001' };

    const { url, body } = buildMainConnectionRequest(context, { messages: [{ role: 'system', content: 'a' }, { role: 'user', content: 'b' }], maxTokens: 8 });

    assert.equal(url, '/api/backends/text-completions/generate');
    assert.equal(body.prompt, 'a\n\nb');
    assert.equal(body.api_type, 'koboldcpp');
    assert.equal(body.api_server, 'http://127.0.0.1:5001');
    assert.equal(body.max_new_tokens, 8);
});

test('an API that cannot be called this way is refused with a message naming it', () => {
    assert.equal(describeMainConnection({ mainApi: 'novel' }).supported, false);
    assert.throws(() => buildMainConnectionRequest({ mainApi: 'novel' }, { prompt: 'x' }), /"novel"/);
});

test('the reply text is found in OpenAI, Claude, Gemini and text completion shapes', () => {
    assert.equal(extractMainConnectionText({ choices: [{ message: { content: 'a' } }] }), 'a');
    assert.equal(extractMainConnectionText({ content: [{ type: 'text', text: 'b' }] }), 'b');
    assert.equal(extractMainConnectionText({ candidates: [{ content: { parts: [{ text: 'c' }] } }] }), 'c');
    assert.equal(extractMainConnectionText({ choices: [{ text: 'd' }] }), 'd');
    assert.equal(extractMainConnectionText({ results: [{ text: 'e' }] }), 'e');
});

test('the worker record for the main connection carries no endpoint or key of its own', () => {
    assert.deepEqual(stMainWorkerRecord(), { name: 'SillyTavern main connection', id: 'st-main', format: 'sillytavern', endpoint: '', apiKey: '', model: '' });
});
