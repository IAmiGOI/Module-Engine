import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ROOT_HOST, DEFAULT_SETTINGS, sanitizeSettings, sanitizeNodeInput, sanitizeEdgeInput,
    buildContainmentPath, wouldCreateCycle, resolveLocalMapHost, computeLocalScale,
    resolveNodePoint, computeDistanceBetweenNodes, resolveEdgeDistance, computeTravelTimeMinutes,
    detectPolygonAdjacency, findAdjacentNodeIds, findNodesWithinDistance, findRoutes,
    isPointInPolygon, findContainingNodeId, snapPointToNearbyVertex,
} from '../libraries/core/map-graph.js';

function node(overrides = {}) {
    return sanitizeNodeInput({ name: 'Node', ...overrides });
}

/** `sanitizeEdgeInput()` deliberately doesn't assign `id` (that's the Core's job) — tests exercising the graph need a real, distinct one per edge. */
function edge(id, overrides = {}) {
    return { id, ...sanitizeEdgeInput(overrides) };
}

test('sanitizeNodeInput clamps polygon points into 0..1 and rejects a polygon with fewer than 3 points', () => {
    const withBadPolygon = node({ polygon: [{ x: -1, y: 2 }, { x: 0.5, y: 0.5 }] });
    assert.equal(withBadPolygon.polygon, null, 'two points is not a polygon');

    const clamped = node({ polygon: [{ x: -1, y: 2 }, { x: 0.5, y: 0.5 }, { x: 2, y: -2 }] });
    assert.deepEqual(clamped.polygon, [{ x: 0, y: 1 }, { x: 0.5, y: 0.5 }, { x: 1, y: 0 }]);
});

test('sanitizeNodeInput accepts a real #rrggbb color and rejects garbage as null (no custom color)', () => {
    assert.equal(node({ color: '#ff8800' }).color, '#ff8800');
    assert.equal(node({ color: 'red' }).color, null, 'CSS color keywords are not #rrggbb — rejected, not guessed at');
    assert.equal(node({ color: '#fff' }).color, null, '3-digit shorthand is not the accepted format');
    assert.equal(node({}).color, null, 'no color given — no custom color');
});

test('sanitizeNodeInput accepts a positive radius, caps it at 0.1, and rejects non-positive/garbage as null', () => {
    assert.equal(node({ radius: 0.03 }).radius, 0.03);
    assert.equal(node({ radius: 5 }).radius, 0.1, 'capped, not left free to swallow the whole canvas');
    assert.equal(node({ radius: 0 }).radius, null);
    assert.equal(node({ radius: -1 }).radius, null);
    assert.equal(node({ radius: 'x' }).radius, null);
});

test('sanitizeNodeInput keeps color/radius from `existing` when the input omits the field entirely (a partial update)', () => {
    const original = node({ color: '#112233', radius: 0.02 });
    const patched = sanitizeNodeInput({ name: 'Node', description: 'x' }, original);
    assert.equal(patched.color, '#112233');
    assert.equal(patched.radius, 0.02);
});

test('wouldCreateCycle catches a node being reparented under its own descendant', () => {
    const nodes = {
        country: node({ parentId: null }),
        city: node({ parentId: 'country' }),
        district: node({ parentId: 'city' }),
    };
    assert.equal(wouldCreateCycle(nodes, 'country', 'district'), true, 'country would become its own great-grandchild');
    assert.equal(wouldCreateCycle(nodes, 'district', 'country'), false, 'the normal direction is fine');
    assert.equal(wouldCreateCycle(nodes, 'city', 'city'), true, 'a node cannot be its own parent');
});

test('buildContainmentPath returns root-to-leaf order and stops cleanly at a broken/missing parent', () => {
    const nodes = { country: node({ parentId: null }), city: node({ parentId: 'country' }) };
    assert.deepEqual(buildContainmentPath(nodes, 'city'), ['country', 'city']);
    assert.deepEqual(buildContainmentPath(nodes, 'ghost'), []);
});

test('resolveLocalMapHost returns ROOT_HOST when no ancestor hosts its own localMap, and the nearest hosting ancestor otherwise', () => {
    const nodes = {
        district: node({ parentId: null }),
        building: node({ parentId: 'district', localMap: { widthUnits: 40, heightUnits: 40 } }),
        room: node({ parentId: 'building' }),
        hallway: node({ parentId: 'room' }),
    };
    assert.equal(resolveLocalMapHost(nodes, 'district'), ROOT_HOST);
    assert.equal(resolveLocalMapHost(nodes, 'room'), 'building', 'room belongs to its building\'s own local map');
    assert.equal(resolveLocalMapHost(nodes, 'hallway'), 'building', 'skips through room, which hosts no map of its own');
});

test('computeLocalScale derives a nested localMap from the coefficient when width/height are not explicitly set', () => {
    const settings = sanitizeSettings({ mapWidthUnits: 30000, mapHeightUnits: 30000, levelScaleCoefficient: 15 });
    const nodes = {
        city: node({ parentId: null, localMap: { widthUnits: null, heightUnits: null } }),
    };
    const scale = computeLocalScale(nodes, settings, 'city');
    assert.equal(scale.widthUnits, 2000, '30000 / 15 = 2000, derived, not the root scale');
});

test('computeLocalScale respects an explicit localMap override instead of deriving from the coefficient', () => {
    const settings = sanitizeSettings({});
    const nodes = { room: node({ localMap: { widthUnits: 5, heightUnits: 4 } }) };
    const scale = computeLocalScale(nodes, settings, 'room');
    assert.deepEqual(scale, { widthUnits: 5, heightUnits: 4 });
});

test('resolveNodePoint prefers the polygon centroid over a plain marker position', () => {
    const withPolygon = node({ polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], position: { x: 0.9, y: 0.9 } });
    assert.deepEqual(resolveNodePoint(withPolygon), { x: 0.5, y: 0.5 });
    const markerOnly = node({ position: { x: 0.2, y: 0.3 } });
    assert.deepEqual(resolveNodePoint(markerOnly), { x: 0.2, y: 0.3 });
    assert.equal(resolveNodePoint(node({})), null);
});

test('computeDistanceBetweenNodes returns null across two different local maps, and a real meter distance within the same one', () => {
    const settings = sanitizeSettings({ mapWidthUnits: 1000, mapHeightUnits: 1000 });
    const nodes = {
        a: node({ position: { x: 0, y: 0 } }),
        b: node({ position: { x: 1, y: 0 } }),
        buildingA: node({ localMap: { widthUnits: 10, heightUnits: 10 } }),
        insideA: node({ parentId: 'buildingA', position: { x: 0, y: 0 } }),
    };
    assert.equal(computeDistanceBetweenNodes(nodes, settings, 'a', 'b'), 1000, 'full width of the root map');
    assert.equal(computeDistanceBetweenNodes(nodes, settings, 'a', 'insideA'), null, 'different local coordinate spaces');
});

test('resolveEdgeDistance falls back to distanceOverrideUnits for a manual edge that bridges two local maps', () => {
    const settings = sanitizeSettings({});
    const nodes = {
        buildingA: node({ localMap: { widthUnits: 10, heightUnits: 10 } }),
        insideA: node({ parentId: 'buildingA', position: { x: 0, y: 0 } }),
        district: node({ position: { x: 0, y: 0 } }),
    };
    const manualEdge = sanitizeEdgeInput({ fromId: 'insideA', toId: 'district', distanceOverrideUnits: 12 });
    assert.equal(resolveEdgeDistance(nodes, settings, manualEdge), 12);
});

test('computeTravelTimeMinutes returns null when time-distance is disabled, and a plausible number when enabled', () => {
    const enabled = sanitizeSettings({ walkSpeedMetersPerMinute: 100 });
    assert.equal(computeTravelTimeMinutes(1000, enabled), 10);
    const disabled = sanitizeSettings({ timeDistanceEnabled: false });
    assert.equal(computeTravelTimeMinutes(1000, disabled), null);
});

test('detectPolygonAdjacency is true for two squares sharing an edge, false for two squares far apart', () => {
    const left = [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 1 }, { x: 0, y: 1 }];
    const right = [{ x: 0.5, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0.5, y: 1 }];
    const far = [{ x: 5, y: 5 }, { x: 6, y: 5 }, { x: 6, y: 6 }, { x: 5, y: 6 }];
    assert.equal(detectPolygonAdjacency(left, right), true);
    assert.equal(detectPolygonAdjacency(left, far), false);
});

test('findAdjacentNodeIds only matches siblings in the SAME local map, ignoring a touching polygon in a different one', () => {
    const left = [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 1 }, { x: 0, y: 1 }];
    const right = [{ x: 0.5, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0.5, y: 1 }];
    const nodes = {
        district1: node({ polygon: left }),
        district2: node({ polygon: right }),
        buildingA: node({ localMap: { widthUnits: 10, heightUnits: 10 } }),
        roomX: node({ parentId: 'buildingA', polygon: right }),
    };
    assert.deepEqual(findAdjacentNodeIds(nodes, 'district1'), ['district2']);
});

test('isPointInPolygon is true for a point inside a simple square, false for one clearly outside', () => {
    const square = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    assert.equal(isPointInPolygon({ x: 0.5, y: 0.5 }, square), true);
    assert.equal(isPointInPolygon({ x: 2, y: 2 }, square), false);
});

test('isPointInPolygon is false for a point outside a concave (L-shaped) polygon that a naive bounding-box check would miss', () => {
    // An L-shape: the notch at the top-right quadrant is NOT inside the shape.
    const lShape = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.5, y: 1 }, { x: 0, y: 1 }];
    assert.equal(isPointInPolygon({ x: 0.75, y: 0.75 }, lShape), false, 'inside the notch, not the shape');
    assert.equal(isPointInPolygon({ x: 0.25, y: 0.25 }, lShape), true, 'inside the solid part');
});

test('findContainingNodeId returns the polygon region that actually contains the point, ignoring non-polygon markers and nodes in a different local space', () => {
    const region = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    const buildingSpace = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]; // same shape, different host
    const nodes = {
        region1: node({ polygon: region }),
        marker1: node({ position: { x: 0.5, y: 0.5 } }), // not a polygon — never a candidate parent
        buildingHost: node({ localMap: { widthUnits: 10, heightUnits: 10 } }),
        roomInBuilding: node({ parentId: 'buildingHost', polygon: buildingSpace }),
    };
    assert.equal(findContainingNodeId(nodes, { x: 0.5, y: 0.5 }, ROOT_HOST), 'region1');
    assert.equal(findContainingNodeId(nodes, { x: 5, y: 5 }, ROOT_HOST), null, 'outside every region — top-level');
});

test('findContainingNodeId picks the SMALLEST enclosing region when polygons are nested', () => {
    const outer = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    const inner = [{ x: 0.4, y: 0.4 }, { x: 0.6, y: 0.4 }, { x: 0.6, y: 0.6 }, { x: 0.4, y: 0.6 }];
    const nodes = { district: node({ polygon: outer }), building: node({ polygon: inner }) };
    assert.equal(findContainingNodeId(nodes, { x: 0.5, y: 0.5 }, ROOT_HOST), 'building', 'the smaller, more specific region wins');
});

test('findContainingNodeId excludes a node checking against its own polygon via excludeId', () => {
    const shape = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    const nodes = { self: node({ polygon: shape }) };
    assert.equal(findContainingNodeId(nodes, { x: 0.5, y: 0.5 }, ROOT_HOST, 'self'), null);
});

test('snapPointToNearbyVertex snaps to the nearest existing vertex within tolerance', () => {
    const square = [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 0.5 }, { x: 0, y: 0.5 }];
    const nodes = { region: node({ polygon: square }) };
    const snapped = snapPointToNearbyVertex({ x: 0.503, y: 0.001 }, nodes, ROOT_HOST);
    assert.deepEqual(snapped, { x: 0.5, y: 0 }, 'close to the top-right corner — snaps exactly onto it');
});

test('snapPointToNearbyVertex leaves the point unchanged when nothing is within tolerance', () => {
    const square = [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 0.5 }, { x: 0, y: 0.5 }];
    const nodes = { region: node({ polygon: square }) };
    const point = { x: 0.9, y: 0.9 };
    assert.deepEqual(snapPointToNearbyVertex(point, nodes, ROOT_HOST), point);
});

test('snapPointToNearbyVertex ignores a vertex in a DIFFERENT local coordinate space even if numerically close', () => {
    const square = [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 0.5 }, { x: 0, y: 0.5 }];
    const nodes = {
        buildingHost: node({ localMap: { widthUnits: 10, heightUnits: 10 } }),
        region: node({ parentId: 'buildingHost', polygon: square }),
    };
    const point = { x: 0.503, y: 0.001 };
    assert.deepEqual(snapPointToNearbyVertex(point, nodes, ROOT_HOST), point, 'the region lives inside buildingHost\'s own space, not ROOT_HOST');
});

test('snapPointToNearbyVertex picks the CLOSEST vertex when several are within tolerance', () => {
    const nodes = {
        a: node({ polygon: [{ x: 0.500, y: 0 }, { x: 0.6, y: 0 }, { x: 0.6, y: 0.1 }] }),
        b: node({ polygon: [{ x: 0.502, y: 0.001 }, { x: 0.7, y: 0 }, { x: 0.7, y: 0.1 }] }),
    };
    const snapped = snapPointToNearbyVertex({ x: 0.501, y: 0.0005 }, nodes, ROOT_HOST);
    assert.deepEqual(snapped, { x: 0.5, y: 0 }, 'nearer to node a\'s vertex than node b\'s');
});

test('findNodesWithinDistance matches two markers close enough together without any polygon/border involved, and excludes ones too far', () => {
    const settings = sanitizeSettings({ mapWidthUnits: 1000, mapHeightUnits: 1000 });
    const nodes = {
        a: node({ position: { x: 0, y: 0 } }),
        near: node({ position: { x: 0.05, y: 0 } }), // 50 units away
        far: node({ position: { x: 0.9, y: 0 } }), // 900 units away
    };
    assert.deepEqual(findNodesWithinDistance(nodes, settings, 'a', 100), ['near']);
});

test('findNodesWithinDistance returns nothing when the threshold is null/0/negative — the feature is off by default', () => {
    const settings = sanitizeSettings({ mapWidthUnits: 1000, mapHeightUnits: 1000 });
    const nodes = { a: node({ position: { x: 0, y: 0 } }), b: node({ position: { x: 0.01, y: 0 } }) };
    assert.deepEqual(findNodesWithinDistance(nodes, settings, 'a', null), []);
    assert.deepEqual(findNodesWithinDistance(nodes, settings, 'a', 0), []);
    assert.deepEqual(findNodesWithinDistance(nodes, settings, 'a', -50), []);
});

test('findNodesWithinDistance ignores a node in a DIFFERENT local coordinate space even if the raw threshold would otherwise cover it', () => {
    const settings = sanitizeSettings({ mapWidthUnits: 1000, mapHeightUnits: 1000 });
    const nodes = {
        a: node({ position: { x: 0, y: 0 } }),
        buildingA: node({ localMap: { widthUnits: 10, heightUnits: 10 } }),
        insideA: node({ parentId: 'buildingA', position: { x: 0, y: 0 } }),
    };
    assert.deepEqual(findNodesWithinDistance(nodes, settings, 'a', 999999), []);
});

test('findRoutes finds the shortest path across three chained nodes and reports total distance/time', () => {
    const settings = sanitizeSettings({ mapWidthUnits: 300, mapHeightUnits: 300, walkSpeedMetersPerMinute: 100 });
    const nodes = {
        a: node({ position: { x: 0, y: 0 } }),
        b: node({ position: { x: 0.5, y: 0 } }),
        c: node({ position: { x: 1, y: 0 } }),
    };
    const edges = {
        ab: edge('ab', { fromId: 'a', toId: 'b' }),
        bc: edge('bc', { fromId: 'b', toId: 'c' }),
    };
    const { routes, reason } = findRoutes(nodes, edges, settings, { fromId: 'a', toId: 'c' });
    assert.equal(reason, null);
    assert.deepEqual(routes[0].nodeIds, ['a', 'b', 'c']);
    assert.equal(routes[0].totalDistanceUnits, 300);
    assert.equal(routes[0].totalTimeMinutes, 3);
});

test('findRoutes reports reason "no-path" when two nodes are simply disconnected', () => {
    const settings = sanitizeSettings({});
    const nodes = { a: node({ position: { x: 0, y: 0 } }), b: node({ position: { x: 1, y: 1 } }) };
    const { routes, reason } = findRoutes(nodes, {}, settings, { fromId: 'a', toId: 'b' });
    assert.deepEqual(routes, []);
    assert.equal(reason, 'no-path');
});

test('findRoutes excludes a node whose rank is below settings.minTraversableRank — an abstract-only "Country" node cannot be walked through', () => {
    const settings = sanitizeSettings({ minTraversableRank: 4 });
    const nodes = {
        country: node({ rank: 1, position: { x: 0, y: 0 } }),
        cityA: node({ rank: 4, position: { x: 0.4, y: 0 } }),
        cityB: node({ rank: 4, position: { x: 0.6, y: 0 } }),
    };
    const edges = {
        e1: edge('e1', { fromId: 'cityA', toId: 'country' }),
        e2: edge('e2', { fromId: 'country', toId: 'cityB' }),
    };
    const { routes, reason } = findRoutes(nodes, edges, settings, { fromId: 'cityA', toId: 'cityB' });
    assert.deepEqual(routes, []);
    assert.equal(reason, 'no-path', 'the only path runs through the abstract-only Country node, which must be excluded');
});

test('findRoutes returns a second, longer route when maxRoutes is 2 and a detour edge exists', () => {
    const settings = sanitizeSettings({ mapWidthUnits: 100, mapHeightUnits: 100 });
    const nodes = {
        a: node({ position: { x: 0, y: 0 } }),
        b: node({ position: { x: 1, y: 0 } }),
        detour: node({ position: { x: 0.5, y: 1 } }),
    };
    const edges = {
        direct: edge('direct', { fromId: 'a', toId: 'b' }),
        viaDetourIn: edge('viaDetourIn', { fromId: 'a', toId: 'detour' }),
        viaDetourOut: edge('viaDetourOut', { fromId: 'detour', toId: 'b' }),
    };
    const { routes } = findRoutes(nodes, edges, settings, { fromId: 'a', toId: 'b', maxRoutes: 2 });
    assert.equal(routes.length, 2);
    assert.deepEqual(routes[0].nodeIds, ['a', 'b'], 'the direct edge stays the shortest route');
    assert.deepEqual(routes[1].nodeIds, ['a', 'detour', 'b']);
    assert.ok(routes[1].totalDistanceUnits > routes[0].totalDistanceUnits);
});

test('findRoutes({fromId,toId}) with the same id on both ends returns a trivial zero-distance route without touching the graph', () => {
    const settings = sanitizeSettings({});
    const nodes = { a: node({ position: { x: 0, y: 0 } }) };
    const { routes, reason } = findRoutes(nodes, {}, settings, { fromId: 'a', toId: 'a' });
    assert.equal(reason, null);
    assert.deepEqual(routes[0], { nodeIds: ['a'], edgeIds: [], totalDistanceUnits: 0, totalTimeMinutes: 0 });
});

test('findRoutes reports reason "unknown-node" for an id that does not exist', () => {
    const settings = sanitizeSettings({});
    const { routes, reason } = findRoutes({ a: node({}) }, {}, settings, { fromId: 'a', toId: 'ghost' });
    assert.deepEqual(routes, []);
    assert.equal(reason, 'unknown-node');
});
