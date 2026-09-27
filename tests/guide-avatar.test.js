import test from 'node:test';
import assert from 'node:assert/strict';
import { anyDown, nextHealthStatus, tierFromHours, matchChibiPose, resolveAvatar, avatarFileFor, STATUS_HOLD_MS } from '../libraries/core/guide-avatar.js';

// --- Здоровье ME: red / green / white ---

test('anyDown() is true only for a real "down" worker — "degraded" does not count (owner: too noisy otherwise)', () => {
    assert.equal(anyDown([{ state: 'up' }, { state: 'degraded' }]), false);
    assert.equal(anyDown([{ state: 'up' }, { state: 'down' }]), true);
    assert.equal(anyDown([]), false);
    assert.equal(anyDown(undefined), false);
});

test('nextHealthStatus(): red while down, green for exactly the hold window right after recovery, then white — never green from a generation succeeding, only from a down worker recovering', () => {
    let state = null;
    state = nextHealthStatus(state, { workers: [{ state: 'up' }], now: 0 });
    assert.equal(state.status, 'white', 'nothing ever went down — no green either');

    state = nextHealthStatus(state, { workers: [{ state: 'down' }], now: 1000 });
    assert.equal(state.status, 'red');

    state = nextHealthStatus(state, { workers: [{ state: 'up' }], now: 2000 });
    assert.equal(state.status, 'green', 'the exact instant it recovers');
    assert.equal(state.recoveredAt, 2000);

    state = nextHealthStatus(state, { workers: [{ state: 'up' }], now: 2000 + STATUS_HOLD_MS - 1 });
    assert.equal(state.status, 'green', 'still inside the hold window');

    state = nextHealthStatus(state, { workers: [{ state: 'up' }], now: 2000 + STATUS_HOLD_MS });
    assert.equal(state.status, 'white', 'hold window elapsed — settles back to white on its own, no separate timer needed');
});

test('nextHealthStatus(): going down again while still green resets straight back to red, dropping the old recovery', () => {
    let state = nextHealthStatus(null, { workers: [{ state: 'down' }], now: 0 });
    state = nextHealthStatus(state, { workers: [{ state: 'up' }], now: 100 }); // recovered, now green
    assert.equal(state.status, 'green');
    state = nextHealthStatus(state, { workers: [{ state: 'down' }], now: 200 }); // down again before the hold elapsed
    assert.equal(state.status, 'red');
    assert.equal(state.recoveredAt, null, 'no longer "just recovered" — it broke again');
});

// --- Тир одежды ---

test('tierFromHours(): three tiers from cumulative hours, thresholds are [N, 2N]', () => {
    assert.equal(tierFromHours(0, [5, 10]), 1);
    assert.equal(tierFromHours(4.9, [5, 10]), 1);
    assert.equal(tierFromHours(5, [5, 10]), 2);
    assert.equal(tierFromHours(9.9, [5, 10]), 2);
    assert.equal(tierFromHours(10, [5, 10]), 3);
    assert.equal(tierFromHours(1000, [5, 10]), 3);
});

// --- Чиби по ключевым словам в её последнем CoT ---

test('matchChibiPose(): first configured pose whose keyword appears (case-insensitive) in the raw last-reply text wins; no config or no match — null', () => {
    const poses = [{ id: 'music', keywords: ['song', 'track'] }, { id: 'sleepy', keywords: ['tired', 'yawn'] }];
    assert.equal(matchChibiPose('<think>I should mention a great TRACK here</think>Here you go.', poses), 'music');
    assert.equal(matchChibiPose('so tired right now', poses), 'sleepy');
    assert.equal(matchChibiPose('nothing relevant here', poses), null);
    assert.equal(matchChibiPose('anything', []), null);
    assert.equal(matchChibiPose('anything', undefined), null);
});

test('matchChibiPose(): a "pattern" entry matches as a regex, case-insensitively, independent of "keywords"', () => {
    const poses = [{ id: 'excited', pattern: '!{2,}' }];
    assert.equal(matchChibiPose('Yes!! Absolutely!!', poses), 'excited');
    assert.equal(matchChibiPose('Yes.', poses), null);
});

// --- Свод: приоритет ---

test('resolveAvatar(): a matched chibi pose wins over white/normal, but red/green health REPLACES the matched pose with chibi angry/happy — the owner\'s "use them as statuses"', () => {
    const chibiPoses = [{ id: 'music', keywords: ['song'] }];
    assert.deepEqual(resolveAvatar({ health: 'white', lastCoT: 'a nice song', chibiPoses, tier: 1, nekoUnlocked: false }), { track: 'chibi', id: 'music' });
    assert.deepEqual(resolveAvatar({ health: 'red', lastCoT: 'a nice song', chibiPoses, tier: 1, nekoUnlocked: false }), { track: 'chibi', id: 'angry' });
    assert.deepEqual(resolveAvatar({ health: 'green', lastCoT: 'a nice song', chibiPoses, tier: 1, nekoUnlocked: false }), { track: 'chibi', id: 'happy' });
});

test('resolveAvatar(): no chibi match — plain status image for red/green, otherwise the normal tier (+ neko flag carried through, not resolved here)', () => {
    const chibiPoses = [{ id: 'music', keywords: ['song'] }];
    assert.deepEqual(resolveAvatar({ health: 'red', lastCoT: 'nothing musical', chibiPoses, tier: 2, nekoUnlocked: false }), { track: 'status', id: 'red' });
    assert.deepEqual(resolveAvatar({ health: 'green', lastCoT: 'nothing musical', chibiPoses, tier: 2, nekoUnlocked: false }), { track: 'status', id: 'green' });
    assert.deepEqual(resolveAvatar({ health: 'white', lastCoT: 'nothing musical', chibiPoses, tier: 2, nekoUnlocked: true }), { track: 'normal', tier: 2, neko: true });
});

// --- Путь к файлу ---

test('avatarFileFor(): status and chibi map straight to their file; normal picks the owner\'s tier filenames, neko-prefixed when unlocked', () => {
    assert.equal(avatarFileFor({ track: 'status', id: 'red' }), 'status-red.png');
    assert.equal(avatarFileFor({ track: 'status', id: 'green' }), 'status-green.png');
    assert.equal(avatarFileFor({ track: 'chibi', id: 'angry' }), 'chibi-angry.png');
    assert.equal(avatarFileFor({ track: 'chibi', id: 'music' }), 'chibi-music.png');
    assert.equal(avatarFileFor({ track: 'normal', tier: 1, neko: false }), 'tier-1-full.png');
    assert.equal(avatarFileFor({ track: 'normal', tier: 2, neko: false }), 'tier-1-shorts.png');
    assert.equal(avatarFileFor({ track: 'normal', tier: 3, neko: true }), 'neko-tier-1-topless.png');
});
