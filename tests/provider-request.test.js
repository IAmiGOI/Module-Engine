import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProviderFormat, buildProviderRequest, resolveProviderResponseText } from '../libraries/core/provider-request.js';

const REQUEST = Object.freeze({ prompt: 'hello', systemPrompt: '', temperature: 0.5, maxTokens: 100, topP: 1, topK: 0, seed: 0 });

test('resolveProviderFormat() falls back to "openai" for an unrecognized or missing format — never throws', () => {
    assert.equal(resolveProviderFormat('openai'), 'openai');
    assert.equal(resolveProviderFormat('anthropic'), 'anthropic');
    assert.equal(resolveProviderFormat('google'), 'google');
    assert.equal(resolveProviderFormat('made-up'), 'openai');
    assert.equal(resolveProviderFormat(undefined), 'openai');
});

test('buildProviderRequest() for openai: appends /chat/completions, sets Bearer auth, shapes the messages array', () => {
    const worker = { endpoint: 'https://api.example.com/v1', apiKey: 'sk-123', model: 'gpt-test', format: 'openai' };

    const built = buildProviderRequest(worker, REQUEST);

    assert.equal(built.url, 'https://api.example.com/v1/chat/completions');
    assert.equal(built.headers.Authorization, 'Bearer sk-123');
    const body = JSON.parse(built.body);
    assert.equal(body.model, 'gpt-test');
    assert.deepEqual(body.messages, [{ role: 'user', content: 'hello' }]);
    assert.equal(body.temperature, 0.5);
});

test('buildProviderRequest() for openai does not double-append /chat/completions when the endpoint already ends with it', () => {
    const worker = { endpoint: 'https://api.example.com/v1/chat/completions', model: 'gpt-test', format: 'openai' };

    const built = buildProviderRequest(worker, REQUEST);

    assert.equal(built.url, 'https://api.example.com/v1/chat/completions');
});

test('buildProviderRequest() for openai with a systemPrompt prepends a system message before the user message', () => {
    const worker = { endpoint: 'https://api.example.com/v1', model: 'gpt-test', format: 'openai' };

    const built = buildProviderRequest(worker, { ...REQUEST, systemPrompt: 'be concise' });

    const body = JSON.parse(built.body);
    assert.deepEqual(body.messages, [{ role: 'system', content: 'be concise' }, { role: 'user', content: 'hello' }]);
});

test('buildProviderRequest() for openai omits Authorization entirely when apiKey is empty — no "Bearer undefined"', () => {
    const worker = { endpoint: 'https://api.example.com/v1', model: 'gpt-test', format: 'openai' };

    const built = buildProviderRequest(worker, REQUEST);

    assert.equal('Authorization' in built.headers, false);
});

test('buildProviderRequest() for anthropic: appends /messages, sets x-api-key + anthropic-version, puts systemPrompt in a top-level "system" field', () => {
    const worker = { endpoint: 'https://api.example.com', apiKey: 'ak-1', model: 'claude-test', format: 'anthropic' };

    const built = buildProviderRequest(worker, { ...REQUEST, systemPrompt: 'be terse' });

    assert.equal(built.url, 'https://api.example.com/messages');
    assert.equal(built.headers['x-api-key'], 'ak-1');
    assert.equal(built.headers['anthropic-version'], '2023-06-01');
    const body = JSON.parse(built.body);
    assert.equal(body.system, 'be terse');
    assert.deepEqual(body.messages, [{ role: 'user', content: 'hello' }]);
});

test('buildProviderRequest() for google: builds a :generateContent URL with the API key as a query param, no auth header', () => {
    const worker = { endpoint: 'https://generativelanguage.googleapis.com/v1', apiKey: 'gk-1', model: 'gemini-test', format: 'google' };

    const built = buildProviderRequest(worker, REQUEST);

    assert.equal(built.url, 'https://generativelanguage.googleapis.com/v1/gemini-test:generateContent?key=gk-1');
    assert.equal('Authorization' in built.headers, false);
    const body = JSON.parse(built.body);
    assert.equal(body.contents[0].parts[0].text, 'hello');
});

test('buildProviderRequest() for google folds a systemPrompt into the single text part, since Gemini generateContent has no separate system role here', () => {
    const worker = { endpoint: 'https://generativelanguage.googleapis.com/v1', apiKey: 'gk-1', model: 'gemini-test', format: 'google' };

    const built = buildProviderRequest(worker, { ...REQUEST, systemPrompt: 'be brief' });

    const body = JSON.parse(built.body);
    assert.match(body.contents[0].parts[0].text, /be brief[\s\S]*hello/);
});

test('resolveProviderResponseText() extracts the reply text for each format', () => {
    assert.equal(resolveProviderResponseText('openai', JSON.stringify({ choices: [{ message: { content: ' hi ' } }] })), 'hi');
    assert.equal(resolveProviderResponseText('anthropic', JSON.stringify({ content: [{ type: 'text', text: ' hi ' }] })), 'hi');
    assert.equal(resolveProviderResponseText('google', JSON.stringify({ candidates: [{ content: { parts: [{ text: ' hi ' }] } }] })), 'hi');
});

test('resolveProviderResponseText() returns "" for malformed JSON or an unexpected shape, never throws', () => {
    assert.equal(resolveProviderResponseText('openai', 'not json at all'), '');
    assert.equal(resolveProviderResponseText('openai', JSON.stringify({ unexpected: true })), '');
});
