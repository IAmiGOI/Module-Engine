import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { request } from '../libraries/shared/request.js';
import { createPipelineCore } from '../cores/pipeline/index.js';
import { createDecisionCore } from '../cores/decision/index.js';

const BEFORE_SEND = 'generation.beforeSend';
const PAYLOAD = 'generation.payload';

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function memoryKey(namespace, key) {
    return `${namespace}:${key}`;
}

async function build({ enabled = false, patch = {}, initialRuns = null, workers = [{ id: 'director', format: 'openai', model: 'director/model' }], summaries = [], withPm = false, reply = () => JSON.stringify({ decision: 'She opens the door.', blocks: [{ op: 'add', title: 'Door', text: 'The east door is open.' }] }) } = {}) {
    const engine = createEngine();
    const settingsStore = new Map();
    const chatMemory = new Map();
    if (initialRuns) chatMemory.set(memoryKey('core.decision', 'runs'), clone(initialRuns));
    const calls = [];
    const notifications = [];
    const workersList = [...workers];

    engine.buses.cores.register('storage.settings.get', ({ namespace, key, fallback }) => settingsStore.has(memoryKey(namespace, key)) ? clone(settingsStore.get(memoryKey(namespace, key))) : fallback);
    engine.buses.cores.register('storage.settings.set', ({ namespace, key, value }) => { settingsStore.set(memoryKey(namespace, key), clone(value)); return true; });
    engine.buses.cores.register('storage.chatMemory.get', ({ namespace, key, fallback }) => chatMemory.has(memoryKey(namespace, key)) ? clone(chatMemory.get(memoryKey(namespace, key))) : fallback);
    engine.buses.cores.register('storage.chatMemory.set', ({ namespace, key, value }) => { chatMemory.set(memoryKey(namespace, key), clone(value)); return true; });
    engine.buses.cores.register('model.workers.get', () => workersList);
    engine.buses.cores.register('summary.list', () => summaries);
    engine.buses.cores.register('chatHistory.messages', () => [{ mesid: '10', text: 'last message' }]);
    engine.buses.cores.register('ui.notify', params => { notifications.push(params); return true; });
    engine.buses.cores.register('model.generate', async params => {
        calls.push(params);
        engine.events.emit('model.generate.raw', {
            requestId: params.requestId, format: 'openai',
            body: JSON.stringify({ choices: [{ message: { reasoning_content: 'she is certain' } }] }),
        });
        return reply(params);
    });

    const pipelineCore = createPipelineCore(engine.registerCaller('core.pipeline', 'cores', { tier: 'official' }), {
        resolveAs: engine.resolveAs,
        publish: (event, payload) => engine.events.emit(event, payload),
    });
    pipelineCore.define({ id: BEFORE_SEND, mode: 'collect' });
    pipelineCore.define({ id: PAYLOAD, mode: 'fold' });
    const pmHost = engine.registerCaller('core.promptManager', 'cores', { tier: 'official' });
    if (withPm) {
        pmHost.own.register('promptManager.rewrite', ({ payload }) => ({ ...payload, messages: [{ role: 'system', content: 'PM assembled' }] }));
        await request(pmHost.own, 'pipeline.stages.add', { params: { pipelineId: PAYLOAD, stage: { id: 'prompt-manager:rewrite', contract: 'promptManager.rewrite', params: { payload: { $from: '$value' } } } } });
    }

    const core = createDecisionCore(engine.registerCaller('core.decision', 'cores', { tier: 'official' }), { retryDelayMs: 0 });
    await core.load();
    if (enabled) await core.configure({ enabled: true, ...patch });
    return { engine, pipelineCore, core, calls, notifications, chatMemory, settingsStore };
}

async function flush() {
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
}

function stages(pipelineCore, id) {
    return pipelineCore.stages(id).map(stage => stage.id);
}

test('off by default: no stages are registered at all, and the director/writer contracts do nothing', async () => {
    const { core, pipelineCore } = await build();
    assert.deepEqual(stages(pipelineCore, BEFORE_SEND), []);
    assert.deepEqual(stages(pipelineCore, PAYLOAD), []);
    assert.deepEqual(await core.decide({ chat: [{ mes: 'hi' }] }), { skipped: 'the decision core is off' });
    const payload = { messages: [{ role: 'system', content: 'ST' }] };
    assert.equal(await core.rewrite({ payload }), payload);
});

test('enabling registers both stages, and the writer stage waits for the Prompt Manager rewrite when PM is already there', async () => {
    const { core, pipelineCore } = await build({ withPm: true });
    await core.configure({ enabled: true });
    assert.deepEqual(stages(pipelineCore, BEFORE_SEND), ['decision:decide']);
    assert.deepEqual(stages(pipelineCore, PAYLOAD), ['prompt-manager:rewrite', 'decision:rewrite']);
    const rewrite = pipelineCore.stages(PAYLOAD).find(stage => stage.id === 'decision:rewrite');
    assert.deepEqual(rewrite.needs, ['prompt-manager:rewrite']);
});

test('the writer stage re-registers with a dependency when the Prompt Manager appears later', async () => {
    const { core, pipelineCore, engine } = await build();
    await core.configure({ enabled: true });
    const before = pipelineCore.stages(PAYLOAD).find(stage => stage.id === 'decision:rewrite');
    assert.deepEqual(before.needs, []);
    const pmHost = engine.registerCaller('core.promptManager', 'cores', { tier: 'official' });
    pmHost.own.register('promptManager.rewrite', ({ payload }) => payload);
    await request(pmHost.own, 'pipeline.stages.add', { params: { pipelineId: PAYLOAD, stage: { id: 'prompt-manager:rewrite', contract: 'promptManager.rewrite' } } });
    await flush();
    const after = pipelineCore.stages(PAYLOAD).find(stage => stage.id === 'decision:rewrite');
    assert.deepEqual(after.needs, ['prompt-manager:rewrite']);
});

test('the director runs on beforeSend, the writer replaces the outgoing messages, and PM runs before but is overridden', async () => {
    const { core, pipelineCore, calls } = await build({ withPm: true, enabled: true, patch: { rules: 'Never kill a named character.', decider: { workerId: 'director' } }, summaries: [{ startIndex: 1, endIndex: 9, text: 'They reached the keep.' }] });
    const chat = [{ mes: 'older' }, { mes: 'Hello?', is_user: true }];
    const before = await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat, type: 'normal' } });
    assert.equal(before.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].workerId, 'director');
    assert.equal(calls[0].stream, false);
    assert.match(JSON.stringify(calls[0].messages), /Never kill a named character/);
    assert.match(JSON.stringify(calls[0].messages), /They reached the keep/);

    const payload = { model: 'st', stream: true, temperature: 1, reasoning_effort: 'high', messages: [{ role: 'system', content: 'ST assembled' }] };
    const sent = await pipelineCore.run({ pipelineId: PAYLOAD, input: payload });
    assert.equal(sent.ok, true);
    const messages = sent.value.messages;
    assert.match(messages[0].content, /You write the character's next reply/);
    assert.equal(messages.some(message => message.content === 'PM assembled'), false, 'the writer body overrides PM');
    assert.equal(messages.some(message => message.content === 'ST assembled'), false, 'the writer body overrides ST assembly');
    assert.equal(messages.at(-1).content, 'Hello?');
    assert.match(messages.map(message => message.content).join('\n'), /She opens the door/);
    assert.equal('reasoning_effort' in sent.value, false);
    assert.equal(sent.value.stream, true, 'streaming is ST\'s own setting and must not be changed');
});

test('blocks and the run are committed only after a genuinely ended run, under the last message number', async () => {
    const { core, pipelineCore, engine, chatMemory } = await build({ enabled: true });
    const chat = [{ mes: 'Hello?', is_user: true }];
    await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat, type: 'normal' } });
    assert.deepEqual(core.blocks(), [], 'nothing is committed before the generation ends');

    engine.events.emit('generation.completed', { runId: 'run_1', outcome: 'ended' });
    await flush();

    assert.deepEqual(core.blocks().map(block => [block.title, block.text]), [['Door', 'The east door is open.']]);
    const storedRuns = chatMemory.get(memoryKey('core.decision', 'runs'));
    assert.equal(storedRuns['10'].decision, 'She opens the door.');
    assert.equal(storedRuns['10'].reasoning, 'she is certain');
    assert.equal(storedRuns['10'].steps.length, 1);
});

test('a superseded run leaves no blocks and no run behind, even if a completed event arrives afterwards', async () => {
    const { core, pipelineCore, engine } = await build({ enabled: true });
    await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'hi' }], type: 'normal' } });
    engine.events.emit('generation.superseded', { runId: 'run_1' });
    engine.events.emit('generation.completed', { runId: 'run_1', outcome: 'ended' });
    await flush();
    assert.deepEqual(core.blocks(), []);
    assert.deepEqual(core.runs(), {});
});

test('a stopped run is treated as cancelled and commits nothing', async () => {
    const { core, pipelineCore, engine } = await build({ enabled: true });
    await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'hi' }], type: 'normal' } });
    engine.events.emit('generation.completed', { runId: 'run_1', outcome: 'stopped' });
    await flush();
    assert.deepEqual(core.blocks(), []);
});

test('a director failure retries once, aborts the beforeSend pipeline after the second failure, notifies, and keeps the old state', async () => {
    let attempts = 0;
    const { core, pipelineCore, engine, notifications } = await build({ enabled: true, reply: () => { attempts += 1; throw new Error('provider is down'); } });
    const result = await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'hi' }], type: 'normal' } });
    assert.equal(result.ok, false);
    assert.equal(result.failedStage, 'decision:decide');
    assert.equal(attempts, 2, 'the fallback attempt really ran');
    engine.events.emit('generation.aborted', { runId: 'run_1', stage: 'decision:decide' });
    await flush();
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].text, /failed twice/);
    assert.deepEqual(core.blocks(), []);
});

test('a malformed director answer is a failure of the attempt, not an exception escaping the pipeline', async () => {
    const { pipelineCore } = await build({ enabled: true, reply: () => 'I think she should run.' });
    const result = await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'hi' }], type: 'normal' } });
    assert.equal(result.ok, false);
    assert.match(result.error.message, /did not submit the turn/);
});

test('on regenerate with "writer only" the director is not called again; the last decision is reused', async () => {
    const { core, pipelineCore, calls } = await build({ enabled: true, patch: { regen: 'writer' }, initialRuns: { 10: { id: 'old', mesid: '10', at: 1, decision: 'She already decided.', reasoning: 'old thought', steps: [] } } });
    const result = await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_2', chat: [{ mes: 'Hello again?', is_user: true }], type: 'regenerate' } });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 0, 'no new director call');
    const sent = await pipelineCore.run({ pipelineId: PAYLOAD, input: { messages: [{ role: 'system', content: 'ST' }] } });
    assert.match(JSON.stringify(sent.value.messages), /She already decided/, 'the writer really used the reused decision');
    assert.equal(core.runs()['10'].decision, 'She already decided.');
});

test('on regenerate with the default "decider" the director does run again', async () => {
    const { pipelineCore, calls } = await build({ enabled: true, initialRuns: { 10: { id: 'old', mesid: '10', at: 1, decision: 'old', steps: [] } } });
    await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_2', chat: [{ mes: 'Hello again?', is_user: true }], type: 'regenerate' } });
    assert.equal(calls.length, 1);
});

test('"writer only" with no earlier decision falls back to running the director instead of writing without a plan', async () => {
    const { pipelineCore, calls } = await build({ enabled: true, patch: { regen: 'writer' } });
    const result = await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_2', chat: [{ mes: 'Hello?', is_user: true }], type: 'swipe' } });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
});
