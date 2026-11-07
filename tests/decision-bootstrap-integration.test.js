import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { createDecisionCore } from '../cores/decision/index.js';

const memoryKey = (namespace, key) => `${namespace}:${key}`;
const clone = value => JSON.parse(JSON.stringify(value));

async function build({ bootstrapReply = null } = {}) {
    const engine = createEngine();
    const settings = new Map();
    const memory = new Map();
    const calls = [];
    const messages = [{ mes: 'The greeting.', is_user: false }];
    engine.buses.cores.register('storage.settings.get', ({ namespace, key, fallback }) => (settings.has(memoryKey(namespace, key)) ? clone(settings.get(memoryKey(namespace, key))) : fallback));
    engine.buses.cores.register('storage.settings.set', ({ namespace, key, value }) => { settings.set(memoryKey(namespace, key), clone(value)); return true; });
    engine.buses.cores.register('storage.chatMemory.get', ({ namespace, key, fallback }) => (memory.has(memoryKey(namespace, key)) ? clone(memory.get(memoryKey(namespace, key))) : fallback));
    engine.buses.cores.register('storage.chatMemory.set', ({ namespace, key, value }) => { memory.set(memoryKey(namespace, key), clone(value)); return true; });
    engine.buses.cores.register('model.workers.get', () => [{ id: 'director', format: 'openai' }]);
    engine.buses.cores.register('summary.list', () => []);
    engine.buses.cores.register('chatHistory.messages', () => messages);
    engine.buses.cores.register('chatHistory.annotations', () => ({}));
    engine.buses.cores.register('lorebook.books', () => []);
    engine.buses.cores.register('lorebook.entries', () => []);
    engine.buses.cores.register('generation.tools', () => []);
    engine.buses.cores.register('generation.callTool', () => 'ok');
    engine.buses.cores.register('stCharacter.chatCharacters', () => []);
    engine.buses.cores.register('stCharacter.persona', () => null);
    engine.buses.services.register('stInput.setLocked', () => ({ ok: true }));
    engine.buses.cores.register('model.generate', async params => {
        calls.push(params);
        if (JSON.stringify(params.messages ?? []).includes('BOOTSTRAP:')) {
            if (bootstrapReply) return bootstrapReply(params, engine);
            return {
                text: '', toolCalls: [
                    { id: 'brief', name: 'write_chat_brief', arguments: { brief: 'TIMELINE:\nThe story starts before the war.\n\nASSUMPTIONS:\n- none', timelineBanks: [], comment: 'The brief is ready.' } },
                    { id: 'await', name: 'await', arguments: { reason: 'Bootstrap done.', comment: 'The brief is written.' } },
                ],
            };
        }
        return {
            text: '', toolCalls: [
                { id: 'plan', name: 'set_plan', arguments: { direction: 'Go.', comment: 'A direction is needed.' } },
                { id: 'turn', name: 'inscribe', arguments: { comment: 'The turn is decided.', scene: { minutes: 1 }, resolution: 'She waits.', userResult: 'The user waits.', characters: [] } },
            ],
        };
    });
    settings.set(memoryKey('core.decision', 'settings'), { decider: { workerId: 'director' }, bootstrap: { maxQuestions: 3, maxSteps: 10, timeoutMs: 1000 } });
    const core = createDecisionCore(engine.registerCaller('core.decision', 'cores', { tier: 'official' }), { retryDelayMs: 0 });
    await core.load();
    await core.configure({ decider: { workerId: 'director' }, bootstrap: { maxQuestions: 3, maxSteps: 10, timeoutMs: 1000 } });
    return { core, calls, memory, messages, engine };
}

test('a new chat runs bootstrap, writes the brief and puts it into the first turn context', async () => {
    const { core, calls, memory, messages } = await build();
    await core.decide({ runId: 'run_1', chat: [{ mes: 'Hello?', is_user: true }], type: 'normal' });
    assert.equal(core.bootstrap().status, 'done');
    const brief = memory.get(memoryKey('core.decision', 'chatBrief'));
    assert.ok(brief, 'the brief is stored in chat memory');
    assert.match(brief.text, /TIMELINE/);
    const firstTurn = calls.find(params => JSON.stringify(params.messages ?? []).includes('A new turn has started'));
    assert.ok(firstTurn, 'the first turn asked the director');
    assert.match(JSON.stringify(firstTurn.messages), /CHAT BRIEF:/);
    assert.match(JSON.stringify(firstTurn.messages), /The story starts before the war/);
    assert.ok(core.bootstrap().status === 'done');
});

test('bootstrap: at most two questions in a row, and the director\'s thinking is kept for the background cycle', async () => {
    const ask = (id, question) => ({ id, name: 'ask_user', arguments: { question, options: ['A', 'B'], comment: 'The material does not settle it.' } });
    let step = 0;
    const { core, messages, engine } = await build({
        bootstrapReply: (params, engine) => {
            step += 1;
            engine.events.emit('model.generate.reasoning', { requestId: params.requestId, delta: `step ${step} thought. ` });
            if (step === 1) return { text: '', toolCalls: [ask('q1', 'When?'), ask('q2', 'Who?'), ask('q3', 'Where?')] };
            return {
                text: '', toolCalls: [
                    { id: 'brief', name: 'write_chat_brief', arguments: { brief: 'TIMELINE:\nEarly.', timelineBanks: [], comment: 'The brief is ready.' } },
                    { id: 'await', name: 'await', arguments: { reason: 'Bootstrap done.', comment: 'The brief is written.' } },
                ],
            };
        },
    });
    engine.events.subscribe('decision.question.asked', payload => setTimeout(() => core.answerQuestion({ id: payload.id, answer: 'A' }), 0));
    await core.decide({ runId: 'run_1', chat: [{ mes: 'Hello?', is_user: true }], type: 'normal' });
    const boot = core.log().find(cycle => cycle.event === 'bootstrap');
    const asks = boot.toolCalls.filter(call => call.name === 'ask_user');
    assert.equal(asks.length, 3);
    assert.equal(asks.filter(call => call.result?.ok !== false).length, 2, 'two questions are asked');
    assert.match(String(asks[2].error ?? asks[2].result?.error), /two questions in a row/, 'the third in a row is refused');
    assert.match(boot.thinking, /step 1 thought/, 'the background cycle keeps its thinking');
});
