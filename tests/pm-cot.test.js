import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCot, shouldRunCot, extractStepOutput, buildStepMessages, runCot, CotStepError, buildCotInjection, cotRecord } from '../libraries/core/pm-cot.js';

const facts = text => ({ messages: [{ role: 'user', text }], chatLength: 4, vars: new Map() });
const step = (id, prompt) => ({ id, name: id, prompt });

test('Guided CoT is off by default and defaults follow the owner decisions', () => {
    const cot = normalizeCot(undefined);
    assert.equal(cot.enabled, false);
    assert.equal(cot.stepMaxTokens, 1500);
    assert.equal(cot.retries, 1);
    assert.equal(shouldRunCot(undefined, facts('x')), false);
});

test('CoT runs always, by a trigger, or only by hand depending on the mode', () => {
    const base = { enabled: true, steps: [step('a', 'p')] };
    assert.equal(shouldRunCot({ ...base, mode: 'always' }, facts('x')), true);
    assert.equal(shouldRunCot({ ...base, mode: 'trigger', condition: { type: 'keyword', words: ['fight'], scan: 1 } }, facts('a fight')), true);
    assert.equal(shouldRunCot({ ...base, mode: 'trigger', condition: { type: 'keyword', words: ['fight'], scan: 1 } }, facts('hello')), false);
    assert.equal(shouldRunCot({ ...base, mode: 'manual' }, facts('x')), false);
    assert.equal(shouldRunCot({ ...base, mode: 'manual' }, facts('x'), { manual: true }), true);
    assert.equal(shouldRunCot({ enabled: true, steps: [] }, facts('x')), false);
});

test('the text and the reasoning of a provider answer are told apart for the different provider shapes', () => {
    assert.deepEqual(extractStepOutput({ choices: [{ message: { content: 'hi', reasoning_content: 'because' } }] }), { text: 'hi', reasoning: 'because' });
    assert.deepEqual(extractStepOutput({ choices: [{ message: { content: 'hi', reasoning: 'r' } }] }), { text: 'hi', reasoning: 'r' });
    assert.deepEqual(extractStepOutput({ content: [{ type: 'thinking', thinking: 'deep' }, { type: 'text', text: 'ok' }] }), { text: 'ok', reasoning: 'deep' });
});

test('a step goes after the whole main prompt as a user message and carries earlier steps with their reasoning', () => {
    const messages = buildStepMessages([{ role: 'system', content: 'main' }], [{ text: 'one', reasoning: 'why' }], 'STEP 2');
    assert.deepEqual(messages, [{ role: 'system', content: 'main' }, { role: 'assistant', content: 'one', reasoning_content: 'why' }, { role: 'user', content: 'STEP 2' }]);
});

test('steps run in order and each one sees the previous answers', async () => {
    const seen = [];
    const progress = [];
    const result = await runCot({
        baseMessages: [{ role: 'system', content: 'main' }], steps: [step('a', 'PA'), step('b', 'PB')], cot: { workers: {} },
        sendStep: async (messages, { index }) => { seen.push(messages.map(m => m.content)); return { text: `out${index}`, reasoning: `r${index}` }; },
        onProgress: event => progress.push(`${event.phase}${event.index + 1}/${event.total}`),
    });
    assert.deepEqual(seen, [['main', 'PA'], ['main', 'out0', 'PB']]);
    assert.deepEqual(result.map(s => s.text), ['out0', 'out1']);
    assert.deepEqual(progress, ['start1/2', 'done1/2', 'start2/2', 'done2/2']);
});

test('a failing step is retried once and a second failure aborts the whole chain', async () => {
    let calls = 0;
    const ok = await runCot({ baseMessages: [], steps: [step('a', 'p')], sendStep: async () => { calls++; if (calls === 1) throw new Error('flaky'); return { text: 'fine' }; } });
    assert.equal(ok[0].text, 'fine');
    assert.equal(calls, 2);
    await assert.rejects(runCot({ baseMessages: [], steps: [step('a', 'p'), step('b', 'p')], sendStep: async () => { throw new Error('down'); } }), error => error instanceof CotStepError && error.stepIndex === 0 && /down/.test(error.message));
});

test('a step gets the model chosen for it and the token limit', async () => {
    let received = null;
    await runCot({ baseMessages: [], steps: [step('a', 'p')], cot: { stepWorkers: { a: 'w2' }, stepMaxTokens: 700 }, sendStep: async (_m, info) => { received = info; return { text: 'x' }; } });
    assert.equal(received.workerId, 'w2');
    assert.equal(received.maxTokens, 700);
});

test('the result of the steps becomes one message and one collapsed record for the chat', () => {
    const steps = [{ id: 'a', name: 'Plan', text: 'go left', reasoning: '' }];
    assert.equal(buildCotInjection(steps).role, 'system');
    assert.equal(buildCotInjection(steps, { injectAs: 'user' }).role, 'user');
    assert.ok(buildCotInjection(steps).content.includes('go left'));
    assert.deepEqual(cotRecord(steps, { at: 1 }), { at: 1, steps: [{ id: 'a', name: 'Plan', text: 'go left', reasoning: undefined }] });
});
