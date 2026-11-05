import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { createPipelineCore } from '../cores/pipeline/index.js';
import { createDecisionCore } from '../cores/decision/index.js';

const BEFORE_SEND = 'generation.beforeSend';
const PAYLOAD = 'generation.payload';
const memoryKey = (namespace, key) => `${namespace}:${key}`;
const clone = value => JSON.parse(JSON.stringify(value));
const call = (name, args) => ({ text: '', toolCalls: [{ id: `${name}_1`, name, arguments: args }] });

async function build({ replies }) {
    const engine = createEngine();
    const settings = new Map();
    const memory = new Map();
    const calls = [];
    let index = 0;
    engine.buses.cores.register('storage.settings.get', ({ namespace, key, fallback }) => settings.has(memoryKey(namespace, key)) ? clone(settings.get(memoryKey(namespace, key))) : fallback);
    engine.buses.cores.register('storage.settings.set', ({ namespace, key, value }) => { settings.set(memoryKey(namespace, key), clone(value)); return true; });
    engine.buses.cores.register('storage.chatMemory.get', ({ namespace, key, fallback }) => memory.has(memoryKey(namespace, key)) ? clone(memory.get(memoryKey(namespace, key))) : fallback);
    engine.buses.cores.register('storage.chatMemory.set', ({ namespace, key, value }) => { memory.set(memoryKey(namespace, key), clone(value)); return true; });
    engine.buses.cores.register('model.workers.get', () => [{ id: 'director', format: 'openai', model: 'director/model' }]);
    engine.buses.cores.register('summary.list', () => []);
    engine.buses.cores.register('chatHistory.messages', () => []);
    engine.buses.cores.register('chatHistory.annotations', ({ namespace }) => namespace === 'module.time' ? { 5: 'Day 1, 08:00 (Morning)' } : {});
    engine.buses.cores.register('map.position.get', () => ({ nodeId: 'room' }));
    engine.buses.cores.register('map.nodes.list', () => [{ id: 'room', name: 'EAST CORRIDOR' }]);
    engine.buses.cores.register('map.nodes.containmentPath', ({ id }) => id === 'room' ? ['room'] : []);
    engine.buses.cores.register('embedding.compute', () => null);
    engine.buses.cores.register('embedding.similarity', () => 0);
    engine.buses.cores.register('ui.notify', () => true);
    engine.buses.cores.register('generation.tools', () => []);
    engine.buses.cores.register('generation.callTool', () => 'ok');
    engine.buses.cores.register('model.generate', async params => {
        calls.push(params);
        return replies[index++] ?? { text: '', toolCalls: [] };
    });
    const pipelineCore = createPipelineCore(engine.registerCaller('core.pipeline', 'cores', { tier: 'official' }), {
        resolveAs: engine.resolveAs,
        publish: (event, payload) => engine.events.emit(event, payload),
    });
    pipelineCore.define({ id: BEFORE_SEND, mode: 'collect' });
    pipelineCore.define({ id: PAYLOAD, mode: 'fold' });
    const core = createDecisionCore(engine.registerCaller('core.decision', 'cores', { tier: 'official' }), { retryDelayMs: 0 });
    await core.load();
    await core.configure({ assessSeed: 1, decider: { workerId: 'director' } });
    return { pipelineCore, core, calls, memory };
}

const form = (comment = 'The form is ready for the writer.') => call('submit_turn', {
    comment, resolution: 'She leaves.', userResult: 'The user waits.', scene: { minutes: 5 }, characters: [],
});

test('a turn without a plan is refused, then set_plan makes the form acceptable', async () => {
    const { pipelineCore, core, memory } = await build({
        replies: [
            form('The form is ready.'),
            form('The form is ready again.'),
            call('set_plan', { direction: 'Get her out before dawn.', stages: ['door', 'road'], comment: 'A direction is required before the form.' }),
            form(),
        ],
    });
    const result = await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'hi' }], type: 'normal' } });
    assert.equal(result.ok, true, result.error?.message);
    const log = memory.get(memoryKey('core.decision', 'log'));
    const submits = log[0].toolCalls.filter(entry => entry.name === 'submit_turn');
    assert.equal(submits.length, 3);
    assert.equal(submits[0].result.ok, false);
    assert.match(submits[0].result.missing.join('\n'), /plan/);
    assert.equal(submits[1].result.ok, false);
    assert.equal(submits[2].result.ok, true);
    assert.equal(core.plan().direction, 'Get her out before dawn.');
    assert.deepEqual(core.plan().stages, ['door', 'road']);
});

test('four notes are kept, the fifth replaces the oldest, arcs open and close, and the writer sees the notes', async () => {
    const { pipelineCore, core } = await build({
        replies: [
            call('set_plan', { direction: 'Get her out.', comment: 'A direction is required before the form.' }),
            ...Array.from({ length: 5 }, (_, index) => call('character_note', { character: 'Lena', op: 'add', title: `Note ${index}`, text: `Text ${index}`, comment: 'The writer must know this about Lena.' })),
            call('arc', { op: 'open', title: 'The escape', comment: 'This is a lasting thread, not one turn.' }),
            form(),
        ],
    });
    await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'hi' }], type: 'normal' } });
    const notes = core.notes();
    assert.equal(notes.lena.length, 4);
    assert.equal(core.arcs()[0].status, 'open');
    assert.equal(core.arcs()[0].title, 'The escape');

    const result = await pipelineCore.run({ pipelineId: PAYLOAD, input: { messages: [{ role: 'system', content: 'ST' }] } });
    const text = result.value.messages.map(message => message.content).join('\n');
    assert.match(text, /Lena: Note 4/);
    assert.match(text, /Text 3/);
    assert.doesNotMatch(text, /Note 0/);
});

test('current_state reads place, time, plan stage and the open arc, and says nothing it cannot source', async () => {
    const { pipelineCore, memory } = await build({
        replies: [
            call('set_plan', { direction: 'Get her out.', stages: ['door', 'road'], comment: 'A direction is required before the form.' }),
            call('arc', { op: 'open', title: 'The escape', comment: 'This is a lasting thread, not one turn.' }),
            call('current_state', { comment: 'I need to know where and when we are.' }),
            form(),
        ],
    });
    await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'hi' }], type: 'normal' } });
    const log = memory.get(memoryKey('core.decision', 'log'));
    const state = log[0].toolCalls.find(entry => entry.name === 'current_state').result;
    assert.equal(state.place, 'EAST CORRIDOR');
    assert.equal(state.time, 'Day 1, 08:00 (Morning)');
    assert.equal(state.planStage, 'door');
    assert.equal(state.arc.title, 'The escape');
    assert.deepEqual(state.sources, { place: 'map', time: 'rp-time', plan: 'plan' });
});
