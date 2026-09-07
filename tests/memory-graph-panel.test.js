import test from 'node:test';
import assert from 'node:assert/strict';
import { pixelToRegion, regionLayoutPosition } from '../cores/ui/memory-graph-panel.js';

// --- pixelToRegion() / regionLayoutPosition() — geometry round-trips ------

test('regionLayoutPosition() then pixelToRegion() round-trips back to the same sector/ring, for every one of the 15 regions', () => {
    for (let sector = 0; sector < 5; sector += 1) {
        for (let ring = 0; ring < 3; ring += 1) {
            const { x, y } = regionLayoutPosition(sector, ring, {});
            const back = pixelToRegion(x, y, {});
            assert.deepEqual(back, { sector, ring }, `region ${sector}:${ring} -> (${x},${y}) -> ${back.sector}:${back.ring}`);
        }
    }
});

test('pixelToRegion() clamps the CENTER point (0,0) to ring 0 without dividing by zero', () => {
    const result = pixelToRegion(0, 0, {});
    assert.equal(result.ring, 0);
    assert.ok(result.sector >= 0 && result.sector < 5);
});

test('pixelToRegion() clamps a point far beyond maxRadius to the OUTERMOST ring, not out of range', () => {
    const result = pixelToRegion(0, 100000, { maxRadius: 240 });
    assert.equal(result.ring, 2);
});

test('pixelToRegion() handles negative dx/dy (bottom-left quadrant) without going out of sector range', () => {
    const result = pixelToRegion(-100, -100, { maxRadius: 240 });
    assert.ok(result.sector >= 0 && result.sector < 5);
    assert.ok(result.ring >= 0 && result.ring < 3);
});

test('pixelToRegion() at a sector boundary angle resolves to exactly ONE of the two adjacent sectors, never something else', () => {
    // Sector 0 spans [-90°, -18°) in screen terms (sector 0 centered at top,
    // -90°); the boundary between sector 0 and sector 1 sits at angle 0
    // (straight right, "3 o'clock") after the same -90° offset used by
    // regionLayoutPosition(). A point exactly on that boundary must land
    // cleanly in one sector, not throw or wrap to something outside [0,5).
    const result = pixelToRegion(240, 0, { maxRadius: 240 });
    assert.ok(result.sector === 0 || result.sector === 1, `boundary point landed in sector ${result.sector}`);
});

test('pixelToRegion() at a ring boundary radius resolves to exactly ONE of the two adjacent rings', () => {
    const boundaryRadius = (240 * 1) / 3; // exact ring0/ring1 boundary
    const result = pixelToRegion(boundaryRadius, 0, { maxRadius: 240 });
    assert.ok(result.ring === 0 || result.ring === 1);
});

test('regionLayoutPosition() fans multiple nodes in the SAME region across different angles, so they do not overlap', () => {
    const first = regionLayoutPosition(1, 1, { indexInRegion: 0, countInRegion: 3 });
    const middle = regionLayoutPosition(1, 1, { indexInRegion: 1, countInRegion: 3 });
    const last = regionLayoutPosition(1, 1, { indexInRegion: 2, countInRegion: 3 });
    assert.notDeepEqual(first, middle);
    assert.notDeepEqual(middle, last);
    assert.notDeepEqual(first, last);
});

test('regionLayoutPosition() places a SINGLE node at the exact angular center of its region (no jitter needed when alone)', () => {
    const solo = regionLayoutPosition(0, 0, { indexInRegion: 0, countInRegion: 1 });
    const alsoSolo = regionLayoutPosition(0, 0, {}); // default indexInRegion/countInRegion
    assert.deepEqual(solo, alsoSolo);
});
