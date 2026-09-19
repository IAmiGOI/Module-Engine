import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeNetwork, createFakeClock, settle } from './helpers/fake-sync-network.js';
import { createFakeDevice } from './helpers/fake-sync-device.js';
import { createFakeDrive, createFakeDropbox } from './helpers/fake-cloud.js';

/** Общая «сеть» облака: токен-эндпоинты обоих провайдеров, Dropbox и Drive. */
function createCloudWorld() {
    const validTokens = new Set(['AT1']);
    const behavior = { refuseRefresh: false };
    const dropbox = createFakeDropbox({ validToken: token => validTokens.has(token) });
    const drive = createFakeDrive({ validToken: token => validTokens.has(token) });
    const log = { tokenRequests: [], devicePolls: 0, deviceRequests: [] };
    let pendingPolls = 2;
    let refreshCounter = 0;
    const json = (status, data) => ({ status, ok: status >= 200 && status < 300, text: JSON.stringify(data), headers: {} });
    const http = async params => {
        const { url } = params;
        if (url === 'https://api.dropboxapi.com/oauth2/token' || url === 'https://oauth2.googleapis.com/token') {
            const body = new URLSearchParams(params.body);
            log.tokenRequests.push(Object.fromEntries(body));
            if (body.get('grant_type') === 'authorization_code') return body.get('code_verifier') && body.get('code') === 'GOOD' ? json(200, { access_token: 'AT1', refresh_token: 'RT', expires_in: 3600 }) : json(400, { error: 'invalid_grant', error_description: 'bad code' });
            if (body.get('grant_type') === 'refresh_token') { if (behavior.refuseRefresh) return json(400, { error: 'invalid_grant', error_description: 'token revoked' }); refreshCounter += 1; const token = `AT-refresh-${refreshCounter}`; validTokens.add(token); return json(200, { access_token: token, expires_in: 3600 }); }
            if (body.get('grant_type').includes('device_code')) { log.devicePolls += 1; return pendingPolls-- > 0 ? json(428, { error: 'authorization_pending' }) : json(200, { access_token: 'AT1', refresh_token: 'RT-google', expires_in: 3600 }); }
        }
        if (url === 'https://oauth2.googleapis.com/device/code') { log.deviceRequests.push(Object.fromEntries(new URLSearchParams(params.body))); return json(200, { device_code: 'DC', user_code: 'WXYZ-1234', verification_url: 'https://www.google.com/device', interval: 5, expires_in: 1800 }); }
        if (url.includes('dropboxapi.com')) return dropbox.http(params);
        if (url.includes('googleapis.com')) return drive.http(params);
        throw new Error(`unexpected url ${url}`);
    };
    return { http, dropbox, drive, log, validTokens, behavior };
}

function makeDevice({ id, name, world, clock, network, cloud = {}, files = {} }) {
    const device = createFakeDevice({ id, name, network, clock, files, overrides: { cloud } });
    device.setHttp(world.http);
    return device;
}

const connectedDropbox = { provider: 'dropbox', enabled: true, tokens: { accessToken: 'AT1', refreshToken: 'RT', expiresAt: Date.now() + 3_600_000 }, apps: { dropbox: { clientId: 'KEY' } } };

test('signing in to Dropbox: a link with PKCE, then the pasted code turns into saved tokens and an enabled cloud', async () => {
    const world = createCloudWorld();
    const device = makeDevice({ id: '0000000000000001', name: 'PC', world, clock: createFakeClock(), network: createFakeNetwork(), cloud: { apps: { dropbox: { clientId: 'KEY' } } } });
    const begun = await device.call('sync.cloud.begin', { provider: 'dropbox' });
    assert.equal(begun.kind, 'code');
    const link = new URL(begun.url);
    assert.equal(link.searchParams.get('client_id'), 'KEY');
    assert.equal(link.searchParams.has('redirect_uri'), false);
    await assert.rejects(device.call('sync.cloud.finish', { code: 'WRONG' }), /bad code/);
    assert.equal((await device.call('sync.status')).cloudAuth.status, 'failed');
    await device.call('sync.cloud.begin', { provider: 'dropbox' });
    await device.call('sync.cloud.finish', { code: 'GOOD' });
    const status = await device.call('sync.status');
    assert.equal(status.cloudAuth.status, 'done');
    assert.equal(status.config.cloud.connected, true);
    assert.equal(status.config.cloud.enabled, true);
    assert.doesNotMatch(JSON.stringify(status), /AT1|"RT"|RT/, 'tokens never reach the interface');
    assert.equal(world.log.tokenRequests.at(-1).code_verifier.length >= 43, true);
    await device.core.stop();
});

test('without an app key there is a helpful message instead of a broken link', async () => {
    const device = makeDevice({ id: '0000000000000001', name: 'PC', world: createCloudWorld(), clock: createFakeClock(), network: createFakeNetwork() });
    await assert.rejects(device.call('sync.cloud.begin', { provider: 'dropbox' }), /no Dropbox app key/i);
    await device.core.stop();
});

test('Google Drive works out of the box with the built-in key: no user setup, and the scope is the one the device flow allows', async () => {
    const world = createCloudWorld();
    const device = makeDevice({ id: '0000000000000001', name: 'PC', world, clock: createFakeClock(), network: createFakeNetwork() });
    const begun = await device.call('sync.cloud.begin', { provider: 'google' });
    assert.equal(begun.kind, 'device');
    assert.equal(begun.userCode, 'WXYZ-1234');
    assert.equal(world.log.deviceRequests[0].scope, 'https://www.googleapis.com/auth/drive.file');
    assert.match(world.log.deviceRequests[0].client_id, /\.apps\.googleusercontent\.com$/);
    await device.core.stop();
});

test('signing in to Google Drive: a code to type at google.com/device, polled until the user confirms', async () => {
    const world = createCloudWorld();
    const clock = createFakeClock();
    const device = makeDevice({ id: '0000000000000001', name: 'PC', world, clock, network: createFakeNetwork(), cloud: { provider: 'google', apps: { google: { clientId: 'GID', clientSecret: 'GSECRET' } } } });
    const begun = await device.call('sync.cloud.begin', { provider: 'google' });
    assert.deepEqual([begun.kind, begun.userCode, begun.url], ['device', 'WXYZ-1234', 'https://www.google.com/device']);
    assert.equal((await device.call('sync.status')).cloudAuth.status, 'waiting');
    await clock.advance(5000);
    await clock.advance(5000);
    assert.equal((await device.call('sync.status')).cloudAuth.status, 'waiting', 'still pending after two polls');
    await clock.advance(5000);
    const status = await device.call('sync.status');
    assert.equal(status.cloudAuth.status, 'done');
    assert.equal(status.config.cloud.connected, true);
    assert.equal(world.log.devicePolls, 3);
    await device.core.stop();
});

test('a Google sign-in that is never confirmed ends by itself and can be cancelled', async () => {
    const world = createCloudWorld();
    const clock = createFakeClock();
    const device = makeDevice({ id: '0000000000000001', name: 'PC', world, clock, network: createFakeNetwork(), cloud: { provider: 'google', apps: { google: { clientId: 'G', clientSecret: 'S' } } } });
    await device.call('sync.cloud.begin', { provider: 'google' });
    await device.call('sync.cloud.cancel');
    assert.equal((await device.call('sync.status')).cloudAuth.status, 'cancelled');
    await clock.advance(20000);
    assert.equal(world.log.devicePolls, 0, 'no polling after cancelling');
    await device.core.stop();
});

test('two devices on the same Dropbox: one uploads, the other downloads, and a repeat pass moves nothing', async () => {
    const world = createCloudWorld();
    const clock = createFakeClock();
    const network = createFakeNetwork();
    const a = makeDevice({ id: '0000000000000001', name: 'PC', world, clock, network, cloud: connectedDropbox, files: { 'backgrounds/a.png': 'AAA', 'chats/Alice/one.jsonl': 'line' } });
    const b = makeDevice({ id: '0000000000000002', name: 'Phone', world, clock, network, cloud: connectedDropbox });
    const first = await a.call('sync.run', { target: 'cloud' });
    assert.equal(first.cloud.outcome, 'done');
    assert.equal(first.cloud.counts.pushed, 2);
    const second = await b.call('sync.run', { target: 'cloud' });
    assert.equal(second.cloud.counts.pulled, 2);
    assert.equal(b.text('chats/Alice/one.jsonl'), 'line');
    world.dropbox.calls.length = 0;
    const third = await a.call('sync.run', { target: 'cloud' });
    assert.equal(third.cloud.counts.pushed + third.cloud.counts.pulled, 0);
    assert.equal(world.dropbox.calls.some(call => call.endsWith('/files/upload')), false, 'nothing uploaded');
    await a.core.stop(); await b.core.stop();
});

test('an expired token is refreshed on its own and the new one is saved', async () => {
    const world = createCloudWorld();
    const cloud = { ...connectedDropbox, tokens: { accessToken: 'STALE', refreshToken: 'RT', expiresAt: 1 } };
    const device = makeDevice({ id: '0000000000000001', name: 'PC', world, clock: createFakeClock(), network: createFakeNetwork(), cloud, files: { 'backgrounds/a.png': 'A' } });
    const result = await device.call('sync.run', { target: 'cloud' });
    assert.equal(result.cloud.outcome, 'done', JSON.stringify(result.cloud));
    assert.equal(world.log.tokenRequests.filter(request => request.grant_type === 'refresh_token').length, 1);
    assert.match(device.settings.get('core.sync/config').cloud.tokens.accessToken, /^AT-refresh-/);
    await device.core.stop();
});

test('a failing cloud is reported in the result, never thrown', async () => {
    const world = createCloudWorld();
    world.validTokens.clear();
    world.behavior.refuseRefresh = true;
    const device = makeDevice({ id: '0000000000000001', name: 'PC', world, clock: createFakeClock(), network: createFakeNetwork(), cloud: { ...connectedDropbox, tokens: { accessToken: 'BAD', refreshToken: 'RT', expiresAt: Date.now() + 3_600_000 } }, files: { 'a/b': 'x' } });
    const result = await device.call('sync.run', { target: 'cloud' });
    assert.equal(result.cloud.outcome, 'failed');
    assert.match(result.cloud.errors[0], /token revoked/);
    await device.core.stop();
});

test('"Sync now" includes the cloud only when it is switched on, and the background schedule only when it is set to auto', async () => {
    const world = createCloudWorld();
    const off = makeDevice({ id: '0000000000000001', name: 'PC', world, clock: createFakeClock(), network: createFakeNetwork(), cloud: { ...connectedDropbox, enabled: false }, files: { 'backgrounds/a.png': 'A' } });
    assert.equal((await off.call('sync.run', {})).cloud, null);
    await off.call('sync.configure', { cloud: { enabled: true } });
    assert.equal((await off.call('sync.run', {})).cloud.outcome, 'done');

    const clock = createFakeClock();
    const scheduled = makeDevice({ id: '0000000000000003', name: 'Tablet', world, clock, network: createFakeNetwork(), cloud: { ...connectedDropbox, auto: false }, files: { 'worlds/w.json': '{"entries":{}}' } });
    await scheduled.core.start();
    const before = scheduled.events.filter(([event]) => event === 'sync.finished').length;
    await clock.advance(11 * 60000);
    assert.equal(scheduled.events.filter(([event]) => event === 'sync.finished').length, before, 'auto is off: the schedule does nothing');
    await scheduled.call('sync.configure', { cloud: { auto: true } });
    await clock.advance(11 * 60000);
    await settle(20);
    assert.ok(scheduled.events.filter(([event]) => event === 'sync.finished').length > before, 'auto is on: the schedule syncs the cloud');
    await off.core.stop(); await scheduled.core.stop();
});

test('disconnecting forgets the tokens and the remembered state of that account', async () => {
    const world = createCloudWorld();
    const device = makeDevice({ id: '0000000000000001', name: 'PC', world, clock: createFakeClock(), network: createFakeNetwork(), cloud: connectedDropbox, files: { 'backgrounds/a.png': 'A' } });
    await device.call('sync.run', { target: 'cloud' });
    assert.ok(device.state.has('base:cloud:dropbox'));
    await device.call('sync.cloud.disconnect');
    const status = await device.call('sync.status');
    assert.equal(status.config.cloud.connected, false);
    assert.equal(status.config.cloud.enabled, false);
    assert.equal(device.state.has('base:cloud:dropbox'), false);
    assert.equal((await device.call('sync.cloud.test')).ok, false);
    await device.core.stop();
});

test('the connection test reports how many synced files the cloud holds', async () => {
    const world = createCloudWorld();
    const device = makeDevice({ id: '0000000000000001', name: 'PC', world, clock: createFakeClock(), network: createFakeNetwork(), cloud: connectedDropbox, files: { 'backgrounds/a.png': 'A', 'backgrounds/b.png': 'B' } });
    await device.call('sync.run', { target: 'cloud' });
    const tested = await device.call('sync.cloud.test');
    assert.equal(tested.ok, true);
    assert.match(tested.message, /Dropbox.*2 synced file/);
    await device.core.stop();
});
