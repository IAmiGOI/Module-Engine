import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { createPipelineCore } from '../cores/pipeline/index.js';
import { createDecisionCore } from '../cores/decision/index.js';

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
    engine.buses.cores.register('model.workers.get', () => [{ id: 'director', format: 'openai' }]);
    engine.buses.cores.register('summary.list', () => []);
    engine.buses.cores.register('chatHistory.messages', () => []);
    engine.buses.cores.register('chatHistory.chatId', () => ({ open: true, id: 'chat-1' }));
    engine.buses.cores.register('chatHistory.annotations', () => ({}));
    engine.buses.cores.register('embedding.compute', () => null);
    engine.buses.cores.register('embedding.similarity', () => 0);
    engine.buses.cores.register('ui.notify', () => true);
    engine.buses.cores.register('generation.tools', () => []);
    engine.buses.cores.register('generation.callTool', () => 'ok');
    engine.buses.cores.register('model.generate', async params => { calls.push(params); return replies[index++] ?? { text: '', toolCalls: [] }; });
    const pipelineCore = createPipelineCore(engine.registerCaller('core.pipeline', 'cores', { tier: 'official' }), {
        resolveAs: engine.resolveAs,
        publish: (event, payload) => engine.events.emit(event, payload),
    });
    pipelineCore.define({ id: 'generation.beforeSend', mode: 'collect' });
    const core = createDecisionCore(engine.registerCaller('core.decision', 'cores', { tier: 'official' }), { retryDelayMs: 0 });
    await core.load();
    await core.configure({ decider: { workerId: 'director' } });
    return { pipelineCore, core, memory, calls };
}

test('recall_name issues two different names and marks them issued in this chat', async () => {
    const { pipelineCore, core, memory } = await build({
        replies: [
            call('set_plan', { direction: 'Cast the scene.', comment: 'A direction is required before the form.' }),
            call('recall_name', { gender: 'female', culture: 'germany', setting: 'modern', comment: 'I need a name for the innkeeper.' }),
            call('recall_name', { gender: 'female', culture: 'germany', setting: 'modern', comment: 'I need another name for her sister.' }),
            call('inscribe', { comment: 'The form is ready.', resolution: 'They meet.', userResult: 'The user waits.', scene: { minutes: 1 }, characters: [] }),
        ],
    });
    const result = await pipelineCore.run({ pipelineId: 'generation.beforeSend', input: { runId: 'run_1', chat: [{ mes: 'hi' }], type: 'normal' } });
    assert.equal(result.ok, true);
    const log = core.log()[0];
    const names = log.toolCalls.filter(entry => entry.name === 'recall_name').map(entry => entry.result);
    assert.equal(names.length, 2);
    assert.equal(names[0].ok, true);
    assert.equal(names[1].ok, true);
    assert.notEqual(names[0].full, names[1].full);
    assert.equal(core.names().length, 2);
    assert.equal(memory.get(memoryKey('core.decision', 'names')).length, 2);
});
