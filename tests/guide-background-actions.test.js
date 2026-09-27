import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuideActions } from '../cores/guide/actions.js';
import { createContractBus } from '../libraries/shared/contract-bus.js';

function build({ names = ['forest.jpg', 'beach.jpg'], setResult = { ok: true, applied: 'beach.jpg', changed: true } } = {}) {
    const services = createContractBus();
    const setActiveCalls = [];
    services.register('stBackgrounds.list', () => names);
    // Real params, not a fixed return — a request() call that forgets to wrap its payload as `{ params }` shows up here as `undefined`.
    services.register('stBackgrounds.setActive', params => { setActiveCalls.push(params); return setResult; });
    const host = { services };
    const actions = createGuideActions({ host, call: async () => ({ ok: false }), modules: null, reveal: async () => true, hide: async () => true, checklist: [], markDone: async () => {} });
    return { actions, setActiveCalls };
}

test('background.list is safe (auto-runnable) and reports the real names from the service', async () => {
    const { actions } = build({ names: ['forest.jpg', 'beach.jpg'] });
    assert.equal(actions['background.list'].safe, true);
    const result = await actions['background.list'].run();
    assert.equal(result.ok, true);
    assert.match(result.message, /forest\.jpg, beach\.jpg/);
});

test('background.list says so plainly when nothing is installed, instead of an empty or confusing message', async () => {
    const { actions } = build({ names: [] });
    const result = await actions['background.list'].run();
    assert.equal(result.ok, true);
    assert.match(result.message, /no backgrounds are installed/i);
});

test('background.set requires a name, and reports the ACTUAL applied filename on success', async () => {
    const { actions, setActiveCalls } = build({ setResult: { ok: true, applied: 'beach-sunset.jpg', changed: true } });
    assert.equal(actions['background.set'].safe, true);
    const missing = await actions['background.set'].run({});
    assert.equal(missing.ok, false);
    assert.equal(setActiveCalls.length, 0, 'no name — never even calls the service');
    const result = await actions['background.set'].run({ name: 'beach' });
    assert.equal(result.ok, true);
    assert.match(result.message, /beach-sunset\.jpg/);
    // Regression: request(bus, contract, { name }) silently drops `name` — request() only reads a `params` key. Catches that shape mistake.
    assert.deepEqual(setActiveCalls, [{ name: 'beach' }], 'the service must actually receive the name the model picked');
});

test('background.set reports failure plainly when nothing matched — never claims success for a guess that missed', async () => {
    const { actions } = build({ setResult: { ok: false, applied: 'forest.jpg', changed: false } });
    const result = await actions['background.set'].run({ name: 'nonexistent-place' });
    assert.equal(result.ok, false);
    assert.match(result.message, /no background found matching "nonexistent-place"/i);
});
