import test from 'node:test';
import assert from 'node:assert/strict';
import { dropDecision, connectModeStep, edgeTypesInGraph } from '../cores/ui/memory-graph/interactions.js';

// --- dropDecision() ---------------------------------------------------------

test('dropDecision() snaps back when dropped outside every zone', () => {
    assert.equal(dropDecision('a', null), 'snap-back');
});

test('dropDecision() snaps back when dropped in the SAME region it started in — owner\'s decision: "returns to place"', () => {
    assert.equal(dropDecision('a', { regionId: 'a' }), 'snap-back');
});

test('dropDecision() snaps back when dropped on the staging zone (regionId: null) — manual drag must never assign the queue', () => {
    assert.equal(dropDecision('a', { regionId: null }), 'snap-back');
});

test('dropDecision() returns a move instruction when dropped in a genuinely DIFFERENT real region', () => {
    assert.deepEqual(dropDecision('a', { regionId: 'b' }), { move: 'b' });
});

test('dropDecision() returns a move instruction even from the staging queue (fromRegionId: null) into a real region', () => {
    assert.deepEqual(dropDecision(null, { regionId: 'b' }), { move: 'b' });
});

// --- connectModeStep() -------------------------------------------------------

test('connectModeStep() selects the first clicked node when nothing is selected yet, without creating an edge', () => {
    const result = connectModeStep({ selectedId: null }, 'n1');
    assert.deepEqual(result, { next: { selectedId: 'n1' }, create: null });
});

test('connectModeStep() treats a missing state the same as {selectedId: null} — the very first click of a session', () => {
    const result = connectModeStep(null, 'n1');
    assert.deepEqual(result, { next: { selectedId: 'n1' }, create: null });
});

test('connectModeStep() clicking the SAME node again deselects it instead of creating a self-edge', () => {
    const result = connectModeStep({ selectedId: 'n1' }, 'n1');
    assert.deepEqual(result, { next: { selectedId: null }, create: null });
});

test('connectModeStep() clicking a DIFFERENT node creates the edge and clears the selection, ready for the next pair', () => {
    const result = connectModeStep({ selectedId: 'n1' }, 'n2');
    assert.deepEqual(result, { next: { selectedId: null }, create: ['n1', 'n2'] });
});

test('connectModeStep() stays usable for a SECOND pair right after the first — the mode itself never turns off', () => {
    const first = connectModeStep({ selectedId: null }, 'a');
    const second = connectModeStep(first.next, 'b');
    assert.deepEqual(second.create, ['a', 'b']);
    const third = connectModeStep(second.next, 'c');
    assert.deepEqual(third, { next: { selectedId: 'c' }, create: null });
});

// --- edgeTypesInGraph() -------------------------------------------------------

test('edgeTypesInGraph() always includes "related" first, even for an empty graph', () => {
    assert.deepEqual(edgeTypesInGraph([]), ['related']);
    assert.deepEqual(edgeTypesInGraph(undefined), ['related']);
});

test('edgeTypesInGraph() collects every distinct edge type actually present, sorted, with "related" always first', () => {
    const nodes = [
        { id: 'a', edges: [{ to: 'b', type: 'mentions' }, { to: 'c', type: 'ally' }] },
        { id: 'b', edges: [{ to: 'a', type: 'mentions' }] },
    ];
    assert.deepEqual(edgeTypesInGraph(nodes), ['related', 'ally', 'mentions']);
});

test('edgeTypesInGraph() does not duplicate "related" when it already appears as a real edge type in the graph', () => {
    const nodes = [{ id: 'a', edges: [{ to: 'b', type: 'related' }] }];
    assert.deepEqual(edgeTypesInGraph(nodes), ['related']);
});
