import test from 'node:test';
import assert from 'node:assert/strict';
import { createCycleRecord, cycleTokens, totalLogTokens } from '../libraries/core/decision-log.js';

const cycle = (index, thinking = '') => createCycleRecord({
    id: `c${index}`, at: index, event: 'turn', thinking,
    messages: [{ role: 'assistant', content: `message ${index} ${'word '.repeat(20)}` }],
    toolCalls: [{ name: 'assess', args: { comment: 'why' }, result: { ok: true } }],
});

test('a cycle record counts its messages, tool calls and thinking', () => {
    const record = cycle(1, 'some thinking');
    assert.ok(record.tokens > 0);
    assert.equal(cycleTokens(record), record.tokens);
});

test('the log token count is the sum of the cycle records it still holds', () => {
    const cycles = [0, 1, 2].map(index => cycle(index, `thought ${index}`));
    assert.equal(totalLogTokens(cycles), cycles.reduce((sum, record) => sum + record.tokens, 0));
    assert.equal(totalLogTokens([]), 0);
});
