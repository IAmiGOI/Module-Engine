import test from 'node:test';
import assert from 'node:assert/strict';
import { categoryOfPath, createCategoryFilter, describeConfigForUi, intersectCategories, sanitizeCategories, sanitizeSyncConfig, SYNC_CATEGORY_IDS } from '../libraries/core/sync-config.js';
import { registerStUserDataService } from '../services/st-user-data.js';
import { createFakeBuses } from '../libraries/shared/fake-buses.js';

const options = { generateDeviceId: () => '0123456789abcdef', defaultDeviceName: 'Phone' };

test('every kind of chat belongs to the one Chats category and unknown sections belong to none', () => {
    assert.equal(categoryOfPath('chats/Alice/x.jsonl'), 'chats');
    assert.equal(categoryOfPath('groupChats/1.jsonl'), 'chats');
    assert.equal(categoryOfPath('groups/1.json'), 'chats');
    assert.equal(categoryOfPath('characters/Alice.png'), 'characters');
    assert.equal(categoryOfPath('mystery/x'), null);
    assert.equal(categoryOfPath('noslash'), null);
});

test('the category filter lets through only enabled categories', () => {
    const include = createCategoryFilter(['backgrounds', 'chats']);
    assert.equal(include('backgrounds/a.png'), true);
    assert.equal(include('groupChats/1.jsonl'), true);
    assert.equal(include('characters/a.png'), false);
    assert.equal(include('mystery/a'), false);
    assert.deepEqual(intersectCategories(['chats', 'worlds', 'personas'], ['worlds', 'chats']), ['chats', 'worlds']);
});

test('the categories the service exposes match the ones the library knows, and every provider maps to a known category', async () => {
    const buses = createFakeBuses();
    registerStUserDataService(buses.services, { getContext: () => ({}), fetch: async () => ({ ok: true, json: async () => [] }) });
    const listed = await new Promise(resolve => buses.services.subscribe('stUserData.categories', {}, result => resolve(result.value)));
    assert.deepEqual(listed.map(item => item.id), [...SYNC_CATEGORY_IDS]);
    for (const section of ['characters', 'chats', 'groups', 'groupChats', 'worlds', 'backgrounds', 'personas']) {
        assert.ok(SYNC_CATEGORY_IDS.includes(categoryOfPath(`${section}/x`)), section);
    }
});

test('categories: a missing list means everything, a given list is filtered to known ids in a fixed order', () => {
    assert.deepEqual(sanitizeCategories(undefined), [...SYNC_CATEGORY_IDS]);
    assert.deepEqual(sanitizeCategories(['worlds', 'bogus', 'characters']), ['characters', 'worlds']);
    assert.deepEqual(sanitizeCategories([]), []);
});

test('an empty or garbage stored config becomes a complete working one with a fresh device id', () => {
    for (const raw of [undefined, null, 'oops', 42, {}]) {
        const config = sanitizeSyncConfig(raw, options);
        assert.equal(config.deviceId, '0123456789abcdef');
        assert.equal(config.deviceName, 'Phone');
        assert.deepEqual(config.categories, [...SYNC_CATEGORY_IDS]);
        assert.equal(config.autoSync, true);
        assert.equal(config.intervalMin, 10);
        assert.equal(config.signalServer, 'https://ntfy.sh');
        assert.deepEqual(config.pairs, []);
        assert.equal(config.github.enabled, false);
    }
});

test('a valid stored config keeps its device id, pairs and settings, and drops broken pairs', () => {
    const config = sanitizeSyncConfig({
        deviceId: 'fedcba9876543210', deviceName: '  My PC  ', autoSync: false, intervalMin: 9999, signalServer: 'https://ntfy.example.org/',
        pairs: [{ id: 'aaaa', name: 'Phone', secret: 's3cret', pairedAt: 5 }, { id: '', secret: 'x' }, { id: 'bbbb' }, null],
        github: { enabled: true, repository: 'o/r', token: 'tok', auto: true },
    }, options);
    assert.equal(config.deviceId, 'fedcba9876543210');
    assert.equal(config.deviceName, 'My PC');
    assert.equal(config.autoSync, false);
    assert.equal(config.intervalMin, 240, 'clamped');
    assert.equal(config.signalServer, 'https://ntfy.example.org');
    assert.deepEqual(config.pairs.map(pair => pair.id), ['aaaa']);
    assert.equal(config.github.owner, 'o');
    assert.equal(config.github.auto, true);
    assert.equal(sanitizeSyncConfig({ signalServer: 'http://insecure' }, options).signalServer, 'https://ntfy.sh', 'only https signal servers are accepted');
});

test('what is shown in the interface never contains pair secrets or the GitHub token', () => {
    const config = sanitizeSyncConfig({ pairs: [{ id: 'aaaa', name: 'Phone', secret: 'TOP-SECRET' }], github: { enabled: true, repository: 'o/r', token: 'ghp_TOKEN' } }, options);
    const shown = JSON.stringify(describeConfigForUi(config));
    assert.doesNotMatch(shown, /TOP-SECRET|ghp_TOKEN/);
    assert.match(shown, /"hasToken":true/);
    assert.match(shown, /o\/r/);
});

test('own connection servers: only well-formed stun/turn addresses survive, and the defaults are always kept', async () => {
    const { sanitizeIceServers, buildIceServers, relayToIceServers, DEFAULT_ICE_SERVERS } = await import('../libraries/core/sync-config.js');
    assert.equal(sanitizeIceServers(undefined), null);
    assert.equal(sanitizeIceServers([{ urls: 'http://not-ice' }, null, {}]), null);
    assert.deepEqual(sanitizeIceServers([{ urls: 'turn:t.example.com:3478', username: 'u', credential: 'c' }, { urls: ['stun:s.example.com', 'bogus'] }]), [
        { urls: ['turn:t.example.com:3478'], username: 'u', credential: 'c' },
        { urls: ['stun:s.example.com'] },
    ]);
    assert.deepEqual(buildIceServers(null), [...DEFAULT_ICE_SERVERS]);
    assert.equal(buildIceServers([{ urls: ['turn:x:1'] }]).length, DEFAULT_ICE_SERVERS.length + 1);
    assert.equal(relayToIceServers({ url: '   ' }), null);
    assert.deepEqual(relayToIceServers({ url: ' turns:t.example.com:443 ', username: 'u', credential: 'p' }), [{ urls: ['turns:t.example.com:443'], username: 'u', credential: 'p' }]);
});
