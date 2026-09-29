import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, estimateMessageTokens, summarizeTokens } from '../libraries/core/pm-tokens.js';
import { trimMessages } from '../libraries/core/pm-trim.js';

const flatCount = () => 10; // каждое сообщение — 10 токенов, чтобы считать в уме
const history = n => Array.from({ length: n }, (_, hid) => ({ role: hid % 2 ? 'assistant' : 'user', content: `m${hid}`, _hid: hid }));

test('the estimator is proportional to length and cheaper for Latin than for Cyrillic text', () => {
    assert.equal(estimateTokens(''), 0);
    assert.ok(estimateTokens('hello world hello world') < estimateTokens('привет мир привет мир'));
    assert.ok(estimateTokens('a'.repeat(400)) >= 90 && estimateTokens('a'.repeat(400)) <= 110);
});

test('a message costs its text plus overhead, tool calls and images add their own weight', () => {
    assert.equal(estimateMessageTokens({ role: 'user', content: '' }), 4);
    assert.ok(estimateMessageTokens({ role: 'assistant', content: '', tool_calls: [{ id: 'x', function: { name: 'Notebook', arguments: '{}' } }] }) > 4);
});

test('the summary attributes tokens to blocks and to history', () => {
    const { total, byBlock } = summarizeTokens([{ role: 'system', content: 'abcd', _block: 'main' }, { role: 'user', content: 'abcd', _hid: 0 }]);
    assert.equal(byBlock.get('main'), 5);
    assert.equal(byBlock.get('history'), 5);
    assert.equal(total, 10);
});

test('nothing is dropped while the prompt fits the budget', () => {
    const result = trimMessages(history(5), { budget: 100, count: flatCount });
    assert.equal(result.messages.length, 5);
    assert.deepEqual(result.dropped, []);
});

test('the oldest history goes first and extra headroom is cut so the next turns do not move the start again', () => {
    const result = trimMessages(history(10), { budget: 90, headroom: 0.2, count: flatCount });
    // цель = 72, значит остаётся 7 сообщений, а не 9
    assert.equal(result.messages.length, 7);
    assert.equal(result.cut, 3);
    const next = trimMessages([...history(10), { role: 'user', content: 'new', _hid: 10 }], { budget: 90, headroom: 0.2, prevCut: result.cut, count: flatCount });
    assert.equal(next.messages[0]._hid, 3); // префикс не сдвинулся, влезло без новой обрезки
});

test('a cut that was already made is never rolled back even when there is room again', () => {
    const result = trimMessages(history(6), { budget: 1000, prevCut: 2, count: flatCount });
    assert.equal(result.messages[0]._hid, 2);
    assert.equal(result.dropped[0].reason, 'stable cut');
});

test('the last message and protected blocks are never dropped', () => {
    const messages = [{ role: 'system', content: 'main', _block: 'main' }, ...history(3)];
    const result = trimMessages(messages, { budget: 15, count: flatCount });
    assert.ok(result.messages.some(m => m._block === 'main'));
    assert.equal(result.messages.at(-1)._hid, 2);
    assert.equal(result.overBudget, true);
});

test('a low priority block is dropped before any history', () => {
    const messages = [{ role: 'system', content: 'lore', _block: 'lore', _priority: 20 }, ...history(4)];
    const result = trimMessages(messages, { budget: 45, headroom: 0, count: flatCount });
    assert.equal(result.messages.some(m => m._block === 'lore'), false);
    assert.equal(result.messages.filter(m => m._hid !== undefined).length, 4);
});

test('a tool call and its results are removed together and never separated', () => {
    const messages = [
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1' }], _hid: 0 }, { role: 'tool', content: 'ok', tool_call_id: 'c1', _hid: 1 },
        { role: 'user', content: 'a', _hid: 2 }, { role: 'assistant', content: 'b', _hid: 3 },
    ];
    const result = trimMessages(messages, { budget: 25, headroom: 0, count: flatCount });
    assert.deepEqual(result.messages.map(m => m._hid), [2, 3]);
});
