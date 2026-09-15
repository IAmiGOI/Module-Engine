import test from 'node:test';
import assert from 'node:assert/strict';
import { computeVisibleRange, reconcileMeasuredHeight } from '../libraries/shared/chat-viewport-math.js';

function order(n) {
    return Array.from({ length: n }, (_, i) => String(i));
}

test('empty chat — visible range is empty, total height zero', () => {
    const range = computeVisibleRange({ order: [], heights: new Map(), scrollTop: 0, viewportHeight: 600 });
    assert.deepEqual(range, { startIndex: 0, endIndex: 0, offsetTop: 0, totalHeight: 0 });
});

test('scrolled to the very top — first rows visible, offsetTop is 0', () => {
    const heights = new Map(order(50).map(id => [id, 100]));
    // viewportHeight=250 deliberately avoids landing exactly on a row boundary (300 would be ambiguous: row 3 starts exactly at the bottom edge).
    const range = computeVisibleRange({ order: order(50), heights, scrollTop: 0, viewportHeight: 250, overscan: 0 });
    assert.equal(range.startIndex, 0);
    assert.equal(range.offsetTop, 0);
    assert.equal(range.endIndex, 3); // rows 0,1,2 fully cover [0,300), which is past the 250px viewport
    assert.equal(range.totalHeight, 5000);
});

test('scrolled into the middle — window follows scrollTop, not index 0', () => {
    const heights = new Map(order(100).map(id => [id, 50]));
    // Row i spans [i*50, i*50+50). scrollTop=1000 lands exactly on row 20's start.
    const range = computeVisibleRange({ order: order(100), heights, scrollTop: 1000, viewportHeight: 200, overscan: 0 });
    assert.equal(range.startIndex, 20);
    assert.equal(range.offsetTop, 1000);
});

test('overscan extends the window on both sides, clamped to the list bounds', () => {
    const heights = new Map(order(100).map(id => [id, 50]));
    const range = computeVisibleRange({ order: order(100), heights, scrollTop: 1000, viewportHeight: 200, overscan: 5 });
    assert.equal(range.startIndex, 15); // 20 - 5
    assert.ok(range.endIndex > 20);
});

test('overscan near the start clamps to zero instead of going negative', () => {
    const heights = new Map(order(20).map(id => [id, 50]));
    const range = computeVisibleRange({ order: order(20), heights, scrollTop: 0, viewportHeight: 100, overscan: 10 });
    assert.equal(range.startIndex, 0);
    assert.equal(range.offsetTop, 0);
});

test('overscan near the end clamps to the list length instead of overshooting', () => {
    const heights = new Map(order(20).map(id => [id, 50]));
    const range = computeVisibleRange({ order: order(20), heights, scrollTop: 900, viewportHeight: 200, overscan: 50 });
    assert.equal(range.endIndex, 20);
});

test('unmeasured rows fall back to estimatedHeight, not zero — an empty heights map does not collapse the whole list into one point', () => {
    const range = computeVisibleRange({ order: order(10), heights: new Map(), scrollTop: 0, viewportHeight: 100, estimatedHeight: 80, overscan: 0 });
    assert.equal(range.totalHeight, 800);
    assert.ok(range.endIndex >= 1 && range.endIndex < 10, 'only a few estimated-height rows should be considered visible, not the entire list');
});

test('one giant row taller than the whole viewport is still the single visible row, not zero rows', () => {
    const heights = new Map([['0', 5000]]);
    const range = computeVisibleRange({ order: ['0'], heights, scrollTop: 0, viewportHeight: 600, overscan: 0 });
    assert.deepEqual(range, { startIndex: 0, endIndex: 1, offsetTop: 0, totalHeight: 5000 });
});

test('reconcileMeasuredHeight returns a new Map with the entry updated, leaving other entries intact', () => {
    const heights = new Map([['0', 100], ['1', 50]]);
    const next = reconcileMeasuredHeight(heights, '1', 120);
    assert.notEqual(next, heights, 'must not mutate the map in place — the caller feeds this into a signal');
    assert.equal(next.get('0'), 100);
    assert.equal(next.get('1'), 120);
});

test('reconcileMeasuredHeight returns null when the rounded height did not actually change — avoids re-triggering a range recompute on ResizeObserver sub-pixel noise', () => {
    const heights = new Map([['0', 100]]);
    assert.equal(reconcileMeasuredHeight(heights, '0', 100.4), null);
    assert.notEqual(reconcileMeasuredHeight(heights, '0', 101), null);
});
