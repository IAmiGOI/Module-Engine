import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { createPipelineCore } from '../cores/pipeline/index.js';
import { createDecisionCore } from '../cores/decision/index.js';
import { setAfterTurnDefault } from '../libraries/core/decision-settings.js';
setAfterTurnDefault(false); // эти тесты считают вызовы модели; работа после хода проверяется отдельно

const BEFORE_SEND = 'generation.beforeSend';
const PAYLOAD = 'generation.payload';
const memoryKey = (namespace, key) => `${namespace}:${key}`;
const clone = value => JSON.parse(JSON.stringify(value));
const call = (name, args) => ({ text: '', toolCalls: [{ id: `${name}_1`, name, arguments: args }] });

async function build({ replies, settings = {}, seed = {}, model = null, usage = null }) {
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
    engine.buses.cores.register('chatHistory.messages', () => [{ mesid: '10' }]);
    engine.buses.cores.register('chatHistory.annotations', () => ({}));
    engine.buses.cores.register('embedding.compute', () => null);
    engine.buses.cores.register('embedding.similarity', () => 0);
    engine.buses.cores.register('ui.notify', () => true);
    engine.buses.cores.register('generation.tools', () => []);
    engine.buses.cores.register('generation.callTool', () => 'ok');
    engine.buses.cores.register('model.generate', async params => {
        calls.push(params);
        if (usage) engine.events.emit('model.generate.raw', {
            requestId: params.requestId, format: 'openai',
            body: JSON.stringify({ choices: [{ message: { content: '' } }], usage }),
        });
        if (model) return model(params);
        return replies[index++] ?? { text: '', toolCalls: [] };
    });
    engine.events.subscribe('decision.snapshot.restored', payload => events.push(payload));
    const pipelineCore = createPipelineCore(engine.registerCaller('core.pipeline', 'cores', { tier: 'official' }), {
        resolveAs: engine.resolveAs,
        publish: (event, payload) => engine.events.emit(event, payload),
    });
    pipelineCore.define({ id: BEFORE_SEND, mode: 'collect' });
    pipelineCore.define({ id: PAYLOAD, mode: 'fold' });
    const core = createDecisionCore(engine.registerCaller('core.decision', 'cores', { tier: 'official' }), { retryDelayMs: 0 });
    await core.load();
    await core.configure({ decider: { workerId: 'director' }, ...settings });
    return { engine, pipelineCore, core, calls, memory, events };
}

async function flush() {
    for (let index = 0; index < 12; index += 1) await new Promise(resolve => setTimeout(resolve, 0));
}

const setPlan = () => call('set_plan', { direction: 'Keep moving.', comment: 'A direction is required before the form.' });
const form = (characters = [], minutes = 5) => call('submit_turn', {
    comment: 'The form is ready for the writer.', resolution: 'She leaves.', userResult: 'The user waits.',
    scene: { minutes }, characters, beats: [{ who: 'Someone', kind: 'action', text: 'acts' }],
});

test('a swipe restores the state from before the turn: roster, plan and clock go back', async () => {
    const { engine, pipelineCore, core, events } = await build({
        replies: [
            setPlan(),
            call('update_roster', { add: [{ name: 'Lena' }], comment: 'Lena is now in the scene.' }),
            call('assess', { character: 'Lena', action: 'leaves', kind: 'body', difficulty: 'easy', experience: 'skilled', why: 'The exit is unguarded.', comment: 'The chance matters for the form.' }),
            form([{ name: 'Lena', decision: 'Leave.', decisionReason: 'She is out of time.', action: 'Leaves.', actionReason: 'The door is open.', assessId: 'asm_run_1_1', outcome: 'She gets out.' }], 5),
        ],
    });
    const result = await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'hi' }], type: 'normal' } });
    assert.equal(result.ok, true);
    engine.events.emit('generation.completed', { runId: 'run_1', outcome: 'ended' });
    await flush();
    assert.deepEqual(core.roster().active, ['Lena']);
    assert.equal(core.plan().direction, 'Keep moving.');

    engine.events.emit('st.messageSwiped');
    await flush();
    assert.deepEqual(core.roster().active, [], 'the roster is back to before the turn');
    assert.equal(core.plan(), null, 'the plan is back to before the turn');
    assert.equal(core.clock().minutes, 0);
    assert.equal(events.length, 1);
});

test('adaptive reasoning asks low effort on the turn and high effort in the passive cycle', async () => {
    const { engine, pipelineCore, calls } = await build({
        replies: [
            setPlan(), form(), call('resolve_character_plan', { character: 'A', result: 'A did it.', comment: 'The plan is over.' }),
            call('await', { reason: 'done', comment: 'Nothing else is due.' }),
        ],
        seed: {
            [memoryKey('core.decision', 'library')]: { a: { name: 'A', level: 1 } },
            [memoryKey('core.decision', 'plans')]: [{ id: 'p1', character: 'A', level: 1, summary: 'Do it.', dueAt: 1, interrupted: false, resolvedAt: null }],
            [memoryKey('core.decision', 'clock')]: { minutes: 10, updatedAt: 1 },
        },
    });
    await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'hi' }], type: 'normal' } });
    await flush();
    assert.ok(calls.some(params => !String(params.requestId).includes(':p') && params.reasoningEffort === 'low'));
    assert.ok(calls.some(params => String(params.requestId).includes(':p') && params.reasoningEffort === 'high'));
});

test('a form timeout uses the saved draft instead of cancelling the turn', async () => {
    const draft = { scene: { minutes: 4 }, resolution: 'The draft resolution.', userResult: 'The user waits.', beats: [{ who: 'Someone', kind: 'action', text: 'acts' }], characters: [] };
    const { pipelineCore, core } = await build({
        settings: { turnDraft: true, formTimeoutMs: 20 },
        seed: { [memoryKey('core.decision', 'draft')]: draft },
        model: params => new Promise((resolve, reject) => {
            params.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    const result = await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'hi' }], type: 'normal' } });
    assert.equal(result.ok, true);
    const outgoing = await pipelineCore.run({ pipelineId: PAYLOAD, input: { messages: [{ role: 'system', content: 'ST' }] } });
    assert.match(outgoing.value.messages.map(message => message.content).join('\n'), /The draft resolution\./);
    assert.equal(core.draft(), null, 'the draft is used once and cleared');
});

test('the log records provider usage and the cached share when the worker reports it', async () => {
    const { pipelineCore, core } = await build({
        replies: [setPlan(), form()],
        usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } },
    });
    await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'hi' }], type: 'normal' } });
    const log = core.log();
    assert.equal(log[0].usage.prompt, 200, 'two model calls in the cycle');
    assert.equal(log[0].usage.completion, 40);
    assert.equal(log[0].usage.cached, 80);
    assert.equal(log[0].usage.total, 240);
});

test('start on typing runs a background draft only when the setting and turn drafting are on', async () => {
    const awaitReply = call('await', { reason: 'draft ready', comment: 'The draft is saved for the next turn.' });
    const on = await build({ replies: [awaitReply], settings: { startOnTyping: true, turnDraft: true } });
    on.engine.events.emit('ui.inputBar.changed', { active: true, height: 40 });
    await flush();
    assert.ok(on.calls.some(params => String(params.requestId).startsWith('typing_')));
    on.engine.events.emit('ui.inputBar.changed', { active: false, height: 0 });

    const off = await build({ replies: [awaitReply], settings: { startOnTyping: false, turnDraft: true } });
    off.engine.events.emit('ui.inputBar.changed', { active: true, height: 40 });
    await flush();
    assert.equal(off.calls.length, 0);
});

test('a form timeout without a draft aborts the model, is logged with its reason and is not retried by the pipeline', async () => {
    let aborted = 0;
    const { pipelineCore, core, calls } = await build({
        settings: { formTimeoutMs: 20 },
        model: params => new Promise((resolve, reject) => {
            params.signal?.addEventListener('abort', () => { aborted += 1; reject(new Error('aborted')); });
        }),
    });
    const result = await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'hi' }], type: 'normal' } });
    await flush();
    assert.equal(result.ok, false);
    assert.match(result.stages[0].failures.at(-1).error.message, /did not finish the turn within 0 s\. Press Regenerate/);
    assert.equal(calls.length, 1, 'the retry fails at once instead of waiting the whole deadline again');
    assert.equal(aborted, 1, 'the request of the timed-out attempt is cancelled');
    const failed = core.log().filter(cycle => (cycle.warnings ?? []).some(line => /^failed: /.test(line)));
    assert.equal(failed.length, 1, 'the failed turn stays in the director log with its reason');
});
