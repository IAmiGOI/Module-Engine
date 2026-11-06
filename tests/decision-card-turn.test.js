import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { request } from '../libraries/shared/request.js';
import { createDecisionCore } from '../cores/decision/index.js';
import { setAfterTurnDefault } from '../libraries/core/decision-settings.js';
setAfterTurnDefault(false); // эти тесты считают вызовы модели; работа после хода проверяется отдельно

function build({ workers = [{ id: 'director', format: 'openai', model: 'director/model' }], replies = [] } = {}) {
    const engine = createEngine();
    const settings = new Map();
    const memory = new Map();
    const memoryWrites = [];
    const calls = [];
    const key = (namespace, name) => `${namespace}:${name}`;
    const bus = engine.buses.cores;
    bus.register('storage.settings.get', ({ namespace, key: name, fallback }) => settings.has(key(namespace, name)) ? structuredClone(settings.get(key(namespace, name))) : fallback);
    bus.register('storage.settings.set', ({ namespace, key: name, value }) => { settings.set(key(namespace, name), structuredClone(value)); return true; });
    bus.register('storage.chatMemory.get', ({ namespace, key: name, fallback }) => memory.has(key(namespace, name)) ? structuredClone(memory.get(key(namespace, name))) : fallback);
    bus.register('storage.chatMemory.set', ({ namespace, key: name, value }) => { memory.set(key(namespace, name), structuredClone(value)); memoryWrites.push(key(namespace, name)); return true; });
    bus.register('model.workers.get', () => workers);
    bus.register('summary.list', () => []);
    bus.register('model.generate', async params => {
        calls.push(params);
        const reply = replies.shift();
        if (!reply) throw new Error('the fake director has no reply left');
        return reply;
    });
    const core = createDecisionCore(engine.registerCaller('core.decision', 'cores', { tier: 'official' }), { retryDelayMs: 0 });
    return { engine, core, calls, memoryWrites, load: async () => { await core.load(); await core.configure({ decider: { workerId: 'director' } }); } };
}

const chat = [{ name: 'Sasha', is_user: true, mes: 'Who goes there?', extra: {} }];
const card = { name: 'Aria', description: 'Aria is a scout.' };

test('a card-test turn goes through the real director and gives the writer notes plus the push, while touching no chat state', async () => {
    const { call, calls, memoryWrites, load } = (() => {
        const made = build({
            replies: [
                { text: '', toolCalls: [{ id: 'c1', name: 'assess', arguments: { comment: 'I need the chance that Aria spots the visitor.', character: 'Aria', action: 'spots the visitor', kind: 'body', difficulty: 'easy', experience: 'skilled', why: 'The camp is quiet and the ground is clear.' } }] },
                { text: '', toolCalls: [{ id: 'c2', name: 'submit_turn', arguments: {
                    comment: 'The test turn is decided.',
                    scene: { minutes: 1 },
                    resolution: 'Aria steps out of the shadows.',
                    userResult: 'The user called into the dark and was heard.',
                    beats: [{ who: 'Aria', kind: 'action', text: 'steps out of the shadows' }, { who: 'Aria', kind: 'line', text: 'who goes there?' }], characters: [{ name: 'Aria', decision: 'Find out who is there.', decisionReason: 'A stranger is close to the camp.', action: 'steps out of the shadows', actionReason: 'She wants to see the visitor first.', outcome: 'She is a trained scout and the ground is clear.', assessId: 'asm_cardtest_1_1', speech: 'Who goes there?' }],
                } }] },
            ],
        });
        return { ...made, call: (contract, params) => request(made.engine.buses.cores, contract, { params }) };
    })();
    await load();
    const answer = await call('decision.cardTurn', { chat, card });
    assert.equal(answer.ok, true, answer.error?.message);
    const messages = answer.value.messages;
    const all = messages.map(message => message.content).join('\n');
    assert.match(all, /You are the Writer of a roleplay/);
    assert.match(all, /### Aria: Description\nAria is a scout\./, 'the card reaches the writer as character notes');
    assert.match(all, /END: Aria steps out of the shadows\./);
    assert.match(all, /Aria — LINE \(meaning\): who goes there\?/);
    assert.equal(messages.at(-1).role, 'system', 'the push comes after the history');
    assert.match(messages.at(-1).content, /^PUSH — what happens this turn:/);
    assert.equal(calls.length, 2, 'assess, then the form');
    assert.ok(calls[0].tools.some(tool => tool.name === 'submit_turn'));
    assert.equal(calls[0].tools.some(tool => tool.name === 'forced_memory'), false, 'the test cannot write real summary state');
    assert.equal(memoryWrites.some(name => name.startsWith('core.decision:')), false, 'nothing is written to the open chat');
});

test('without a usable director worker the card-test turn fails with a clear reason instead of silently writing prose', async () => {
    const made = build({ workers: [{ id: 'director', format: 'anthropic', model: 'x' }] });
    await made.load();
    const answer = await request(made.engine.buses.cores, 'decision.cardTurn', { params: { chat, card } });
    assert.equal(answer.ok, false);
    assert.match(answer.error.message, /the director needs an "openai" worker/);
});
