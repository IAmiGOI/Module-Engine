import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { createPipelineCore } from '../cores/pipeline/index.js';
import { createDecisionCore } from '../cores/decision/index.js';

const BEFORE_SEND = 'generation.beforeSend';
const memoryKey = (namespace, key) => `${namespace}:${key}`;
const clone = value => JSON.parse(JSON.stringify(value));
const call = (name, args) => ({ text: '', toolCalls: [{ id: `${name}_1`, name, arguments: args }] });

async function build({ replies, thresholdTokens = 10 }) {
    const engine = createEngine();
    const settings = new Map();
    const memory = new Map();
    const calls = [];
    let index = 0;
    engine.buses.cores.register('storage.settings.get', ({ namespace, key, fallback }) => settings.has(memoryKey(namespace, key)) ? clone(settings.get(memoryKey(namespace, key))) : fallback);
    engine.buses.cores.register('storage.settings.set', ({ namespace, key, value }) => { settings.set(memoryKey(namespace, key), clone(value)); return true; });
    engine.buses.cores.register('storage.chatMemory.get', ({ namespace, key, fallback }) => memory.has(memoryKey(namespace, key)) ? clone(memory.get(memoryKey(namespace, key))) : fallback);
    engine.buses.cores.register('storage.chatMemory.set', ({ namespace, key, value }) => { memory.set(memoryKey(namespace, key), clone(value)); return true; });
    engine.buses.cores.register('model.workers.get', () => [
        { id: 'director', format: 'openai', model: 'director/model' },
        { id: 'compressor', format: 'openai', model: 'compressor/model' },
    ]);
    engine.buses.cores.register('summary.list', () => []);
    engine.buses.cores.register('chatHistory.messages', () => []);
    engine.buses.cores.register('chatHistory.chatId', () => ({ open: true, id: 'chat-1' }));
    engine.buses.cores.register('chatHistory.annotations', () => ({}));
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
    const core = createDecisionCore(engine.registerCaller('core.decision', 'cores', { tier: 'official' }), { retryDelayMs: 0 });
    await core.load();
    await core.configure({
        assessSeed: 1, decider: { workerId: 'director' },
        compression: { workerId: 'compressor', thresholdTokens, maxTokens: 500, temperature: 0 },
    });
    return { pipelineCore, core, calls, memory };
}

const form = () => call('inscribe', {
    comment: 'The form is ready for the writer.', resolution: 'They move on.', userResult: 'The user waits.',
    scene: { minutes: 5 }, characters: [],
});

test('a memory section over the threshold is compressed by the separate worker, and ordinary records become one', async () => {
    const { pipelineCore, core, calls } = await build({
        replies: [
            call('set_plan', { direction: 'Keep the keep moving.', comment: 'A direction is required before the form.' }),
            call('memory', { op: 'write', character: 'Lena', text: 'She found the old key under the third stair, and it still fits the east door.', comment: 'This must be remembered.' }),
            'Lena found the key; it opens the east door.',
            form(),
        ],
    });
    const result = await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'hi' }], type: 'normal' } });
    assert.equal(result.ok, true);
    const compressionCall = calls.find(params => params.workerId === 'compressor');
    assert.ok(compressionCall, 'the compressor worker was used, not the director');
    assert.match(compressionCall.prompt, /third stair/);
    const records = core.bank().lena;
    assert.equal(records.length, 1);
    assert.equal(records[0].compressed, true);
    assert.match(records[0].text, /east door/);
});

test('important records are never compressed, even when the section is over the threshold', async () => {
    const { pipelineCore, core, calls } = await build({
        replies: [
            call('set_plan', { direction: 'Keep the keep moving.', comment: 'A direction is required before the form.' }),
            call('memory', { op: 'write', character: 'Lena', text: 'She promised to bring Marek back alive, and means it.', important: true, comment: 'This promise must never be lost.' }),
            call('memory', { op: 'write', character: 'Lena', text: 'She found the old key under the third stair, and it still fits the east door.', comment: 'This is an ordinary detail.' }),
            'Lena found the key; the promise still stands.',
            form(),
        ],
    });
    await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'hi' }], type: 'normal' } });
    const records = core.bank().lena;
    assert.equal(records.filter(record => record.important).length, 1);
    assert.match(records.find(record => record.important).text, /promised/);
    assert.equal(records.filter(record => record.compressed).length, 1);
    assert.ok(calls.some(params => params.workerId === 'compressor'));
});

test('below the threshold the compressor is never called', async () => {
    const { pipelineCore, core, calls } = await build({
        replies: [
            call('set_plan', { direction: 'Keep the keep moving.', comment: 'A direction is required before the form.' }),
            call('memory', { op: 'write', character: 'Lena', text: 'Short note.', comment: 'Small detail.' }),
            form(),
        ],
        thresholdTokens: 100000,
    });
    await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'hi' }], type: 'normal' } });
    assert.equal(core.bank().lena.length, 1);
    assert.equal(calls.some(params => params.workerId === 'compressor'), false);
});
