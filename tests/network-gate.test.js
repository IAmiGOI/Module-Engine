import test from 'node:test';
import assert from 'node:assert/strict';
import { createNetworkGate } from '../libraries/shared/network-gate.js';
import { createRightsCore } from '../cores/rights/index.js';
import { createContractBus } from '../libraries/shared/contract-bus.js';
import { createEventBus } from '../libraries/shared/event-bus.js';

test('a caller with networkAccess: true reaches the target bus normally', async () => {
    const rights = createRightsCore();
    rights.register('module.weather', { tier: 'official', networkAccess: true });
    const targetBus = createContractBus();
    targetBus.register('http.request', () => 'response body');
    const gate = createNetworkGate(rights, targetBus);

    const result = await new Promise(resolve => gate.subscribe('http.request', { callerId: 'module.weather' }, resolve));

    assert.deepEqual(result, { ok: true, value: 'response body' });
});

test('a caller with no networkAccess is denied even though it is otherwise official tier — never reaches the target bus', async () => {
    const rights = createRightsCore();
    rights.register('module.trusted', { tier: 'official' }); // networkAccess defaults to false
    let handlerCalled = false;
    const targetBus = createContractBus();
    targetBus.register('http.request', () => { handlerCalled = true; return 'body'; });
    const gate = createNetworkGate(rights, targetBus);

    const result = await new Promise(resolve => gate.subscribe('http.request', { callerId: 'module.trusted' }, resolve));

    assert.equal(result.ok, false);
    assert.match(result.error.message, /no network access/);
    assert.equal(handlerCalled, false, 'the underlying supplier must never even be called without networkAccess');
});

test('networkAccess: true is still subject to the REGULAR rights check too — the two checks compose', async () => {
    const rights = createRightsCore();
    rights.register('module.rogue', { tier: 'community', allowedContracts: [], networkAccess: true });
    const targetBus = createContractBus();
    targetBus.register('http.request', () => 'body');
    const gate = createNetworkGate(rights, targetBus);

    const result = await new Promise(resolve => gate.subscribe('http.request', { callerId: 'module.rogue' }, resolve));

    assert.equal(result.ok, false, 'networkAccess alone does not bypass the regular per-contract rights check');
});

test('a quarantine applied MID-subscription revokes networkAccess on the very next delivery', async () => {
    const rights = createRightsCore();
    rights.register('module.weather', { tier: 'official', networkAccess: true });
    const events = createEventBus();
    const targetBus = createContractBus(events);
    let callCount = 0;
    targetBus.register('http.request', () => ++callCount);
    const gate = createNetworkGate(rights, targetBus);

    const deliveries = [];
    gate.subscribe('http.request', { callerId: 'module.weather', when: { event: 'poll' } }, r => deliveries.push(r));

    events.emit('poll');
    await flushMicrotasks();
    assert.deepEqual(deliveries, [{ ok: true, value: 1 }], 'sanity check — allowed before quarantine');

    rights.quarantine('module.weather');
    events.emit('poll');
    await flushMicrotasks();

    assert.equal(deliveries.length, 2);
    assert.equal(deliveries[1].ok, false, 'the next delivery after quarantine must be refused');
});

test('revoking networkAccess (a fresh register() with networkAccess left out) denies future deliveries even without quarantine', async () => {
    const rights = createRightsCore();
    rights.register('module.weather', { tier: 'official', networkAccess: true });
    const events = createEventBus();
    const targetBus = createContractBus(events);
    targetBus.register('http.request', () => 'body');
    const gate = createNetworkGate(rights, targetBus);

    const deliveries = [];
    gate.subscribe('http.request', { callerId: 'module.weather', when: { event: 'poll' } }, r => deliveries.push(r));
    events.emit('poll');
    await flushMicrotasks();
    assert.equal(deliveries[0].ok, true);

    rights.register('module.weather', { tier: 'official' }); // networkAccess defaults back to false
    events.emit('poll');
    await flushMicrotasks();

    assert.equal(deliveries[1].ok, false);
});

test('register() is a pure pass-through to the target bus — no network check on the supplier side', () => {
    const rights = createRightsCore(); // deliberately empty — no callers registered at all
    const targetBus = createContractBus();
    const gate = createNetworkGate(rights, targetBus);

    assert.doesNotThrow(() => gate.register('http.request', () => 'value'));
});

async function flushMicrotasks(rounds = 10) {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
}
