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

// --- Ризонинг: три разных настоящих API, ни одного общего поля -------------

test('a request with no reasoning fields at all sends NOTHING extra — the bare REQUEST fixture above must stay a safe, inert baseline for every other test in this file', () => {
    const anthropic = buildProviderRequest({ endpoint: 'https://api.example.com', format: 'anthropic' }, REQUEST);
    const google = buildProviderRequest({ endpoint: 'https://generativelanguage.googleapis.com/v1', model: 'g', format: 'google' }, REQUEST);
    const openai = buildProviderRequest({ endpoint: 'https://openrouter.ai/api/v1', format: 'openai' }, REQUEST);

    assert.equal('thinking' in JSON.parse(anthropic.body), false);
    assert.equal('thinkingConfig' in JSON.parse(google.body).generationConfig, false);
    assert.equal('reasoning' in JSON.parse(openai.body), false);
});

test('openai reasoning ONLY goes to a real OpenRouter endpoint — a generic OpenAI-compatible one gets nothing, since there is no shared standard for it', () => {
    const generic = buildProviderRequest(
        { endpoint: 'https://api.example.com/v1', format: 'openai' },
        { ...REQUEST, reasoningMode: 'enabled', reasoningEffort: 'high', reasoningBudget: 2000 },
    );
    const openRouter = buildProviderRequest(
        { endpoint: 'https://openrouter.ai/api/v1', format: 'openai' },
        { ...REQUEST, reasoningMode: 'enabled', reasoningEffort: 'high', reasoningBudget: 2000 },
    );

    assert.equal('reasoning' in JSON.parse(generic.body), false);
    assert.deepEqual(JSON.parse(openRouter.body).reasoning, { enabled: true, effort: 'high', max_tokens: 2000 });
});

test('openai reasoning "disabled" is sent as an explicit choice, distinct from silence ("inherit")', () => {
    const built = buildProviderRequest(
        { endpoint: 'https://openrouter.ai/api/v1', format: 'openai' },
        { ...REQUEST, reasoningMode: 'disabled', reasoningEffort: 'low', reasoningBudget: 0 },
    );

    assert.deepEqual(JSON.parse(built.body).reasoning, { enabled: false, effort: 'low' });
});

test('openai reasoning stays silent on "inherit" — the provider decides, nothing is sent either way', () => {
    const built = buildProviderRequest(
        { endpoint: 'https://openrouter.ai/api/v1', format: 'openai' },
        { ...REQUEST, reasoningMode: 'inherit' },
    );

    assert.equal('reasoning' in JSON.parse(built.body), false);
});

test('anthropic "enabled" sends a real thinking budget, clamped to Anthropic\'s own minimum of 1024', () => {
    const built = buildProviderRequest(
        { endpoint: 'https://api.example.com', format: 'anthropic' },
        { ...REQUEST, maxTokens: 4000, reasoningMode: 'enabled', reasoningBudget: 200 },
    );

    assert.deepEqual(JSON.parse(built.body).thinking, { type: 'enabled', budget_tokens: 1024 });
});

test('anthropic "enabled" never sends a budget that reaches or exceeds max_tokens — Anthropic requires it strictly smaller', () => {
    const built = buildProviderRequest(
        { endpoint: 'https://api.example.com', format: 'anthropic' },
        { ...REQUEST, maxTokens: 2000, reasoningMode: 'enabled', reasoningBudget: 999999 },
    );

    assert.equal(JSON.parse(built.body).thinking.budget_tokens, 1999);
});

test('anthropic "enabled" with a max_tokens too small to hold ANY valid budget sends no thinking at all, rather than a request Anthropic is guaranteed to refuse', () => {
    const built = buildProviderRequest(
        { endpoint: 'https://api.example.com', format: 'anthropic' },
        { ...REQUEST, maxTokens: 500, reasoningMode: 'enabled', reasoningBudget: 200 },
    );

    assert.equal('thinking' in JSON.parse(built.body), false);
});

test('anthropic "disabled" is sent explicitly, not just silence', () => {
    const built = buildProviderRequest(
        { endpoint: 'https://api.example.com', format: 'anthropic' },
        { ...REQUEST, reasoningMode: 'disabled' },
    );

    assert.deepEqual(JSON.parse(built.body).thinking, { type: 'disabled' });
});

test('google "enabled" with an explicit budget sends that exact number', () => {
    const built = buildProviderRequest(
        { endpoint: 'https://generativelanguage.googleapis.com/v1', model: 'g', format: 'google' },
        { ...REQUEST, reasoningMode: 'enabled', reasoningBudget: 3000 },
    );

    assert.deepEqual(JSON.parse(built.body).generationConfig.thinkingConfig, { thinkingBudget: 3000 });
});

test('google "enabled" with NO explicit budget asks for -1 — "let the model decide", not a hardcoded guess', () => {
    const built = buildProviderRequest(
        { endpoint: 'https://generativelanguage.googleapis.com/v1', model: 'g', format: 'google' },
        { ...REQUEST, reasoningMode: 'enabled', reasoningBudget: 0 },
    );

    assert.deepEqual(JSON.parse(built.body).generationConfig.thinkingConfig, { thinkingBudget: -1 });
});

test('google "disabled" sends an explicit zero budget', () => {
    const built = buildProviderRequest(
        { endpoint: 'https://generativelanguage.googleapis.com/v1', model: 'g', format: 'google' },
        { ...REQUEST, reasoningMode: 'disabled' },
    );

    assert.deepEqual(JSON.parse(built.body).generationConfig.thinkingConfig, { thinkingBudget: 0 });
});
