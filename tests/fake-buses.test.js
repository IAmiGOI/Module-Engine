import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeBuses } from '../libraries/shared/fake-buses.js';

test('createFakeBuses() returns independent events/modules/cores/services/network buses', () => {
    const buses = createFakeBuses();

    assert.equal(typeof buses.events.emit, 'function');
    assert.equal(typeof buses.modules.register, 'function');
    assert.equal(typeof buses.cores.register, 'function');
    assert.equal(typeof buses.services.register, 'function');
    assert.equal(typeof buses.network.register, 'function');
});

test('a contract registered on the modules bus is invisible to the cores/services/network buses — independent domains', async () => {
    const { modules, cores, services, network } = createFakeBuses();
    modules.register('module.only', () => 'from modules bus');

    const fromModules = await new Promise(resolve => modules.subscribe('module.only', {}, resolve));
    const fromCores = await new Promise(resolve => cores.subscribe('module.only', {}, resolve));
    const fromServices = await new Promise(resolve => services.subscribe('module.only', {}, resolve));
    const fromNetwork = await new Promise(resolve => network.subscribe('module.only', {}, resolve));

    assert.equal(fromModules.ok, true);
    assert.equal(fromCores.ok, false, 'the cores bus must not see a contract registered on the modules bus');
    assert.equal(fromServices.ok, false, 'the services bus must not see a contract registered on the modules bus');
    assert.equal(fromNetwork.ok, false, 'the network bus must not see a contract registered on the modules bus');
});

test('all 3 contract buses share the SAME underlying event bus — an event fired anywhere reaches a "when" subscription on any of them', async () => {
    const { events, modules, cores } = createFakeBuses();
    modules.register('modules.value', () => 'm');
    cores.register('cores.value', () => 'c');

    const deliveries = [];
    modules.subscribe('modules.value', { when: { event: 'shared.tick' } }, r => deliveries.push(['modules', r]));
    cores.subscribe('cores.value', { when: { event: 'shared.tick' } }, r => deliveries.push(['cores', r]));

    events.emit('shared.tick');
    // subscribe()'s "when"-gated delivery always crosses at least one
    // microtask tick (contract-bus.js's resolve() is async even for a
    // synchronous supplier) — emit() itself doesn't wait for that.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    assert.equal(deliveries.length, 2, 'both buses\' subscriptions must react to the one shared event');
});
