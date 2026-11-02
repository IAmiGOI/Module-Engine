import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { request } from '../libraries/shared/request.js';
import { createPipelineCore } from '../cores/pipeline/index.js';
import { createDecisionCore } from '../cores/decision/index.js';

/**
 * e1 на уровне ядра: цикл инструментов, обязательный комментарий, лог,
 * пробуждение через await и «у прозаика инструментов нет».
 */

const BEFORE_SEND = 'generation.beforeSend';
const PAYLOAD = 'generation.payload';

function memoryKey(namespace, key) { return `${namespace}:${key}`; }
const clone = value => JSON.parse(JSON.stringify(value));

async function build({ replies, externalTools = [], callTool = async () => 'ok' }) {
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
    engine.buses.cores.register('ui.notify', () => true);
    engine.buses.cores.register('generation.tools', () => externalTools);
    engine.buses.cores.register('generation.callTool', ({ name, args }) => callTool(name, args));
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
    await core.configure({ enabled: true, decider: { workerId: 'director' } });
    return { engine, pipelineCore, core, calls, memory };
}

const call = (name, args) => ({ text: '', toolCalls: [{ id: `${name}_1`, name, arguments: args }] });

test('the director runs a tool cycle: a Notebook call with a comment, then submit_turn, and both land in the log', async () => {
    const seen = [];
    const { pipelineCore, core, calls, memory } = await build({
        replies: [
            call('Notebook', { action: 'write', title: 'Door', content: 'Open', comment: 'I need to remember that the door is open.' }),
            call('submit_turn', { comment: 'The turn is ready for the writer.', resolution: 'She steps through the open door.', characters: [], scene: { minutes: 2 }, userResult: 'The user waits.' }),
        ],
        externalTools: [{ name: 'Notebook', description: 'notes', parameters: { type: 'object', properties: {} } }],
        callTool: async (name, args) => { seen.push({ name, args }); return 'note saved'; },
    });
    const result = await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'hi' }], type: 'normal' } });
    assert.equal(result.ok, true);
    assert.deepEqual(seen, [{ name: 'Notebook', args: { action: 'write', title: 'Door', content: 'Open' } }], 'the comment is not passed to the foreign tool');
    assert.equal(calls[0].tools.some(tool => tool.name === 'Notebook'), true, 'the director sees the engine tool');
    assert.equal(calls[0].tools.find(tool => tool.name === 'Notebook').parameters.required.includes('comment'), true, 'every foreign tool is given the comment field');
    assert.equal(calls[0].returnMessage, true);

    const log = memory.get(memoryKey('core.decision', 'log'));
    assert.equal(log.length, 1, 'one cycle is recorded');
    assert.deepEqual(log[0].toolCalls.map(entry => entry.name), ['Notebook', 'submit_turn']);
    assert.match(log[0].toolCalls[0].comment, /remember/);
    assert.equal(log[0].toolCalls[0].result, 'note saved');
    assert.equal(core.runs()['10'], undefined, 'the log is separate from the per-message runs');
});

test('update_roster is persisted and reaches the next context', async () => {
    const { pipelineCore, core, memory, calls } = await build({
        replies: [
            call('update_roster', { add: [{ name: 'Lena' }], comment: 'Lena walks into the scene and can affect it.' }),
            call('submit_turn', { comment: 'The turn is ready for the writer.', resolution: 'Lena arrives.', characters: [], scene: { minutes: 1 }, userResult: 'The user waits.' }),
            call('await', { reason: 'next turn', comment: 'Nothing else happens between turns.' }),
        ],
    });
    await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'hi' }], type: 'normal' } });
    assert.deepEqual(core.roster?.() ?? memory.get(memoryKey('core.decision', 'roster')), { active: ['Lena'] });
    const stored = memory.get(memoryKey('core.decision', 'roster'));
    assert.deepEqual(stored, { active: ['Lena'] });
    assert.equal(calls.length, 2, 'the cycle asked the model twice: roster, then the form');
});

test('the writer body carries the form decision and no tools at all', async () => {
    const { pipelineCore, core } = await build({
        replies: [call('submit_turn', { comment: 'The turn is ready for the writer.', resolution: 'She steps through the open door.', characters: [], scene: { minutes: 2 }, userResult: 'The user waits.' })],
    });
    await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'hi' }], type: 'normal' } });
    const payload = {
        messages: [{ role: 'system', content: 'ST assembled' }],
        tools: [{ type: 'function', function: { name: 'Notebook' } }],
        tool_choice: 'auto',
        stream: true,
    };
    const result = await pipelineCore.run({ pipelineId: PAYLOAD, input: payload });
    assert.equal(result.ok, true);
    const body = result.value;
    assert.equal('tools' in body, false);
    assert.equal('tool_choice' in body, false);
    assert.match(body.messages.map(message => message.content).join('\n'), /She steps through the open door/);
    assert.equal(body.stream, true);
});

test('await ends the passive cycle; on a turn with no form the decision fails instead of writing blindly', async () => {
    const { pipelineCore } = await build({
        replies: [
            call('await', { reason: 'nothing to decide', comment: 'There is no new turn to decide.' }),
            call('await', { reason: 'nothing to decide', comment: 'There is no new turn to decide.' }),
        ],
    });
    const result = await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'hi' }], type: 'normal' } });
    assert.equal(result.ok, false);
    assert.match(result.error.message, /did not submit the turn/);
});
