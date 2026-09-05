import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';

/**
 * The "walking skeleton" (ROADMAP.md step 3): one fictional Core registers
 * a contract on its OWN bus, one fictional Module reaches it through the
 * REAL chain — its own Gate, real rights-checking, the Core Bus's real
 * Director resolving to the real supplier. Proves the whole assembled
 * connectivity skeleton actually works end to end, not just its pieces in
 * isolation (see TESTING.md's "Уровень 2" — this is the smallest possible
 * instance of that idea, before any real Core/Module exists yet).
 */

test('a Module reaches a Core\'s contract through the real Director -> Gate -> Director chain', async () => {
    const engine = createEngine();
    const core = engine.registerCaller('core.tracking', 'cores', { tier: 'official' });
    core.own.register('tracking.value', () => 'health: 100');

    const module = engine.registerCaller('module.macros', 'modules', {
        tier: 'community',
        allowedContracts: ['tracking.value'],
    });
    const result = await new Promise(resolve => module.cores.subscribe('tracking.value', {}, resolve));

    assert.deepEqual(result, { ok: true, value: 'health: 100' });
});

test('a Module WITHOUT the right to a Core\'s contract is refused before the Core is ever reached', async () => {
    const engine = createEngine();
    const core = engine.registerCaller('core.tracking', 'cores', { tier: 'official' });
    let handlerCalled = false;
    core.own.register('tracking.value', () => { handlerCalled = true; return 'health: 100'; });

    const module = engine.registerCaller('module.untrusted', 'modules', { tier: 'community', allowedContracts: [] });
    const result = await new Promise(resolve => module.cores.subscribe('tracking.value', {}, resolve));

    assert.equal(result.ok, false);
    assert.equal(handlerCalled, false);
});

test('the reverse direction works too — a Core reaches a Module\'s contract through its own Gate', async () => {
    const engine = createEngine();
    const module = engine.registerCaller('module.ui', 'modules', { tier: 'official' });
    module.own.register('ui.renderRequest', () => 'rendered');

    const core = engine.registerCaller('core.pipeline', 'cores', { tier: 'official' });
    const result = await new Promise(resolve => core.modules.subscribe('ui.renderRequest', {}, resolve));

    assert.deepEqual(result, { ok: true, value: 'rendered' });
});

test('same-domain calls (Core -> Core) stay on the caller\'s own bus directly — no Gate, no rights check at all', async () => {
    const engine = createEngine();
    const supplierCore = engine.registerCaller('core.sidecar', 'cores', { tier: 'official' });
    supplierCore.own.register('model.generate', () => 'generated text');

    // A second Core with an otherwise-empty community grant — if same-domain
    // calls went through a Gate like cross-domain ones do, this would be
    // denied; same-bus Core->Core must not require any declared right at all.
    const consumerCore = engine.registerCaller('core.promptManager', 'cores', { tier: 'community', allowedContracts: [] });
    const result = await new Promise(resolve => consumerCore.own.subscribe('model.generate', {}, resolve));

    assert.deepEqual(result, { ok: true, value: 'generated text' });
});

test('the shared Event Bus is reachable from every caller\'s host, and ties a "when"-gated cross-domain subscription to a real event', async () => {
    const engine = createEngine();
    const core = engine.registerCaller('core.tracking', 'cores', { tier: 'official' });
    let count = 0;
    core.own.register('tracking.value', () => ++count);

    const module = engine.registerCaller('module.macros', 'modules', { tier: 'official' });
    const deliveries = [];
    module.cores.subscribe('tracking.value', { when: { event: 'turn.completed' } }, r => deliveries.push(r));

    engine.events.emit('turn.completed');
    await flushMicrotasks();

    assert.deepEqual(deliveries, [{ ok: true, value: 1 }]);
});

test('a Module with networkAccess reaches a contract on the network bus through host.network', async () => {
    const engine = createEngine();
    engine.buses.network.register('http.request', () => 'response body');

    const module = engine.registerCaller('module.weather', 'modules', { tier: 'official', networkAccess: true });
    const result = await new Promise(resolve => module.network.subscribe('http.request', {}, resolve));

    assert.deepEqual(result, { ok: true, value: 'response body' });
});

test('a Module WITHOUT networkAccess is refused on host.network even at official tier — network access is never implied by tier', async () => {
    const engine = createEngine();
    let handlerCalled = false;
    engine.buses.network.register('http.request', () => { handlerCalled = true; return 'body'; });

    const module = engine.registerCaller('module.trusted', 'modules', { tier: 'official' });
    const result = await new Promise(resolve => module.network.subscribe('http.request', {}, resolve));

    assert.equal(result.ok, false);
    assert.equal(handlerCalled, false);
});

test('the network bus is genuinely separate from the services bus — a contract registered on one is unreachable through the other\'s Gate', async () => {
    const engine = createEngine();
    engine.buses.network.register('http.request', () => 'from network bus');

    // Even a caller with a blanket official-tier services grant (which would
    // normally allow ANY contract on buses.services) must not be able to
    // reach http.request through host.services — it was never registered
    // there at all. This is the structural guarantee network-gate.js's own
    // doc comment relies on, proven directly rather than just by inspection.
    const module = engine.registerCaller('module.curious', 'modules', { tier: 'official', networkAccess: true });
    const result = await new Promise(resolve => module.services.subscribe('http.request', {}, resolve));

    assert.equal(result.ok, false, 'http.request must not be reachable through the services accessor, regardless of rights');
});

async function flushMicrotasks(rounds = 10) {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
}
