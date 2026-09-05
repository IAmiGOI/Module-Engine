import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { request } from '../libraries/shared/request.js';
import { createPipelineCore } from '../cores/pipeline/index.js';

/** Движок с Ядром пайплайнов, собранный ровно как в engine-wiring.js — с настоящим `resolveAs`. */
function buildEngine({ timeouts } = {}) {
    const engine = createEngine();
    const events = [];
    const host = engine.registerCaller('core.pipeline', 'cores', { tier: 'official' });
    const core = createPipelineCore(host, {
        resolveAs: engine.resolveAs,
        publish: (event, payload) => events.push({ event, payload }),
        // Границы в миллисекундах, а не в секундах: проверяем ЛОГИКУ выбора
        // таймаута, и ждать ради этого настоящие 2 секунды незачем.
        timeouts: { minMs: 20, maxMs: 400, slack: 4, ...(timeouts ?? {}) },
    });
    return { engine, host, core, events, named: name => events.filter(entry => entry.event === name) };
}

/** Ядро-поставщик: регистрирует контракты и запоминает, кто до него реально дошёл. */
function supplierCore(engine, callerId, contracts) {
    const host = engine.registerCaller(callerId, 'cores', { tier: 'official' });
    const calls = [];
    for (const [contract, handler] of Object.entries(contracts)) {
        host.own.register(contract, params => { calls.push({ contract, params }); return handler(params); });
    }
    return { host, calls };
}

test('createPipelineCore() refuses to exist without resolveAs() — without it every stage would run under the pipeline\'s own identity', () => {
    const engine = createEngine();
    const host = engine.registerCaller('core.pipeline', 'cores', { tier: 'official' });

    assert.throws(() => createPipelineCore(host, {}), /needs resolveAs\(\)/);
});

test('a defined pipeline runs its stages through the real Директор and returns every output by stage id', async () => {
    const { engine, core } = buildEngine();
    supplierCore(engine, 'core.lore', {
        'worldInfo.entries': () => 'lore text',
        'characterCard.field': () => 'Alice',
    });

    core.define({ id: 'generation.beforeSend', mode: 'collect' });
    core.addStage({ pipelineId: 'generation.beforeSend', stage: { id: 'wi', contract: 'worldInfo.entries' } }, 'core.lore');
    core.addStage({ pipelineId: 'generation.beforeSend', stage: { id: 'card', contract: 'characterCard.field' } }, 'core.lore');

    const result = await core.run({ pipelineId: 'generation.beforeSend' });

    assert.equal(result.ok, true);
    assert.equal(result.outputs.wi, 'lore text');
    assert.equal(result.outputs.card, 'Alice');
});

test('a stage runs under the rights of ITS OWNER — a community Module cannot reach a contract it has no right to just by declaring a stage', async () => {
    const { engine, core } = buildEngine();
    const secret = supplierCore(engine, 'core.secret', { 'secret.thing': () => 'should never be reached' });

    // Модуль вправе только объявить этап — и больше ничего.
    const moduleHost = engine.registerCaller('module.evil', 'modules', { tier: 'community', allowedContracts: ['pipeline.stages.add'] });
    core.define({ id: 'demo' });
    const added = await request(moduleHost.cores, 'pipeline.stages.add', {
        params: { pipelineId: 'demo', stage: { id: 'sneaky', contract: 'secret.thing' } },
    });
    assert.equal(added.ok, true, 'объявить этап модулю можно — это его право');

    const result = await core.run({ pipelineId: 'demo' });

    assert.equal(result.ok, false);
    assert.match(result.error.message, /Access denied/);
    assert.deepEqual(secret.calls, [], 'поставщик не должен быть вызван вообще — иначе пайплайн отмывал бы права');
});

test('the SAME stage declared by an official Core does reach the contract — it is the owner\'s rights that decide, not the pipeline\'s', async () => {
    const { engine, core } = buildEngine();
    const secret = supplierCore(engine, 'core.secret', { 'secret.thing': () => 'allowed' });

    core.define({ id: 'demo' });
    core.addStage({ pipelineId: 'demo', stage: { id: 'legit', contract: 'secret.thing' } }, 'core.secret');

    const result = await core.run({ pipelineId: 'demo' });

    assert.equal(result.ok, true);
    assert.equal(result.outputs.legit, 'allowed');
    assert.equal(secret.calls.length, 1);
});

test('the owner is taken from the Директор, not from params — a caller cannot declare a stage owned by somebody else', async () => {
    const { engine, core } = buildEngine();
    supplierCore(engine, 'core.secret', { 'secret.thing': () => 'nope' });

    const moduleHost = engine.registerCaller('module.liar', 'modules', { tier: 'community', allowedContracts: ['pipeline.stages.add'] });
    core.define({ id: 'demo' });
    await request(moduleHost.cores, 'pipeline.stages.add', {
        params: { pipelineId: 'demo', owner: 'core.secret', stage: { id: 'forged', contract: 'secret.thing', owner: 'core.secret' } },
    });

    assert.deepEqual(core.stages('demo').map(stage => stage.owner), ['module.liar']);
});

test('adding a stage publishes "pipeline.stagesChanged" — that signal IS the Блок notification consumers re-read on', async () => {
    const { core, named } = buildEngine();
    core.define({ id: 'demo' });

    core.addStage({ pipelineId: 'demo', stage: { id: 'a', contract: 'x.y' } }, 'core.a');
    core.removeStage({ pipelineId: 'demo', stageId: 'a' });

    assert.deepEqual(named('pipeline.stagesChanged').map(entry => entry.payload), [
        { pipelineId: 'demo', stages: 1, added: 'a', owner: 'core.a' },
        { pipelineId: 'demo', stages: 0, removed: 'a' },
    ]);
});

test('a stage forming a dependency cycle is rejected AT REGISTRATION, not when somebody\'s generation fails to start', () => {
    const { core } = buildEngine();
    core.define({ id: 'demo' });
    core.addStage({ pipelineId: 'demo', stage: { id: 'a', contract: 'x.y', needs: [] } }, 'core.a');
    core.addStage({ pipelineId: 'demo', stage: { id: 'b', contract: 'x.y', needs: ['a'] } }, 'core.a');

    assert.throws(
        () => core.addStage({ pipelineId: 'demo', stage: { id: 'a', contract: 'x.y', needs: ['b'] } }, 'core.a'),
        /dependency cycle/,
    );
    assert.deepEqual(core.stages('demo').map(stage => stage.id), ['a', 'b'], 'отклонённая регистрация не должна оставлять следов');
});

test('re-defining a pipeline keeps the stages other owners already registered — build order must not decide whose contribution survives', () => {
    const { core } = buildEngine();
    core.define({ id: 'demo' });
    core.addStage({ pipelineId: 'demo', stage: { id: 'a', contract: 'x.y' } }, 'core.a');

    core.define({ id: 'demo', mode: 'fold', description: 'redefined' });

    assert.deepEqual(core.stages('demo').map(stage => stage.id), ['a']);
});

test('a failing stage falls back to a different worker, and the run succeeds on that second attempt', async () => {
    const { engine, core } = buildEngine();
    supplierCore(engine, 'core.models', {
        'model.generate': params => {
            if (params.workerId !== 'backup') throw new Error('Failed to fetch');
            return 'recovered';
        },
    });

    core.define({ id: 'demo' });
    core.addStage({
        pipelineId: 'demo',
        stage: { id: 'poll', contract: 'model.generate', params: { workerId: 'main' }, fallbacks: [{ params: { workerId: 'backup' } }] },
    }, 'core.models');

    const result = await core.run({ pipelineId: 'demo' });

    assert.equal(result.ok, true);
    assert.equal(result.outputs.poll, 'recovered');
});

test('an exhausted stage aborts the run and says which stage it was — for beforeSend that means no generation this cycle', async () => {
    const { engine, core, named } = buildEngine();
    supplierCore(engine, 'core.models', { 'model.generate': () => { throw new Error('provider is down'); } });

    core.define({ id: 'demo' });
    core.addStage({ pipelineId: 'demo', stage: { id: 'poll', contract: 'model.generate' } }, 'core.models');

    const result = await core.run({ pipelineId: 'demo' });

    assert.equal(result.ok, false);
    assert.equal(result.failedStage, 'poll');
    assert.equal(named('pipeline.finished')[0].payload.ok, false);
    assert.equal(named('pipeline.finished')[0].payload.failedStage, 'poll');
});

test('the whole run is reachable through contracts too — a Module drives a pipeline without any direct reference to the Core', async () => {
    const { engine, core } = buildEngine();
    supplierCore(engine, 'core.lore', { 'worldInfo.entries': () => 'lore' });
    core.define({ id: 'demo' });

    const moduleHost = engine.registerCaller('module.ok', 'modules', {
        tier: 'community',
        allowedContracts: ['pipeline.stages.add', 'pipeline.run', 'pipeline.stages', 'worldInfo.entries'],
    });
    await request(moduleHost.cores, 'pipeline.stages.add', { params: { pipelineId: 'demo', stage: { id: 'wi', contract: 'worldInfo.entries' } } });
    const listed = await request(moduleHost.cores, 'pipeline.stages', { params: { pipelineId: 'demo' } });
    const ran = await request(moduleHost.cores, 'pipeline.run', { params: { pipelineId: 'demo' } });

    assert.deepEqual(listed.value.map(stage => stage.id), ['wi']);
    assert.equal(ran.value.ok, true);
    assert.equal(ran.value.outputs.wi, 'lore');
});

test('the dynamic timeout asks Ядро статистики when one is registered, instead of using a fixed constant', async () => {
    const { engine, core } = buildEngine();
    const asked = [];
    supplierCore(engine, 'core.stats', {
        'statistics.expectedDuration': params => { asked.push(params); return 5; },
        'slow.thing': () => new Promise(resolve => setTimeout(() => resolve('too late'), 300)),
    });

    core.define({ id: 'demo' });
    core.addStage({ pipelineId: 'demo', stage: { id: 'slow', contract: 'slow.thing' } }, 'core.stats');
    const result = await core.run({ pipelineId: 'demo' });

    assert.deepEqual(asked, [{ scope: 'pipeline.stage', key: 'demo:slow' }]);
    assert.equal(result.ok, false, 'ответ статистики (50мс × запас) должен реально ограничить этап, а не остаться справочным');
    assert.match(result.stages[0].failures[0].error.message, /timed out after 20ms/, 'ниже минимума таймаут не опускается — совет статистики не должен уметь задушить этап');
});

test('with no Ядро статистики registered, the pipeline still runs — it falls back to its own measurements', async () => {
    const { engine, core } = buildEngine();
    supplierCore(engine, 'core.lore', { 'worldInfo.entries': () => 'lore' });

    core.define({ id: 'demo' });
    core.addStage({ pipelineId: 'demo', stage: { id: 'wi', contract: 'worldInfo.entries' } }, 'core.lore');

    assert.equal((await core.run({ pipelineId: 'demo' })).ok, true);
    assert.equal((await core.run({ pipelineId: 'demo' })).ok, true, 'второй прогон уже пользуется замером первого — и не должен от этого падать');
});

test('running a pipeline nobody defined is a plain error envelope, not a throw across the bus', async () => {
    const { engine } = buildEngine();
    const moduleHost = engine.registerCaller('module.ok', 'modules', { tier: 'community', allowedContracts: ['pipeline.run'] });

    const result = await request(moduleHost.cores, 'pipeline.run', { params: { pipelineId: 'ghost' } });

    assert.equal(result.ok, false);
    assert.match(result.error.message, /pipeline "ghost" is not defined/);
});
