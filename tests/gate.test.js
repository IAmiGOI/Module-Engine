import test from 'node:test';
import assert from 'node:assert/strict';
import { createGate } from '../libraries/shared/gate.js';
import { createRightsCore } from '../cores/rights/index.js';
import { createContractBus } from '../libraries/shared/contract-bus.js';
import { createEventBus } from '../libraries/shared/event-bus.js';

test('an allowed caller\'s subscribe() passes straight through to the target bus', async () => {
    const rights = createRightsCore();
    rights.register('module.tracker', { tier: 'official' });
    const targetBus = createContractBus();
    targetBus.register('model.generate', () => 'generated text');
    const gate = createGate(rights, targetBus);

    const result = await new Promise(resolve => gate.subscribe('model.generate', { callerId: 'module.tracker' }, resolve));

    assert.deepEqual(result, { ok: true, value: 'generated text' });
});

test('a denied caller never reaches the target bus at all — delivered a structured refusal instead', async () => {
    const rights = createRightsCore();
    rights.register('module.rogue', { tier: 'community', allowedContracts: [] });
    let handlerCalled = false;
    const targetBus = createContractBus();
    targetBus.register('storage.settings', () => { handlerCalled = true; return 'secret'; });
    const gate = createGate(rights, targetBus);

    const result = await new Promise(resolve => gate.subscribe('storage.settings', { callerId: 'module.rogue' }, resolve));

    assert.equal(result.ok, false);
    assert.match(result.error.message, /Access denied/);
    assert.equal(handlerCalled, false, 'the underlying supplier must never even be called for a denied request');
});

test('subscribe() with no matching registration for callerId is denied the same way as an explicit denial', async () => {
    const rights = createRightsCore();
    const targetBus = createContractBus();
    targetBus.register('model.generate', () => 'text');
    const gate = createGate(rights, targetBus);

    const result = await new Promise(resolve => gate.subscribe('model.generate', { callerId: 'ghost' }, resolve));

    assert.equal(result.ok, false);
});

test('a quarantine applied MID-subscription is enforced on the very next delivery, not just future subscribe() calls', async () => {
    const rights = createRightsCore();
    rights.register('module.suspicious', { tier: 'official' });
    const events = createEventBus();
    const targetBus = createContractBus(events);
    let callCount = 0;
    targetBus.register('tracking.value', () => ++callCount);
    const gate = createGate(rights, targetBus);

    const deliveries = [];
    gate.subscribe('tracking.value', { callerId: 'module.suspicious', when: { event: 'tick' } }, r => deliveries.push(r));

    events.emit('tick');
    await flushMicrotasks();
    assert.deepEqual(deliveries, [{ ok: true, value: 1 }], 'sanity check — allowed while not yet quarantined');

    rights.quarantine('module.suspicious');
    events.emit('tick');
    await flushMicrotasks();

    assert.equal(deliveries.length, 2);
    assert.equal(deliveries[1].ok, false, 'the next delivery after quarantine must be refused, even on an already-active subscription');
});

test('register() is a pure pass-through to the target bus — no rights check on the supplier side', () => {
    const rights = createRightsCore(); // deliberately empty — no callers registered at all
    const targetBus = createContractBus();
    const gate = createGate(rights, targetBus);

    assert.doesNotThrow(() => gate.register('anything.at.all', () => 'value'));
});

async function flushMicrotasks(rounds = 10) {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
}
