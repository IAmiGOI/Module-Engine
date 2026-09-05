import test from 'node:test';
import assert from 'node:assert/strict';
import { createRightsCore } from '../cores/rights/index.js';

test('an unregistered caller is denied any contract — no registration means no rights at all', () => {
    const rights = createRightsCore();

    const decision = rights.checkAccess('ghost', 'anything');

    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /not a registered caller/);
});

test('official tier is allowed any contract, with no declared list at all', () => {
    const rights = createRightsCore();
    rights.register('core.ui', { tier: 'official' });

    assert.equal(rights.checkAccess('core.ui', 'anything.at.all').allowed, true);
});

test('community tier is allowed ONLY what its own key explicitly lists — everything else denied', () => {
    const rights = createRightsCore();
    rights.register('community.someModule', { tier: 'community', allowedContracts: ['model.generate'] });

    assert.equal(rights.checkAccess('community.someModule', 'model.generate').allowed, true);
    const denied = rights.checkAccess('community.someModule', 'storage.settings');
    assert.equal(denied.allowed, false);
    assert.match(denied.reason, /community tier/);
});

test('scanned-safe tier defaults to allow — only what the scan explicitly denied is refused', () => {
    const rights = createRightsCore();
    rights.register('scanned.module', { tier: 'scanned-safe', deniedContracts: ['storage.settings'] });

    assert.equal(rights.checkAccess('scanned.module', 'model.generate').allowed, true, 'not on the deny list — allowed by default');
    assert.equal(rights.checkAccess('scanned.module', 'storage.settings').allowed, false, 'explicitly denied by the scan');
});

test('scanned-unsafe tier still uses the same default-allow/deny-by-exception policy as scanned-safe', () => {
    const rights = createRightsCore();
    rights.register('risky.module', { tier: 'scanned-unsafe', deniedContracts: [] });

    assert.equal(rights.checkAccess('risky.module', 'anything').allowed, true);
});

test('register() rejects an unrecognized trust tier', () => {
    const rights = createRightsCore();
    assert.throws(() => rights.register('x', { tier: 'super-trusted' }));
});

test('quarantine() denies every future request regardless of tier — including official', () => {
    const rights = createRightsCore();
    rights.register('core.trusted', { tier: 'official' });
    assert.equal(rights.checkAccess('core.trusted', 'anything').allowed, true);

    rights.quarantine('core.trusted');

    const decision = rights.checkAccess('core.trusted', 'anything');
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /quarantined/);
});

test('quarantine() works even for a caller that was never registered at all', () => {
    const rights = createRightsCore();

    rights.quarantine('never.seen');

    assert.equal(rights.isQuarantined('never.seen'), true);
    assert.equal(rights.checkAccess('never.seen', 'anything').allowed, false);
});

test('quarantine survives a fresh register() call for the same id — it is NOT a way to clear it', () => {
    const rights = createRightsCore();
    rights.register('bad.module', { tier: 'community', allowedContracts: [] });
    rights.quarantine('bad.module');

    rights.register('bad.module', { tier: 'community', allowedContracts: ['model.generate'] });

    assert.equal(rights.isQuarantined('bad.module'), true);
    assert.equal(rights.checkAccess('bad.module', 'model.generate').allowed, false, 're-registering must not lift a quarantine');
});

test('networkAccess defaults to false, even for official tier — it is never implied by trust tier', () => {
    const rights = createRightsCore();
    rights.register('core.trusted', { tier: 'official' });

    assert.equal(rights.hasNetworkAccess('core.trusted'), false);
});

test('networkAccess: true grants hasNetworkAccess(), independent of allowedContracts', () => {
    const rights = createRightsCore();
    rights.register('module.weather', { tier: 'community', allowedContracts: [], networkAccess: true });

    assert.equal(rights.hasNetworkAccess('module.weather'), true);
    assert.equal(rights.checkAccess('module.weather', 'anything').allowed, false, 'networkAccess must not leak into the regular contract check');
});

test('hasNetworkAccess() denies an unregistered caller', () => {
    const rights = createRightsCore();

    assert.equal(rights.hasNetworkAccess('ghost'), false);
});

test('quarantine denies networkAccess too, even if it was previously granted', () => {
    const rights = createRightsCore();
    rights.register('module.weather', { tier: 'official', networkAccess: true });
    assert.equal(rights.hasNetworkAccess('module.weather'), true);

    rights.quarantine('module.weather');

    assert.equal(rights.hasNetworkAccess('module.weather'), false);
});
