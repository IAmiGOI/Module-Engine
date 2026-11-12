import test from 'node:test';
import assert from 'node:assert/strict';
import { runDecisionCycle, normalizeAnswer } from '../libraries/core/decision-agent.js';

test('an answer cut off by the token limit is named in the warnings, not taken for a forgotten field', async () => {
    assert.equal(normalizeAnswer({ text: '', toolCalls: [], finishReason: 'length' }).finishReason, 'length');
    const answers = [{ text: '', toolCalls: [{ id: 'a', name: 'await', arguments: '{"comment":"Nothing more to do this turn."}' }], finishReason: 'length' }];
    const result = await runDecisionCycle({ messages: [{ role: 'user', content: 'go' }], tools: [], generate: async () => answers.shift() ?? { text: '', toolCalls: [{ id: 'b', name: 'await', arguments: '{}' }] }, handlers: {}, maxSteps: 2 });
    assert.ok(result.warnings.some(item => /cut off by the token limit \(finish_reason: length\)/.test(item)), JSON.stringify(result.warnings));
});
