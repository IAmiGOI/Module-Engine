import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBodyFormat, disableReasoning, computeWriterPayload, stripTools } from '../libraries/core/decision-body.js';
import { clampDecisionSettings, DEFAULT_SETTINGS } from '../libraries/core/decision-settings.js';

const context = {
    messages: [{ role: 'system', content: 'write' }, { role: 'user', content: 'hi' }],
    prompt: 'write\n\nUser: hi',
};

test('body format is Chat Completion / Text Completion, with the source choosing the dialect', () => {
    assert.equal(resolveBodyFormat({ messages: [] }), 'openai');
    assert.equal(resolveBodyFormat({ messages: [], chat_completion_source: 'openrouter' }), 'openai');
    assert.equal(resolveBodyFormat({ messages: [], chat_completion_source: 'claude' }), 'anthropic');
    assert.equal(resolveBodyFormat({ messages: [], chat_completion_source: 'makersuite' }), 'google');
    assert.equal(resolveBodyFormat({ prompt: 'text' }), 'text');
    assert.equal(resolveBodyFormat({}), null);
});

test('reasoning is removed for every format provider-request.js knows; OpenRouter, Anthropic and Google get an explicit off switch', () => {
    const base = { temperature: 0.5, messages: [], reasoning_effort: 'high', include_reasoning: true, thinking_budget: 400, stream: true };

    const openai = disableReasoning({ ...base, chat_completion_source: 'openai' }, 'openai');
    assert.equal('reasoning_effort' in openai, false);
    assert.equal('include_reasoning' in openai, false);
    assert.equal('reasoning' in openai, false);
    assert.equal(openai.temperature, 0.5);
    assert.equal(openai.stream, true);

    const openrouter = disableReasoning({ ...base, chat_completion_source: 'openrouter' }, 'openai');
    assert.deepEqual(openrouter.reasoning, { enabled: false });

    const anthropic = disableReasoning({ ...base, chat_completion_source: 'claude', thinking: { type: 'enabled' } }, 'anthropic');
    assert.equal('thinking_budget' in anthropic, false);
    assert.deepEqual(anthropic.thinking, { type: 'disabled' });

    const google = disableReasoning({ ...base, chat_completion_source: 'makersuite', generationConfig: { thinkingConfig: { thinkingBudget: 9 }, temperature: 1 } }, 'google');
    assert.deepEqual(google.generationConfig.thinkingConfig, { thinkingBudget: 0 }, 'a native Google body keeps the flag where the API expects it');
    assert.equal('thinkingConfig' in google, false);
    assert.equal(google.generationConfig.temperature, 1);

    const googleStBody = disableReasoning({ ...base, chat_completion_source: 'makersuite' }, 'google');
    assert.deepEqual(googleStBody.thinkingConfig, { thinkingBudget: 0 }, 'the ST body has no generationConfig, so the off switch sits on top');

    const text = disableReasoning({ ...base, prompt: 'x' }, 'text');
    assert.equal('reasoning_effort' in text, false);
    assert.equal('reasoning' in text, false);
});

test('a Chat Completion body gets the writer messages, keeps every other field, and never touches stream', () => {
    const body = computeWriterPayload({ model: 'st', temperature: 1, stream: true, max_tokens: 500, reasoning_effort: 'high', include_reasoning: true, messages: [{ role: 'system', content: 'ST assembled' }] }, context, { writer: {} });
    assert.deepEqual(body.messages, context.messages);
    assert.equal(body.stream, true);
    assert.equal(body.max_tokens, 500);
    assert.equal(body.temperature, 1);
    assert.equal('reasoning_effort' in body, false, 'computeWriterPayload always disables reasoning, even without a sampler override');
    assert.equal('include_reasoning' in body, false);
});

test('a Text Completion body gets the flat writer prompt instead of messages', () => {
    const body = computeWriterPayload({ prompt: 'ST prompt', max_new_tokens: 300, stream: true }, context, { writer: {} });
    assert.equal(body.prompt, context.prompt);
    assert.equal('messages' in body, false);
    assert.equal(body.max_new_tokens, 300);
});

test('an unknown body is left to the caller (null), so the send hook can pass it through untouched', () => {
    assert.equal(computeWriterPayload({ foo: 1 }, context, {}), null);
});

test('the writer sampler is applied only when the setting asks for it, and model is overridden only when a real model is given', () => {
    const untouched = computeWriterPayload({ messages: [], temperature: 1, max_tokens: 500 }, context, { writer: { applySampler: false, temperature: 0.1, maxTokens: 100 }, model: 'writer/model' });
    assert.equal(untouched.temperature, 1);
    assert.equal(untouched.max_tokens, 500);
    assert.equal(untouched.model, 'writer/model');

    const applied = computeWriterPayload({ messages: [], temperature: 1, max_tokens: 500 }, context, { writer: { applySampler: true, temperature: 0.1, topP: 0.8, topK: 20, maxTokens: 100 } });
    assert.equal(applied.temperature, 0.1);
    assert.equal(applied.top_p, 0.8);
    assert.equal(applied.top_k, 20);
    assert.equal(applied.max_tokens, 100);
});

test('settings clamp to safe defaults, and an explicit regen choice survives', () => {
    const clamped = clampDecisionSettings({ regen: 'writer', rules: 'Be brief.', decider: { temperature: 99, topP: -1, maxTokens: 0, reasoningMode: 'sometimes' }, writer: { topK: 'lots' } });
    assert.equal(clamped.regen, 'writer');
    assert.equal(clamped.rules, 'Be brief.');
    assert.equal(clamped.decider.temperature, 2);
    assert.equal(clamped.decider.topP, 0);
    assert.equal(clamped.decider.maxTokens, 1);
    assert.equal(clamped.decider.reasoningMode, 'inherit');
    assert.equal(clamped.writer.topK, 0);
    assert.equal('enabled' in clampDecisionSettings({}), false, 'there is no on/off switch anymore');
});

test('the writer body carries no tools: tools, tool_choice and the legacy function keys are stripped, while everything else survives', () => {
    const payload = {
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'Notebook' } }],
        tool_choice: 'auto',
        functions: [{ name: 'old' }],
        function_call: 'auto',
        parallel_tool_calls: true,
        temperature: 0.4,
        stream: true,
    };
    const body = computeWriterPayload(payload, context, { writer: {} });
    for (const key of ['tools', 'tool_choice', 'functions', 'function_call', 'parallel_tool_calls']) {
        assert.equal(key in body, false, `${key} must not reach the writer`);
    }
    assert.equal(body.temperature, 0.4);
    assert.equal(body.stream, true);
    assert.deepEqual(body.messages, context.messages);
});

test('stripTools() leaves a body without tools untouched and also clears nested generationConfig tool keys', () => {
    assert.deepEqual(stripTools({ prompt: 'x' }), { prompt: 'x' });
    const google = stripTools({ generationConfig: { temperature: 1, tools: [{ name: 'x' }], tool_config: {} } });
    assert.deepEqual(google.generationConfig, { temperature: 1 });
});
