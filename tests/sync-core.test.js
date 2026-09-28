import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeNetwork, createFakeClock, settle } from './helpers/fake-sync-network.js';
import { createFakeDevice } from './helpers/fake-sync-device.js';
import { createFakeGithub } from './helpers/fake-github.js';
import { generateSecret } from '../libraries/core/sync-secrets.js';
import { buildCardPng, fakeCard } from './helpers/fake-png.js';

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
    const pairingStatus = async device => (await device.call('sync.status')).pairing?.status;
    for (let attempt = 0; attempt < 200 && ((await pairingStatus(a)) !== 'done' || (await pairingStatus(b)) !== 'done'); attempt += 1) await settle(3);
    assert.equal(await pairingStatus(a), 'done');
    assert.equal(await pairingStatus(b), 'done');
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

test('the SAME character created independently on both devices (empty base, first meeting) settles instead of creating a duplicate — the main bug from SYNC_IMPROVEMENT_PLAN.md', async () => {
    // Real card-fingerprint.js semantics: only create_date/chat differ (exactly what ST itself rewrites on every PNG import), same
    // image bytes and same description/personality otherwise — computeCardFingerprint() must see these as the same character.
    const cardOnA = buildCardPng(fakeCard({ chat: 'Alice - 2026-01-01 @00h00m00s', create_date: '2026-01-01T00:00:00.000Z' }));
    const cardOnB = buildCardPng(fakeCard({ chat: 'Alice - 2026-03-14 @09h22m10s', create_date: '2026-03-14T09:22:10.000Z' }));
    assert.notEqual(Buffer.from(cardOnA).toString('base64'), Buffer.from(cardOnB).toString('base64'), 'sanity: the raw bytes actually differ');
    const pair = await createPair({ aFiles: { 'characters/Alice.png': cardOnA }, bFiles: { 'characters/Alice.png': cardOnB } });
    await connect(pair);
    const status = await pair.a.call('sync.status');
    assert.equal(status.last.peers[0].counts.conflicts, 0, 'no conflict — the plan settled on the key, not the raw bytes');
    assert.equal(status.last.peers[0].counts.pushed, 0, 'no transfer either way — the whole point of key-comparison');
    assert.equal(status.last.peers[0].counts.pulled, 0);
    assert.deepEqual(pair.a.paths(), ['characters/Alice.png'], 'no "(conflict ...)" duplicate appeared');
    assert.deepEqual(pair.b.paths(), ['characters/Alice.png']);
    assert.deepEqual(pair.a.log.filter(line => line.startsWith('write:')), [], 'each device kept its own bytes — neither was overwritten');
    assert.deepEqual(pair.b.log.filter(line => line.startsWith('write:')), []);
    await stopAll(pair.a, pair.b);
});

test('two GENUINELY different characters that happen to share a path at first meeting still conflict — key-comparison only settles the SAME character', async () => {
    const pair = await createPair({
        aFiles: { 'characters/Alice.png': buildCardPng(fakeCard({ description: 'Alice from PC.' })) },
        bFiles: { 'characters/Alice.png': buildCardPng(fakeCard({ description: 'A totally different card from Phone.' })) },
    });
    await connect(pair);
    const status = await pair.a.call('sync.status');
    assert.equal(status.last.peers[0].counts.conflicts, 1, 'different content under the same path is still a real conflict');
    await stopAll(pair.a, pair.b);
});

test('two genuinely different characters at first meeting: the loser goes to quarantine on its own device, not a duplicate in characters/ (ROADMAP 5.106б)', async () => {
    const cardOnA = buildCardPng(fakeCard({ description: 'Alice from PC.' }), { imageLabel: 'PC-ART' });
    const cardOnB = buildCardPng(fakeCard({ description: 'A totally different card from Phone.' }), { imageLabel: 'PHONE-ART' });
    const pair = await createPair({ aFiles: { 'characters/Alice.png': cardOnA }, bFiles: { 'characters/Alice.png': cardOnB } });
    await connect(pair);
    const status = await pair.a.call('sync.status');
    assert.equal(status.last.peers[0].counts.conflicts, 1);
    assert.equal(status.last.peers[0].counts.quarantined, 1);
    // A is the leader (lower id) with the earlier-created (lower) timestamp implicitly via file order — whichever loses, exactly
    // one device keeps a "(conflict ...)" file and NEITHER does, because this path is `characters/` (quarantine policy).
    assert.equal(pair.a.paths().some(path => path.includes('(conflict')), false, 'no conflict-copy file on A');
    assert.equal(pair.b.paths().some(path => path.includes('(conflict')), false, 'no conflict-copy file on B');
    assert.deepEqual(pair.a.paths(), ['characters/Alice.png']);
    assert.deepEqual(pair.b.paths(), ['characters/Alice.png']);
    // The loser's bytes survive SOMEWHERE — in the losing device's own quarantine, not lost outright.
    const quarantineKeys = device => [...device.state.keys()].filter(key => key.startsWith('quarantine:'));
    const loserQuarantineKeys = [...quarantineKeys(pair.a), ...quarantineKeys(pair.b)];
    assert.equal(loserQuarantineKeys.length, 1, 'exactly one side quarantined its losing version');
    await stopAll(pair.a, pair.b);
});

test('a first-meeting conflict on chats (copy policy, unaffected by 5.106б) still behaves exactly as before', async () => {
    const pair = await createPair({
        aFiles: { 'chats/Alice/log.jsonl': '{"a":"from phone"}' },
        bFiles: { 'chats/Alice/log.jsonl': '{"a":"from pc"}' },
    });
    await connect(pair);
    const status = await pair.a.call('sync.status');
    assert.equal(status.last.peers[0].counts.conflicts, 1);
    assert.equal(status.last.peers[0].counts.quarantined, 0, 'chats keep the old copy behavior — never quarantined');
    assert.ok(pair.a.paths().some(path => path.includes('(conflict')), 'a conflict-copy chat file was created, as always');
    await stopAll(pair.a, pair.b);
});

test('a mass character deletion (simulating a temporary empty ST listing) is blocked and reported, not propagated to the other device (ROADMAP 5.106в)', async () => {
    const aFiles = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`characters/c${i}.png`, `card${i}`]));
    const pair = await createPair({ aFiles });
    await connect(pair);
    assert.equal(pair.b.paths().length, 30, 'first pass copied everything over normally');
    // Simulate ST's /api/characters/all returning empty on A for one pass — indistinguishable from "the user deleted everything".
    for (const path of Object.keys(aFiles)) pair.a.store.delete(path);
    const before = finishedRuns(pair.a);
    await pair.a.call('sync.run');
    await waitFor(() => finishedRuns(pair.a) > before);
    const status = await pair.a.call('sync.status');
    assert.deepEqual(status.last.peers[0].needsConfirmation, ['characters']);
    assert.equal(pair.b.paths().length, 30, 'B keeps every character — nothing was deleted from it');
    assert.deepEqual(pair.b.log.filter(line => line.startsWith('remove:')), []);
    await stopAll(pair.a, pair.b);
});

test('when confirming the finished pass with the other device fails, lastSync is not advanced and a problem is shown — files are already synced, only the handshake is not (ROADMAP 5.106д)', async () => {
    const pair = await createPair({ aFiles: { 'backgrounds/a.png': 'A' } });
    await connect(pair);
    // Drop the channel the instant the leader reports 100% progress — the transfer itself is done, but the trailing `finish` RPC
    // (telling B the final base) has not gone out yet, so it fails exactly like a connection that dies right after the files land.
    // `events` is a plain array the fake device pushes directly to (its `publish` override bypasses the real event bus), so
    // catching this synchronously means intercepting the push itself.
    const originalPush = pair.a.events.push.bind(pair.a.events);
    let dropped = false;
    pair.a.events.push = entry => {
        // The very last per-file progress tick from inside runSync's own loop ({op: null, done === total}) — fires before
        // runAgainst's trailing writeState/flushCache/refreshStInterface and before runPeer calls `finish`, unlike the run()-level
        // `sync.progress` reset to null, which only happens once the WHOLE pass (finish included) is already done.
        const progress = entry[1]?.progress;
        if (!dropped && entry[0] === 'sync.progress' && progress?.phase === 'syncing' && progress.op === null) { dropped = true; pair.network.dropAll('dropped right after transfer'); }
        return originalPush(entry);
    };
    pair.a.put('backgrounds/b.png', 'B');
    const before = finishedRuns(pair.a);
    await pair.a.call('sync.run');
    await waitFor(() => finishedRuns(pair.a) > before);
    pair.a.events.push = originalPush;
    assert.equal(pair.b.text('backgrounds/b.png'), 'B', 'the file itself DID arrive — only the finish handshake failed');
    const status = await pair.a.call('sync.status');
    const connection = status.connections.find(item => item.name === 'Phone');
    assert.ok(connection.problem, 'a problem is shown, same channel as a connection failure');
    assert.match(connection.problem, /finish|confirm/i);
    await stopAll(pair.a, pair.b);
});

test('a file whose claimed hash does not match its real bytes is refused on write, not silently corrupted (ROADMAP 5.106е, Этап 4.3)', async () => {
    const pair = await createPair({ aFiles: { 'characters/x.png': 'REAL BYTES' } });
    // Poison A's hash cache BEFORE either core starts (its in-memory cache is loaded lazily on first use and then held for the
    // session — poisoning stored state afterwards would be invisible to an already-running core). A wrong hash under the file's
    // real, current stamp makes scanLocal trust it without rehashing — indistinguishable, from the receiving side, from bytes that
    // got corrupted somewhere on the wire.
    pair.a.state.set('cache', { 'characters/x.png': { stamp: 'v1', hash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' } });
    await connect(pair);
    const status = await pair.a.call('sync.status');
    assert.equal(status.last.peers[0].counts.failed, 1, 'the mismatch is a per-file failure, not silently accepted');
    assert.equal(pair.b.text('characters/x.png'), undefined, 'B never wrote the bad bytes at all');
    assert.ok(status.last.peers[0].errors.some(line => /integrity/i.test(line)), 'the error is legible, not a generic failure');
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

// ── Соединение: причина неудачи, ручной запуск, свой ретранслятор ─────────────────────────────────────────────────

test('pressing Sync now on a device with no open channel calls the other device instead of silently doing nothing', async () => {
    const pair = await createPair({ aFiles: { 'backgrounds/pc.png': 'PC' } });
    await pair.a.core.start();           // ноутбук уже открыт и слушает; телефон (B) только что открыл ST и НЕ стартовал соединение сам
    const result = await pair.b.call('sync.run');
    await waitFor(() => pair.b.text('backgrounds/pc.png') === 'PC', { label: 'the file to arrive after the manual sync' });
    assert.equal(result.peers[0].outcome, 'requested');
    assert.deepEqual((await pair.b.call('sync.status')).connections.map(item => item.status), ['open']);
    await stopAll(pair.a, pair.b);
});

test('when the direct channel never opens, the card gets a plain reason instead of a silent "offline"', async () => {
    const pair = await createPair({});
    await pair.a.core.start();           // B не запущен вовсе: предложение соединения останется без ответа
    const run = pair.a.call('sync.run');
    await settle();
    await pair.clock.advance(31000);
    await run;
    const status = await pair.a.call('sync.status');
    assert.equal(status.connections[0].status, 'offline');
    assert.match(status.connections[0].problem, /Could not connect/);
    assert.match(status.connections[0].problem, /TURN/);
    await stopAll(pair.a, pair.b);
});

test('a problem is forgotten as soon as the devices connect', async () => {
    const pair = await createPair({});
    await pair.a.core.start();
    const run = pair.a.call('sync.run');
    await settle();
    await pair.clock.advance(31000);
    await run;
    assert.ok((await pair.a.call('sync.status')).connections[0].problem);
    await pair.b.core.start();
    await pair.clock.advance(9000);
    await waitFor(() => finishedRuns(pair.a) >= 2, { label: 'the reconnect pass' });
    assert.equal((await pair.a.call('sync.status')).connections[0].problem, null);
    await stopAll(pair.a, pair.b);
});

test('a relay (TURN) server is used together with the default STUN ones, and its password never reaches the interface', async () => {
    const pair = await createPair({ aFiles: { 'backgrounds/a.png': 'A' } });
    for (const device of [pair.a, pair.b]) await device.call('sync.configure', { relay: { url: 'turn:turn.example.com:3478', username: 'me', credential: 'S3CRET-PW' } });
    await connect(pair);
    const servers = pair.network.opens.at(-1).iceServers;
    assert.ok(servers.some(server => String(server.urls).startsWith('stun:')), 'STUN is still there');
    assert.deepEqual(servers.at(-1), { urls: ['turn:turn.example.com:3478'], username: 'me', credential: 'S3CRET-PW' });
    const shown = JSON.stringify(await pair.a.call('sync.status'));
    assert.doesNotMatch(shown, /S3CRET-PW/);
    assert.match(shown, /"hasCredential":true/);
    await pair.a.call('sync.configure', { relay: { url: 'turn:turn.example.com:3478', username: 'me2' } });
    assert.equal(pair.a.settings.get('core.sync/config').iceServers[0].credential, 'S3CRET-PW', 'an empty password field keeps the saved one');
    await pair.a.call('sync.configure', { relay: { url: '' } });
    assert.equal(pair.a.settings.get('core.sync/config').iceServers, null, 'an empty address removes the relay');
    await stopAll(pair.a, pair.b);
});

// ── Синхронизация при загрузке страницы ─────────────────────────────────────────────────────────────────────────

test('planLoadSync says whether there is anything to sync at page load, and respects the switch', async () => {
    const lonely = createFakeDevice({ id: A_ID, name: 'PC', network: createFakeNetwork(), clock: createFakeClock() });
    assert.equal(await lonely.core.planLoadSync(), false, 'no pairs, nothing enabled');
    await lonely.call('sync.configure', { github: { enabled: true, repository: 'o/r', token: 't' } });
    assert.equal(await lonely.core.planLoadSync(), false, 'GitHub enabled but not set to run in the background');
    await lonely.call('sync.configure', { github: { auto: true } });
    assert.equal(await lonely.core.planLoadSync(), true);
    await lonely.call('sync.configure', { syncOnLoad: false });
    assert.equal(await lonely.core.planLoadSync(), false, 'the page-load switch is off');
    assert.deepEqual(await lonely.core.runOnLoad(), { outcome: 'skipped' });
    await stopAll(lonely);

    const pair = await createPair({});
    assert.equal(await pair.a.core.planLoadSync(), true, 'a paired device with automatic sync on');
    await pair.a.call('sync.configure', { autoSync: false });
    assert.equal(await pair.a.core.planLoadSync(), false);
    await stopAll(pair.a, pair.b);
});

test('the page-load pass connects to the other device (waiting only briefly), syncs, and reports itself as a "load" pass', async () => {
    const pair = await createPair({ aFiles: { 'backgrounds/a.png': 'A' } });
    await pair.a.core.start();
    await pair.b.core.start();
    await pair.b.core.runOnLoad();
    await waitFor(() => pair.b.text('backgrounds/a.png') === 'A', { label: 'the file after the page-load pass' });
    const finished = pair.b.events.filter(([event]) => event === 'sync.finished').at(-1)[1];
    assert.equal(finished.target, 'load');
    await stopAll(pair.a, pair.b);
});

test('when the other device is not online the page-load pass gives up after a short wait instead of holding the page', async () => {
    const pair = await createPair({});
    await pair.a.core.start();
    const run = pair.a.core.runOnLoad();
    await settle();
    await pair.clock.advance(9000);
    const result = await run;
    assert.equal(result.target, 'load');
    assert.equal(result.peers.length, 0);
    await stopAll(pair.a, pair.b);
});

test('starting the core no longer runs a background pass by itself — the page-load pass is the one place that does', async () => {
    const network = createFakeNetwork();
    const clock = createFakeClock();
    const fake = createFakeGithub();
    const device = createFakeDevice({ id: A_ID, name: 'PC', network, clock, files: { 'a.png': 'A' }, overrides: { github: { enabled: true, repository: 'o/r', token: 'secret-token', auto: true } } });
    device.setHttp(fake.http);
    await device.core.start();
    await settle();
    assert.equal(fake.calls.length, 0, 'nothing was sent just because the core started');
    await device.core.runOnLoad();
    assert.ok(fake.calls.length > 0);
    await stopAll(device);
});

test('receiving presets makes the device tell the interface a reload is needed — on the receiving side, whichever role it has', async () => {
    const pair = await createPair({ aFiles: { 'presets/openai/My Prompts.json': '{"prompts":[]}', 'backgrounds/a.png': 'A' } });
    await connect(pair);
    assert.equal(pair.b.text('presets/openai/My Prompts.json'), '{"prompts":[]}');
    await waitFor(() => pair.b.events.some(([event]) => event === 'sync.reloadHint'), { label: 'the reload hint on the receiver' });
    assert.equal((await pair.b.call('sync.status')).reloadHint, true);
    assert.equal(pair.a.events.some(([event]) => event === 'sync.reloadHint'), false, 'the sender changed nothing locally');
    assert.equal((await pair.a.call('sync.status')).reloadHint, false);
    await stopAll(pair.a, pair.b);
});
