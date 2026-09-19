import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeNetwork, createFakeClock, settle } from './helpers/fake-sync-network.js';
import { createFakeDevice } from './helpers/fake-sync-device.js';
import { createFakeGithub } from './helpers/fake-github.js';
import { generateSecret } from '../libraries/core/sync-secrets.js';

const A_ID = '0000000000000001';   // меньший id — ведущий
const B_ID = '0000000000000002';

async function waitFor(predicate, { timeoutMs = 5000, label = 'condition' } = {}) {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
        await settle(3);
    }
}

const pairsOf = device => device.settings.get('core.sync/config').pairs ?? [];
const finishedRuns = device => device.events.filter(([event]) => event === 'sync.finished').length;

/** Два уже сопряжённых устройства (общий секрет вписан в настройки — сам обмен кодом проверяется отдельным тестом). */
async function createPair({ aFiles = {}, bFiles = {}, aOptions = {}, bOptions = {} } = {}) {
    const network = createFakeNetwork();
    const clock = createFakeClock();
    const secret = generateSecret();
    const a = createFakeDevice({ id: A_ID, name: 'PC', network, clock, files: aFiles, ...aOptions, overrides: { pairs: [{ id: B_ID, name: 'Phone', secret, pairedAt: 1 }], ...aOptions.overrides } });
    const b = createFakeDevice({ id: B_ID, name: 'Phone', network, clock, files: bFiles, ...bOptions, overrides: { pairs: [{ id: A_ID, name: 'PC', secret, pairedAt: 1 }], ...bOptions.overrides } });
    return { network, clock, a, b };
}

async function connect({ a, b }) {
    await a.core.start();
    await b.core.start();
    await waitFor(() => finishedRuns(a) >= 1 || a.events.some(([event]) => event === 'sync.finished'), { label: 'the first automatic pass' });
    await settle();
}

async function stopAll(...devices) {
    for (const device of devices) await device.core.stop();
}

test('pairing by code: one device shows a code, the other enters it, and both end up paired with the same secret', async () => {
    const network = createFakeNetwork();
    const clock = createFakeClock();
    const a = createFakeDevice({ id: A_ID, name: 'PC', network, clock });
    const b = createFakeDevice({ id: B_ID, name: 'Phone', network, clock });
    const { code } = await a.call('sync.pair.start');
    assert.match(code, /^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    assert.equal((await a.call('sync.status')).pairing.status, 'waiting');
    await b.call('sync.pair.join', { code: code.toLowerCase().replace('-', ' ') });
    await waitFor(() => pairsOf(a).length === 1 && pairsOf(b).length === 1, { label: 'both sides to store the pair' });
    const pairA = pairsOf(a)[0];
    const pairB = pairsOf(b)[0];
    assert.equal(pairA.id, B_ID);
    assert.equal(pairB.id, A_ID);
    assert.equal(pairA.name, 'Phone');
    assert.equal(pairA.secret, pairB.secret);
    await settle();
    assert.equal((await a.call('sync.status')).pairing.status, 'done');
    assert.equal((await b.call('sync.status')).pairing.status, 'done');
    assert.doesNotMatch(JSON.stringify(network.posted), new RegExp(pairA.secret), 'the secret never travels in the clear');
    await stopAll(a, b);
});

test('a wrong or malformed code pairs nothing: malformed is refused at once, a wrong one times out', async () => {
    const network = createFakeNetwork();
    const clock = createFakeClock();
    const a = createFakeDevice({ id: A_ID, name: 'PC', network, clock });
    const b = createFakeDevice({ id: B_ID, name: 'Phone', network, clock });
    await a.call('sync.pair.start');
    await assert.rejects(b.call('sync.pair.join', { code: 'nope' }), /does not look like a pairing code/);
    await b.call('sync.pair.join', { code: 'ZZZZZ-ZZZZZ' });
    await clock.advance(91000);
    assert.equal((await b.call('sync.status')).pairing.status, 'failed');
    assert.equal(pairsOf(a).length, 0);
    assert.equal(pairsOf(b).length, 0);
    await stopAll(a, b);
});

test('an unused code expires', async () => {
    const network = createFakeNetwork();
    const clock = createFakeClock();
    const a = createFakeDevice({ id: A_ID, name: 'PC', network, clock });
    await a.call('sync.pair.start');
    await clock.advance(10 * 60000 + 1000);
    assert.equal((await a.call('sync.status')).pairing.status, 'expired');
    await stopAll(a);
});

test('paired devices find each other on their own, the lower id leads, and the first pass copies files in both directions', async () => {
    const pair = await createPair({
        aFiles: { 'backgrounds/pc-only.png': 'PC-BG', 'chats/Alice/one.jsonl': '{"a":1}' },
        bFiles: { 'backgrounds/phone-only.png': 'PHONE-BG', 'worlds/Lore.json': '{"entries":{}}' },
    });
    await connect(pair);
    const status = await pair.a.call('sync.status');
    assert.deepEqual(status.connections.map(item => [item.name, item.status, item.role]), [['Phone', 'open', 'leader']]);
    assert.deepEqual((await pair.b.call('sync.status')).connections.map(item => [item.status, item.role]), [['open', 'follower']]);
    assert.deepEqual(pair.a.paths(), ['backgrounds/pc-only.png', 'backgrounds/phone-only.png', 'chats/Alice/one.jsonl', 'worlds/Lore.json']);
    assert.deepEqual(pair.b.paths(), pair.a.paths());
    assert.equal(pair.b.text('backgrounds/pc-only.png'), 'PC-BG');
    assert.equal(pair.a.text('worlds/Lore.json'), '{"entries":{}}');
    assert.equal(status.last.peers[0].counts.pushed, 2);
    assert.equal(status.last.peers[0].counts.pulled, 2);
    assert.ok(pair.a.refreshed().includes('backgrounds') && pair.b.refreshed().includes('backgrounds'), 'ST is told to reload its backgrounds list on both sides');
    await stopAll(pair.a, pair.b);
});

test('a second pass moves nothing when nothing changed, and only the changed file when one did', async () => {
    const pair = await createPair({ aFiles: { 'backgrounds/a.png': 'A', 'backgrounds/b.png': 'B' } });
    await connect(pair);
    pair.a.clearLog(); pair.b.clearLog();
    const before = finishedRuns(pair.a);
    await pair.a.call('sync.run');
    await waitFor(() => finishedRuns(pair.a) > before);
    assert.deepEqual(pair.a.log.filter(line => line.startsWith('write:') || line.startsWith('remove:')), []);
    assert.deepEqual(pair.b.log.filter(line => line.startsWith('write:') || line.startsWith('remove:')), []);
    assert.deepEqual(pair.a.log.filter(line => line.startsWith('read:')), [], 'unchanged stamps mean no file is even read');

    pair.a.put('backgrounds/b.png', 'B-edited');
    pair.a.clearLog(); pair.b.clearLog();
    const again = finishedRuns(pair.a);
    await pair.a.call('sync.run');
    await waitFor(() => finishedRuns(pair.a) > again);
    assert.deepEqual(pair.b.log.filter(line => line.startsWith('write:')), ['write:backgrounds/b.png']);
    assert.equal(pair.b.text('backgrounds/b.png'), 'B-edited');
    await stopAll(pair.a, pair.b);
});

test('a deletion on either device reaches the other one', async () => {
    const pair = await createPair({ aFiles: { 'worlds/gone.json': '{"entries":{}}', 'worlds/stay.json': '{"entries":{"1":1}}' } });
    await connect(pair);
    pair.b.store.delete('worlds/gone.json');
    pair.b.put('worlds/stay.json', '{"entries":{"1":2}}');
    const before = finishedRuns(pair.a);
    await pair.b.call('sync.run');   // the follower asks the leader to run
    await waitFor(() => finishedRuns(pair.a) > before, { label: 'the leader to run on request' });
    assert.equal(pair.a.paths().includes('worlds/gone.json'), false);
    assert.equal(pair.a.text('worlds/stay.json'), '{"entries":{"1":2}}');
    await stopAll(pair.a, pair.b);
});

test('the follower gets the leader\'s base, so a later pass led by the follower does not resurrect or duplicate anything', async () => {
    const pair = await createPair({ aFiles: { 'backgrounds/x.png': 'X' } });
    await connect(pair);
    assert.deepEqual(pair.b.state.get(`base:pair:${A_ID}`), pair.a.state.get(`base:pair:${B_ID}`));
    assert.ok(Object.keys(pair.b.state.get(`base:pair:${A_ID}`)).includes('backgrounds/x.png'));
    await stopAll(pair.a, pair.b);
});

test('two different edits of the same chat keep both versions: the newer wins in place, the older survives as a copy on both devices', async () => {
    const pair = await createPair({ aFiles: { 'chats/Alice/log.jsonl': 'v1' } });
    await connect(pair);
    pair.a.put('chats/Alice/log.jsonl', 'edited on PC', 5000);
    pair.b.put('chats/Alice/log.jsonl', 'edited on phone', 9000);
    const before = finishedRuns(pair.a);
    await pair.a.call('sync.run');
    await waitFor(() => finishedRuns(pair.a) > before);
    for (const device of [pair.a, pair.b]) {
        assert.equal(device.text('chats/Alice/log.jsonl'), 'edited on phone');
        const copy = device.paths().find(path => path.includes('(conflict'));
        assert.ok(copy, `${device.name} has a conflict copy`);
        assert.equal(device.text(copy), 'edited on PC');
    }
    await stopAll(pair.a, pair.b);
});

test('a chat that is open on the receiving device is left alone and simply retried on the next pass', async () => {
    let chatIsOpen = true;
    const network = createFakeNetwork();
    const clock = createFakeClock();
    const secret = generateSecret();
    const a = createFakeDevice({ id: A_ID, name: 'PC', network, clock, files: { 'chats/Alice/live.jsonl': 'from PC' }, overrides: { pairs: [{ id: B_ID, name: 'Phone', secret, pairedAt: 1 }] } });
    const b = createFakeDevice({ id: B_ID, name: 'Phone', network, clock, deferWrite: path => chatIsOpen && path.startsWith('chats/'), overrides: { pairs: [{ id: A_ID, name: 'PC', secret, pairedAt: 1 }] } });
    await connect({ a, b });
    assert.equal(b.text('chats/Alice/live.jsonl'), undefined, 'not written while open');
    assert.equal((await a.call('sync.status')).last.peers[0].counts.failed, 0, 'not an error');
    chatIsOpen = false;
    const before = finishedRuns(a);
    await a.call('sync.run');
    await waitFor(() => finishedRuns(a) > before);
    assert.equal(b.text('chats/Alice/live.jsonl'), 'from PC');
    await stopAll(a, b);
});

test('only categories enabled on BOTH devices are synced', async () => {
    const pair = await createPair({
        aFiles: { 'backgrounds/bg.png': 'BG', 'chats/Alice/c.jsonl': 'CHAT', 'characters/Bob.png': 'BOB' },
        bOptions: { categories: ['backgrounds', 'characters'] },
        aOptions: { categories: ['backgrounds', 'chats'] },
    });
    await connect(pair);
    assert.deepEqual(pair.b.paths(), ['backgrounds/bg.png']);
    await stopAll(pair.a, pair.b);
});

test('a file ST rewrites on import (the card gets a new create_date) does not bounce between the devices forever', async () => {
    const lossy = (path, text) => (path.startsWith('characters/') ? `${text}|imported` : null);
    const pair = await createPair({ aFiles: { 'characters/Bob.png': 'CARD' }, bOptions: { lossy } });
    await connect(pair);
    assert.equal(pair.b.text('characters/Bob.png'), 'CARD|imported', 'ST changed the bytes on import');
    pair.a.clearLog(); pair.b.clearLog();
    for (let round = 0; round < 3; round += 1) {
        const before = finishedRuns(pair.a);
        await pair.a.call('sync.run');
        await waitFor(() => finishedRuns(pair.a) > before);
    }
    assert.deepEqual(pair.a.log.filter(line => line.startsWith('write:')), [], 'nothing came back to the sender');
    assert.deepEqual(pair.b.log.filter(line => line.startsWith('write:')), [], 'nothing was rewritten on the receiver');
    pair.b.put('characters/Bob.png', 'CARD-V2-EDITED-ON-PHONE');
    const before = finishedRuns(pair.a);
    await pair.a.call('sync.run');
    await waitFor(() => finishedRuns(pair.a) > before);
    assert.equal(pair.a.text('characters/Bob.png'), 'CARD-V2-EDITED-ON-PHONE', 'a real edit still travels');
    await stopAll(pair.a, pair.b);
});

test('if the channel drops the devices reconnect by themselves after the pause and sync again', async () => {
    const pair = await createPair({ aFiles: { 'backgrounds/a.png': 'A' } });
    await connect(pair);
    const passesBefore = finishedRuns(pair.a);
    pair.network.dropAll('network dropped');
    await settle();
    assert.equal((await pair.a.call('sync.status')).connections[0].status, 'offline');
    pair.a.put('backgrounds/while-offline.png', 'NEW');
    await pair.clock.advance(9000);
    await waitFor(() => finishedRuns(pair.a) > passesBefore, { label: 'the pass after reconnecting' });
    assert.equal((await pair.a.call('sync.status')).connections[0].status, 'open');
    assert.equal(pair.b.text('backgrounds/while-offline.png'), 'NEW');
    await stopAll(pair.a, pair.b);
});

test('removing a pair forgets its secret, its base and closes the connection', async () => {
    const pair = await createPair({ aFiles: { 'backgrounds/a.png': 'A' } });
    await connect(pair);
    await pair.a.call('sync.pair.remove', { id: B_ID });
    assert.deepEqual(pairsOf(pair.a), []);
    assert.equal(pair.a.state.has(`base:pair:${B_ID}`), false);
    assert.deepEqual((await pair.a.call('sync.status')).connections, []);
    await stopAll(pair.a, pair.b);
});

test('the interface never receives pair secrets or the GitHub token', async () => {
    const pair = await createPair({ aOptions: { overrides: { github: { enabled: true, repository: 'o/r', token: 'ghp_SECRET_TOKEN' } } } });
    const shown = JSON.stringify(await pair.a.call('sync.status'));
    assert.doesNotMatch(shown, /ghp_SECRET_TOKEN/);
    assert.doesNotMatch(shown, new RegExp(pairsOf(pair.a)[0].secret));
    await stopAll(pair.a, pair.b);
});

// ── GitHub ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function githubDevice(files = {}, github = {}) {
    const network = createFakeNetwork();
    const clock = createFakeClock();
    const fake = createFakeGithub();
    const device = createFakeDevice({ id: A_ID, name: 'PC', network, clock, files, overrides: { github: { enabled: true, repository: 'o/r', token: 'secret-token', ...github } } });
    device.setHttp(fake.http);
    return { device, fake, clock };
}

test('a GitHub pass uploads only changed files in one commit and a repeat pass makes no uploads', async () => {
    const { device, fake } = githubDevice({ 'backgrounds/a.png': 'A', 'worlds/l.json': '{"entries":{}}' });
    const first = await device.call('sync.run', { target: 'github' });
    assert.equal(first.github.outcome, 'done');
    assert.equal(first.github.counts.pushed, 2);
    assert.deepEqual(Object.keys(fake.files()).sort(), ['backgrounds/a.png', 'worlds/l.json']);
    fake.calls.length = 0;
    const second = await device.call('sync.run', { target: 'github' });
    assert.equal(second.github.counts.pushed, 0);
    assert.equal(fake.calls.some(call => call.startsWith('POST')), false, 'no uploads');
    device.put('worlds/l.json', '{"entries":{"1":1}}');
    fake.calls.length = 0;
    await device.call('sync.run', { target: 'github' });
    assert.equal(fake.calls.filter(call => call === 'POST /git/blobs').length, 1);
    await device.core.stop();
});

test('a second device pulls what the first pushed through GitHub, and files above the size limit stay off it', async () => {
    const one = githubDevice({ 'backgrounds/small.png': 'tiny', 'backgrounds/huge.mp4': 'x'.repeat(2 * 1024 * 1024) }, { maxFileMb: 1 });
    await one.device.call('sync.run', { target: 'github' });
    assert.deepEqual(Object.keys(one.fake.files()), ['backgrounds/small.png']);
    const network = createFakeNetwork();
    const two = createFakeDevice({ id: B_ID, name: 'Phone', network, clock: one.clock, overrides: { github: { enabled: true, repository: 'o/r', token: 'secret-token' } } });
    two.setHttp(one.fake.http);
    const result = await two.call('sync.run', { target: 'github' });
    assert.equal(result.github.counts.pulled, 1);
    assert.equal(two.text('backgrounds/small.png'), 'tiny');
    await one.device.core.stop(); await two.core.stop();
});

test('an unconfigured or failing GitHub is reported, never thrown, and the token is testable', async () => {
    const { device } = githubDevice({}, { token: '' });
    assert.equal((await device.call('sync.run', { target: 'github' })).github.outcome, 'unconfigured');
    assert.equal((await device.call('sync.github.test')).ok, false);
    await device.call('sync.configure', { github: { token: 'secret-token' } });
    const tested = await device.call('sync.github.test');
    assert.equal(tested.ok, true, tested.message);
    device.setHttp(() => ({ status: 401, ok: false, text: '{"message":"Bad credentials"}', headers: {} }));
    const failed = await device.call('sync.run', { target: 'github' });
    assert.equal(failed.github.outcome, 'failed');
    assert.match(failed.github.errors[0], /token/);
    await device.core.stop();
});

test('configuring GitHub keeps the stored token unless a new one is given, and it can be cleared', async () => {
    const { device } = githubDevice();
    await device.call('sync.configure', { github: { repository: 'https://github.com/x/y', branch: 'dev', maxFileMb: 10 } });
    let config = device.settings.get('core.sync/config');
    assert.equal(config.github.token, 'secret-token');
    assert.equal(`${config.github.owner}/${config.github.repo}`, 'x/y');
    assert.equal(config.github.branch, 'dev');
    assert.equal(config.github.maxFileBytes, 10 * 1024 * 1024);
    await device.call('sync.configure', { github: {}, clearToken: true });
    config = device.settings.get('core.sync/config');
    assert.equal(config.github.token, '');
    await device.core.stop();
});
