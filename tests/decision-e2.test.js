import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { createPipelineCore } from '../cores/pipeline/index.js';
import { createDecisionCore } from '../cores/decision/index.js';
import { setAfterTurnDefault } from '../libraries/core/decision-settings.js';
setAfterTurnDefault(false); // эти тесты считают вызовы модели; работа после хода проверяется отдельно

/**
 * e2 на уровне ядра: assess с e5 (фейковые векторы), строгая форма, место и
 * время без модели, Push в теле прозаика.
 */

const BEFORE_SEND = 'generation.beforeSend';
const PAYLOAD = 'generation.payload';
const memoryKey = (namespace, key) => `${namespace}:${key}`;
const clone = value => JSON.parse(JSON.stringify(value));
const call = (name, args) => ({ text: '', toolCalls: [{ id: `${name}_1`, name, arguments: args }] });
const hash = text => [...String(text)].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 100000, 7);

function lena(assessId = 'asm_run_1_1') {
    return {
        name: 'Lena', decision: 'Leave the keep.', decisionReason: 'She is out of time.',
        action: 'Opens the east door.', actionReason: 'It is the only exit.',
        assessId, outcome: 'The lock gives after a hard pull.', speech: 'Not tonight.',
    };
}

async function build({ replies }) {
    const engine = createEngine();
    const settings = new Map();
    const memory = new Map();
    const calls = [];
    const timeShifts = [];
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
    engine.buses.cores.register('map.nodes.list', () => [{ id: 'keep', name: 'KEEP' }, { id: 'wing', name: 'EAST WING' }, { id: 'room', name: 'EAST CORRIDOR' }]);
    engine.buses.cores.register('map.nodes.containmentPath', ({ id }) => id === 'room' ? ['keep', 'wing', 'room'] : []);
    engine.buses.cores.register('embedding.compute', ({ text }) => [hash(text)]);
    engine.buses.cores.register('embedding.similarity', ({ a, b }) => (a[0] === b[0] ? 1 : 0));
    engine.buses.cores.register('ui.notify', () => true);
    engine.buses.cores.register('generation.tools', () => []);
    engine.buses.cores.register('generation.callTool', () => 'ok');
    engine.buses.cores.register('model.generate', async params => {
        calls.push(params);
        return replies[index++] ?? { text: '', toolCalls: [] };
    });
    engine.events.subscribe('decision.timeShift', payload => timeShifts.push(payload));

    const pipelineCore = createPipelineCore(engine.registerCaller('core.pipeline', 'cores', { tier: 'official' }), {
        resolveAs: engine.resolveAs,
        publish: (event, payload) => engine.events.emit(event, payload),
    });
    pipelineCore.define({ id: BEFORE_SEND, mode: 'collect' });
    pipelineCore.define({ id: PAYLOAD, mode: 'fold' });
    const core = createDecisionCore(engine.registerCaller('core.decision', 'cores', { tier: 'official' }), { retryDelayMs: 0 });
    await core.load();
    await core.configure({ assessSeed: 1, decider: { workerId: 'director' } });
    return { engine, pipelineCore, core, calls, memory, timeShifts };
}

test('assess uses the two-level table, the form validates, the place is read from the map and the minute count shifts RP Time', async () => {
    const { pipelineCore, calls, memory, timeShifts } = await build({
        replies: [
            call('update_roster', { add: [{ name: 'Lena' }], comment: 'Lena is now in the scene and can affect it.' }),
            call('assess', { character: 'Lena', action: 'opens the door', kind: 'body', difficulty: 'trivial', experience: 'master', why: 'The door is the only exit.', comment: 'I need the chance before writing the outcome.' }),
            call('set_plan', { direction: 'Get her out of the keep before dawn.', comment: 'I need a direction before the turn can be submitted.' }),
            call('submit_turn', {
                comment: 'The form is ready for the writer.', resolution: 'She gets out before the guard turns the corner.',
                userResult: 'The user pushes the door; it opens but the sleeve tears.', scene: { minutes: 90 },
                characters: [lena()],
            }),
        ],
    });
    const result = await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'hi' }], type: 'normal' } });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 4, 'roster, assess, plan, form');

    const log = memory.get(memoryKey('core.decision', 'log'));
    const assess = log[0].toolCalls.find(entry => entry.name === 'assess');
    assert.ok(assess.result.probability > 0.9, `trivial + master is very likely, got ${assess.result.probability}`);
    assert.equal(assess.result.difficulty, 'trivial');
    assert.equal(assess.result.experience, 'master');
    assert.ok(assess.result.words.length > 0);
    assert.equal(log[0].toolCalls.find(entry => entry.name === 'submit_turn').result.ok, true);

    assert.equal(timeShifts.length, 1);
    assert.deepEqual(timeShifts[0], { runId: 'run_1', minutes: 90, timeBefore: 'Day 1, 08:00 (Morning)', timeAfter: 'Day 1, 09:30 (Morning)', clockMinutes: 2010 });
});

test('the writer receives a Push with place, time, the user result and the degree words — and no tools', async () => {
    const { pipelineCore } = await build({
        replies: [
            call('update_roster', { add: [{ name: 'Lena' }], comment: 'Lena is now in the scene and can affect it.' }),
            call('assess', { character: 'Lena', action: 'opens the door', kind: 'body', difficulty: 'trivial', experience: 'master', why: 'The door is the only exit.', comment: 'I need the chance before writing the outcome.' }),
            call('set_plan', { direction: 'Get her out of the keep before dawn.', comment: 'I need a direction before the turn can be submitted.' }),
            call('submit_turn', {
                comment: 'The form is ready for the writer.', resolution: 'She gets out before the guard turns the corner.',
                userResult: 'The user pushes the door; it opens but the sleeve tears.', scene: { minutes: 90 },
                characters: [lena()],
            }),
        ],
    });
    await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'hi' }], type: 'normal' } });
    const result = await pipelineCore.run({ pipelineId: PAYLOAD, input: { messages: [{ role: 'system', content: 'ST' }], tools: [{ type: 'function', function: { name: 'Notebook' } }], stream: true } });
    const body = result.value;
    const text = body.messages.map(message => message.content).join('\n');
    assert.match(text, /took 90 minutes/);
    assert.match(text, /Place: KEEP → EAST WING → EAST CORRIDOR/);
    assert.match(text, /Time: Day 1, 09:30 \(Morning\)/);
    assert.match(text, /The user's action: The user pushes the door/);
    assert.match(text, /Lena will Opens the east door because It is the only exit/);
    assert.match(text, /— (flawlessly, exactly as intended|cleanly, without a hitch|barely, with visible effort|clumsily, with a mistake|badly botched)/);
    assert.match(text, /When the push says an opponent may counter something a character did not expect/);
    assert.equal('tools' in body, false);
    assert.equal(body.stream, true);
});

test('an incomplete form is refused with the list of missing fields, and the director can fix it and submit again', async () => {
    const { pipelineCore, calls } = await build({
        replies: [
            call('update_roster', { add: [{ name: 'Lena' }], comment: 'Lena is now in the scene and can affect it.' }),
            call('assess', { character: 'Lena', action: 'opens the door', kind: 'body', difficulty: 'easy', experience: 'skilled', why: 'The door is the only exit.', comment: 'I need the chance before writing the outcome.' }),
            call('set_plan', { direction: 'Get her out of the keep before dawn.', comment: 'I need a direction before the turn can be submitted.' }),
            call('submit_turn', { comment: 'The form is ready.', resolution: 'She leaves.', userResult: 'The user waits.', scene: { minutes: 5 }, characters: [] }),
            call('submit_turn', {
                comment: 'The form is ready now.', resolution: 'She gets out.', userResult: 'The user waits.', scene: { minutes: 5 },
                characters: [lena()],
            }),
        ],
    });
    const result = await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'hi' }], type: 'normal' } });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 5, 'the refused form cost one more model call');
});

test('a form that omits an active roster member is refused, and the missing name is in the tool result', async () => {
    const { pipelineCore, memory } = await build({
        replies: [
            call('update_roster', { add: [{ name: 'Lena' }, { name: 'Marek' }], comment: 'Both are in the scene now.' }),
            call('assess', { character: 'Lena', action: 'opens the door', kind: 'body', difficulty: 'easy', experience: 'skilled', why: 'The door is the only exit.', comment: 'I need the chance before writing the outcome.' }),
            call('set_plan', { direction: 'Get her out of the keep before dawn.', comment: 'I need a direction before the turn can be submitted.' }),
            call('submit_turn', { comment: 'The form is ready.', resolution: 'She leaves.', userResult: 'The user waits.', scene: { minutes: 5 }, characters: [lena()] }),
            call('submit_turn', {
                comment: 'The form is ready now.', resolution: 'They leave.', userResult: 'The user waits.', scene: { minutes: 5 },
                characters: [lena(), { ...lena('asm_run_1_1'), name: 'Marek', action: 'Follows her out.' }],
            }),
        ],
    });
    await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'hi' }], type: 'normal' } });
    const log = memory.get(memoryKey('core.decision', 'log'));
    const first = log[0].toolCalls.filter(entry => entry.name === 'submit_turn')[0];
    assert.equal(first.result.ok, false);
    assert.match(first.result.missing.join('\n'), /Marek/);
});
