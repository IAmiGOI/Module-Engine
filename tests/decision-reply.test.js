import test from 'node:test';
import assert from 'node:assert/strict';
import { runDecisionCycle } from '../libraries/core/decision-agent.js';
import { deciderRequestParams, DECIDER_MIN_TOKENS_WITH_REASONING } from '../libraries/core/decision-settings.js';

const call = (name, args) => ({ id: `${name}_${Math.random()}`, name, arguments: { comment: 'This call has a real reason.', ...args } });

test('an empty answer is retried once with a doubled token limit instead of being taken as await', async () => {
    const seen = [];
    let step = 0;
    const result = await runDecisionCycle({
        messages: [{ role: 'system', content: 's' }],
        generate: async params => { seen.push(params.boost ?? 1); step += 1; return step === 1 ? { text: '', toolCalls: [] } : { text: '', toolCalls: [call('await', { reason: 'done' })] }; },
        handlers: { await: () => ({ ok: true }) },
        implicitAwait: true,
    });
    assert.deepEqual(seen, [1, 2]);
    assert.equal(result.type, 'await');
    assert.equal(result.implicit, undefined, 'the retry produced a real await, not an implicit one');
    assert.ok(result.warnings.some(warning => /cut off by the token limit/.test(warning)));
});

test('a reply in await becomes the director answer in the cycle messages', async () => {
    const result = await runDecisionCycle({
        messages: [],
        generate: async () => ({ text: '', toolCalls: [call('await', { reason: 'done', reply: 'Fixed: Emilia no longer knows Subaru.' })] }),
        handlers: { await: () => ({ ok: true }) },
    });
    assert.equal(result.reply, 'Fixed: Emilia no longer knows Subaru.');
    assert.equal(result.messages.at(-1).role, 'assistant');
    assert.equal(result.messages.at(-1).content, 'Fixed: Emilia no longer knows Subaru.');
});

test('with reasoning on, the director never asks for fewer tokens than the safe floor', () => {
    assert.equal(deciderRequestParams({ maxTokens: 2000, reasoningMode: 'enabled' }).maxTokens, DECIDER_MIN_TOKENS_WITH_REASONING);
    assert.equal(deciderRequestParams({ maxTokens: 2000, reasoningMode: 'disabled' }).maxTokens, 2000);
    assert.equal(deciderRequestParams({ maxTokens: 12000, reasoningMode: 'enabled' }).maxTokens, 12000);
});
