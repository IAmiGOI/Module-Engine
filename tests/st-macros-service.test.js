import test from 'node:test';
import assert from 'node:assert/strict';
import { registerStMacrosService } from '../services/st-macros.js';
import { createContractBus } from '../libraries/shared/contract-bus.js';

function fakeModernContext() {
    const registered = new Map(); // name -> { handler, ...options }
    return {
        context: {
            macros: {
                register: (name, options) => registered.set(name, options),
                registry: { unregisterMacro: name => registered.delete(name) },
            },
        },
        registered,
    };
}

function fakeLegacyContext() {
    const registered = new Map(); // name -> handler
    return {
        context: {
            registerMacro: (name, handler) => registered.set(name, handler),
            unregisterMacro: name => registered.delete(name),
        },
        registered,
    };
}

test('stMacros.register uses the modern context.macros.register API when available', async () => {
    const { context, registered } = fakeModernContext();
    const bus = createContractBus();
    registerStMacrosService(bus, { getContext: () => context });
    const handler = () => 'value';

    const result = await new Promise(resolve => bus.subscribe('stMacros.register', { params: { name: 'myMacro', handler } }, resolve));

    assert.deepEqual(result, { ok: true, value: true });
    assert.equal(registered.get('myMacro').handler, handler);
});

test('stMacros.register falls back to the legacy context.registerMacro API when the modern one is absent', async () => {
    const { context, registered } = fakeLegacyContext();
    const bus = createContractBus();
    registerStMacrosService(bus, { getContext: () => context });
    const handler = () => 'value';

    await new Promise(resolve => bus.subscribe('stMacros.register', { params: { name: 'myMacro', handler } }, resolve));

    assert.equal(registered.get('myMacro'), handler);
});

test('stMacros.register fails clearly through the normal envelope when neither ST API is available', async () => {
    const bus = createContractBus();
    registerStMacrosService(bus, { getContext: () => ({}) });

    const result = await new Promise(resolve => bus.subscribe('stMacros.register', { params: { name: 'x', handler: () => '' } }, resolve));

    assert.equal(result.ok, false);
    assert.match(result.error.message, /neither/);
});

test('stMacros.unregister removes a previously-registered macro via the modern API', async () => {
    const { context, registered } = fakeModernContext();
    const bus = createContractBus();
    registerStMacrosService(bus, { getContext: () => context });
    await new Promise(resolve => bus.subscribe('stMacros.register', { params: { name: 'myMacro', handler: () => '' } }, resolve));

    await new Promise(resolve => bus.subscribe('stMacros.unregister', { params: { name: 'myMacro' } }, resolve));

    assert.equal(registered.has('myMacro'), false);
});

test('stMacros.unregister falls back to the legacy context.unregisterMacro API', async () => {
    const { context, registered } = fakeLegacyContext();
    const bus = createContractBus();
    registerStMacrosService(bus, { getContext: () => context });
    await new Promise(resolve => bus.subscribe('stMacros.register', { params: { name: 'myMacro', handler: () => '' } }, resolve));

    await new Promise(resolve => bus.subscribe('stMacros.unregister', { params: { name: 'myMacro' } }, resolve));

    assert.equal(registered.has('myMacro'), false);
});
