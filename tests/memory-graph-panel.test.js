import test from 'node:test';
import assert from 'node:assert/strict';
import { pixelToRegion, regionLayoutPosition, packOffsetInRegion, regionWedgePath, renderRegionBackgroundSvg } from '../cores/ui/memory-graph-panel.js';

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

test('regionLayoutPosition() spreads multiple nodes in the SAME region across different positions, so they do not overlap', () => {
    const first = regionLayoutPosition(1, 1, { indexInRegion: 0 });
    const middle = regionLayoutPosition(1, 1, { indexInRegion: 1 });
    const last = regionLayoutPosition(1, 1, { indexInRegion: 2 });
    assert.notDeepEqual(first, middle);
    assert.notDeepEqual(middle, last);
    assert.notDeepEqual(first, last);
});

test('regionLayoutPosition() ignores countInRegion entirely — an EARLIER node\'s position must not shift when a LATER node joins the same region', () => {
    // Старый угловой веер пересчитывал ВСЕ позиции при каждой вставке
    // (раствор веера зависел от countInRegion) — новая раскладка кольцами
    // не должна: у ноды #0 позиция одна и та же, сколько бы соседей потом
    // ни добавилось.
    const withOneNeighbour = regionLayoutPosition(2, 0, { indexInRegion: 0, countInRegion: 2 });
    const withManyNeighbours = regionLayoutPosition(2, 0, { indexInRegion: 0, countInRegion: 20 });
    assert.deepEqual(withOneNeighbour, withManyNeighbours);
});

test('regionLayoutPosition() places node #0 sixteen pixels out along the SAME ray as the region\'s own anchor point (no angular deviation for the default case)', () => {
    const solo = regionLayoutPosition(0, 0, { indexInRegion: 0 });
    const alsoSolo = regionLayoutPosition(0, 0, {}); // default indexInRegion
    assert.deepEqual(solo, alsoSolo);
});

// --- packOffsetInRegion() — the two hard distances the user specified explicitly:
// "минимальная дистанция от точки привязки - 16 пикселей, минимальная
// дистанция до любой другой точки - 8 пикселей" ----------------------------

test('packOffsetInRegion() keeps EVERY node at least 16px from the anchor point (radius never below minAnchorDistance)', () => {
    for (let i = 0; i < 60; i += 1) {
        const { radius } = packOffsetInRegion(i);
        assert.ok(radius >= 16 - 1e-9, `index ${i} got radius ${radius}, below the 16px floor`);
    }
});

test('packOffsetInRegion() keeps every PAIR of nodes at least 8px apart, up to a full region (23 = maxNodesPerRegion)', () => {
    const points = Array.from({ length: 23 }, (_, i) => {
        const { radius, angle } = packOffsetInRegion(i);
        return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
    });
    for (let i = 0; i < points.length; i += 1) {
        for (let j = i + 1; j < points.length; j += 1) {
            const dx = points[i].x - points[j].x;
            const dy = points[i].y - points[j].y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            assert.ok(distance >= 8 - 1e-9, `nodes #${i} and #${j} are only ${distance}px apart`);
        }
    }
});

test('packOffsetInRegion() honors custom minAnchorDistance/minPointDistance overrides', () => {
    const { radius } = packOffsetInRegion(0, { minAnchorDistance: 100, minPointDistance: 50, maxAnchorDistance: 200 });
    assert.equal(radius, 100);
});

test('packOffsetInRegion() never places a node beyond maxAnchorDistance (30px default), even far past a full region\'s worth of nodes', () => {
    for (let i = 0; i < 60; i += 1) {
        const { radius } = packOffsetInRegion(i);
        assert.ok(radius <= 30 + 1e-9, `index ${i} got radius ${radius}, past the 30px ceiling`);
    }
});

// --- regionWedgePath() / renderRegionBackgroundSvg() — the faint per-region background fill ---

test('regionWedgePath() returns a well-formed SVG path (starts with M, ends with Z) for every one of the 15 regions', () => {
    for (let sector = 0; sector < 5; sector += 1) {
        for (let ring = 0; ring < 3; ring += 1) {
            const d = regionWedgePath(sector, ring);
            assert.ok(d.startsWith('M '), `region ${sector}:${ring} path did not start with a moveto: ${d}`);
            assert.ok(d.trim().endsWith('Z'), `region ${sector}:${ring} path did not close: ${d}`);
        }
    }
});

test('regionWedgePath() for ring 0 starts exactly at the model-space center (a solid wedge, no degenerate zero-radius arc)', () => {
    const d = regionWedgePath(0, 0, { maxRadius: 240 });
    assert.ok(d.startsWith('M 240.00,240.00'), `expected ring 0 to start at (240,240) — the center in a 240-radius model space: ${d}`);
});

test('renderRegionBackgroundSvg() emits exactly 15 path cells (5 sectors x 3 rings) inside a single <svg>', () => {
    const svg = renderRegionBackgroundSvg();
    assert.ok(svg.startsWith('<svg'));
    const pathCount = (svg.match(/<path /g) ?? []).length;
    assert.equal(pathCount, 15);
});

test('renderRegionBackgroundSvg() sizes the <svg> in EXPLICIT pixels equal to 2*maxRadius, not a percentage — so 1 SVG unit stays exactly 1 CSS px for the live pan/zoom transform to scale correctly', () => {
    const svg = renderRegionBackgroundSvg({ maxRadius: 300 });
    assert.ok(svg.includes('width="600"'), svg);
    assert.ok(svg.includes('height="600"'), svg);
    assert.ok(svg.includes('viewBox="0 0 600 600"'), svg);
    assert.ok(!svg.includes('width="100%"'), 'must not fall back to percentage sizing');
});
