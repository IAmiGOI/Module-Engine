import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { createPipelineCore } from '../cores/pipeline/index.js';
import { createDecisionCore } from '../cores/decision/index.js';

const BEFORE_SEND = 'generation.beforeSend';
const memoryKey = (namespace, key) => `${namespace}:${key}`;
const clone = value => JSON.parse(JSON.stringify(value));
const call = (name, args) => ({ text: '', toolCalls: [{ id: `${name}_1`, name, arguments: args }] });

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
const oldCycle = index => ({ id: `old_${index}`, at: index, event: 'turn', messages: [{ role: 'user', content: `old message ${index} ${'word '.repeat(20)}` }], toolCalls: [], thinking: '', tokens: 100, warnings: [] });

test('over the log limit the director summarizes closed arcs first, then the raw old cycles go to the archive', async () => {
    const { pipelineCore, core, calls, memory, events } = await build({
        replies: [setPlan(), form(), 'The old escape is over; the key is still missing.'],
        seed: {
            [memoryKey('core.decision', 'log')]: [oldCycle(1), oldCycle(2), oldCycle(3)],
            [memoryKey('core.decision', 'arcs')]: [{ id: 'arc_1', title: 'The old escape', status: 'closed', stages: [{ note: 'She got out.' }] }],
        },
        settings: { logLimitTokens: 50, archiveLimitTokens: 500000 },
    });
    const result = await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'hi' }], type: 'normal' } });
    assert.equal(result.ok, true);
    assert.ok(calls.some(params => String(params.prompt).includes('The old escape')));
    assert.match(core.arcs()[0].summary, /key is still missing/);
    assert.equal(core.log().length, 1, 'only the current cycle stays in the log');
    assert.equal(memory.get(memoryKey('core.decision', 'logArchive')).length, 3);
    assert.equal(events.some(([type]) => type === 'compacted'), true);
});

test('no closed arcs means a warning, not a corrupted log', async () => {
    const { pipelineCore, core, calls, memory, events } = await build({
        replies: [setPlan(), form()],
        seed: { [memoryKey('core.decision', 'log')]: [oldCycle(1), oldCycle(2), oldCycle(3)] },
        settings: { logLimitTokens: 50 },
    });
    const result = await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'hi' }], type: 'normal' } });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 2, 'no arc-summary call was made');
    assert.equal(core.log().length, 4, 'the log is untouched');
    assert.equal(core.archive().length, 0);
    assert.equal(events.some(([type, payload]) => type === 'warning' && /no closed arcs/.test(payload.reason)), true);
});

test('thinking is trimmed in batches: after six cycles only the last three keep it', async () => {
    const replies = [setPlan(), form(), form(), form(), form(), form(), form()];
    const { pipelineCore, core } = await build({ replies, settings: { logLimitTokens: 1000000 } });
    for (let turn = 1; turn <= 6; turn += 1) {
        const result = await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: `run_${turn}`, chat: [{ mes: `m${turn}` }], type: 'normal' } });
        assert.equal(result.ok, true);
    }
    const log = core.log();
    assert.equal(log.length, 6);
    assert.deepEqual(log.map(cycle => Boolean(cycle.thinking)), [false, false, false, true, true, true]);
});
