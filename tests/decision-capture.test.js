import test from 'node:test';
import assert from 'node:assert/strict';
import { captureReasoning } from '../cores/decision/capture.js';

function fakeHost() {
    const handlers = new Map();
    return {
        host: {
            events: {
                subscribe(name, handler) {
                    handlers.set(name, handler);
                    return () => handlers.delete(name);
                },
            },
        },
        emit(name, payload) { handlers.get(name)?.(payload); },
    };
}

test('streamed reasoning and text reach the window as they arrive, in order', () => {
    const { host, emit } = fakeHost();
    const thinking = [];
    const answer = [];
    const captured = captureReasoning(host, 'run_1:', { onThinking: text => thinking.push(text), onAnswer: text => answer.push(text), throttle: false });
    emit('model.generate.reasoning', { requestId: 'run_1:1', delta: 'the guard ' });
    emit('model.generate.reasoning', { requestId: 'run_1:1', delta: 'is tired' });
    emit('model.generate.chunk', { requestId: 'run_1:1', text: 'He looks' });
    emit('model.generate.chunk', { requestId: 'other:1', text: 'ignored' });
    assert.equal(captured.value, 'the guard is tired');
    assert.deepEqual(thinking, ['the guard ', 'the guard is tired']);
    assert.deepEqual(answer, ['He looks']);
    captured.stop();
});

test('a non-streaming raw body still gives reasoning and usage', () => {
    const { host, emit } = fakeHost();
    const captured = captureReasoning(host, 'run_1:');
    emit('model.generate.raw', {
        requestId: 'run_1:1', format: 'openai',
        body: JSON.stringify({ choices: [{ message: { reasoning_content: 'deep thought' } }], usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 6 } } }),
    });
    assert.equal(captured.value, 'deep thought');
    assert.deepEqual(captured.usage, { prompt: 10, completion: 4, cached: 6, total: 14 });
    captured.stop();
});

test('a streamed usage blob is counted once, without parsing the SSE body as JSON', () => {
    const { host, emit } = fakeHost();
    const captured = captureReasoning(host, 'run_1:');
    emit('model.generate.raw', { requestId: 'run_1:1', format: 'openai', body: 'data: {...}\\n\\ndata: [DONE]\\n\\n', usage: { prompt_tokens: 7, completion_tokens: 3 } });
    assert.deepEqual(captured.usage, { prompt: 7, completion: 3, cached: 0, total: 10 });
    captured.stop();
});

test('a flood of thinking deltas reaches the window only a few times, with the latest text, and the last one on stop', async () => {
    const { host, emit } = fakeHost();
    const seen = [];
    const captured = captureReasoning(host, 'run_1:', { onThinking: text => seen.push(text) });
    for (let index = 0; index < 200; index += 1) emit('model.generate.reasoning', { requestId: 'run_1:1:0', delta: 'x' });
    assert.equal(seen.length, 0, 'nothing is pushed per delta');
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].length, 200, 'the latest accumulated text');
    emit('model.generate.reasoning', { requestId: 'run_1:1:0', delta: 'y' });
    captured.stop();
    assert.equal(seen.at(-1).length, 201, 'stop() flushes the final text');
});
