import test from 'node:test';
import assert from 'node:assert/strict';
import { cutAfterDigest, planHistoryFold, buildDigestPrompt, digestBlock, clampDigest, DIGEST_MAX_CHARS } from '../libraries/core/guide-digest.js';

const turn = (role, size) => ({ role, content: 'x'.repeat(size) });

test('under the limit nothing is folded; over it the oldest turns go until the fresh window fits, and the last two turns always stay', () => {
    const turns = Array.from({ length: 10 }, (_, index) => turn(index % 2 ? 'assistant' : 'user', 4000)); // ≈ 1000 tokens each
    assert.equal(planHistoryFold(turns, { limitTokens: 20000, keepTokens: 5000 }), 0);
    assert.equal(planHistoryFold(turns, { limitTokens: 5000, keepTokens: 3100 }), 7);
    assert.equal(planHistoryFold(turns, { limitTokens: 100, keepTokens: 0 }), 8);
});

test('messages up to the folded mark are skipped; a mark that fell out of the chat leaves everything', () => {
    const history = ['a', 'b', 'c', 'd'].map(id => ({ id }));
    assert.deepEqual(cutAfterDigest(history, 'b').map(message => message.id), ['c', 'd']);
    assert.deepEqual(cutAfterDigest(history, 'gone').map(message => message.id), ['a', 'b', 'c', 'd']);
    assert.equal(cutAfterDigest(history, '').length, 4);
});

test('the fold prompt carries the previous summary and the folded turns, the block is empty without a summary, and the summary is bounded', () => {
    const prompt = buildDigestPrompt('earlier facts', [{ role: 'user', content: 'make her terse' }, { role: 'assistant', content: 'done' }]);
    assert.ok(prompt.includes('earlier facts') && prompt.includes('User: make her terse') && prompt.includes('Assistant: done'));
    assert.match(buildDigestPrompt('', []), /\(nothing yet\)/);
    assert.equal(digestBlock('  '), '');
    assert.match(digestBlock('facts'), /^## Earlier in this conversation/);
    assert.equal(clampDigest('y'.repeat(DIGEST_MAX_CHARS + 50)).length, DIGEST_MAX_CHARS);
});
