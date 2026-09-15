import test from 'node:test';
import assert from 'node:assert/strict';
import {
    FULL_VIEWPORT_RECT, viewportZoomScale, clampViewportRect, computeZoomedViewportRect,
    computePannedViewportRect, computeQuadtreeLevel, listVisibleTiles, tileCacheKey,
    computeTileSourcePixelRect,
} from '../libraries/shared/map-viewport.js';

test('viewportZoomScale is 1 at FULL_VIEWPORT_RECT and grows as the rect shrinks', () => {
    assert.equal(viewportZoomScale(FULL_VIEWPORT_RECT), 1);
    assert.equal(viewportZoomScale({ minX: 0.25, minY: 0.25, maxX: 0.75, maxY: 0.75 }), 2, 'half-size rect = 2x zoom');
    assert.equal(viewportZoomScale({ minX: 0, minY: 0, maxX: 0.25, maxY: 0.25 }), 4);
});

test('clampViewportRect preserves size while repositioning a rect that drifted outside the unit square', () => {
    const clamped = clampViewportRect({ minX: -0.1, minY: 0.9, maxX: 0.4, maxY: 1.4 });
    assert.ok(Math.abs((clamped.maxX - clamped.minX) - 0.5) < 1e-9, 'size unchanged');
    assert.ok(Math.abs((clamped.maxY - clamped.minY) - 0.5) < 1e-9);
    assert.ok(clamped.minX >= 0 && clamped.maxX <= 1 + 1e-9);
    assert.ok(clamped.minY >= 0 && clamped.maxY <= 1 + 1e-9);
});

test('clampViewportRect leaves an already-valid rect untouched', () => {
    const rect = { minX: 0.2, minY: 0.3, maxX: 0.6, maxY: 0.7 };
    assert.deepEqual(clampViewportRect(rect), rect);
});

test('computeZoomedViewportRect zooming in keeps the pivot at the same relative position within the new rect', () => {
    const pivot = { x: 0.3, y: 0.3 };
    const zoomed = computeZoomedViewportRect(FULL_VIEWPORT_RECT, 2, pivot, { minZoom: 1, maxZoom: 16 });
    assert.equal(viewportZoomScale(zoomed), 2);
    const relX = (pivot.x - zoomed.minX) / (zoomed.maxX - zoomed.minX);
    const relY = (pivot.y - zoomed.minY) / (zoomed.maxY - zoomed.minY);
    assert.ok(Math.abs(relX - 0.3) < 1e-9, 'pivot stays at 30% across the new rect horizontally');
    assert.ok(Math.abs(relY - 0.3) < 1e-9);
});

test('computeZoomedViewportRect clamps at maxZoom instead of zooming past it', () => {
    const zoomed = computeZoomedViewportRect(FULL_VIEWPORT_RECT, 1000, { x: 0.5, y: 0.5 }, { minZoom: 1, maxZoom: 16 });
    assert.equal(viewportZoomScale(zoomed), 16);
});

test('computeZoomedViewportRect zooming out from an already-zoomed rect clamps at minZoom, not below it', () => {
    const zoomedIn = computeZoomedViewportRect(FULL_VIEWPORT_RECT, 4, { x: 0.5, y: 0.5 }, { minZoom: 1, maxZoom: 16 });
    const zoomedOut = computeZoomedViewportRect(zoomedIn, 0.01, { x: 0.5, y: 0.5 }, { minZoom: 1, maxZoom: 16 });
    assert.equal(viewportZoomScale(zoomedOut), 1);
});

test('computePannedViewportRect moves the rect by the given delta and clamps it back inside the unit square', () => {
    const rect = { minX: 0.4, minY: 0.4, maxX: 0.6, maxY: 0.6 };
    const panned = computePannedViewportRect(rect, 0.1, -0.1);
    assert.ok(Math.abs(panned.minX - 0.5) < 1e-9);
    assert.ok(Math.abs(panned.minY - 0.3) < 1e-9);
    assert.ok(Math.abs((panned.maxX - panned.minX) - 0.2) < 1e-9, 'size unchanged by a pan');

    const pannedPastEdge = computePannedViewportRect(rect, 10, 10);
    assert.equal(pannedPastEdge.maxX, 1, 'clamped to the right edge, not pushed off it');
    assert.equal(pannedPastEdge.maxY, 1);
});

test('computeQuadtreeLevel rounds log2(zoomScale), clamped to [0, maxLevel]', () => {
    assert.equal(computeQuadtreeLevel(1, 4), 0);
    assert.equal(computeQuadtreeLevel(2, 4), 1);
    assert.equal(computeQuadtreeLevel(16, 4), 4);
    assert.equal(computeQuadtreeLevel(1000, 4), 4, 'clamped at maxLevel even for an absurd zoom scale');
    assert.equal(computeQuadtreeLevel(0.1, 4), 0, 'below 1x zoom never goes negative');
});

test('listVisibleTiles at level 0 always returns exactly the one whole-image tile', () => {
    const tiles = listVisibleTiles({ minX: 0.4, minY: 0.4, maxX: 0.6, maxY: 0.6 }, 0);
    assert.deepEqual(tiles, [{ level: 0, col: 0, row: 0, rect: { minX: 0, minY: 0, maxX: 1, maxY: 1 } }]);
});

test('listVisibleTiles at a deeper level returns only the tiles the viewport actually overlaps, not the whole grid', () => {
    // Level 2 = 4x4 grid, each tile 0.25 wide. A viewport covering [0.3,0.6) should touch columns 1-2.
    const tiles = listVisibleTiles({ minX: 0.3, minY: 0.3, maxX: 0.6, maxY: 0.6 }, 2);
    const cols = [...new Set(tiles.map(t => t.col))].sort();
    const rows = [...new Set(tiles.map(t => t.row))].sort();
    assert.deepEqual(cols, [1, 2]);
    assert.deepEqual(rows, [1, 2]);
    assert.equal(tiles.length, 4, '2x2 tiles, not all 16 of the level-2 grid');
});

test('listVisibleTiles never returns a tile outside the grid, even for a viewport pinned to the very edge', () => {
    const tiles = listVisibleTiles({ minX: 0.9, minY: 0.9, maxX: 1, maxY: 1 }, 2);
    for (const tile of tiles) {
        assert.ok(tile.col >= 0 && tile.col < 4);
        assert.ok(tile.row >= 0 && tile.row < 4);
    }
});

test('tileCacheKey is deterministic and distinct per (assetId, level, col, row, algorithmVersion)', () => {
    assert.equal(tileCacheKey('img1', 2, 1, 3, 1), tileCacheKey('img1', 2, 1, 3, 1));
    assert.notEqual(tileCacheKey('img1', 2, 1, 3, 1), tileCacheKey('img1', 2, 1, 4, 1));
    assert.notEqual(tileCacheKey('img1', 2, 1, 3, 1), tileCacheKey('img2', 2, 1, 3, 1));
});

test('tileCacheKey changes when algorithmVersion changes — a bumped version must invalidate every previously-cached tile (owner: a fixed seam bug kept showing the OLD, still-buggy cached tiles because the cache key never changed)', () => {
    assert.notEqual(tileCacheKey('img1', 2, 1, 3, 1), tileCacheKey('img1', 2, 1, 3, 2));
});

test('computeTileSourcePixelRect: every field is a real INTEGER for a boundary that does NOT divide evenly — this is what actually matters, not just that the (still-fractional) math happens to agree; cropImagePixels() rounds its own x/y/width/height internally, so a caller (like this one, historically) computing padding from UNROUNDED values silently disagreed with where the crop actually landed, by a fraction of a source pixel — multiplied by the upscale factor, several real pixels of seam', () => {
    // 803px wide source, level-1 boundary at 803*0.5 = 401.5 — exactly the
    // kind of fractional boundary that exposed the seam bug live.
    const rect = computeTileSourcePixelRect({ minX: 0, minY: 0, maxX: 0.5, maxY: 1 }, 803, 100);
    assert.ok(Number.isInteger(rect.x) && Number.isInteger(rect.y) && Number.isInteger(rect.width) && Number.isInteger(rect.height));
});

test('computeTileSourcePixelRect: two horizontally-adjacent tiles at a boundary that does NOT divide evenly share the EXACT same integer edge pixel — no gap, no overlap', () => {
    const left = computeTileSourcePixelRect({ minX: 0, minY: 0, maxX: 0.5, maxY: 1 }, 803, 100);
    const right = computeTileSourcePixelRect({ minX: 0.5, minY: 0, maxX: 1, maxY: 1 }, 803, 100);
    assert.equal(left.x + left.width, right.x, 'left tile\'s right edge must land EXACTLY where the right tile\'s left edge starts');
    assert.equal(left.x + left.width + right.width, 803, 'together they must cover the WHOLE source width, no pixel lost or double-counted');
});

test('computeTileSourcePixelRect: same for a vertical boundary and an odd source height', () => {
    const top = computeTileSourcePixelRect({ minX: 0, minY: 0, maxX: 1, maxY: 0.5 }, 100, 601);
    const bottom = computeTileSourcePixelRect({ minX: 0, minY: 0.5, maxX: 1, maxY: 1 }, 100, 601);
    assert.equal(top.y + top.height, bottom.y);
    assert.equal(top.y + top.height + bottom.height, 601);
});

test('computeTileSourcePixelRect on the full 0..1 rect returns the exact whole image', () => {
    const rect = computeTileSourcePixelRect(FULL_VIEWPORT_RECT, 803, 601);
    assert.deepEqual(rect, { x: 0, y: 0, width: 803, height: 601 });
});
