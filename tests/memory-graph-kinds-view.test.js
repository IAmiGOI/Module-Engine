import test from 'node:test';
import assert from 'node:assert/strict';
import { KIND_SHAPE, nodeKindData, directedEdgeEnds, hiddenByKind, isOrbitEvent, eventAnchorId, placeEventsNearAnchors, structuredStyleRules, DEFAULT_KIND_FILTERS } from '../cores/ui/memory-graph/kinds-view.js';
import { graphStylesheet } from '../cores/ui/memory-graph/stylesheet.js';
import { findMetric, glowValue, STRUCTURED_METRICS } from '../cores/ui/memory-graph/metrics.js';

const event = (id, anchorId, extra = {}) => ({ id, kind: 'event', createdAt: 0, edges: anchorId ? [{ to: anchorId, type: 'participates', dir: 'in' }] : [], ...extra });

test('each kind has its own shape and a node without a kind is drawn as a fact', () => {
    assert.deepEqual(Object.values(KIND_SHAPE).sort(), ['diamond', 'ellipse', 'hexagon', 'round-rectangle']);
    assert.equal(nodeKindData({}).shape, 'diamond');
    assert.equal(nodeKindData({ kind: 'event', core: true }).core, true);
    assert.equal(nodeKindData({ kind: 'object', subtype: 'place' }).subtype, 'place');
});

test('an event edge is drawn once from its out record with an arrow, and the in record is skipped', () => {
    assert.deepEqual(directedEdgeEnds({ id: 'a' }, { to: 'e', type: 'participates', dir: 'out' }), { skip: false, source: 'a', target: 'e', directed: true, chain: false });
    assert.equal(directedEdgeEnds({ id: 'e' }, { to: 'a', type: 'participates', dir: 'in' }).skip, true);
    assert.equal(directedEdgeEnds({ id: 'a' }, { to: 'e', type: 'next', dir: 'out' }).chain, true);
    assert.equal(directedEdgeEnds({ id: 'a' }, { to: 'b', type: 'related' }), null, 'a lore edge stays a plain line');
});

test('the structured style rules give shape, core outline, arrows and thicker chains, and the full stylesheet includes them', () => {
    const selectors = structuredStyleRules().map(rule => rule.selector);
    assert.deepEqual(selectors, ['node[shape]', 'node[?core]', 'edge[?directed]', 'edge[?chain]']);
    const all = graphStylesheet().map(rule => rule.selector);
    for (const selector of selectors) assert.ok(all.includes(selector));
    assert.ok(all.indexOf('.dimmed') > all.indexOf('edge[?directed]'), 'dimming still wins over the structured rules');
});

test('kind filters hide unchecked kinds and, with Core only, everything that is not core', () => {
    assert.equal(hiddenByKind({ kind: 'event' }, { ...DEFAULT_KIND_FILTERS, event: false }), true);
    assert.equal(hiddenByKind({ kind: 'fact' }, DEFAULT_KIND_FILTERS), false);
    assert.equal(hiddenByKind({ kind: 'fact', core: false }, { ...DEFAULT_KIND_FILTERS, coreOnly: true }), true);
    assert.equal(hiddenByKind({ kind: 'fact', core: true }, { ...DEFAULT_KIND_FILTERS, coreOnly: true }), false);
});

test('only a non-core event with a known anchor is laid out on an orbit', () => {
    const nodes = { a: { id: 'a', kind: 'entity', edges: [] } };
    assert.equal(isOrbitEvent(event('e1', 'a'), nodes), true);
    assert.equal(isOrbitEvent(event('e2', 'a', { core: true }), nodes), false);
    assert.equal(isOrbitEvent(event('e3', null), nodes), false);
    assert.equal(eventAnchorId(event('e4', 'missing'), nodes), null);
});

test('events sit on an orbit around their anchor, outside its own disc, deterministically and independent of each other', () => {
    const nodes = { a: { id: 'a', kind: 'entity', edges: [] } };
    const positions = new Map([['a', { x: 100, y: 50 }]]);
    const radii = new Map([['a', 10]]);
    const events = [event('e1', 'a', { createdAt: 1 }), event('e2', 'a', { createdAt: 2 })];

    const first = placeEventsNearAnchors(events, nodes, positions, radii);
    const again = placeEventsNearAnchors([...events].reverse(), nodes, positions, radii);

    assert.deepEqual([...first.entries()].sort(), [...again.entries()].sort());
    for (const point of first.values()) assert.ok(Math.hypot(point.x - 100, point.y - 50) >= 10 + 20);
    const alone = placeEventsNearAnchors([events[0]], nodes, positions, radii);
    assert.deepEqual(alone.get('e1'), first.get('e1'), 'adding another event does not move the first one');
});

test('the kind and core metrics exist only as structured metrics and are found by id', () => {
    assert.deepEqual(STRUCTURED_METRICS.map(metric => metric.id), ['kind', 'core']);
    assert.equal(findMetric('kind').value({ kind: 'event' }), 'event');
    assert.ok(findMetric('core').value({ core: true }) > findMetric('core').value({ core: false }));
    assert.equal(glowValue({ core: true }, 'core', {}, {}), 0.5);
    assert.equal(glowValue({ core: false }, 'core', {}, {}), 0);
});
