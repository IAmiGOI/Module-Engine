import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { createPipelineCore } from '../cores/pipeline/index.js';
import { createDecisionCore } from '../cores/decision/index.js';

const BEFORE_SEND = 'generation.beforeSend';
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
    await core.configure({ assessSeed: 1, decider: { workerId: 'director' } });
    return { pipelineCore, core, calls, memory };
}

const form = (characters = [], minutes = 5) => call('submit_turn', {
    comment: 'The form is ready for the writer.', resolution: 'They move on.', userResult: 'The user waits.',
    scene: { minutes }, characters,
});

async function flush() {
    for (let index = 0; index < 12; index += 1) await new Promise(resolve => setTimeout(resolve, 0));
}

test('an 8-hour jump closes several plans oldest-first in the passive cycle, and the writer turn does not wait for it', async () => {
    const { pipelineCore, core, calls, memory } = await build({
        replies: [
            call('set_plan', { direction: 'Keep the keep moving.', comment: 'A direction is required before the form.' }),
            call('set_character_level', { character: 'A', level: 1, comment: 'A matters to the story.' }),
            call('set_character_level', { character: 'B', level: 1, comment: 'B matters to the story.' }),
            call('set_character_plan', { character: 'A', summary: 'Find the key.', durationMinutes: 180, comment: 'A has a plan outside the scene.' }),
            call('set_character_plan', { character: 'B', summary: 'Talk to the guard.', durationMinutes: 240, comment: 'B has a plan outside the scene.' }),
            form([], 480),
            call('resolve_character_plan', { character: 'A', result: 'A found the key.', comment: 'The first plan is over.' }),
            call('resolve_character_plan', { character: 'B', result: 'B learned the guard rotates at dawn.', important: true, comment: 'The second plan is over.' }),
            call('await', { reason: 'no more due plans', comment: 'Nothing else ends right now.' }),
        ],
    });
    const result = await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'hi' }], type: 'normal' } });
    assert.equal(result.ok, true);
    await flush();

    const bank = core.bank();
    assert.ok(bank.a?.[0]?.text.includes('found the key'));
    assert.equal(bank.b?.[0]?.important, true);
    assert.ok(core.plans().every(plan => plan.resolvedAt));

    const log = memory.get(memoryKey('core.decision', 'log'));
    const passive = log.find(cycle => cycle.event === 'time');
    assert.ok(passive, 'the passive cycle is in the director log');
    assert.deepEqual(passive.toolCalls.map(entry => entry.name), ['resolve_character_plan', 'resolve_character_plan', 'await']);
    assert.deepEqual(passive.toolCalls.map(entry => entry.args.character).slice(0, 2), ['A', 'B']);
    assert.equal(calls.filter(params => String(params.requestId).includes(':p')).length, 3, 'the passive cycle ran only its own calls, after the form');
});

test('entering the roster interrupts an existing plan: it becomes approximate and loses its due time', async () => {
    const { pipelineCore, core } = await build({
        replies: [
            call('set_plan', { direction: 'Bring A in.', comment: 'A direction is required before the form.' }),
            call('set_character_level', { character: 'A', level: 1, comment: 'A matters to the story.' }),
            call('set_character_plan', { character: 'A', summary: 'Find the key.', durationMinutes: 180, comment: 'A has a plan outside the scene.' }),
            call('update_roster', { add: [{ name: 'A' }], comment: 'A walks into the scene.' }),
            call('assess', { character: 'A', action: 'arrives', kind: 'body', difficulty: 'easy', experience: 'skilled', why: 'The road is clear.', comment: 'The chance matters for the form.' }),
            form([{ name: 'A', decision: 'Arrive.', decisionReason: 'She was called.', action: 'Walks in.', actionReason: 'The door is open.', assessId: 'asm_run_1_1', outcome: 'She makes it in.' }], 5),
        ],
    });
    const result = await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'hi' }], type: 'normal' } });
    assert.equal(result.ok, true);
    const plan = core.plans().find(item => item.character === 'A');
    assert.equal(plan.interrupted, true);
    assert.equal(plan.dueAt, null);
    assert.equal(plan.approximate, true);
});

test('level 4 gets no plan, and a level-5 character disappears from the library when it leaves the roster', async () => {
    const { pipelineCore, core, memory } = await build({
        replies: [
            call('set_plan', { direction: 'Keep the world moving.', comment: 'A direction is required before the form.' }),
            call('set_character_level', { character: 'C', level: 4, comment: 'C is not important and not frequent.' }),
            call('set_character_plan', { character: 'C', summary: 'Nothing much.', durationMinutes: 600, comment: 'C should not get a plan.' }),
            call('update_roster', { add: [{ name: 'D' }], comment: 'D is here for one scene.' }),
            call('set_character_level', { character: 'D', level: 5, comment: 'D is a one-off.' }),
            call('update_roster', { remove: ['D'], comment: 'D leaves and is not coming back.' }),
            form([], 5),
        ],
    });
    const result = await pipelineCore.run({ pipelineId: BEFORE_SEND, input: { runId: 'run_1', chat: [{ mes: 'hi' }], type: 'normal' } });
    assert.equal(result.ok, true);
    const log = memory.get(memoryKey('core.decision', 'log'));
    const level4Plan = log[0].toolCalls.find(entry => entry.name === 'set_character_plan');
    assert.equal(level4Plan.result.ok, false);
    assert.match(level4Plan.result.error, /takes no timed plans/);
    assert.equal(core.library().d, undefined, 'level 5 is gone after the roster exit');
    assert.ok(core.library().c, 'level 4 stays in the library');
});
