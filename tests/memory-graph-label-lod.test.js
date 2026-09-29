import test from 'node:test';
import assert from 'node:assert/strict';
import { regionLabelStyle, labelTier, chooseNodeLabels, ZOOM_TIERS } from '../cores/ui/memory-graph/label-lod.js';

const item = (id, x, y, tier, weight = 0, label = 'Some node') => ({ id, label, x, y, radius: 6, tier, weight });

test('a region name is big and bright when zoomed out, fades as you zoom in, and is gone up close', () => {
    const far = regionLabelStyle(0.4);
    const mid = regionLabelStyle(1.2);
    const near = regionLabelStyle(2.5);
    assert.ok(far.opacity > mid.opacity && mid.opacity > 0);
    assert.equal(near.opacity, 0);
    assert.ok(far.fontPx > mid.fontPx);
    assert.ok(far.fontPx <= 15 && near.fontPx >= 10);
    assert.equal(regionLabelStyle(NaN).opacity, regionLabelStyle(1).opacity);
});

test('a node tier is 0 for core or protected, 1 for large, and 2 for the rest', () => {
    assert.equal(labelTier({ core: true, size: 8 }), 0);
    assert.equal(labelTier({ protectedNode: true, size: 8 }), 0);
    assert.equal(labelTier({ size: 24 }), 1);
    assert.equal(labelTier({ size: 10 }), 2);
});

test('zoomed out only core nodes are labeled, at medium zoom large nodes join, and close up everything can be', () => {
    const all = [item('core', 0, 0, 0), item('big', 200, 0, 1), item('small', 400, 0, 2)];
    assert.deepEqual([...chooseNodeLabels(all, 0.4)], ['core']);
    assert.deepEqual([...chooseNodeLabels(all, ZOOM_TIERS.mid)], ['core', 'big']);
    assert.deepEqual([...chooseNodeLabels(all, ZOOM_TIERS.near)], ['core', 'big', 'small']);
});

test('a label that would overlap a more important one is skipped', () => {
    const chosen = chooseNodeLabels([item('a', 100, 100, 0, 5), item('b', 110, 104, 0, 9), item('c', 400, 100, 0, 1)], 1);
    assert.deepEqual([...chosen].sort(), ['b', 'c'], 'the heavier of the two overlapping labels wins');
});

test('nodes outside the viewport are not labeled and the label count is capped', () => {
    const many = Array.from({ length: 200 }, (_, i) => item(`n${i}`, (i % 20) * 90, Math.floor(i / 20) * 40, 0, i));
    assert.equal(chooseNodeLabels(many, 1, { maxLabels: 10 }).size, 10);
    assert.deepEqual([...chooseNodeLabels([item('off', 5000, 5000, 0)], 1, { viewport: { width: 800, height: 600 } })], []);
});

import { chooseRegionLabels } from '../cores/ui/memory-graph/label-lod.js';

test('region names that would overlap are hidden, the region with more nodes stays', () => {
    const chosen = chooseRegionLabels([
        { id: 'small', label: 'Harbor', x: 100, y: 100, fontPx: 12, weight: 3 },
        { id: 'big', label: 'Legion', x: 110, y: 104, fontPx: 12, weight: 30 },
        { id: 'far', label: 'Continent', x: 500, y: 300, fontPx: 12, weight: 1 },
    ]);
    assert.deepEqual([...chosen].sort(), ['big', 'far']);
});

test('a forced label (hovered node, retrieval beacon) is always shown, ahead of the zoom tiers, and pushes overlapping ones out', () => {
    const chosen = chooseNodeLabels([
        { ...item('hovered', 300, 300, 2), forced: true },
        item('core-under', 305, 302, 0, 99),
        item('elsewhere', 700, 300, 0, 1),
    ], 0.4);
    assert.deepEqual([...chosen].sort(), ['elsewhere', 'hovered']);
});

import { duplicatesVisibleRegionName } from '../cores/ui/memory-graph/label-lod.js';

test('a node label equal to a visible region name is redundant, but comes back once the region name fades', () => {
    const names = new Set(['the legion', 'para-raid']);
    assert.equal(duplicatesVisibleRegionName('The Legion', names, 0.9), true);
    assert.equal(duplicatesVisibleRegionName('Kira', names, 0.9), false);
    assert.equal(duplicatesVisibleRegionName('The Legion', names, 0), false);
    assert.equal(duplicatesVisibleRegionName('', names, 0.9), false);
});
