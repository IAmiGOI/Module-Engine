import test from 'node:test';
import assert from 'node:assert/strict';
import { createCycleContext } from '../cores/decision/cycle-context.js';
import { DIRECTOR_CONCRETE } from '../libraries/core/decision-prompts.js';

test('a turn whose thinking passes the limit is cut, and asked again with the thinking tail and a demand for concrete decisions', async () => {
    const watchers = new Map();
    const capture = (prefix, handlers) => { watchers.set(prefix, handlers); return { stop: () => watchers.delete(prefix) }; };
    const requests = [];
    const call = async (contract, params) => {
        assert.equal(contract, 'model.generate');
        requests.push(params);
        if (params.requestId.endsWith(':c')) return { text: '', toolCalls: [{ id: 'f', name: 'submit_turn', arguments: {} }] };
        return new Promise((resolve, reject) => {
            params.signal.addEventListener('abort', () => reject(new Error('aborted')));
            watchers.get(params.requestId).onThinking('Wait, actually... '.repeat(800));
        });
    };
    const cuts = [];
    const context = createCycleContext({ call, store: {}, capture });
    const generate = context.generateFor({
        settings: { decider: { workerId: 'director', maxTokens: 2000 } }, worker: { id: 'director' }, runId: 'run_1', prefix: '', startedAt: 1,
        thinkLimit: 2000, onCut: info => cuts.push(info),
    });
    const answer = await generate({ messages: [{ role: 'user', content: 'Turn.' }], tools: [], toolChoice: 'auto', returnMessage: true });
    assert.equal(answer.toolCalls[0].name, 'submit_turn');
    assert.equal(requests.length, 2);
    assert.equal(cuts.length, 1);
    const pushed = requests[1].messages.at(-1).content;
    assert.match(pushed, /Stop weighing options/);
    assert.ok(pushed.startsWith(DIRECTOR_CONCRETE.split('{{thinking}}')[0]), 'the PROMPTS.md section 21 text');
    assert.match(pushed, /Wait, actually/, 'the cut thinking is carried over, not lost');
    assert.ok(pushed.length < 6000, 'only the tail of the thinking');
});

test('without a limit the request goes once, as before', async () => {
    let count = 0;
    const context = createCycleContext({ call: async () => { count += 1; return { text: 'ok', toolCalls: [] }; }, store: {}, capture: () => ({ stop() {} }) });
    const generate = context.generateFor({ settings: { decider: { workerId: 'director' } }, worker: { id: 'director' }, runId: 'r', prefix: '', startedAt: 1 });
    await generate({ messages: [], tools: [], toolChoice: 'auto', returnMessage: true });
    assert.equal(count, 1);
});
