import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { createDecisionCore } from '../cores/decision/index.js';

const memoryKey = (namespace, key) => `${namespace}:${key}`;
const clone = value => JSON.parse(JSON.stringify(value));
let callCounter = 0;
const call = (name, args) => ({ text: '', toolCalls: [{ id: `${name}_${(callCounter += 1)}`, name, arguments: args }] });
const form = () => call('submit_turn', {
    comment: 'The form is ready for the writer.', resolution: 'They move on.', userResult: 'The user waits.',
    scene: { minutes: 5, place: 'the east corridor' }, characters: [],
});
const setPlan = () => call('set_plan', { direction: 'Keep the keep moving.', comment: 'A direction is required before the form.' });

const oldCycle = (index, event = 'turn') => ({
    id: `old_${index}`, runId: `old_run_${index}`, at: index * 100, event, turn: index,
    messages: [{ role: 'user', content: `old message ${index}` }], toolCalls: [],
    thinking: `thought ${index}`, tokens: 100, warnings: [],
});

async function build({ replies, seed = {}, settings = {} }) {
    const engine = createEngine();
    const storedSettings = new Map();
    const memory = new Map(Object.entries(seed).map(([key, value]) => [key, clone(value)]));
    const calls = [];
    const events = [];
    let index = 0;
    let lastMesid = null;
    engine.buses.cores.register('storage.settings.get', ({ namespace, key, fallback }) => storedSettings.has(memoryKey(namespace, key)) ? clone(storedSettings.get(memoryKey(namespace, key))) : fallback);
    engine.buses.cores.register('storage.settings.set', ({ namespace, key, value }) => { storedSettings.set(memoryKey(namespace, key), clone(value)); return true; });
    engine.buses.cores.register('storage.chatMemory.get', ({ namespace, key, fallback }) => memory.has(memoryKey(namespace, key)) ? clone(memory.get(memoryKey(namespace, key))) : fallback);
    engine.buses.cores.register('storage.chatMemory.set', ({ namespace, key, value }) => { memory.set(memoryKey(namespace, key), clone(value)); return true; });
    engine.buses.cores.register('model.workers.get', () => [{ id: 'director', format: 'openai' }]);
    engine.buses.cores.register('summary.list', () => []);
    engine.buses.cores.register('chatHistory.messages', () => (lastMesid === null ? [] : [{ mesid: lastMesid }]));
    engine.buses.cores.register('chatHistory.annotations', () => ({}));
    engine.buses.cores.register('embedding.compute', () => null);
    engine.buses.cores.register('embedding.similarity', () => 0);
    engine.buses.cores.register('ui.notify', () => true);
    engine.buses.cores.register('generation.tools', () => []);
    engine.buses.cores.register('generation.callTool', () => 'ok');
    engine.buses.cores.register('model.generate', async params => {
        calls.push(params);
        engine.events.emit('model.generate.raw', {
            requestId: params.requestId, format: 'openai',
            body: JSON.stringify({ choices: [{ message: { reasoning_content: `thought for ${params.requestId}` } }] }),
        });
        return replies[index++] ?? { text: '', toolCalls: [] };
    });
    engine.events.subscribe('decision.digest.appended', payload => events.push(['digest', payload]));
    engine.events.subscribe('decision.digest.correction', payload => events.push(['correction', payload]));
    engine.events.subscribe('decision.log.warning', payload => events.push(['warning', payload]));
    engine.events.subscribe('decision.log.compacted', payload => events.push(['compacted', payload]));

    const core = createDecisionCore(engine.registerCaller('core.decision', 'cores', { tier: 'official' }), { retryDelayMs: 0 });
    await core.load();
    await core.configure({ assessSeed: 1, decider: { workerId: 'director' }, ...settings });

    async function turn(number) {
        const runId = `run_${number}`;
        lastMesid = String(number);
        const before = calls.length;
        await core.decide({ runId, chat: [{ mes: `user ${number}`, is_user: true }], type: 'normal' });
        engine.events.emit('generation.completed', { runId, outcome: 'ended' });
        await new Promise(resolve => setTimeout(resolve, 5));
        return calls.slice(before);
    }

    return { core, engine, calls, memory, events, turn, setMesid: value => { lastMesid = value; } };
}

test('after turn N+1 the prefix holds compressed 1…N−1 and the two full turns N and N+1', async () => {
    const { core, turn } = await build({ replies: [setPlan(), form(), form(), form(), form()] });
    await turn(1);
    await turn(2);
    await turn(3);
    assert.equal(core.digests().length, 1, 'turn 1 is compressed after turn 3');
    assert.match(core.digests()[0].text, /^TURN 1 \(compressed\)/);
    assert.equal(core.archive().length, 1, 'the full turn 1 is archived');
    assert.equal(core.log().length, 2, 'the log keeps exactly turns 2 and 3');

    const contextText = (await turn(4))[0].messages.map(message => message.content).join('\n');
    assert.match(contextText, /EARLIER TURNS \(compressed\)/);
    assert.match(contextText, /TURN 1 \(compressed\)/);
    assert.match(contextText, /TURN 2 \(full\)/);
    assert.match(contextText, /TURN 3 \(full\)/);
    assert.doesNotMatch(contextText, /TURN 1 \(full\)/);
    assert.doesNotMatch(contextText, /TURN 4 \(full\)/, 'the turn in progress is not in the log yet');
});

test('a compressed record never changes between later requests', async () => {
    const { core, turn } = await build({ replies: [setPlan(), form(), form(), form(), form()] });
    await turn(1);
    await turn(2);
    await turn(3);
    const first = core.digests()[0].text;
    await turn(4);
    assert.equal(core.digests()[0].text, first, 'the record of turn 1 is byte-identical');
    assert.equal(core.digests()[1].text.startsWith('TURN 2 (compressed)'), true);
    assert.match(core.digests()[1].text, /Resolution: They move on/);
});

test('the archive keeps the full turn, while the digest leaves thinking and read results out', async () => {
    const { core, turn } = await build({ replies: [setPlan(), form(), form(), form()] });
    await turn(1);
    await turn(2);
    await turn(3);
    const archived = core.archive()[0];
    assert.ok(Array.isArray(archived.messages));
    assert.match(archived.thinking, /thought for run_1/);
    assert.equal(archived.form.resolution, 'They move on.');
    assert.match(archived.push, /This turn took 5 minutes/);
    assert.doesNotMatch(core.digests()[0].text, /thought for run_1/);
});

test('swiping the last turn does not change the compressed part, and a swiped turn is never compressed', async () => {
    const { core, engine, turn } = await build({ replies: [setPlan(), form(), form(), form(), form(), form(), form()] });
    await turn(1);
    await turn(2);
    await turn(3);
    const before = JSON.stringify(core.digests());
    engine.events.emit('st.messageSwiped');
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(JSON.stringify(core.digests()), before, 'the compressed part did not move on a swipe');

    await turn(4);
    await turn(5);
    await turn(6);
    assert.equal(core.digests().some(record => /^TURN 3 \(compressed\)/.test(record.text)), false, 'the swiped turn is not compressed');
});

test('deleting an already compressed message appends a correction instead of rewriting the record', async () => {
    const { core, engine, turn } = await build({ replies: [setPlan(), form(), form(), form()] });
    await turn(1);
    await turn(2);
    await turn(3);
    const first = core.digests()[0].text;
    engine.events.emit('st.messageDeleted', { args: [1] });
    await new Promise(resolve => setTimeout(resolve, 10));
    const digests = core.digests();
    assert.equal(digests[0].text, first, 'the old record is untouched');
    assert.match(digests.at(-1).text, /turn 1: message deleted by the user/);
});

test('closed arcs are summarized when the compressed part grows past its own limit', async () => {
    const long = 'OLD-DIGEST '.repeat(200);
    const { core, calls } = await build({
        replies: [setPlan(), form(), 'The old escape is over; the key is still missing.'],
        seed: {
            [memoryKey('core.decision', 'log')]: [oldCycle(1), oldCycle(2)],
            [memoryKey('core.decision', 'turnDigests')]: [{ key: 'old', at: 100, text: long, tokens: 2000 }],
            [memoryKey('core.decision', 'arcs')]: [{ id: 'arc_1', title: 'The old escape', status: 'closed', stages: [{ note: 'She got out.' }], createdAt: 50, closedAt: 150 }],
        },
        settings: { compressedLimitTokens: 10 },
    });
    await core.decide({ runId: 'run_arc', chat: [{ mes: 'hello', is_user: true }], type: 'normal' });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(calls.some(params => String(params.prompt ?? '').includes('The old escape')), 'the model was asked for the arc summary');
    assert.match(core.arcs()[0].summary, /key is still missing/);
    assert.equal(core.digests().some(record => /OLD-DIGEST/.test(record.text)), false, 'the arc turns were replaced by its summary');
    assert.equal(core.digests().some(record => /CLOSED ARCS \(summary\)/.test(record.text)), true);
});
