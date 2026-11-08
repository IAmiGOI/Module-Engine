import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { createDecisionCore } from '../cores/decision/index.js';
import { setAfterTurnDefault } from '../libraries/core/decision-settings.js';
setAfterTurnDefault(false); // эти тесты считают вызовы модели; работа после хода проверяется отдельно

const memoryKey = (namespace, key) => `${namespace}:${key}`;
const clone = value => JSON.parse(JSON.stringify(value));
let callCounter = 0;
const call = (name, args) => ({ text: '', toolCalls: [{ id: `${name}_${(callCounter += 1)}`, name, arguments: args }] });
const setPlan = () => call('set_plan', { direction: 'Keep the keep moving.', comment: 'A direction is required before the form.' });
const form = () => call('inscribe', {
    comment: 'The form is ready for the writer.', resolution: 'They move on.', userResult: 'The user waits.',
    scene: { minutes: 5 }, characters: [],
});

async function build({ settings = {}, memory = new Map() } = {}) {
    const engine = createEngine();
    const storedSettings = new Map();
    const calls = [];
    const events = [];
    let lastMesid = null;
    let lastMes = '';
    engine.buses.cores.register('storage.settings.get', ({ namespace, key, fallback }) => (storedSettings.has(memoryKey(namespace, key)) ? clone(storedSettings.get(memoryKey(namespace, key))) : fallback));
    engine.buses.cores.register('storage.settings.set', ({ namespace, key, value }) => { storedSettings.set(memoryKey(namespace, key), clone(value)); return true; });
    engine.buses.cores.register('storage.chatMemory.get', ({ namespace, key, fallback }) => (memory.has(memoryKey(namespace, key)) ? clone(memory.get(memoryKey(namespace, key))) : fallback));
    engine.buses.cores.register('storage.chatMemory.set', ({ namespace, key, value }) => { memory.set(memoryKey(namespace, key), clone(value)); return true; });
    engine.buses.cores.register('model.workers.get', () => [{ id: 'director', format: 'openai' }]);
    engine.buses.cores.register('summary.list', () => []);
    engine.buses.cores.register('chatHistory.messages', () => (lastMesid === null ? [] : [{ mesid: 'greeting', mes: 'Hello.' }, { mesid: lastMesid, mes: lastMes }]));
    engine.buses.cores.register('chatHistory.chatId', () => ({ open: true, id: 'chat-1' }));
    engine.buses.cores.register('chatHistory.annotations', () => ({}));
    engine.buses.cores.register('ui.notify', () => true);
    engine.buses.cores.register('generation.tools', () => []);
    engine.buses.cores.register('generation.callTool', () => 'ok');
    engine.buses.cores.register('model.generate', async params => {
        calls.push(params);
        if (String(params.prompt ?? '').includes('floating window is being rolled over')) return 'The first cycles are over.';
        return { text: '', toolCalls: [...setPlan().toolCalls, ...form().toolCalls] };
    });
    engine.events.subscribe('decision.window.switched', payload => events.push(payload));
    const core = createDecisionCore(engine.registerCaller('core.decision', 'cores', { tier: 'official' }), { retryDelayMs: 0 });
    await core.load();
    await core.configure({ assessSeed: 1, decider: { workerId: 'director' }, ...settings });

    async function turn(number) {
        const runId = `run_${number}`;
        lastMesid = number;
        lastMes = `prose ${number}`;
        await core.decide({ runId, chat: [{ mes: `user ${number}`, is_user: true }], type: 'normal' });
        engine.events.emit('generation.completed', { runId, outcome: 'ended' });
        await new Promise(resolve => setTimeout(resolve, 30));
    }

    return { core, calls, memory, events, turn };
}

test('a real turn lands in the floating window with the user message and the writer reply', async () => {
    const { core, turn } = await build({ settings: { windowLimit: 4, windowDropShare: 0.5 } });
    await turn(1);
    const entries = core.window().entries;
    assert.equal(entries.length, 1);
    assert.match(entries[0].text, /User: user 1/);
    assert.match(entries[0].text, /Writer: prose 1/);
    assert.doesNotMatch(entries[0].text, /PUSH:/);
});

test('a small window limit switches the window, freezes the summary and puts it before the new cycles', async () => {
    const { core, calls, events, turn } = await build({ settings: { windowLimit: 4, windowDropShare: 0.5 } });
    for (let number = 1; number <= 4; number += 1) await turn(number);
    assert.equal(core.window().entries.filter(entry => entry.kind === 'turn').length, 2, 'half of four cycles stay');
    assert.equal(core.frozen().length, 1);
    assert.match(core.frozen()[0].text, /The first cycles are over/);
    assert.ok(events.some(payload => payload.reason === '50 cycles'), 'the reason is recorded even with a test limit');
    assert.equal(core.log().length, 2, 'the log keeps only the cycles still in the window');
    assert.ok(core.archive().length >= 2, 'the dropped full cycles are archived');

    await turn(5);
    const lastContext = calls.at(-1).messages.map(message => message.content).join('\n');
    assert.match(lastContext, /PREVIOUS WINDOWS \(summaries\):/);
    assert.match(lastContext, /The first cycles are over/);
    assert.doesNotMatch(lastContext, /TURN 1 \(compressed\)/, 'the dropped cycles are gone from the context');
});

test('a page reload does not restart the turn count: the next turn is appended, the history in the window is kept', async () => {
    const memory = new Map();
    const first = await build({ memory });
    for (let number = 1; number <= 3; number += 1) await first.turn(number);
    assert.deepEqual(first.core.window().entries.filter(entry => entry.kind === 'turn').map(entry => entry.turn), [1, 2, 3]);
    const reloaded = await build({ memory });
    await reloaded.turn(4);
    const turns = reloaded.core.window().entries.filter(entry => entry.kind === 'turn');
    assert.deepEqual(turns.map(entry => entry.turn), [1, 2, 3, 4], 'turns 2–3 are not wiped by a restarted counter');
    assert.match(turns.at(-1).text, /User: user 4/);
});
