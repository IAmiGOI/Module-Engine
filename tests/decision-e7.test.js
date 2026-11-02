import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { createPipelineCore } from '../cores/pipeline/index.js';
import { createDecisionCore } from '../cores/decision/index.js';

const BEFORE_SEND = 'generation.beforeSend';
const memoryKey = (namespace, key) => `${namespace}:${key}`;
const clone = value => JSON.parse(JSON.stringify(value));
let callCounter = 0;
const call = (name, args) => ({ text: '', toolCalls: [{ id: `${name}_${(callCounter += 1)}`, name, arguments: args }] });

async function build({ replies, seed = {}, settings = {} }) {
    const engine = createEngine();
    const storedSettings = new Map();
    const memory = new Map(Object.entries(seed).map(([key, value]) => [key, clone(value)]));
    const calls = [];
    const events = [];
    let index = 0;
    engine.buses.cores.register('storage.settings.get', ({ namespace, key, fallback }) => storedSettings.has(memoryKey(namespace, key)) ? clone(storedSettings.get(memoryKey(namespace, key))) : fallback);
    engine.buses.cores.register('storage.settings.set', ({ namespace, key, value }) => { storedSettings.set(memoryKey(namespace, key), clone(value)); return true; });
    engine.buses.cores.register('storage.chatMemory.get', ({ namespace, key, fallback }) => memory.has(memoryKey(namespace, key)) ? clone(memory.get(memoryKey(namespace, key))) : fallback);
    engine.buses.cores.register('storage.chatMemory.set', ({ namespace, key, value }) => { memory.set(memoryKey(namespace, key), clone(value)); return true; });
    engine.buses.cores.register('model.workers.get', () => [{ id: 'director', format: 'openai' }]);
    engine.buses.cores.register('summary.list', () => []);
    engine.buses.cores.register('chatHistory.messages', () => []);
    engine.buses.cores.register('chatHistory.annotations', () => ({}));
    engine.buses.cores.register('embedding.compute', () => null);
    engine.buses.cores.register('embedding.similarity', () => 0);
    engine.buses.cores.register('ui.notify', () => true);
    engine.buses.cores.register('generation.tools', () => []);
    engine.buses.cores.register('generation.callTool', () => 'ok');
    engine.buses.cores.register('model.generate', async params => {
        calls.push(params);
        engine.events.emit('model.generate.raw', {
            requestId: params.requestId, format: 'openai',
            body: JSON.stringify({ choices: [{ message: { reasoning_content: `thought for ${params.requestId}` } }] }),
        });
        return replies[index++] ?? { text: '', toolCalls: [] };
    });
    engine.events.subscribe('decision.log.compacted', payload => events.push(['compacted', payload]));
    engine.events.subscribe('decision.log.warning', payload => events.push(['warning', payload]));

    const pipelineCore = createPipelineCore(engine.registerCaller('core.pipeline', 'cores', { tier: 'official' }), {
        resolveAs: engine.resolveAs,
        publish: (event, payload) => engine.events.emit(event, payload),
    });
    pipelineCore.define({ id: BEFORE_SEND, mode: 'collect' });
    const core = createDecisionCore(engine.registerCaller('core.decision', 'cores', { tier: 'official' }), { retryDelayMs: 0 });
    await core.load();
    await core.configure({ assessSeed: 1, decider: { workerId: 'director' }, ...settings });
    return { pipelineCore, core, calls, memory, events };
}

const form = () => call('submit_turn', {
    comment: 'The form is ready for the writer.', resolution: 'They move on.', userResult: 'The user waits.',
    scene: { minutes: 5 }, characters: [],
});
const setPlan = () => call('set_plan', { direction: 'Keep the keep moving.', comment: 'A direction is required before the form.' });
const oldCycle = (index, event = 'turn') => ({
    id: `old_${index}`, runId: `old_run_${index}`, at: index * 100, event, turn: index,
    messages: [{ role: 'user', content: `old message ${index} ${'word '.repeat(20)}` }],
    toolCalls: [], thinking: `thought ${index}`, tokens: 100, warnings: [],
});

test('after the third turn the first is compressed, its full cycles are archived, and the log keeps two turns', async () => {
    const { pipelineCore, core } = await build({ replies: [setPlan(), form(), form(), form()] });
    for (let turn = 1; turn <= 3; turn += 1) {
        const result = await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: `run_${turn}`, chat: [{ mes: `m${turn}` }], type: 'normal' } });
        assert.equal(result.ok, true);
    }
    assert.equal(core.log().length, 2, 'only turns 2 and 3 stay full');
    assert.equal(core.archive().length, 1, 'the first turn is archived whole');
    assert.equal(core.digests().length, 1);
    assert.match(core.digests()[0].text, /^TURN 1 \(compressed\)/);
});

test('with no closed arcs the over-limit compressed part warns instead of losing records', async () => {
    const long = 'OLD-DIGEST '.repeat(200);
    const { pipelineCore, core, memory, events } = await build({
        replies: [setPlan(), form()],
        seed: {
            [memoryKey('core.decision', 'log')]: [oldCycle(1), oldCycle(2)],
            [memoryKey('core.decision', 'turnDigests')]: [{ key: 'old', at: 100, text: long, tokens: 2000 }],
        },
        settings: { compressedLimitTokens: 10 },
    });
    const result = await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'hi' }], type: 'normal' } });
    assert.equal(result.ok, true);
    assert.equal(events.some(([type, payload]) => type === 'warning' && /no closed arcs/.test(payload.reason)), true);
    assert.equal(memory.get(memoryKey('core.decision', 'turnDigests'))[0].text, long, 'the seed record is untouched');
    assert.equal(core.log().length, 2, 'the two newest turns stay full');
});

test('thinking lives exactly as long as the two full turns and stays whole in the archive', async () => {
    const replies = [setPlan(), form(), form(), form(), form(), form(), form()];
    const { pipelineCore, core } = await build({ replies, settings: { compressedLimitTokens: 1000000 } });
    for (let turn = 1; turn <= 6; turn += 1) {
        const result = await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: `run_${turn}`, chat: [{ mes: `m${turn}` }], type: 'normal' } });
        assert.equal(result.ok, true);
    }
    assert.equal(core.log().length, 2);
    assert.equal(core.archive().length, 4);
    assert.equal(core.digests().length, 4);
    assert.equal(core.log().every(cycle => Boolean(cycle.thinking)), true, 'the two full turns keep their thinking');
    assert.equal(core.archive().every(cycle => Boolean(cycle.thinking)), true, 'the archive keeps the full cycles, thinking included');
    assert.equal(core.digests().every(record => !/thought for/.test(record.text)), true, 'the digest drops thinking');
});
