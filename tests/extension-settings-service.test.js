import test from 'node:test';
import assert from 'node:assert/strict';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { createContractBus } from '../libraries/shared/contract-bus.js';

function fakeContext(initialExtensionSettings = {}) {
    let debouncedCalls = 0;
    return {
        context: {
            extensionSettings: initialExtensionSettings,
            saveSettingsDebounced: () => { debouncedCalls += 1; },
        },
        debouncedCalls: () => debouncedCalls,
    };
}

test('extensionSettings.read returns {} when nothing has ever been stored', async () => {
    const { context } = fakeContext({});
    const bus = createContractBus();
    registerExtensionSettingsService(bus, { getContext: () => context });

    const result = await new Promise(resolve => bus.subscribe('extensionSettings.read', {}, resolve));

    assert.deepEqual(result, { ok: true, value: {} });
});

test('extensionSettings.write stores the raw object under its own key and calls saveSettingsDebounced', async () => {
    const { context, debouncedCalls } = fakeContext({});
    const bus = createContractBus();
    registerExtensionSettingsService(bus, { getContext: () => context });

    await new Promise(resolve => bus.subscribe('extensionSettings.write', { params: { raw: { 'core.tracking': { enabled: true } } } }, resolve));

    assert.deepEqual(context.extensionSettings.stme_settings, { 'core.tracking': { enabled: true } });
    assert.equal(debouncedCalls(), 1);
});

test('extensionSettings.write falls back to saveSettings() when saveSettingsDebounced is not available on this ST build', async () => {
    let saveCalls = 0;
    const context = { extensionSettings: {}, saveSettings: () => { saveCalls += 1; } };
    const bus = createContractBus();
    registerExtensionSettingsService(bus, { getContext: () => context });

    await new Promise(resolve => bus.subscribe('extensionSettings.write', { params: { raw: { ns: {} } } }, resolve));

    assert.equal(saveCalls, 1);
});

test('a custom storageKey keeps this Сервис\'s data out of extensionSettings\'s default slot', async () => {
    const { context } = fakeContext({});
    const bus = createContractBus();
    registerExtensionSettingsService(bus, { getContext: () => context, storageKey: 'custom_slot' });

    await new Promise(resolve => bus.subscribe('extensionSettings.write', { params: { raw: { ns: { key: 'v' } } } }, resolve));

    assert.deepEqual(context.extensionSettings.custom_slot, { ns: { key: 'v' } });
    assert.equal('stme_settings' in context.extensionSettings, false);
});

test('registerExtensionSettingsService()\'s returned unregister function retires both contracts', async () => {
    const { context } = fakeContext({});
    const bus = createContractBus();
    const unregister = registerExtensionSettingsService(bus, { getContext: () => context });

    unregister();
    const result = await new Promise(resolve => bus.subscribe('extensionSettings.read', {}, resolve));

    assert.equal(result.ok, false);
});
