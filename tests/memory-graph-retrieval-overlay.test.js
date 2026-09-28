import test from 'node:test';
import assert from 'node:assert/strict';
import { retrievalClasses, routeChainLabels } from '../cores/ui/memory-graph/retrieval-overlay.js';

const NODE_IDS = ['a', 'b', 'c', 'd', 'e'];
const EDGES = [
    { id: 'edge:a|b', source: 'a', target: 'b' },
    { id: 'edge:b|c', source: 'b', target: 'c' },
    { id: 'edge:d|e', source: 'd', target: 'e' },
];

test('retrievalClasses() returns an empty map for a null/undefined retrieval — no classes touched at all', () => {
    assert.deepEqual(retrievalClasses(null, NODE_IDS, EDGES), new Map());
    assert.deepEqual(retrievalClasses(undefined, NODE_IDS, EDGES), new Map());
});

test('retrievalClasses() returns an empty map for a degenerate retrieval object with no beacons/segments/noise', () => {
    const retrieval = { at: Date.now(), sticky: false, beaconIds: [], segments: [], standaloneIds: [], noiseIds: [], query: '' };
    assert.deepEqual(retrievalClasses(retrieval, NODE_IDS, EDGES), new Map());
});

test('retrievalClasses() marks beacon nodes as "beacon", route edges as "route", and everything else as "dimmed"', () => {
    const retrieval = { beaconIds: ['a', 'c'], segments: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }], noiseIds: [] };
    const classes = retrievalClasses(retrieval, NODE_IDS, EDGES);
    assert.equal(classes.get('a'), 'beacon');
    assert.equal(classes.get('c'), 'beacon');
    assert.equal(classes.get('b'), 'route-node', 'b sits on the route between two beacons but is not itself a beacon');
    assert.equal(classes.get('d'), 'dimmed');
    assert.equal(classes.get('e'), 'dimmed');
    assert.equal(classes.get('edge:a|b'), 'route');
    assert.equal(classes.get('edge:b|c'), 'route');
    assert.equal(classes.get('edge:d|e'), 'dimmed');
});

test('retrievalClasses() marks a beacon that also sits on the route as "beacon", never demoted to "route-node"', () => {
    const retrieval = { beaconIds: ['a', 'b', 'c'], segments: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }], noiseIds: [] };
    const classes = retrievalClasses(retrieval, NODE_IDS, EDGES);
    assert.equal(classes.get('b'), 'beacon');
});

test('retrievalClasses() marks a standalone beacon (no route edges at all) as "beacon", not "dimmed"', () => {
    const retrieval = { beaconIds: ['a'], segments: [], standaloneIds: ['a'], noiseIds: [] };
    const classes = retrievalClasses(retrieval, NODE_IDS, EDGES);
    assert.equal(classes.get('a'), 'beacon');
    assert.equal(classes.get('b'), 'dimmed');
});

test('retrievalClasses() marks noise nodes as "noise" as long as they are not already a beacon or route node', () => {
    const retrieval = { beaconIds: ['a'], segments: [], noiseIds: ['d', 'e'] };
    const classes = retrievalClasses(retrieval, NODE_IDS, EDGES);
    assert.equal(classes.get('d'), 'noise');
    assert.equal(classes.get('e'), 'noise');
});

test('retrievalClasses() matches a route edge regardless of segment direction vs. the edge\'s own source/target order', () => {
    const retrieval = { beaconIds: [], segments: [{ from: 'b', to: 'a' }], noiseIds: [] }; // reversed vs. edge:a|b's source/target
    const classes = retrievalClasses(retrieval, NODE_IDS, EDGES);
    assert.equal(classes.get('edge:a|b'), 'route');
});

test('routeChainLabels() reconstructs the ordered node label chain from consecutive segments', () => {
    const segments = [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }];
    const labelById = new Map([['a', 'Alice'], ['b', 'Bob'], ['c', 'Carol']]);
    assert.deepEqual(routeChainLabels(segments, labelById), ['Alice', 'Bob', 'Carol']);
});

test('routeChainLabels() falls back to the raw id when a label is missing', () => {
    const segments = [{ from: 'a', to: 'x' }];
    const labelById = new Map([['a', 'Alice']]);
    assert.deepEqual(routeChainLabels(segments, labelById), ['Alice', 'x']);
});

test('routeChainLabels() returns an empty array for an empty or missing segment list', () => {
    assert.deepEqual(routeChainLabels([], new Map()), []);
    assert.deepEqual(routeChainLabels(undefined, new Map()), []);
});
