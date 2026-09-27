import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuideActions } from '../cores/guide/actions.js';
import { createContractBus } from '../libraries/shared/contract-bus.js';

function build({ names = ['forest.jpg', 'beach.jpg'], setResult = { ok: true, applied: 'beach.jpg', changed: true } } = {}) {
    const services = createContractBus();
    services.register('stBackgrounds.list', () => names);
    services.register('stBackgrounds.setActive', () => setResult);
    const host = { services };
    const actions = createGuideActions({ host, call: async () => ({ ok: false }), modules: null, reveal: async () => true, hide: async () => true, checklist: [], markDone: async () => {} });
    return actions;
}

test('background.list is safe (auto-runnable) and reports the real names from the service', async () => {
    const actions = build({ names: ['forest.jpg', 'beach.jpg'] });
    assert.equal(actions['background.list'].safe, true);
    const result = await actions['background.list'].run();
    assert.equal(result.ok, true);
    assert.match(result.message, /forest\.jpg, beach\.jpg/);
});

test('background.list says so plainly when nothing is installed, instead of an empty or confusing message', async () => {
    const actions = build({ names: [] });
    const result = await actions['background.list'].run();
    assert.equal(result.ok, true);
    assert.match(result.message, /no backgrounds are installed/i);
});

test('background.set requires a name, and reports the ACTUAL applied filename on success', async () => {
    const actions = build({ setResult: { ok: true, applied: 'beach-sunset.jpg', changed: true } });
    assert.equal(actions['background.set'].safe, true);
    const missing = await actions['background.set'].run({});
    assert.equal(missing.ok, false);
    const result = await actions['background.set'].run({ name: 'beach' });
    assert.equal(result.ok, true);
    assert.match(result.message, /beach-sunset\.jpg/);
});

test('background.set reports failure plainly when nothing matched — never claims success for a guess that missed', async () => {
    const actions = build({ setResult: { ok: false, applied: 'forest.jpg', changed: false } });
    const result = await actions['background.set'].run({ name: 'nonexistent-place' });
    assert.equal(result.ok, false);
    assert.match(result.message, /no background found matching "nonexistent-place"/i);
});
