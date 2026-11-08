import test from 'node:test';
import assert from 'node:assert/strict';
import { createResearcher, researchSection } from '../libraries/core/decision-researcher.js';
import { buildToolList } from '../libraries/core/decision-tools.js';
import { createEngine } from '../libraries/shared/engine.js';
import { createPipelineCore } from '../cores/pipeline/index.js';
import { createDecisionCore } from '../cores/decision/index.js';

/**
 * e8 на уровне субагента: фейковый поиск, лимит задач, лимит шагов,
 * асинхронный отчёт, который не блокирует вызывающего.
 */

function makeHarness({ maxSteps = 50, maxTasks = 2 } = {}) {
    const memory = { tasks: [] };
    const events = [];
    const searches = [];
    let gate = null;
    let gateResolve = null;
    gate = new Promise(resolve => { gateResolve = resolve; });
    const settings = { researcher: { workerId: 'web', maxTasks, maxSteps } };
    const call = async (contract, params) => {
        if (contract === 'stWebSearch.search') { searches.push(params.query); return { source: 'web', results: [{ title: 'T', url: 'U', snippet: 'S' }] }; }
        if (contract === 'stWebSearch.open') return { id: 'p1', url: params.url, chars: 100, outline: [], head: 'head' };
        if (contract === 'stWebSearch.view') return { id: params.id, text: 'text', from: 0, to: 4, next: null, total: 100 };
        if (contract === 'stWebSearch.find') return { id: params.id, matches: [] };
        if (contract !== 'model.generate') throw new Error(`unexpected contract ${contract}`);
        const task = String(params.messages?.[1]?.content ?? '');
        if (task.includes('slow')) {
            await gate;
            return { text: '', toolCalls: [{ id: 'f', name: 'finish', arguments: { report: 'slow report', comment: 'I have enough now.' }, rawArguments: '{}' }] };
        }
        if (task.includes('limit')) {
            return { text: '', toolCalls: [{ id: 's', name: 'web_search', arguments: { query: 'q', comment: 'I still need more facts.' }, rawArguments: '{}' }] };
        }
        if (task.includes('comment')) {
            const first = params.messages.filter(message => message.role === 'tool').length === 0;
            if (first) return { text: '', toolCalls: [{ id: 's', name: 'web_search', arguments: { query: 'q' }, rawArguments: '{}' }] };
            return { text: '', toolCalls: [{ id: 'f', name: 'finish', arguments: { report: 'comment report', comment: 'I have enough now.' }, rawArguments: '{}' }] };
        }
        return { text: '', toolCalls: [{ id: 'f', name: 'finish', arguments: { report: 'quick report', comment: 'I have enough now.' }, rawArguments: '{}' }] };
    };
    const store = {
        research: () => memory.tasks,
        addResearch: async task => { memory.tasks = [...memory.tasks, task]; return memory.tasks; },
        updateResearch: async (id, patch) => { memory.tasks = memory.tasks.map(task => (task.id === id ? { ...task, ...patch } : task)); return memory.tasks; },
        saveResearch: async next => { memory.tasks = next; return next; },
    };
    const researcher = createResearcher({
        call, getSettings: () => settings, getWorkers: () => [{ id: 'web', format: 'openai' }], store,
        publishEvent: (event, payload) => events.push([event, payload]),
    });
    return { researcher, memory, events, searches, release: () => gateResolve(), settings };
}

async function flush() {
    for (let index = 0; index < 12; index += 1) await new Promise(resolve => setTimeout(resolve, 0));
}

test('the director tool list exposes spawn_researcher and the researcher has its web tools', () => {
    const tools = buildToolList([]).map(tool => tool.name);
    assert.ok(tools.includes('spawn_researcher'));
    assert.match(researchSection([{ status: 'done', task: 'Find X', report: 'X is Y' }]), /X is Y/);
});

test('at most two tasks run at once; the third is refused immediately, not queued', async () => {
    const { researcher, release } = makeHarness();
    const first = researcher.start({ task: 'slow one' });
    const second = researcher.start({ task: 'slow two' });
    const third = researcher.start({ task: 'slow three' });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(third.ok, false);
    assert.match(third.error, /already running/);
    assert.equal(researcher.running(), 2);
    release();
    await flush();
    assert.equal(researcher.running(), 0);
});

test('start() returns before the report — the turn never waits for the researcher', async () => {
    const { researcher, release, events } = makeHarness();
    const started = researcher.start({ task: 'slow report' });
    assert.equal(started.ok, true);
    assert.equal(events.length, 0, 'nothing has finished yet');
    release();
    await flush();
    assert.equal(events.filter(([name]) => name === 'decision.researcher.report').length, 1);
});

test('a task is stopped at the step limit and still sends an honest report', async () => {
    const { researcher, events, searches } = makeHarness({ maxSteps: 3 });
    researcher.start({ task: 'limit task' });
    await flush();
    const report = events.find(([name]) => name === 'decision.researcher.report')[1];
    assert.equal(report.steps, 3);
    assert.match(report.report, /3-step limit/);
    assert.equal(searches.length, 3);
});

test('a researcher tool call without a comment is rejected, and the model can recover and finish', async () => {
    const { researcher, events, memory } = makeHarness();
    researcher.start({ task: 'comment task' });
    await flush();
    const report = events.find(([name]) => name === 'decision.researcher.report')[1];
    assert.match(report.report, /comment report/);
    const task = memory.tasks[0];
    assert.match(task.trace[0].error, /comment/);
    assert.equal(task.trace[1].name, 'finish');
    assert.equal(task.status, 'done');
});


async function buildCore() {
    const engine = createEngine();
    const settingsStore = new Map();
    const memory = new Map();
    const calls = [];
    const reports = [];
    let gateResolve = null;
    const gate = new Promise(resolve => { gateResolve = resolve; });
    const key = (namespace, name) => `${namespace}:${name}`;
    const clone = value => JSON.parse(JSON.stringify(value));
    engine.buses.cores.register('storage.settings.get', ({ namespace, key: name, fallback }) => settingsStore.has(key(namespace, name)) ? clone(settingsStore.get(key(namespace, name))) : fallback);
    engine.buses.cores.register('storage.settings.set', ({ namespace, key: name, value }) => { settingsStore.set(key(namespace, name), clone(value)); return true; });
    engine.buses.cores.register('storage.chatMemory.get', ({ namespace, key: name, fallback }) => memory.has(key(namespace, name)) ? clone(memory.get(key(namespace, name))) : fallback);
    engine.buses.cores.register('storage.chatMemory.set', ({ namespace, key: name, value }) => { memory.set(key(namespace, name), clone(value)); return true; });
    engine.buses.cores.register('model.workers.get', () => [
        { id: 'director', format: 'openai' }, { id: 'web', format: 'openai' },
    ]);
    engine.buses.cores.register('summary.list', () => []);
    engine.buses.cores.register('chatHistory.messages', () => []);
    engine.buses.cores.register('chatHistory.chatId', () => ({ open: true, id: 'chat-1' }));
    engine.buses.cores.register('chatHistory.annotations', () => ({}));
    engine.buses.cores.register('embedding.compute', () => null);
    engine.buses.cores.register('embedding.similarity', () => 0);
    engine.buses.cores.register('ui.notify', () => true);
    engine.buses.cores.register('generation.tools', () => []);
    engine.buses.cores.register('generation.callTool', () => 'ok');
    engine.buses.cores.register('model.generate', async params => {
        calls.push(params);
        const system = String(params.messages?.[0]?.content ?? '');
        if (system.startsWith('You are a background researcher')) {
            await gate;
            return { text: '', toolCalls: [{ id: 'f', name: 'finish', arguments: { report: 'found it', comment: 'I have enough now.' }, rawArguments: '{}' }] };
        }
        return replies.shift() ?? { text: '', toolCalls: [{ id: 'a', name: 'await', arguments: { reason: 'done', comment: 'Nothing else is due.' }, rawArguments: '{}' }] };
    });
    const replies = [
        { text: '', toolCalls: [{ id: 'p', name: 'set_plan', arguments: { direction: 'Keep moving.', comment: 'A direction is required.' }, rawArguments: '{}' }] },
        { text: '', toolCalls: [{ id: 'r1', name: 'spawn_researcher', arguments: { task: 'find one', comment: 'Research would help later.' }, rawArguments: '{}' }] },
        { text: '', toolCalls: [{ id: 'r2', name: 'spawn_researcher', arguments: { task: 'find two', comment: 'Research would help later.' }, rawArguments: '{}' }] },
        { text: '', toolCalls: [{ id: 'r3', name: 'spawn_researcher', arguments: { task: 'find three', comment: 'Research would help later.' }, rawArguments: '{}' }] },
        { text: '', toolCalls: [{ id: 's', name: 'inscribe', arguments: { comment: 'The form is ready.', resolution: 'They move.', userResult: 'The user waits.', scene: { minutes: 1 }, characters: [] }, rawArguments: '{}' }] },
    ];
    engine.events.subscribe('decision.researcher.report', payload => reports.push(payload));
    const pipelineCore = createPipelineCore(engine.registerCaller('core.pipeline', 'cores', { tier: 'official' }), {
        resolveAs: engine.resolveAs,
        publish: (event, payload) => engine.events.emit(event, payload),
    });
    pipelineCore.define({ id: 'generation.beforeSend', mode: 'collect' });
    const core = createDecisionCore(engine.registerCaller('core.decision', 'cores', { tier: 'official' }), { retryDelayMs: 0 });
    await core.load();
    await core.configure({ decider: { workerId: 'director' }, researcher: { workerId: 'web', maxTasks: 2, maxSteps: 10 } });
    return { pipelineCore, core, calls, reports, release: () => gateResolve(), memory };
}

test('the core exposes spawn_researcher, refuses a third task, and wakes for the report after the turn', async () => {
    const { pipelineCore, core, calls, reports, release } = await buildCore();
    const result = await pipelineCore.run({ pipelineId: 'generation.beforeSend', input: { runId: 'run_1', chat: [{ mes: 'hi' }], type: 'normal' } });
    assert.equal(result.ok, true);
    const log = core.log()[0];
    const spawns = log.toolCalls.filter(entry => entry.name === 'spawn_researcher');
    assert.equal(spawns.length, 3);
    assert.equal(spawns[0].result.ok, true);
    assert.equal(spawns[1].result.ok, true);
    assert.equal(spawns[2].result.ok, false);
    assert.match(spawns[2].result.error, /already running/);
    release();
    await flush();
    assert.equal(reports.length, 2);
    assert.ok(core.research().every(task => task.status === 'done'));
    assert.ok(calls.some(params => String(params.messages?.[0]?.content ?? '').includes('background researcher')));
});

function splitBusHarness(reply) {
    const memory = { tasks: [] };
    const store = {
        research: () => memory.tasks,
        addResearch: async task => { memory.tasks = [...memory.tasks, task]; return memory.tasks; },
        updateResearch: async (id, patch) => { memory.tasks = memory.tasks.map(task => (task.id === id ? { ...task, ...patch } : task)); return memory.tasks; },
    };
    const services = [];
    const call = async (contract, params) => {
        if (contract.startsWith('stWebSearch.')) throw new Error(`No supplier registered for contract "${contract}".`);
        if (contract === 'model.generate') return reply(params);
        throw new Error(`unexpected ${contract}`);
    };
    const callService = async (contract, params) => { services.push(contract); return { source: 'web', results: [{ title: 'Rem', url: 'https://wiki', snippet: 'A maid.' }] }; };
    const settings = { researcher: { workerId: 'web', maxTasks: 2, maxSteps: 6, bankConcurrency: 4 } };
    const researcher = createResearcher({ call, callService, getSettings: () => settings, getWorkers: () => [{ id: 'web', format: 'openai' }], store, publishEvent: () => {} });
    return { researcher, services };
}

test('the web tools go through the services bus, not the cores bus', async () => {
    let step = 0;
    const { researcher, services } = splitBusHarness(() => {
        step += 1;
        if (step === 1) return { text: '', toolCalls: [{ id: 's', name: 'web_search', arguments: { query: 'Rem Re:Zero', comment: 'I need the canon.' } }] };
        return { text: '', toolCalls: [{ id: 'f', name: 'finish', arguments: { report: '***Rem***', comment: 'The bank is ready.' } }] };
    });
    const done = await researcher.start({ task: 'Build the bank.' }).done;
    assert.deepEqual(services, ['stWebSearch.search']);
    assert.equal(done.error, null);
    assert.equal(done.trace[0].error, null, 'the search succeeded instead of "No supplier registered"');
    assert.equal(done.report, '***Rem***');
});

test('an empty answer gets one nudge to finish; a second empty answer is a failure, never a report', async () => {
    let step = 0;
    const { researcher } = splitBusHarness(() => { step += 1; return { text: '', toolCalls: [] }; });
    const done = await researcher.start({ task: 'Build the bank.', kind: 'bank' }).done;
    assert.equal(step, 2, 'one nudge, then give up');
    assert.match(done.error, /no report/);
});

test('bank builders have their own limit and do not take the two director research slots', () => {
    const { researcher } = splitBusHarness(() => new Promise(() => {}));
    for (let index = 0; index < 4; index += 1) assert.equal(researcher.start({ task: `bank ${index}`, kind: 'bank' }).ok, true);
    assert.equal(researcher.start({ task: 'bank 5', kind: 'bank' }).ok, false);
    assert.equal(researcher.start({ task: 'director one' }).ok, true);
    assert.equal(researcher.start({ task: 'director two' }).ok, true);
    assert.equal(researcher.start({ task: 'director three' }).ok, false);
});

test('cancelling a turn stops its research tasks: the task ends as cancelled and wakes nobody', async () => {
    const { researcher, release, events, memory } = makeHarness();
    const mine = researcher.start({ task: 'slow mine', runId: 'turn_1' });
    const other = researcher.start({ task: 'slow other', runId: 'turn_2' });
    assert.equal(researcher.cancel({ runId: 'turn_1' }), 1);
    release();
    await flush();
    const tasks = Object.fromEntries(memory.tasks.map(task => [task.id, task]));
    assert.equal(tasks[mine.taskId].status, 'cancelled');
    assert.match(tasks[mine.taskId].error, /cancelled/);
    assert.equal(tasks[other.taskId].status, 'done');
    const reports = events.filter(([name]) => name === 'decision.researcher.report').map(([, payload]) => payload.taskId);
    assert.deepEqual(reports, [other.taskId], 'only the task of the living turn reports');
});

test('a bank builder that hits the step limit still writes its report from what it read, and old pages are shortened in its context', async () => {
    const { createResearcher } = await import('../libraries/core/decision-researcher.js');
    const memory = { tasks: [] };
    const seen = [];
    const call = async (contract, params) => {
        if (contract === 'stWebSearch.view') return { id: params.id, text: 'x'.repeat(5000) };
        if (contract !== 'model.generate') return { results: [] };
        seen.push(params.messages.filter(message => message.role === 'tool').map(message => String(message.content).length));
        if (!params.tools) return { text: '***Elsa***\nBuilt from what was read.' };
        return { text: '', toolCalls: [{ id: `v${seen.length}`, name: 'web_view', arguments: { id: 'p', comment: 'Reading the next section.' } }] };
    };
    const researcher = createResearcher({
        call, callService: call, getSettings: () => ({ researcher: { workerId: 'web', maxTasks: 2, maxSteps: 8 } }),
        getWorkers: () => [{ id: 'web', format: 'openai' }],
        store: { research: () => memory.tasks, addResearch: async task => { memory.tasks.push(task); }, updateResearch: async (id, patch) => { memory.tasks = memory.tasks.map(task => (task.id === id ? { ...task, ...patch } : task)); } },
        publishEvent: () => {},
    });
    const started = researcher.start({ task: 'Build the data bank now.', kind: 'bank', notify: false, maxSteps: 8 });
    const done = await started.done;
    assert.equal(done.error, null);
    assert.match(done.report, /Built from what was read/);
    const last = seen.at(-1);
    assert.ok(last.filter(length => length > 1000).length <= 3, 'only the last three page reads stay whole');
});

test('the researcher uses the guide\'s web toolkit: character databases, wikis, meaning search', async () => {
    const { createResearcher, RESEARCH_TOOLS } = await import('../libraries/core/decision-researcher.js');
    const names = RESEARCH_TOOLS.map(tool => tool.name);
    for (const name of ['web_character', 'web_wikis', 'web_wiki', 'web_search', 'web_open', 'web_view', 'web_find']) assert.ok(names.includes(name), name);
    const used = [];
    const webActions = {
        'web.character': { run: async args => { used.push(['web.character', args.name]); return { ok: true, message: 'found', detail: 'Candidates for Elsa:\n1. Elsa Granhiert — anilist:1' }; } },
        'web.read': { run: async args => { used.push(['web.read', args.ref]); return { ok: false, message: 'The page did not open: offline' }; } },
    };
    const results = [];
    let step = 0;
    const call = async (contract, params) => {
        step += 1;
        results.push(params.messages.filter(message => message.role === 'tool').map(message => String(message.content)));
        if (step === 1) return { text: '', toolCalls: [{ id: 'a', name: 'web_character', arguments: { name: 'Elsa', comment: 'Look her up first.' } }] };
        if (step === 2) return { text: '', toolCalls: [{ id: 'b', name: 'web_open', arguments: { ref: 'anilist:1', comment: 'Open the best one.' } }] };
        return { text: '', toolCalls: [{ id: 'f', name: 'finish', arguments: { report: 'Elsa bank.', comment: 'Enough.' } }] };
    };
    const memory = { tasks: [] };
    const researcher = createResearcher({
        call, webActions, getSettings: () => ({ researcher: { workerId: 'web', maxTasks: 2, maxSteps: 10 } }), getWorkers: () => [{ id: 'web', format: 'openai' }],
        store: { research: () => memory.tasks, addResearch: async task => { memory.tasks.push(task); }, updateResearch: async () => {} }, publishEvent: () => {},
    });
    const done = await researcher.start({ task: 'Build the data bank now.', kind: 'bank', notify: false }).done;
    assert.equal(done.report, 'Elsa bank.');
    assert.deepEqual(used, [['web.character', 'Elsa'], ['web.read', 'anilist:1']]);
    assert.match(results[1].join('\n'), /Candidates for Elsa/);
    assert.match(results[2].join('\n'), /did not open: offline/);
});
