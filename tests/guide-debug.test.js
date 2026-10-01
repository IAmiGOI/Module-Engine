import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRawResponse, createDebugLog } from '../libraries/core/guide-debug.js';

const SSE = [
    'data: {"choices":[{"delta":{"role":"assistant","reasoning_content":"thinking about it"}}]}',
    'data: {"choices":[{"delta":{"content":"Let me pull up "}}]}',
    'data: {"choices":[{"delta":{"content":"the sections.","tool_calls":[{"index":0,"function":{"name":"web.page","arguments":"{\\"id\\":\\"p1\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":100,"completion_tokens":20}}',
    'data: [DONE]',
].join('\n\n');

test('the raw provider answer is summed up with everything we normally throw away: tool calls the provider parsed itself, reasoning size, finish reasons, usage and unknown delta keys', () => {
    const summary = summarizeRawResponse({ status: 200, format: 'openai', body: SSE });
    assert.deepEqual([summary.status, summary.frames, summary.finishReasons, summary.contentChars, summary.reasoningChars], [200, 3, ['tool_calls'], 'Let me pull up the sections.'.length, 'thinking about it'.length]);
    assert.deepEqual(summary.providerToolCalls, [{ name: 'web.page', args: '{"id":"p1"}' }]);
    assert.deepEqual(summary.usage, { prompt_tokens: 100, completion_tokens: 20 });
    const single = summarizeRawResponse({ status: 200, body: JSON.stringify({ choices: [{ message: { content: 'Hi.', weird: 1 }, finish_reason: 'length' }] }) });
    assert.deepEqual([single.finishReasons, single.otherDeltaKeys, single.contentChars], [['length'], ['weird'], 3]);
    assert.equal(summarizeRawResponse({ status: 500, body: 'oops' }).frames, 0);
    assert.equal(summarizeRawResponse({ status: 200, body: 'x'.repeat(10000) }).bodyTail.length, 3500, 'the tail of a long body is kept');
});

test('the log keeps the last turns only, pairs a raw answer with its turn by request id, and prints readable JSON with long replies cut', () => {
    let clock = 1000;
    const log = createDebugLog({ now: () => (clock += 1), limit: 3 });
    for (const id of ['a', 'b', 'c', 'd']) log.begin({ requestId: id, kind: 'user' });
    assert.deepEqual(log.entries().map(entry => entry.requestId), ['b', 'c', 'd']);
    assert.equal(log.attachRaw('c', { status: 200, body: SSE }), true);
    assert.equal(log.attachRaw('zzz', { status: 200, body: SSE }), false);
    log.entries().at(-1).reply = 'x'.repeat(7000);
    const parsed = JSON.parse(log.toText({ worker: 'w1' }));
    assert.deepEqual([parsed.guideDebugLog, parsed.meta.worker, parsed.turns.length], [1, 'w1', 3]);
    assert.equal(parsed.turns[1].raw.providerToolCalls[0].name, 'web.page');
    assert.match(parsed.turns[2].reply, /\[\+1000 chars\]$/);
});