import test from 'node:test';
import assert from 'node:assert/strict';
import { createSseFrameParser } from '../libraries/core/sse-stream.js';

test('createSseFrameParser() yields one frame for one complete push', () => {
    const parser = createSseFrameParser();
    const frames = parser.push('data: {"text":"hi"}\n\n');
    assert.deepEqual(frames, [{ event: null, data: '{"text":"hi"}' }]);
});

test('createSseFrameParser() buffers a frame split across two push() calls — the real shape of fetch chunks', () => {
    const parser = createSseFrameParser();
    assert.deepEqual(parser.push('data: {"tex'), []);
    assert.deepEqual(parser.push('t":"hi"}\n\n'), [{ event: null, data: '{"text":"hi"}' }]);
});

test('createSseFrameParser() yields several frames delivered in a single chunk', () => {
    const parser = createSseFrameParser();
    const frames = parser.push('data: one\n\ndata: two\n\ndata: three\n\n');
    assert.deepEqual(frames.map(f => f.data), ['one', 'two', 'three']);
});

test('createSseFrameParser() reads the named "event" field — Anthropic frames carry event: content_block_delta', () => {
    const parser = createSseFrameParser();
    const frames = parser.push('event: content_block_delta\ndata: {"delta":{"text":"hi"}}\n\n');
    assert.equal(frames[0].event, 'content_block_delta');
    assert.equal(frames[0].data, '{"delta":{"text":"hi"}}');
});

test('createSseFrameParser() joins multiple data: lines in one frame with a newline, per the SSE spec', () => {
    const parser = createSseFrameParser();
    const frames = parser.push('data: line one\ndata: line two\n\n');
    assert.equal(frames[0].data, 'line one\nline two');
});

test('createSseFrameParser() ignores comment lines (starting with ":") used by some providers as keep-alives', () => {
    const parser = createSseFrameParser();
    const frames = parser.push(': keep-alive\ndata: real\n\n');
    assert.deepEqual(frames, [{ event: null, data: 'real' }]);
});

test('createSseFrameParser().flush() recovers a final frame the provider never closed with a trailing blank line', () => {
    const parser = createSseFrameParser();
    assert.deepEqual(parser.push('data: unterminated'), []);
    assert.deepEqual(parser.flush(), [{ event: null, data: 'unterminated' }]);
});

test('createSseFrameParser().flush() returns nothing for a stream that ended cleanly on a frame boundary', () => {
    const parser = createSseFrameParser();
    parser.push('data: done\n\n');
    assert.deepEqual(parser.flush(), []);
});
