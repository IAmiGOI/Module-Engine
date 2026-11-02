import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { createPipelineCore } from '../cores/pipeline/index.js';
import { createDecisionCore } from '../cores/decision/index.js';

const BEFORE_SEND = 'generation.beforeSend';

async function flush() {
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
}

function build() {
    const engine = createEngine();
    const settings = new Map();
    const memory = new Map();
    const key = (namespace, name) => `${namespace}:${name}`;
    const bus = engine.buses.cores;
    let lastMesid = '10';
    bus.register('storage.settings.get', ({ namespace, key: name, fallback }) => settings.has(key(namespace, name)) ? structuredClone(settings.get(key(namespace, name))) : fallback);
    bus.register('storage.settings.set', ({ namespace, key: name, value }) => { settings.set(key(namespace, name), structuredClone(value)); return true; });
    bus.register('storage.chatMemory.get', ({ namespace, key: name, fallback }) => memory.has(key(namespace, name)) ? structuredClone(memory.get(key(namespace, name))) : fallback);
    bus.register('storage.chatMemory.set', ({ namespace, key: name, value }) => { memory.set(key(namespace, name), structuredClone(value)); return true; });
    bus.register('model.workers.get', () => [{ id: 'director', format: 'openai', model: 'director/model' }]);
    bus.register('summary.list', () => []);
    bus.register('chatHistory.messages', () => [{ mesid: lastMesid, text: 'last' }]);
    bus.register('chatHistory.annotations', () => ({}));
    bus.register('ui.notify', () => true);
    bus.register('ui.reveal', () => true);
    bus.register('model.generate', async () => ({
        text: '',
        toolCalls: [
            { id: 'plan', name: 'set_plan', arguments: { comment: 'This turn needs a direction.', direction: 'Keep moving.' } },
            { id: 'mem', name: 'memory', arguments: { comment: 'This result must outlive the turn.', op: 'write', character: 'Aria', text: 'Aria promised to return before dawn.' } },
            { id: 'name', name: 'recall_name', arguments: { comment: 'The new guard needs a name.', gender: 'female', culture: 'germany', setting: 'modern' } },
            { id: 'turn', name: 'submit_turn', arguments: { comment: 'The turn is decided.', scene: { minutes: 1 }, resolution: 'The guard is named.', userResult: 'The user waited.', characters: [] } },
        ],
    }));
    const pipelineCore = createPipelineCore(engine.registerCaller('core.pipeline', 'cores', { tier: 'official' }), {
        resolveAs: engine.resolveAs, publish: (event, payload) => engine.events.emit(event, payload),
    });
    pipelineCore.define({ id: BEFORE_SEND, mode: 'collect' });
    const core = createDecisionCore(engine.registerCaller('core.decision', 'cores', { tier: 'official' }), { retryDelayMs: 0 });
    return { engine, pipelineCore, core, setMesid: value => { lastMesid = String(value); }, load: async () => { await core.load(); await core.configure({ decider: { workerId: 'director' } }); } };
}

async function runTurn({ engine, pipelineCore }, runId) {
    const result = await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId, chat: [{ mes: 'hi', is_user: true }], type: 'normal' } });
    assert.equal(result.ok, true, result.error?.message);
    engine.events.emit('generation.completed', { runId, outcome: 'ended' });
    await flush();
}

test('a swipe returns the bank records and issued names from the rejected turn, and marks its log cycle instead of deleting it', async () => {
    const made = build();
    await made.load();
    await runTurn(made, 'run_1');
    assert.equal(made.core.bank().aria.length, 1);
    assert.equal(made.core.names().length, 1);
    assert.equal(made.core.log().length, 1);
    assert.equal(made.core.log()[0].rejected, false);

    made.engine.events.emit('st.messageSwiped', {});
    await flush();

    assert.deepEqual(made.core.bank(), {}, 'the record written by the rejected turn is gone');
    assert.deepEqual(made.core.names(), [], 'the name issued by the rejected turn is returned');
    assert.equal(made.core.log().length, 1, 'the log stays a history of reasoning');
    assert.equal(made.core.log()[0].rejected, true, 'the rejected turn is marked');
});

test('deleting the message does the same, and leaves earlier rejected cycles marked', async () => {
    const made = build();
    await made.load();
    await runTurn(made, 'run_1');
    made.engine.events.emit('st.messageSwiped', {});
    await flush();

    made.setMesid('11');
    await runTurn(made, 'run_2');
    assert.equal(made.core.bank().aria.length, 1);
    assert.equal(made.core.names().length, 1);
    assert.equal(made.core.log().length, 2);

    made.engine.events.emit('st.messageDeleted', { args: [11] });
    await flush();

    assert.deepEqual(made.core.bank(), {});
    assert.deepEqual(made.core.names(), []);
    assert.equal(made.core.log().length, 2, 'both cycles remain in the log');
    assert.equal(made.core.log()[0].rejected, true);
    assert.equal(made.core.log()[1].rejected, true);
});
