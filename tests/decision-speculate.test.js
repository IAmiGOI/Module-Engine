import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { createPipelineCore } from '../cores/pipeline/index.js';
import { createDecisionCore } from '../cores/decision/index.js';
import { setAfterTurnDefault } from '../libraries/core/decision-settings.js';
setAfterTurnDefault(false); // тесты считают вызовы модели; «после хода» проверяется отдельно

const BEFORE_SEND = 'generation.beforeSend';
const DRAFT = 'Lena, come in and close the door behind you.';
const clone = value => JSON.parse(JSON.stringify(value));
const memoryKey = (namespace, key) => `${namespace}:${key}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const tool = (name, args, id = name) => ({ text: '', toolCalls: [{ id: `${id}_1`, name, arguments: args }] });

const branchReply = () => tool('inscribe', {
    comment: 'The speculative turn is ready.',
    stop: 'Lena steps through the door and closes it.',
    beats: [],
    characters: [],
    roster: { add: [{ name: 'Lena' }] },
    scene: { duration: 'a few minutes' },
    userResult: 'The user waits.',
}, 'branch');

const plainReply = () => tool('inscribe', {
    comment: 'The turn is ready.',
    stop: 'A moment passes.',
    beats: [],
    characters: [],
    scene: { duration: 'a moment' },
    userResult: 'The user waits.',
}, 'plain');

const askReply = () => tool('ask_user', {
    comment: 'The scene needs the user to choose a direction.',
    question: 'Which way does the corridor turn?',
    options: ['Left', 'Right'],
    why: 'The corridor splits and the scene needs the user.',
}, 'ask');

async function build({ replies = [], baseChat = [] } = {}) {
    const engine = createEngine();
    const settingsStore = new Map();
    const chatMemory = new Map();
    const calls = [];
    const state = { chat: baseChat.map(message => ({ ...message })), draft: '', clock: 100000 };
    let index = 0;

    engine.buses.cores.register('storage.settings.get', ({ namespace, key, fallback }) => settingsStore.has(memoryKey(namespace, key)) ? clone(settingsStore.get(memoryKey(namespace, key))) : fallback);
    engine.buses.cores.register('storage.settings.set', ({ namespace, key, value }) => { settingsStore.set(memoryKey(namespace, key), clone(value)); return true; });
    engine.buses.cores.register('storage.chatMemory.get', ({ namespace, key, fallback }) => chatMemory.has(memoryKey(namespace, key)) ? clone(chatMemory.get(memoryKey(namespace, key))) : fallback);
    engine.buses.cores.register('storage.chatMemory.set', ({ namespace, key, value }) => { chatMemory.set(memoryKey(namespace, key), clone(value)); return true; });
    engine.buses.cores.register('model.workers.get', () => [{ id: 'director', format: 'openai', model: 'director/model' }]);
    engine.buses.cores.register('summary.list', () => []);
    engine.buses.cores.register('chatHistory.messages', ({ limit = 10, includeSystem = false } = {}) => {
        const list = state.chat
            .map((message, position) => ({
                mesid: String(position),
                isUser: Boolean(message?.is_user),
                isSystem: Boolean(message?.is_system),
                name: String(message?.name ?? ''),
                text: String(message?.mes ?? ''),
            }))
            .filter(message => includeSystem || !message.isSystem);
        const size = Number(limit);
        return size > 0 ? list.slice(-size) : list;
    });
    engine.buses.cores.register('chatHistory.chatId', () => ({ open: true, id: 'chat-1' }));
    engine.buses.cores.register('ui.notify', () => true);
    engine.buses.cores.register('ui.reveal', () => true);
    engine.buses.cores.register('model.generate', async params => {
        calls.push(params);
        return replies[index++] ?? { text: '', toolCalls: [] };
    });
    engine.buses.services.register('stInput.readText', () => state.draft);
    engine.buses.services.register('stCharacter.chatCharacters', () => []);
    engine.buses.services.register('stCharacter.persona', () => null);

    const pipelineCore = createPipelineCore(engine.registerCaller('core.pipeline', 'cores', { tier: 'official' }), {
        resolveAs: engine.resolveAs,
        publish: (event, payload) => engine.events.emit(event, payload),
    });
    pipelineCore.define({ id: BEFORE_SEND, mode: 'collect' });
    const core = createDecisionCore(engine.registerCaller('core.decision', 'cores', { tier: 'official' }), {
        retryDelayMs: 0,
        speculate: { intervalMs: 5, now: () => state.clock },
    });
    await core.load();
    await core.configure({ decider: { workerId: 'director' }, modes: { enabled: false }, speculate: { enabled: true, threshold: 0.5 } });
    return { engine, pipelineCore, core, calls, chatMemory, state };
}

async function waitFor(check, { timeout = 1500 } = {}) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
        if (await check()) return true;
        await delay(5);
    }
    return false;
}

/** Набрать черновик, дать тикеру увидеть его, выдержать паузу и дождаться ветки. */
async function startBranch({ engine, core, calls, state }) {
    state.draft = DRAFT;
    engine.events.emit('ui.inputBar.changed', { active: true, height: 40 });
    assert.ok(await waitFor(() => core.speculateState().polling), 'the ticker is running');
    await delay(25); // первый тик замечает текст, не начиная ветку
    state.clock += 3000;
    assert.ok(await waitFor(() => calls.length >= 1), 'the branch asked the model');
    assert.ok(await waitFor(() => {
        const branch = core.speculateState().branch;
        return branch && branch.running === false;
    }), 'the branch finished during the pause');
    engine.events.emit('ui.inputBar.changed', { active: false, height: 0 });
}

const send = (pipelineCore, chat, runId = 'run_1') => pipelineCore.run({
    pipelineId: BEFORE_SEND, input: { runId, chat, type: 'normal' },
});

test('the branch writes nothing to the store or chat memory before the merge', async () => {
    const host = await build({ replies: [branchReply(), plainReply()] });
    await startBranch(host);

    assert.equal(host.core.log().length, 0, 'no cycle in the journal');
    assert.equal(host.chatMemory.has(memoryKey('core.decision', 'log')), false, 'no half-written journal in chat memory');
    assert.deepEqual(host.core.roster(), { active: [] }, 'the roster is untouched');
    assert.equal(host.core.clock().minutes, 0, 'the clock is untouched');
});

test('sending the same text merges the branch: one journal entry, the roster and clock applied, no second model request', async () => {
    const host = await build({ replies: [branchReply(), plainReply()] });
    await startBranch(host);
    const chat = [...host.state.chat, { mes: DRAFT, is_user: true }];
    const result = await send(host.pipelineCore, chat, 'run_1');

    assert.equal(result.ok, true);
    assert.equal(host.calls.length, 1, 'the turn was not asked again');
    const log = host.core.log();
    assert.equal(log.length, 1, 'exactly one turn in the journal');
    assert.equal(log[0].event, 'turn');
    assert.equal(log[0].runId, 'run_1', 'the merged record carries the real run id');
    assert.equal(log[0].speculative.used, true);
    assert.deepEqual(host.core.roster().active, ['Lena'], 'the branch roster was applied at the merge');
    assert.equal(host.core.clock().minutes, 5, 'the branch clock was applied at the merge');
});

test('changed text throws the branch away and the turn runs as usual', async () => {
    const host = await build({ replies: [branchReply(), plainReply()] });
    await startBranch(host);

    host.engine.events.emit('ui.inputBar.changed', { active: true, height: 40 });
    host.state.draft = 'A different message, written after another pause.';
    host.state.clock += 1000;
    assert.ok(await waitFor(() => host.core.speculateState().branch === null && host.core.speculateState().lastDiscard?.reason === 'changed'), 'the branch was discarded on the text change');
    host.engine.events.emit('ui.inputBar.changed', { active: false, height: 0 });

    const chat = [...host.state.chat, { mes: host.state.draft, is_user: true }];
    const result = await send(host.pipelineCore, chat, 'run_1');
    assert.equal(result.ok, true);
    assert.equal(host.calls.length, 2, 'the discarded branch and the real turn');
    assert.deepEqual(host.core.roster().active, [], 'the branch roster never reached the world');
    assert.equal(host.core.clock().minutes, 1, 'only the real turn moved the clock');
    const log = host.core.log();
    assert.equal(log.length, 1, 'the discarded branch left no journal entry');
    assert.equal(log[0].speculative.used, false);
    assert.equal(log[0].speculative.reason, 'changed');
});

test('ask_user inside the branch throws it away: a speculative question never reaches the player', async () => {
    const host = await build({ replies: [askReply(), branchReply(), plainReply()] });
    try {
        host.state.draft = DRAFT;
        host.engine.events.emit('ui.inputBar.changed', { active: true, height: 40 });
        assert.ok(await waitFor(() => host.core.speculateState().polling));
        await delay(25);
        host.state.clock += 3000;
        assert.ok(await waitFor(() => host.calls.length >= 1), 'the branch asked the model');
        assert.ok(await waitFor(() => {
            const branch = host.core.speculateState().branch;
            return branch && branch.discarded && branch.reason === 'ask_user';
        }), 'the branch was abandoned on ask_user');
        await waitFor(() => {
            const branch = host.core.speculateState().branch;
            return !branch || branch.running === false;
        });
        host.engine.events.emit('ui.inputBar.changed', { active: false, height: 0 });

        const chat = [...host.state.chat, { mes: DRAFT, is_user: true }];
        const result = await send(host.pipelineCore, chat, 'run_1');
        assert.equal(result.ok, true);
        assert.deepEqual(host.core.roster().active, [], 'the branch roster never reached the world');
        assert.equal(host.core.clock().minutes, 1);
        const log = host.core.log();
        assert.equal(log.length, 1);
        assert.equal(log[0].speculative.used, false);
        assert.equal(log[0].speculative.reason, 'ask_user');
    } finally {
        // Без этого интервал тикера держал бы процесс после проваленной проверки.
        host.engine.events.emit('ui.inputBar.changed', { active: false, height: 0 });
    }
});

test('a chat change between the start and the send breaks the fingerprint and the branch is discarded', async () => {
    const host = await build({ replies: [branchReply(), plainReply()] });
    await startBranch(host);

    host.state.chat.push({ mes: 'A new reply arrives while the player is still typing.', is_user: false });
    const chat = [...host.state.chat, { mes: DRAFT, is_user: true }];
    const result = await send(host.pipelineCore, chat, 'run_1');
    assert.equal(result.ok, true);
    assert.equal(host.calls.length, 2, 'the branch and the real turn');
    assert.deepEqual(host.core.roster().active, [], 'the branch roster never reached the world');
    assert.equal(host.core.clock().minutes, 1);
    const log = host.core.log();
    assert.equal(log.length, 1);
    assert.equal(log[0].speculative.used, false);
    assert.equal(log[0].speculative.reason, 'fingerprint');
});

test('the merge holds when the chat ST hands the interceptor differs from the raw chat (hidden messages, swipes, regexed text)', async () => {
    const baseChat = [
        { mes: 'Hello there.', is_user: false, name: 'Lena', swipes: ['Hello there.', 'Hi.'], swipe_id: 0 },
        { mes: '(hidden note)', is_user: false, is_system: true, name: 'System' },
    ];
    const host = await build({ replies: [branchReply(), plainReply()], baseChat });
    await startBranch(host);
    // Перехватчику ST отдаёт чат без скрытых сообщений и с обработанным текстом; сырой чат уже содержит отправленное.
    host.state.chat.push({ mes: DRAFT, is_user: true });
    const chat = [{ mes: 'Hello there!', is_user: false, name: 'Lena', swipes: ['Hello there.', 'Hi.'], swipe_id: 0 }, { mes: DRAFT, is_user: true }];
    const result = await send(host.pipelineCore, chat, 'run_1');

    assert.equal(result.ok, true);
    assert.equal(host.calls.length, 1, 'the branch was merged, not asked again');
    assert.equal(host.core.log()[0].speculative.used, true);
});
