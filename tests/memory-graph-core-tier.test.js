import test from 'node:test';
import assert from 'node:assert/strict';
import { coreCap, shouldSwapCenter, planRegionRole } from '../cores/memory-graph/core-tier.js';

test('the core cap is the larger of the minimum, the share of all nodes, and the cores left by the bootstrap', () => {
    assert.equal(coreCap(20, { coreMaxShare: 0.08, coreMinCap: 5 }), 5);
    assert.equal(coreCap(200, { coreMaxShare: 0.08, coreMinCap: 5 }), 16);
    assert.equal(coreCap(200, { coreMaxShare: 0.08, coreMinCap: 5, bootstrapCoreCount: 40 }), 40);
});

test('a more important node takes over the center, and with equal importance the better connected one does', () => {
    assert.equal(shouldSwapCenter({ id: 'a', importance: 9 }, { id: 'c', importance: 7 }), true);
    assert.equal(shouldSwapCenter({ id: 'a', importance: 7, degree: 4 }, { id: 'c', importance: 7, degree: 2 }), true);
    assert.equal(shouldSwapCenter({ id: 'a', importance: 7, degree: 2 }, { id: 'c', importance: 7, degree: 2 }), false);
});

test('a promoted node becomes a sub-center while there is room, and stays a plain core when there is none', () => {
    const nodes = { c: { id: 'c', importance: 9 }, n: { id: 'n', importance: 5 } };
    const region = { centerNodeId: 'c', subCenterIds: [] };
    assert.deepEqual(planRegionRole(nodes.n, region, nodes, { subCentersPerRegion: 2 }), { role: 'subCenter' });
    assert.deepEqual(planRegionRole(nodes.n, { ...region, subCenterIds: ['x', 'y'] }, nodes, { subCentersPerRegion: 2 }), { role: 'none' });
});

test('a promoted node more important than the center replaces it and the old center is demoted', () => {
    const nodes = { c: { id: 'c', importance: 6 }, n: { id: 'n', importance: 9 } };
    assert.deepEqual(planRegionRole(nodes.n, { centerNodeId: 'c', subCenterIds: [] }, nodes), { role: 'center', demoteCenter: true });
});

import { shouldSeedRegion, regionKeyForLabel } from '../cores/memory-graph/region-birth.js';

const center = embedding => ({ embedding });
const fiveCenters = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [0, 1, 1]].map(center);

test('a candidate unlike every center seeds a region when it is clearly below the graph typical similarity', () => {
    assert.equal(shouldSeedRegion([-1, -1, -1], fiveCenters, [0.95, 0.9, 0.97, 0.92, 0.94]), true);
});

test('a candidate as close to a center as the typical node does not seed a region', () => {
    assert.equal(shouldSeedRegion([1, 0.1, 0], fiveCenters, [0.95, 0.9, 0.97, 0.92, 0.94]), false);
});

test('fewer than four centers never seed a region, and neither does a graph with no spread to compare against', () => {
    assert.equal(shouldSeedRegion([-1, -1, -1], fiveCenters.slice(0, 3), [0.9, 0.95, 0.92, 0.93]), false);
    assert.equal(shouldSeedRegion([-1, -1, -1], fiveCenters, [0.9, 0.9, 0.9, 0.9]), false);
});

test('a region key is a slug of the label and takes a numeric suffix on collision', () => {
    assert.equal(regionKeyForLabel('The Varekh Succession!', []), 'region:the-varekh-succession');
    assert.equal(regionKeyForLabel('Kira', ['region:kira', 'region:kira-2']), 'region:kira-3');
});
