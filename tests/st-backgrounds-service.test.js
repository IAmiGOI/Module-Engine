import test from 'node:test';
import assert from 'node:assert/strict';
import { registerStBackgroundsService } from '../services/st-backgrounds.js';
import { createContractBus } from '../libraries/shared/contract-bus.js';

/** A fake `/bg` slash command: `run('/bg')` reports the current name, `run('/bg <query>')` fuzzy-matches (substring here is enough) and "clicks" it. */
function fakeContext(current = 'forest.jpg') {
    let active = current;
    const available = ['forest.jpg', 'beach-sunset.jpg', 'castle-night.jpg'];
    const run = async text => {
        const query = text.replace(/^\/bg\s*/, '').trim();
        if (!query) return { pipe: active };
        const found = available.find(name => name.toLowerCase().includes(query.toLowerCase()));
        if (found) active = found;
        return { pipe: '' }; // setBackgroundCallback always returns '' on a set attempt, found or not — see doc-comment
    };
    return { executeSlashCommandsWithOptions: run, _activeName: () => active };
}

test('setActive() reports success when the resulting background actually contains the requested name', async () => {
    const context = fakeContext('forest.jpg');
    const bus = createContractBus();
    registerStBackgroundsService(bus, { getContext: () => context });
    const result = await new Promise(resolve => bus.subscribe('stBackgrounds.setActive', { params: { name: 'beach' } }, resolve));
    assert.equal(result.ok, true);
    assert.equal(result.value.applied, 'beach-sunset.jpg');
    assert.equal(result.value.changed, true);
});

test('setActive() reports failure (not just a thrown error) when no background matches — /bg\'s own callback answers "" either way, found or not', async () => {
    const context = fakeContext('forest.jpg');
    const bus = createContractBus();
    registerStBackgroundsService(bus, { getContext: () => context });
    const result = await new Promise(resolve => bus.subscribe('stBackgrounds.setActive', { params: { name: 'nonexistent-place' } }, resolve));
    assert.equal(result.ok, true, 'the bus call itself succeeds — it is setActive()\'s OWN { ok } that reports the outcome');
    assert.equal(result.value.ok, false, 'no background matched "nonexistent-place"');
    assert.equal(result.value.changed, false, 'still on the original background');
});

test('setActive() requires a name and a working slash-command API, without throwing across the bus', async () => {
    const bus = createContractBus();
    registerStBackgroundsService(bus, { getContext: () => fakeContext() });
    const noName = await new Promise(resolve => bus.subscribe('stBackgrounds.setActive', { params: {} }, resolve));
    assert.equal(noName.ok, false);

    const noApi = createContractBus();
    registerStBackgroundsService(noApi, { getContext: () => ({}) });
    const result = await new Promise(resolve => noApi.subscribe('stBackgrounds.setActive', { params: { name: 'beach' } }, resolve));
    assert.equal(result.ok, false);
});
