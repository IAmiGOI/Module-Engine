import test from 'node:test';
import assert from 'node:assert/strict';
import { planRegionSplit } from '../cores/memory-graph/region-split.js';
import { createRegionOps } from '../cores/memory-graph/structured/region-ops.js';
import { DEFAULT_SETTINGS } from '../cores/memory-graph/math.js';

// Эмбединги как у E5: у всех нод большая общая составляющая (сходства сжаты в узкую полосу), тема — небольшой сдвиг.
const DIM = 16;
const unitAt = (index, size) => Array.from({ length: DIM }, (_, i) => (i === index ? size : 0));
function embeddingFor(topic, variant) {
    const base = Array.from({ length: DIM }, () => 1);
    const shift = unitAt(topic, 0.9);
    const noise = unitAt(8 + (variant % 7), 0.05 * (1 + (variant % 3)));
    return base.map((value, i) => value + shift[i] + noise[i]);
}
const node = (id, topic, variant, extra = {}) => ({ id, embedding: embeddingFor(topic, variant), importance: 3, ...extra });

/** Регион: 6 нод темы 0 («дом»), 4 темы 1, 3 темы 2, и одна «одиночка» темы 3. */
function threeTopics() {
    const nodes = [];
    for (let i = 0; i < 6; i += 1) nodes.push(node(`home${i}`, 0, i));
    for (let i = 0; i < 4; i += 1) nodes.push(node(`nyx${i}`, 1, i));
    for (let i = 0; i < 3; i += 1) nodes.push(node(`tea${i}`, 2, i));
    nodes.push(node('loner', 3, 0));
    return nodes;
}

test('planRegionSplit() takes every theme except the biggest out of a region, and leaves the biggest theme at home', () => {
    const { clusters } = planRegionSplit(threeTopics());
    const groups = clusters.map(cluster => [...cluster.ids].sort().join(','));
    assert.deepEqual(groups.sort(), ['nyx0,nyx1,nyx2,nyx3', 'tea0,tea1,tea2'].sort());
});

test('planRegionSplit() leaves a lone node and a pair at home — a region needs at least minCluster nodes of one theme', () => {
    const nodes = [...threeTopics().filter(item => !item.id.startsWith('tea')), node('tea0', 2, 0), node('tea1', 2, 1)];
    const ids = planRegionSplit(nodes).clusters.flatMap(cluster => cluster.ids);
    assert.ok(!ids.includes('tea0') && !ids.includes('tea1') && !ids.includes('loner'));
});

test('planRegionSplit() finds nothing to split in a region with one theme, or with too few nodes', () => {
    const oneTheme = Array.from({ length: 12 }, (_, i) => node(`n${i}`, 0, i));
    assert.deepEqual(planRegionSplit(oneTheme).clusters, []);
    assert.deepEqual(planRegionSplit(threeTopics().slice(0, 6)).clusters, [], 'under minNodes');
});

test('planRegionSplit() picks the most important node of a theme as its center, and is independent of the input order', () => {
    const nodes = threeTopics().map(item => (item.id === 'nyx2' ? { ...item, importance: 9 } : item));
    const first = planRegionSplit(nodes);
    const second = planRegionSplit([...nodes].reverse());
    assert.equal(first.clusters.find(cluster => cluster.ids.includes('nyx0')).centerId, 'nyx2');
    assert.deepEqual(second.clusters.map(c => [c.centerId, [...c.ids].sort()]).sort(), first.clusters.map(c => [c.centerId, [...c.ids].sort()]).sort());
});

test('planRegionSplit() never makes more than maxNewRegions regions, keeping the most cohesive themes', () => {
    const { clusters } = planRegionSplit(threeTopics(), { maxNewRegions: 1 });
    assert.equal(clusters.length, 1);
});

// --- Операция над графом ------------------------------------------------------

function buildCtx({ regionBirth = true, maxRegions = 24, turn = 100 } = {}) {
    const items = threeTopics().map(item => ({ ...item, kind: 'fact', label: item.id, regionId: 'main', edges: [] }));
    const heroes = ['hero1', 'hero2'].map(id => ({ id, kind: 'entity', label: id, regionId: 'main', core: true, protectedNode: true, embedding: embeddingFor(0, 3), edges: [] }));
    const nodes = Object.fromEntries([...heroes, ...items].map(item => [item.id, item]));
    const regions = { main: { centerNodeId: 'hero1', subCenterIds: ['hero2'], nodeIds: Object.keys(nodes), wordProfile: {} } };
    const events = [];
    const persisted = [];
    const ctx = {
        nodes, regions, mergeQueue: {}, reconsolidationQueue: {}, turnCounter: turn, features: { regionBirth },
        settings: { ...DEFAULT_SETTINGS, maxRegions },
        enqueueWrite: task => task(),
        publishEvent: (name, payload) => events.push([name, payload]),
        persistNodes: async () => persisted.push('nodes'), persistRegions: async () => persisted.push('regions'),
        persistMergeQueue: async () => persisted.push('merge'), persistReconsolidationQueue: async () => persisted.push('reconsolidation'),
    };
    return { ctx, events, persisted };
}

test('sweepRegionSplits() turns each theme into its own region: nodes move, the center becomes a protected Core, heroes stay home', async () => {
    const { ctx, events, persisted } = buildCtx();
    const { created } = await createRegionOps(ctx).sweepRegionSplits();
    assert.equal(created.length, 2);
    assert.equal(Object.keys(ctx.regions).length, 3);
    for (const item of created) {
        const region = ctx.regions[item.regionId];
        assert.equal(region.nodeIds.length, item.nodeIds.length);
        for (const id of item.nodeIds) assert.equal(ctx.nodes[id].regionId, item.regionId);
        assert.equal(ctx.nodes[item.centerNodeId].core, true);
        assert.equal(ctx.nodes[item.centerNodeId].protectedNode, true);
    }
    assert.equal(ctx.nodes.hero1.regionId, 'main');
    assert.equal(ctx.nodes.hero2.regionId, 'main');
    assert.ok(!ctx.regions.main.nodeIds.some(id => id.startsWith('nyx') || id.startsWith('tea')), 'moved nodes leave the old region');
    assert.equal(events.filter(([name]) => name === 'memoryGraph.regionCreated').length, 2);
    assert.ok(persisted.includes('nodes') && persisted.includes('regions'));
});

test('sweepRegionSplits() drops queued merges/reconsolidations whose nodes ended up in different regions, and keeps the rest', async () => {
    const { ctx } = buildCtx();
    ctx.reconsolidationQueue = {
        split: { nodeIds: ['nyx0', 'home0', 'home1'], regionId: 'main' },
        intact: { nodeIds: ['nyx0', 'nyx1', 'nyx2'], regionId: 'main' },
    };
    ctx.mergeQueue = { crossing: { nodeIdA: 'tea0', nodeIdB: 'home0' }, same: { nodeIdA: 'home0', nodeIdB: 'home1' } };
    await createRegionOps(ctx).sweepRegionSplits();
    assert.deepEqual(Object.keys(ctx.reconsolidationQueue), ['intact']);
    assert.deepEqual(Object.keys(ctx.mergeQueue), ['same']);
});

test('sweepRegionSplits() respects the region limit, the structured feature flag, and the sweep period', async () => {
    const full = buildCtx({ maxRegions: 1 });
    assert.deepEqual((await createRegionOps(full.ctx).sweepRegionSplits()).created, [], 'no room for a new region');
    const off = buildCtx({ regionBirth: false });
    assert.deepEqual((await createRegionOps(off.ctx).sweepRegionSplits()).created, [], 'legacy graphs are not split');
    const { ctx } = buildCtx();
    const ops = createRegionOps(ctx);
    assert.equal((await ops.sweepRegionSplits()).created.length, 2);
    ctx.turnCounter += 1;
    assert.deepEqual((await ops.sweepRegionSplits()).created, [], 'within regionSplitEveryTurns nothing is re-run');
});

test('a graph that was already split is not split again: every new region holds one theme', async () => {
    const { ctx } = buildCtx();
    const ops = createRegionOps(ctx);
    await ops.sweepRegionSplits();
    ctx.turnCounter += 50;
    assert.deepEqual((await ops.sweepRegionSplits()).created, []);
});
