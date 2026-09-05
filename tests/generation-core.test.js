import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerStEventsService } from '../services/st-events.js';
import { registerStToolsService } from '../services/st-tools.js';
import { createEventsCore } from '../cores/events/index.js';
import { createGenerationCore, BEFORE_SEND_PIPELINE, PAYLOAD_PIPELINE, COMPLETED_PIPELINE, INTERCEPTOR_NAME } from '../cores/generation/index.js';
import { registerStGenerationService } from '../services/st-generation.js';
import { createPipelineCore } from '../cores/pipeline/index.js';

/**
 * Scenario level (TESTING.md "Уровень 2") — real engine, real Гейты, the real
 * ST bridge underneath; only SillyTavern itself is faked. Proves the four
 * named PIPELINE.md moments actually get produced from real ST events, and
 * that tool calls — which ST has NO event for — are observed because the
 * engine registers the tools itself.
 */
function fakeSillyTavern() {
    const listeners = new Map();
    const tools = new Map();
    const eventTypes = {
        GENERATION_STARTED: 'generation_started',
        GENERATE_AFTER_COMBINE_PROMPTS: 'generate_after_combine_prompts',
        GENERATION_ENDED: 'generation_ended',
        GENERATION_STOPPED: 'generation_stopped',
    };
    const context = {
        eventTypes,
        eventSource: {
            on: (name, handler) => listeners.set(name, [...(listeners.get(name) ?? []), handler]),
            off: (name, handler) => listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== handler)),
        },
        registerFunctionTool: definition => tools.set(definition.name, definition),
        unregisterFunctionTool: name => tools.delete(name),
    };
    // «Глобальный объект» этого поддельного ST: сюда встанет именованная
    // функция перехватчика и сюда же подменяется `fetch`. Настоящий globalThis
    // не трогаем — тесты не должны мешать друг другу.
    const backendCalls = [];
    const target = {
        fetch: async (url, init) => {
            backendCalls.push({ url, payload: JSON.parse(init.body) });
            return new Response(JSON.stringify({ choices: [{ message: { content: 'backend reply' } }] }), { status: 200 });
        },
    };

    const fire = (key, ...args) => { for (const handler of listeners.get(eventTypes[key] ?? key) ?? []) handler(...args); };

    return {
        context,
        tools,
        target,
        backendCalls,
        fire,
        /**
         * Полный прогон в том порядке, в каком его делает настоящий ST 1.16.0
         * (проверено по public/script.js): сначала GENERATION_STARTED, потом
         * `await` перехватчика, и ТОЛЬКО если он не отменил — сборка и отправка.
         * Отменённый прогон намеренно НЕ эмитит GENERATION_ENDED: ST на этой
         * ветке просто разблокирует интерфейс и выходит.
         */
        generate: async ({ chat = [{ mes: 'hello' }], contextSize = 4096, type = 'normal', payload = { messages: [] } } = {}) => {
            fire('GENERATION_STARTED');
            let aborted = false;
            await target[INTERCEPTOR_NAME]?.(chat, contextSize, () => { aborted = true; }, type);
            if (aborted) return { aborted: true };
            const response = await target.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(payload) });
            fire('GENERATION_ENDED');
            return { aborted: false, response };
        },
        /** Plays what ST does when the model decides to call a tool. */
        invokeTool: (name, args) => tools.get(name).action(args),
    };
}

async function buildEngine() {
    const engine = createEngine();
    const st = fakeSillyTavern();
    registerStEventsService(engine.buses.services, { getContext: () => st.context });
    registerStToolsService(engine.buses.services, { getContext: () => st.context });
    registerStGenerationService(engine.buses.services, { target: st.target });
    const eventsCore = createEventsCore(engine.registerCaller('core.events', 'cores', { tier: 'official' }));
    const pipelineCore = createPipelineCore(engine.registerCaller('core.pipeline', 'cores', { tier: 'official' }), {
        resolveAs: engine.resolveAs,
        publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.pipeline' }),
    });
    const generationCore = createGenerationCore(engine.registerCaller('core.generation', 'cores', { tier: 'official' }), {
        publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.generation' }),
        pipelines: pipelineCore,
    });
    await eventsCore.bridge();
    await generationCore.install(); // с этого момента генерация ST физически идёт через движок
    return { engine, st, eventsCore, generationCore, pipelineCore };
}

function collect(engine, ...eventNames) {
    const seen = [];
    for (const name of eventNames) engine.events.subscribe(name, payload => seen.push({ event: name, payload }));
    return seen;
}

test('a real ST generation produces the named lifecycle moments in order', async () => {
    const { engine, st } = await buildEngine();
    const seen = collect(engine, 'generation.beforeSend', 'generation.sending', 'generation.completed');

    st.fire('GENERATION_STARTED');
    st.fire('GENERATE_AFTER_COMBINE_PROMPTS');
    st.fire('GENERATION_ENDED');

    assert.deepEqual(seen.map(entry => entry.event), ['generation.beforeSend', 'generation.sending', 'generation.completed']);
    assert.equal(seen[2].payload.outcome, 'ended');
});

test('every moment of one run carries the SAME runId, so consumers can tie them together', async () => {
    const { engine, st } = await buildEngine();
    const seen = collect(engine, 'generation.beforeSend', 'generation.sending', 'generation.completed');

    st.fire('GENERATION_STARTED');
    st.fire('GENERATE_AFTER_COMBINE_PROMPTS');
    st.fire('GENERATION_ENDED');

    const runIds = new Set(seen.map(entry => entry.payload.runId));
    assert.equal(runIds.size, 1);
});

test('a stopped generation completes with its own outcome, not silently like a normal end', async () => {
    const { engine, st } = await buildEngine();
    const seen = collect(engine, 'generation.completed');

    st.fire('GENERATION_STARTED');
    st.fire('GENERATION_STOPPED');

    assert.equal(seen[0].payload.outcome, 'stopped');
});

test('a new generation started before the previous one ended closes the old run as superseded — a run must never hang forever', async () => {
    const { engine, st, generationCore } = await buildEngine();
    const superseded = collect(engine, 'generation.superseded');
    const completed = collect(engine, 'generation.completed');

    st.fire('GENERATION_STARTED');
    st.fire('GENERATION_STARTED');

    assert.equal(superseded[0].payload.outcome, 'superseded');
    assert.deepEqual(completed, [], 'a superseded run is NOT a completed reply — subscribers of generation.completed must not see it');
    assert.equal(generationCore.current().stage, 'beforeSend', 'the second run is now the live one');
});

test('a DRY RUN start is ignored — one real generation must fire generation.completed exactly once', async () => {
    const { engine, st } = await buildEngine();
    const completed = collect(engine, 'generation.completed');
    const superseded = collect(engine, 'generation.superseded');

    // Настоящая ST шлёт GENERATION_STARTED и для сухого прогона (её собственный
    // комментарий: «Occurs every time, even if the generation is aborted»),
    // третьим аргументом — `dryRun`. Такой прогон никогда не кончается.
    st.fire('GENERATION_STARTED', 'normal', {}, true);
    st.fire('GENERATION_STARTED', 'normal', {}, false);
    st.fire('GENERATION_ENDED');

    assert.equal(completed.length, 1, 'exactly one completion for one real generation');
    assert.deepEqual(superseded, [], 'the dry run never opened a run, so nothing was superseded');
});

test('a tool registered THROUGH the engine reports its own call and result — the caller writes no reporting code', async () => {
    const { engine, st, generationCore } = await buildEngine();
    const seen = collect(engine, 'generation.toolCall', 'generation.toolResult');
    await generationCore.registerTool({
        name: 'roll_dice',
        description: 'Rolls dice.',
        parameters: { type: 'object', properties: {} },
        action: async args => `rolled ${args.dice}`,
    });
    st.fire('GENERATION_STARTED');

    const returned = await st.invokeTool('roll_dice', { dice: 'd20' });

    assert.equal(returned, 'rolled d20', 'the tool still returns its own value to ST, untouched');
    assert.deepEqual(seen.map(entry => entry.event), ['generation.toolCall', 'generation.toolResult']);
    assert.equal(seen[0].payload.tool, 'roll_dice');
    assert.deepEqual(seen[0].payload.args, { dice: 'd20' });
    assert.equal(seen[1].payload.result, 'rolled d20');
});

test('SEVERAL tool calls in one run are each observed, indexed in order, and all recorded on the run', async () => {
    const { engine, st, generationCore } = await buildEngine();
    const seen = collect(engine, 'generation.toolCall');
    await generationCore.registerTool({ name: 'roll_dice', action: async args => `rolled ${args.dice}` });
    await generationCore.registerTool({ name: 'lookup', action: async args => `found ${args.q}` });
    st.fire('GENERATION_STARTED');

    await st.invokeTool('roll_dice', { dice: 'd20' });
    await st.invokeTool('lookup', { q: 'orcs' });
    await st.invokeTool('roll_dice', { dice: '2d6' });

    assert.deepEqual(seen.map(entry => entry.payload.index), [0, 1, 2], 'indexed in call order within the run');
    assert.deepEqual(seen.map(entry => entry.payload.tool), ['roll_dice', 'lookup', 'roll_dice']);
    const run = generationCore.current();
    assert.equal(run.toolCalls.length, 3);
    assert.equal(new Set(seen.map(entry => entry.payload.callId)).size, 3, 'every call gets its own id');
});

test('a run is NOT finished just because a tool call finished — the model keeps going and may call more', async () => {
    const { engine, st, generationCore } = await buildEngine();
    const completions = collect(engine, 'generation.completed');
    await generationCore.registerTool({ name: 'roll_dice', action: async () => 'ok' });
    st.fire('GENERATION_STARTED');

    await st.invokeTool('roll_dice', {});

    assert.deepEqual(completions, [], 'still mid-run');
    assert.equal(generationCore.current().toolCalls.length, 1);

    st.fire('GENERATION_ENDED');
    assert.equal(completions.length, 1);
    assert.equal(completions[0].payload.toolCalls, 1, 'the completed run reports how many tools it used');
});

test('a tool that throws still reports its result as an error, and the error still reaches ST', async () => {
    const { engine, st, generationCore } = await buildEngine();
    const seen = collect(engine, 'generation.toolResult');
    await generationCore.registerTool({ name: 'broken', action: async () => { throw new Error('tool exploded'); } });
    st.fire('GENERATION_STARTED');

    await assert.rejects(st.invokeTool('broken', {}), /tool exploded/, 'the engine must not swallow the tool\'s own failure');
    assert.equal(seen[0].payload.error, 'tool exploded');
});

test('awaitCompletion() resolves with the finished run — the "wait until this generation is really over" primitive', async () => {
    const { st, generationCore } = await buildEngine();
    st.fire('GENERATION_STARTED');
    const runId = generationCore.current().runId;

    const pending = generationCore.awaitCompletion(runId);
    st.fire('GENERATION_ENDED');
    const run = await pending;

    assert.equal(run.runId, runId);
    assert.equal(run.outcome, 'ended');
});

test('awaitCompletion() on an ALREADY finished run resolves immediately rather than hanging', async () => {
    const { st, generationCore } = await buildEngine();
    st.fire('GENERATION_STARTED');
    const runId = generationCore.current().runId;
    st.fire('GENERATION_ENDED');

    const run = await generationCore.awaitCompletion(runId);

    assert.equal(run.outcome, 'ended');
});

test('a Module reaches the lifecycle through Gate-checked contracts; one without the right is refused', async () => {
    const { engine, st } = await buildEngine();
    st.fire('GENERATION_STARTED');
    const allowed = engine.registerCaller('module.ok', 'modules', { tier: 'community', allowedContracts: ['generation.current'] });
    const denied = engine.registerCaller('module.nope', 'modules', { tier: 'community', allowedContracts: [] });

    const okResult = await new Promise(resolve => allowed.cores.subscribe('generation.current', {}, resolve));
    const deniedResult = await new Promise(resolve => denied.cores.subscribe('generation.current', {}, resolve));

    assert.equal(okResult.value.stage, 'beforeSend');
    assert.equal(deniedResult.ok, false);
});

test('unregister() takes the engine\'s own tools back out of ST — a stale tool must not outlive the Ядро', async () => {
    const { st, generationCore } = await buildEngine();
    await generationCore.registerTool({ name: 'roll_dice', action: async () => 'ok' });
    assert.equal(st.tools.has('roll_dice'), true);

    await generationCore.unregister();

    assert.equal(st.tools.has('roll_dice'), false);
});

// --- Связка с Ядром пайплайнов ---------------------------------------------
//
// Ядро жизненного цикла владеет МОМЕНТАМИ, а что в них происходит — целиком
// объявленные этапы чужих Ядер/Модулей. Здесь проверяется именно стык:
// настоящее событие ST доходит до настоящего этапа настоящего пайплайна.

test('both lifecycle pipelines exist from the start, so a contributor can register before anything has run', async () => {
    const { pipelineCore } = await buildEngine();

    assert.deepEqual(pipelineCore.stages(BEFORE_SEND_PIPELINE), []);
    assert.deepEqual(pipelineCore.stages(COMPLETED_PIPELINE), []);
});

test('a real ST generation actually runs the beforeSend contributions, and awaitBeforeSend() hands back their outputs', async () => {
    const { engine, st, pipelineCore, generationCore } = await buildEngine();
    const loreHost = engine.registerCaller('core.lore', 'cores', { tier: 'official' });
    loreHost.own.register('worldInfo.entries', () => 'lore for this turn');
    pipelineCore.addStage({ pipelineId: BEFORE_SEND_PIPELINE, stage: { id: 'wi', contract: 'worldInfo.entries' } }, 'core.lore');

    await st.generate();

    const contributions = await generationCore.awaitBeforeSend('run_1');
    assert.equal(contributions.ok, true);
    assert.equal(contributions.outputs.wi, 'lore for this turn');
});

test('the completed pipeline is a fold over the finished run — a post-processing stage sees the run it is processing', async () => {
    const { engine, st, pipelineCore } = await buildEngine();
    const seen = [];
    const postHost = engine.registerCaller('core.post', 'cores', { tier: 'official' });
    postHost.own.register('post.summarize', params => { seen.push(params); return 'summarized'; });
    pipelineCore.addStage({
        pipelineId: COMPLETED_PIPELINE,
        stage: { id: 'summarize', contract: 'post.summarize', params: { run: { $from: '$value' } } },
    }, 'core.post');

    st.fire('GENERATION_STARTED');
    st.fire('GENERATION_ENDED');
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(seen.length, 1);
    assert.equal(seen[0].run.outcome, 'ended');
});

test('a failed contribution ABORTS the real generation — nothing is sent, and the run is closed by us because ST emits no GENERATION_ENDED on that branch', async () => {
    const { engine, st, pipelineCore, generationCore } = await buildEngine();
    const loreHost = engine.registerCaller('core.lore', 'cores', { tier: 'official' });
    loreHost.own.register('worldInfo.entries', () => { throw new Error('lorebook unavailable'); });
    pipelineCore.addStage({ pipelineId: BEFORE_SEND_PIPELINE, stage: { id: 'wi', contract: 'worldInfo.entries' } }, 'core.lore');

    const result = await st.generate();

    assert.equal(result.aborted, true, 'ST must be told to stop');
    assert.deepEqual(st.backendCalls, [], 'nothing may reach the provider');
    assert.equal(generationCore.current(), null, 'the run must not be left hanging');
    assert.equal(generationCore.runs()[0].outcome, 'aborted');
});

test('awaitBeforeSend() on a run nobody started resolves to null instead of hanging forever', async () => {
    const { generationCore } = await buildEngine();

    assert.equal(await generationCore.awaitBeforeSend('run_nope'), null);
});

// --- Отправка принадлежит движку -------------------------------------------
//
// Решение владельца проекта: генерация ST проходит через движок целиком —
// придержать, изменить, отменить. Здесь проверяется, что это действительно
// так, а не только объявлено.

test('a contribution stage reaches the PROVIDER — the payload SillyTavern sends is the one the pipeline produced', async () => {
    const { engine, st, pipelineCore } = await buildEngine();
    const loreHost = engine.registerCaller('core.lore', 'cores', { tier: 'official' });
    loreHost.own.register('prompt.inject', ({ body }) => ({ ...body, messages: [{ role: 'system', content: 'injected lore' }, ...body.messages] }));
    pipelineCore.addStage({
        pipelineId: PAYLOAD_PIPELINE,
        stage: { id: 'inject', contract: 'prompt.inject', params: { body: { $from: '$value' } } },
    }, 'core.lore');

    await st.generate({ payload: { messages: [{ role: 'user', content: 'hi' }] } });

    assert.deepEqual(st.backendCalls[0].payload.messages, [
        { role: 'system', content: 'injected lore' },
        { role: 'user', content: 'hi' },
    ]);
});

test('the interceptor genuinely HOLDS the generation — nothing is sent until the contributions are done', async () => {
    const { engine, st, pipelineCore } = await buildEngine();
    const order = [];
    const loreHost = engine.registerCaller('core.lore', 'cores', { tier: 'official' });
    loreHost.own.register('worldInfo.entries', async () => {
        await new Promise(resolve => setTimeout(resolve, 30));
        order.push('contribution finished');
        return 'lore';
    });
    pipelineCore.addStage({ pipelineId: BEFORE_SEND_PIPELINE, stage: { id: 'wi', contract: 'worldInfo.entries' } }, 'core.lore');

    await st.generate();
    order.push('request sent');

    assert.deepEqual(order, ['contribution finished', 'request sent']);
});

test('the interceptor is handed ST\'s own chat copy, so a stage editing it shapes the prompt without touching saved history', async () => {
    const { engine, st, pipelineCore } = await buildEngine();
    const loreHost = engine.registerCaller('core.lore', 'cores', { tier: 'official' });
    loreHost.own.register('chat.annotate', ({ chat }) => { chat.push({ mes: 'appended by the engine' }); return true; });
    pipelineCore.addStage({
        pipelineId: BEFORE_SEND_PIPELINE,
        stage: { id: 'annotate', contract: 'chat.annotate', params: { chat: { $from: '$input.chat' } } },
    }, 'core.lore');
    const chat = [{ mes: 'hello' }];

    await st.generate({ chat });

    assert.deepEqual(chat.map(item => item.mes), ['hello', 'appended by the engine']);
});

test('a failing payload stage cancels the send outright rather than quietly letting an incomplete prompt through', async () => {
    const { engine, st, pipelineCore, generationCore } = await buildEngine();
    const loreHost = engine.registerCaller('core.lore', 'cores', { tier: 'official' });
    loreHost.own.register('prompt.inject', () => { throw new Error('assembler unavailable'); });
    pipelineCore.addStage({ pipelineId: PAYLOAD_PIPELINE, stage: { id: 'inject', contract: 'prompt.inject' } }, 'core.lore');

    const result = await st.generate();

    assert.deepEqual(st.backendCalls, [], 'an incomplete prompt must never reach the provider');
    assert.equal(result.response.ok, false);
    assert.equal(generationCore.runs()[0].outcome, 'aborted');
});

test('with no stages registered at all, a generation passes through completely unchanged', async () => {
    const { st } = await buildEngine();

    const result = await st.generate({ payload: { messages: [{ role: 'user', content: 'hi' }] } });

    assert.equal(result.aborted, false);
    assert.deepEqual(st.backendCalls[0].payload, { messages: [{ role: 'user', content: 'hi' }] });
});

test('uninstall() gives SillyTavern its own send back — removing the engine must leave no trace', async () => {
    const { st, generationCore } = await buildEngine();
    const patched = st.target.fetch;

    await generationCore.uninstall();

    assert.notEqual(st.target.fetch, patched, 'fetch restored');
    assert.equal(st.target[INTERCEPTOR_NAME], undefined, 'interceptor global removed');
});
