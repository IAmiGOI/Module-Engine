import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAttempts, computeStageLevels, resolveStageParams, runPipeline } from '../libraries/core/pipeline-runner.js';

const noSleep = () => Promise.resolve();

/** Исполнитель-протокол: пишет каждый вызов и отвечает тем, что задано на контракт. */
function recordingExecute(replies = {}) {
    const calls = [];
    const execute = async call => {
        calls.push(call);
        const reply = replies[call.contract];
        if (typeof reply === 'function') return reply(call);
        if (reply && typeof reply === 'object' && 'ok' in reply) return reply; // уже конверт — не заворачивать второй раз
        return { ok: true, value: reply ?? `${call.contract}:ok` };
    };
    return { execute, calls };
}

test('computeStageLevels() puts everything independent into ONE level, so it can run at once', () => {
    const levels = computeStageLevels([
        { id: 'wi' },
        { id: 'card' },
        { id: 'assemble', needs: ['wi', 'card'] },
    ]);

    assert.deepEqual(levels.map(level => level.map(stage => stage.id)), [['wi', 'card'], ['assemble']]);
});

test('computeStageLevels() keeps declaration order inside a level — two unrelated stages must not silently swap between runs', () => {
    const levels = computeStageLevels([{ id: 'b' }, { id: 'a' }, { id: 'c' }]);

    assert.deepEqual(levels[0].map(stage => stage.id), ['b', 'a', 'c']);
});

test('computeStageLevels() names the stages involved in a dependency cycle instead of hanging or reporting a bare failure', () => {
    assert.throws(
        () => computeStageLevels([{ id: 'a', needs: ['b'] }, { id: 'b', needs: ['a'] }]),
        /dependency cycle between stages: a, b/,
    );
});

test('computeStageLevels() rejects a stage that needs something nobody registered', () => {
    assert.throws(() => computeStageLevels([{ id: 'a', needs: ['ghost'] }]), /needs "ghost", which is not registered/);
});

test('computeStageLevels() rejects two stages claiming the same id — the outputs map addresses stages by id', () => {
    assert.throws(() => computeStageLevels([{ id: 'a' }, { id: 'a' }]), /duplicate stage id "a"/);
});

test('buildAttempts() makes a fallback INHERIT the stage contract and params, overriding only what it names', () => {
    const attempts = buildAttempts({
        id: 'poll',
        contract: 'model.generate',
        params: { prompt: 'hi', workerId: 'main' },
        fallbacks: [{ params: { workerId: 'backup' }, delayMs: 500 }, { contract: 'model.mainLlm' }],
    });

    assert.deepEqual(attempts, [
        { contract: 'model.generate', params: { prompt: 'hi', workerId: 'main' }, delayMs: 0 },
        { contract: 'model.generate', params: { prompt: 'hi', workerId: 'backup' }, delayMs: 500 },
        { contract: 'model.mainLlm', params: { prompt: 'hi', workerId: 'main' }, delayMs: 0 },
    ]);
});

test('resolveStageParams() substitutes a whole earlier output, and a field inside one, wherever it is nested', () => {
    const resolved = resolveStageParams(
        { text: { $from: 'wi' }, name: { $from: 'card.persona.name' }, list: [{ $from: 'wi' }], plain: 7 },
        { wi: 'entries', card: { persona: { name: 'Alice' } } },
    );

    assert.deepEqual(resolved, { text: 'entries', name: 'Alice', list: ['entries'], plain: 7 });
});

test('collect mode runs a whole level concurrently and returns every output keyed by stage id', async () => {
    let running = 0;
    let peak = 0;
    const execute = async call => {
        running += 1;
        peak = Math.max(peak, running);
        await Promise.resolve();
        running -= 1;
        return { ok: true, value: `${call.stageId}!` };
    };

    const result = await runPipeline({
        stages: [{ id: 'wi', contract: 'worldInfo.entries' }, { id: 'card', contract: 'characterCard.field' }],
        execute,
        sleep: noSleep,
    });

    assert.equal(result.ok, true);
    assert.equal(peak, 2, 'independent stages must actually overlap, not run one after another');
    assert.deepEqual(result.outputs.wi, 'wi!');
    assert.deepEqual(result.outputs.card, 'card!');
});

test('a dependent stage receives the outputs of the stages it declared it needs', async () => {
    const { execute, calls } = recordingExecute({
        'worldInfo.entries': { ok: true, value: 'lore' },
        'prompt.assemble': { ok: true, value: 'built' },
    });

    const result = await runPipeline({
        stages: [
            { id: 'wi', contract: 'worldInfo.entries' },
            { id: 'assemble', contract: 'prompt.assemble', needs: ['wi'], params: { lore: { $from: 'wi' } } },
        ],
        execute,
        sleep: noSleep,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(calls.at(-1).params, { lore: 'lore' });
});

test('fold mode threads the carried value through the chain — each stage rewrites what the previous one returned', async () => {
    const execute = async call => ({ ok: true, value: `${call.params.value}+${call.stageId}` });

    const result = await runPipeline({
        mode: 'fold',
        input: 'raw',
        stages: [
            { id: 'trim', contract: 'post.trim', params: { value: { $from: '$value' } } },
            { id: 'macros', contract: 'post.macros', needs: ['trim'], params: { value: { $from: '$value' } } },
        ],
        execute,
        sleep: noSleep,
    });

    assert.equal(result.value, 'raw+trim+macros');
});

test('a failing stage is retried through its fallback chain, and a later attempt that succeeds makes the whole run succeed', async () => {
    const seen = [];
    const execute = async call => {
        seen.push({ contract: call.contract, workerId: call.params.workerId, attempt: call.attempt });
        return call.params.workerId === 'backup' ? { ok: true, value: 'recovered' } : { ok: false, error: { message: 'Failed to fetch' } };
    };

    const result = await runPipeline({
        stages: [{
            id: 'poll',
            contract: 'model.generate',
            params: { workerId: 'main' },
            fallbacks: [{ params: { workerId: 'backup' }, delayMs: 5 }],
        }],
        execute,
        sleep: noSleep,
    });

    assert.equal(result.ok, true);
    assert.equal(result.outputs.poll, 'recovered');
    assert.deepEqual(seen, [
        { contract: 'model.generate', workerId: 'main', attempt: 0 },
        { contract: 'model.generate', workerId: 'backup', attempt: 1 },
    ]);
});

test('a fallback\'s delayMs is actually waited out before the next attempt, in the order declared', async () => {
    const slept = [];
    const execute = async () => ({ ok: false, error: { message: 'nope' } });

    await runPipeline({
        stages: [{ id: 'poll', contract: 'model.generate', fallbacks: [{ delayMs: 500 }, { delayMs: 1500 }] }],
        execute,
        sleep: async ms => { slept.push(ms); },
    });

    assert.deepEqual(slept, [500, 1500]);
});

test('an exhausted stage aborts the WHOLE pipeline by default, and later levels never start', async () => {
    const { execute, calls } = recordingExecute({
        'model.generate': { ok: false, error: { message: 'provider is down' } },
    });

    const result = await runPipeline({
        stages: [
            { id: 'poll', contract: 'model.generate' },
            { id: 'assemble', contract: 'prompt.assemble', needs: ['poll'] },
        ],
        execute,
        sleep: noSleep,
    });

    assert.equal(result.ok, false);
    assert.equal(result.failedStage, 'poll');
    assert.match(result.error.message, /pipeline aborted at stage "poll": provider is down/);
    assert.deepEqual(calls.map(call => call.contract), ['model.generate'], 'the dependent stage must never run after an abort');
});

test('onExhausted "flag" keeps the pipeline going and reports the stage as flagged instead of aborting', async () => {
    const execute = async call => (call.contract === 'model.generate'
        ? { ok: false, error: { message: 'provider is down' } }
        : { ok: true, value: 'assembled' });

    const result = await runPipeline({
        stages: [
            { id: 'poll', contract: 'model.generate', onExhausted: 'flag' },
            { id: 'assemble', contract: 'prompt.assemble', needs: ['poll'] },
        ],
        execute,
        sleep: noSleep,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.flagged, ['poll']);
    assert.equal(result.outputs.assemble, 'assembled');
});

test('a flagged failure in fold mode leaves the carried value untouched — a broken rewriter must not destroy the text', async () => {
    const execute = async call => (call.stageId === 'broken'
        ? { ok: false, error: { message: 'boom' } }
        : { ok: true, value: 'rewritten' });

    const result = await runPipeline({
        mode: 'fold',
        input: 'original',
        stages: [
            { id: 'broken', contract: 'post.broken', onExhausted: 'flag' },
            { id: 'ok', contract: 'post.ok', needs: ['broken'] },
        ],
        execute,
        sleep: noSleep,
    });

    assert.equal(result.value, 'rewritten');
    assert.deepEqual(result.flagged, ['broken']);
});

test('a stage that throws instead of returning an envelope is an ordinary failed attempt, not a crash of the run', async () => {
    let attempts = 0;
    const execute = async () => { attempts += 1; if (attempts === 1) throw new Error('TypeError: Failed to fetch'); return { ok: true, value: 'second time lucky' }; };

    const result = await runPipeline({
        stages: [{ id: 'poll', contract: 'model.generate', fallbacks: [{ delayMs: 10 }] }],
        execute,
        sleep: noSleep,
    });

    assert.equal(result.ok, true);
    assert.equal(result.outputs.poll, 'second time lucky');
});

test('a stage slower than its timeout fails that attempt, and the next attempt still gets its chance', async () => {
    let attempt = 0;
    const execute = async () => {
        attempt += 1;
        if (attempt === 1) return new Promise(resolve => setTimeout(() => resolve({ ok: true, value: 'too late' }), 200));
        return { ok: true, value: 'in time' };
    };

    const result = await runPipeline({
        stages: [{ id: 'poll', contract: 'model.generate', fallbacks: [{}] }],
        execute,
        resolveTimeout: () => 20,
        sleep: noSleep,
    });

    assert.equal(result.ok, true);
    assert.equal(result.outputs.poll, 'in time');
    assert.match(result.stages[0].failures[0].error.message, /timed out after 20ms/);
});

test('every stage reports its own duration, which is what a dynamic timeout will later be computed from', async () => {
    let clock = 0;
    const execute = async () => { clock += 40; return { ok: true, value: 'x' }; };

    const result = await runPipeline({
        stages: [{ id: 'poll', contract: 'model.generate' }],
        execute,
        sleep: noSleep,
        now: () => clock,
    });

    assert.equal(result.stages[0].durationMs, 40);
});

test('the run reports its stages in the order they finished, with the attempt each one succeeded on', async () => {
    const events = [];
    const execute = async call => (call.attempt === 0 && call.stageId === 'poll'
        ? { ok: false, error: { message: 'first try failed' } }
        : { ok: true, value: 'v' });

    await runPipeline({
        stages: [{ id: 'poll', contract: 'model.generate', fallbacks: [{}] }],
        execute,
        onEvent: (name, payload) => events.push([name, payload.stageId]),
        sleep: noSleep,
    });

    assert.deepEqual(events, [['stageStarted', 'poll'], ['stageAttemptFailed', 'poll'], ['stageFinished', 'poll']]);
});

test('runPipeline() refuses an unknown mode rather than silently treating it as collect', async () => {
    await assert.rejects(() => runPipeline({ stages: [], mode: 'parallel', execute: async () => ({ ok: true }) }), /unknown mode "parallel"/);
});
