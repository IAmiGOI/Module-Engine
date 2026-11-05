import test from 'node:test';
import assert from 'node:assert/strict';
import { lowestEffort } from '../cores/decision/writer-proxy.js';
import { buildProviderRequest } from '../libraries/core/provider-request.js';

test('the writer asks NanoGPT for no reasoning, or the lowest level the model accepts', () => {
    assert.equal(lowestEffort(['none', 'high']), 'none');
    assert.equal(lowestEffort(['low', 'high', 'max']), 'low');
    assert.equal(lowestEffort(null), null);
    const worker = { format: 'openai', endpoint: 'https://nano-gpt.com/api/v1/chat/completions', model: 'z-ai/glm-5.3-flash-uncensored', apiKey: 'k' };
    const built = buildProviderRequest(worker, { messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, reasoningMode: 'disabled', disabledEffort: 'low' }, { stream: true });
    const body = JSON.parse(built.body);
    assert.equal(body.reasoning_effort, 'low');
    assert.equal(body.reasoning, undefined);
});
