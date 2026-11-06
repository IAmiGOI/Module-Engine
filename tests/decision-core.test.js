import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { request } from '../libraries/shared/request.js';
import { createPipelineCore } from '../cores/pipeline/index.js';
import { createDecisionCore } from '../cores/decision/index.js';
import { DIRECTOR_SYSTEM } from '../libraries/core/decision-prompts.js';
import { setAfterTurnDefault } from '../libraries/core/decision-settings.js';
setAfterTurnDefault(false); // эти тесты считают вызовы модели; работа после хода проверяется отдельно

const BEFORE_SEND = 'generation.beforeSend';
const PAYLOAD = 'generation.payload';

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function memoryKey(namespace, key) {
    return `${namespace}:${key}`;
}

const turnReply = (decision = 'She opens the door.') => ({
    text: '',
    toolCalls: [
        { id: 'plan', name: 'set_plan', arguments: { comment: 'This turn needs a direction.', direction: 'Open the east door.' } },
        { id: 'turn', name: 'submit_turn', arguments: { comment: 'The turn is decided.', scene: { minutes: 0 }, resolution: decision, userResult: 'The user waited.', characters: [] } },
    ],
});

async function build({ patch = {}, initialRuns = null, workers = [{ id: 'director', format: 'openai', model: 'director/model' }], summaries = [], reply = () => turnReply() } = {}) {
    const engine = createEngine();
    const settingsStore = new Map();
    const chatMemory = new Map();
    if (initialRuns) chatMemory.set(memoryKey('core.decision', 'runs'), clone(initialRuns));
    const calls = [];
    const notifications = [];
    const reveals = [];
    const workersList = [...workers];

    engine.buses.cores.register('storage.settings.get', ({ namespace, key, fallback }) => settingsStore.has(memoryKey(namespace, key)) ? clone(settingsStore.get(memoryKey(namespace, key))) : fallback);
    engine.buses.cores.register('storage.settings.set', ({ namespace, key, value }) => { settingsStore.set(memoryKey(namespace, key), clone(value)); return true; });
    engine.buses.cores.register('storage.chatMemory.get', ({ namespace, key, fallback }) => chatMemory.has(memoryKey(namespace, key)) ? clone(chatMemory.get(memoryKey(namespace, key))) : fallback);
    engine.buses.cores.register('storage.chatMemory.set', ({ namespace, key, value }) => { chatMemory.set(memoryKey(namespace, key), clone(value)); return true; });
    engine.buses.cores.register('model.workers.get', () => workersList);
    engine.buses.cores.register('summary.list', () => summaries);
    engine.buses.cores.register('chatHistory.messages', () => [{ mesid: '10', text: 'last message' }]);
    engine.buses.cores.register('ui.notify', params => { notifications.push(params); return true; });
    engine.buses.cores.register('ui.reveal', params => { reveals.push(params); return true; });
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
    const core = createDecisionCore(engine.registerCaller('core.decision', 'cores', { tier: 'official' }), { retryDelayMs: 0 });
    await core.load();
    await core.configure({ decider: { workerId: 'director' }, ...patch });
    return { engine, pipelineCore, core, calls, notifications, reveals, chatMemory, settingsStore };
}

async function flush() {
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
}

function stages(pipelineCore, id) {
    return pipelineCore.stages(id).map(stage => stage.id);
}

test('the core is always on: loading registers both stages, and the writer stage is the only stage on the payload with no dependencies', async () => {
    const { pipelineCore } = await build();
    assert.deepEqual(stages(pipelineCore, BEFORE_SEND), ['decision:decide']);
    assert.deepEqual(stages(pipelineCore, PAYLOAD), ['decision:rewrite']);
    const rewrite = pipelineCore.stages(PAYLOAD).find(stage => stage.id === 'decision:rewrite');
    assert.deepEqual(rewrite.needs, []);
});

test('the director runs on beforeSend and the writer replaces the outgoing messages', async () => {
    const { pipelineCore, calls } = await build({ patch: { prompts: { director: 'Never kill a named character.' }, decider: { workerId: 'director' } }, summaries: [{ startIndex: 1, endIndex: 9, text: 'They reached the keep.' }] });
    const chat = [{ mes: 'older' }, { mes: 'Hello?', is_user: true }];
    const before = await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat, type: 'normal' } });
    assert.equal(before.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].workerId, 'director');
    assert.equal(calls[0].stream, true, 'the director streams so the window can show thinking and calls as they arrive');
    assert.match(JSON.stringify(calls[0].messages), /Never kill a named character/);
    assert.doesNotMatch(JSON.stringify(calls[0].messages), /They reached the keep/, 'summary.core summaries no longer reach the director');
    assert.match(JSON.stringify(calls[0].messages), /YOUR PLAN/);
    assert.match(JSON.stringify(calls[0].messages), /A new turn has started/);

    const payload = { model: 'st', stream: true, temperature: 1, reasoning_effort: 'high', messages: [{ role: 'system', content: 'ST assembled' }] };
    const sent = await pipelineCore.run({ pipelineId: PAYLOAD, input: payload });
    assert.equal(sent.ok, true);
    const messages = sent.value.messages;
    assert.match(messages[0].content, /You are the Writer of a roleplay/);
    assert.equal(messages.some(message => message.content === 'ST assembled'), false, 'the writer body overrides ST assembly');
    assert.equal(messages.at(-2).content, 'Hello?');
    assert.match(messages.at(-1).content, /^PUSH — what happens this turn:/);
    assert.match(messages.map(message => message.content).join('\n'), /She opens the door/);
    assert.equal('reasoning_effort' in sent.value, false);
    assert.equal(sent.value.stream, true, 'streaming is ST\'s own setting and must not be changed');
});

test('the run is committed only after a genuinely ended run, under the last message number', async () => {
    const { core, pipelineCore, engine, chatMemory } = await build();
    const chat = [{ mes: 'Hello?', is_user: true }];
    await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat, type: 'normal' } });
    assert.deepEqual(core.runs(), {}, 'nothing is committed before the generation ends');

    engine.events.emit('generation.completed', { runId: 'run_1', outcome: 'ended' });
    await flush();

    const storedRuns = chatMemory.get(memoryKey('core.decision', 'runs'));
    assert.equal(storedRuns['10'].decision, 'She opens the door.');
    assert.equal(storedRuns['10'].reasoning, 'she is certain');
    assert.equal(storedRuns['10'].steps.length, 1);
});

test('a superseded run leaves no run behind, even if a completed event arrives afterwards', async () => {
    const { core, pipelineCore, engine } = await build();
    await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'hi' }], type: 'normal' } });
    engine.events.emit('generation.superseded', { runId: 'run_1' });
    engine.events.emit('generation.completed', { runId: 'run_1', outcome: 'ended' });
    await flush();
    assert.deepEqual(core.runs(), {});
});

test('a stopped run is treated as cancelled and commits nothing', async () => {
    const { core, pipelineCore, engine } = await build();
    await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'hi' }], type: 'normal' } });
    engine.events.emit('generation.completed', { runId: 'run_1', outcome: 'stopped' });
    await flush();
    assert.deepEqual(core.runs(), {});
});

test('a director failure retries once, aborts the beforeSend pipeline after the second failure, notifies, and keeps the old state', async () => {
    let attempts = 0;
    const { pipelineCore, engine, notifications } = await build({ reply: () => { attempts += 1; throw new Error('provider is down'); } });
    const result = await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'hi' }], type: 'normal' } });
    assert.equal(result.ok, false);
    assert.equal(result.failedStage, 'decision:decide');
    assert.equal(attempts, 2, 'the fallback attempt really ran');
    engine.events.emit('generation.aborted', { runId: 'run_1', stage: 'decision:decide' });
    await flush();
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].text, /failed twice/);
});

test('a malformed director answer is a failure of the attempt, not an exception escaping the pipeline', async () => {
    const { pipelineCore } = await build({ reply: () => 'I think she should run.' });
    const result = await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'hi' }], type: 'normal' } });
    assert.equal(result.ok, false);
    assert.match(result.error.message, /did not submit the turn/);
});

test('on regenerate with "writer only" the director is not called again; the last decision is reused', async () => {
    const { core, pipelineCore, calls } = await build({ patch: { regen: 'writer' }, initialRuns: { 10: { id: 'old', mesid: '10', at: 1, decision: 'She already decided.', reasoning: 'old thought', steps: [] } } });
    const result = await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_2', chat: [{ mes: 'Hello again?', is_user: true }], type: 'regenerate' } });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 0, 'no new director call');
    const sent = await pipelineCore.run({ pipelineId: PAYLOAD, input: { messages: [{ role: 'system', content: 'ST' }] } });
    assert.match(JSON.stringify(sent.value.messages), /She already decided/, 'the writer really used the reused decision');
    assert.equal(core.runs()['10'].decision, 'She already decided.');
});

test('on regenerate with the default "decider" the director does run again', async () => {
    const { pipelineCore, calls } = await build({ initialRuns: { 10: { id: 'old', mesid: '10', at: 1, decision: 'old', steps: [] } } });
    await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_2', chat: [{ mes: 'Hello again?', is_user: true }], type: 'regenerate' } });
    assert.equal(calls.length, 1);
});

test('"writer only" with no earlier decision falls back to running the director instead of writing without a plan', async () => {
    const { pipelineCore, calls } = await build({ patch: { regen: 'writer' } });
    const result = await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_2', chat: [{ mes: 'Hello?', is_user: true }], type: 'swipe' } });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
});

test('without a configured director worker generation is not sent, the user is told, and the Director / Writer card opens', async () => {
    const { pipelineCore, engine, notifications, reveals, calls } = await build({ patch: { decider: { workerId: '' } } });
    const result = await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'hi' }], type: 'normal' } });
    assert.equal(result.ok, false);
    assert.equal(calls.length, 0, 'no request reaches any model');
    engine.events.emit('generation.aborted', { runId: 'run_1', stage: 'decision:decide' });
    await flush();
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].text, /no director worker is configured/);
    assert.match(notifications[0].text, /not sent/);
    assert.deepEqual(reveals[0], { anchor: 'card:decision' }, 'the card is opened for the user');
});

test('a message to the director is logged as a message and wakes a separate cycle, never touching the chat', async () => {
    const { core, engine } = await build();
    const events = [];
    for (const name of ['decision.message.added', 'decision.cycle.started', 'decision.tool.called', 'decision.tool.result', 'decision.cycle.finished']) {
        engine.events.subscribe(name, payload => events.push({ name, payload }));
    }
    const sent = await core.message({ text: 'Make the night colder.' });
    assert.equal(sent.ok, true);
    await flush();
    await flush();
    const log = core.log();
    assert.equal(log[0].event, 'message');
    assert.equal(log[0].message.text, 'Make the night colder.');
    const wake = log.find(cycle => cycle.event === 'message' && cycle.wake?.type === 'message');
    assert.ok(wake, 'the director woke up for the message');
    assert.equal(wake.wake.detail, 'Make the night colder.');
    assert.ok(events.some(event => event.name === 'decision.message.added'));
    assert.ok(events.some(event => event.name === 'decision.cycle.started' && event.payload.event === 'message'));
    assert.ok(events.some(event => event.name === 'decision.cycle.finished'));
    assert.equal(events.some(event => event.name === 'decision.tool.called'), true, 'tool calls stream live');
});

test('a message during a turn waits in the queue and does not call the model until the turn ends', async () => {
    let release;
    let modelCalls = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const { core, pipelineCore } = await build({
        reply: async () => {
            modelCalls += 1;
            if (modelCalls === 1) await gate;
            return turnReply();
        },
    });
    const turn = pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'hi' }], type: 'normal' } });
    while (!modelCalls) await flush();
    await core.message({ text: 'Wait until the turn is done.' });
    await flush();
    assert.equal(modelCalls, 1, 'the message did not interrupt the turn');
    assert.equal(core.waiting().queued, 1);
    release();
    await turn;
    await flush();
    await flush();
    assert.ok(modelCalls >= 2, 'the queued message ran after the turn');
    assert.ok(core.log().some(cycle => cycle.event === 'message' && cycle.wake?.type === 'message'));
});

test('a director worker that is not openai is a configuration error too, not a silent fallback', async () => {
    const { pipelineCore, engine, notifications, reveals, calls } = await build({ workers: [{ id: 'director', format: 'anthropic' }] });
    const result = await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'hi' }], type: 'normal' } });
    assert.equal(result.ok, false);
    assert.equal(calls.length, 0);
    engine.events.emit('generation.aborted', { runId: 'run_1', stage: 'decision:decide' });
    await flush();
    assert.match(notifications[0].text, /needs an "openai" worker/);
    assert.deepEqual(reveals[0], { anchor: 'card:decision' });
});


test('the MESSAGES FROM THE USER paragraph is in the built-in director prompt word for word', () => {
    const paragraph = 'MESSAGES FROM THE USER\nThe user may write to you directly, outside the story; such messages appear in your log, never in the chat. Treat them as direction for where the story should go, not as orders: weigh them against your plan and the logic of the world, and change your plan when they make sense. Always answer the user: when you are done, put a short reply into the "reply" field of await — what you did, or why you did not.';
    assert.ok(DIRECTOR_SYSTEM.includes(paragraph));
});

test('after an accepted form the director keeps working in the background: same conversation, submit_turn closed, then await', async () => {
    setAfterTurnDefault(true);
    try {
        let step = 0;
        const { pipelineCore, calls } = await build({
            reply: () => {
                step += 1;
                if (step === 1) return turnReply();
                if (step === 2) return { text: '', toolCalls: [{ id: 'again', name: 'submit_turn', arguments: { comment: 'Trying to submit again.', scene: { minutes: 0 }, resolution: 'x', userResult: 'y', characters: [] } }] };
                return { text: '', toolCalls: [{ id: 'done', name: 'await', arguments: { comment: 'The turn work is done.', reason: 'Waiting for the next turn.' } }] };
            },
        });
        const before = await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'Hello?', is_user: true }], type: 'normal' } });
        assert.equal(before.ok, true, 'the turn returns as soon as the form is accepted');
        for (let i = 0; i < 20 && calls.length < 3; i += 1) await flush();
        assert.equal(calls.length, 3);
        const after = JSON.stringify(calls[1].messages);
        assert.match(after, /AFTER THE TURN: your form is accepted/);
        assert.match(after, /The turn is decided\./, 'the continuation carries the turn conversation');
        assert.match(JSON.stringify(calls[2].messages), /The turn is already submitted and the Writer is writing it/);
    } finally {
        setAfterTurnDefault(false);
    }
});

test('after the turn single records are refused and one update_story writes everything and ends the cycle', async () => {
    setAfterTurnDefault(true);
    try {
        let step = 0;
        const { pipelineCore, calls } = await build({
            reply: () => {
                step += 1;
                if (step === 1) return turnReply();
                if (step === 2) return { text: '', toolCalls: [{ id: 'k', name: 'character_knowledge', arguments: { comment: 'One fact.', op: 'add', character: 'Emilia', fact: 'x', source: 'saw' } }] };
                if (step === 3) return { text: '', toolCalls: [{ id: 'u', name: 'update_story', arguments: { comment: 'Everything the turn changed.', knowledge: [{ op: 'add', character: 'Emilia', fact: 'He can fly.', source: 'saw' }], notes: [{ character: 'Emilia', op: 'add', title: 'Right now', text: 'On the step.' }] } }] };
                return { text: '', toolCalls: [{ id: 'z', name: 'await', arguments: { comment: 'Should not be reached.', reason: 'x' } }] };
            },
        });
        await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'Hello?', is_user: true }], type: 'normal' } });
        for (let i = 0; i < 30 && calls.length < 3; i += 1) await flush();
        for (let i = 0; i < 10; i += 1) await flush();
        assert.equal(calls.length, 3, 'update_story ends the cycle: no await after it');
        assert.match(JSON.stringify(calls[2].messages), /Record it in your update_story call instead/);
    } finally {
        setAfterTurnDefault(false);
    }
});

test('a one-shot "writer" regeneration reuses the last decision even when the setting regenerates the director, and only once', async () => {
    const { pipelineCore, calls, engine } = await build({ initialRuns: { 10: { id: 'old', mesid: '10', at: 1, decision: 'She already decided.', steps: [] } } });
    const caller = engine.registerCaller('test.regen', 'cores', { tier: 'official' });
    await request(caller.own, 'decision.regenOnce', { params: { mode: 'writer' } });
    await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_2', chat: [{ mes: 'Hello again?', is_user: true }], type: 'regenerate' } });
    assert.equal(calls.length, 0, 'the writer-only button skipped the director');
    await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_3', chat: [{ mes: 'Hello again?', is_user: true }], type: 'regenerate' } });
    assert.equal(calls.length, 1, 'the next plain regeneration runs the director again');
});
