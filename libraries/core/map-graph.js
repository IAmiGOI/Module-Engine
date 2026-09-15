/**
 * Chistaya geometry/graph math for the location-map feature (ROADMAP.md,
 * MAP.md) — no ST, no DOM, no storage, no events. [cores/map/index.js](../../cores/map/index.js)
 * is the only real consumer, adding persistence/contracts/events on top of
 * what's here, per LIBRARIES.md's "Library before Core" rule.
 *
 * **Two separate edge concepts, never conflated:**
 * - **Containment** (`node.parentId`) — vertical, a tree, arbitrary depth,
 *   no fixed level names ("Страна/Регион/.../Помещение" are UI-level
 *   presets, not an enforced schema — a node's `rank` is a free number).
 * - **Adjacency** (graph edges in this file) — horizontal, "can walk from
 *   here to there", auto-created when two sibling polygons' borders touch,
 *   or added manually. `findRoutes()` only ever walks adjacency edges.
 *
 * **Coordinate spaces are local, not global.** A node's polygon/position is
 * normalized (0..1) against whichever "local map" contains it — either its
 * own `localMap` (if it hosts one, e.g. a building's floor plan image) or
 * the nearest ancestor that does, or the implicit root main map. Distance
 * is only geometrically defined between two nodes sharing the SAME local
 * map — crossing from one local map to another (e.g. one building's rooms
 * to a district) has no shared coordinate system, which is precisely what
 * keeps "walk into a building, walk between its rooms, but never teleport
 * room-to-room across two different buildings" true for free, without a
 * special case: such a cross-space edge can only be a manual edge carrying
 * its own `distanceOverrideUnits`.
 */

export const ROOT_HOST = 'root';

export const DEFAULT_SETTINGS = Object.freeze({
    /** Real-world size (meters) the root main map's full 0..1 normalized square represents. */
    mapWidthUnits: 100_000,
    mapHeightUnits: 100_000,
    /** Each nested `localMap` without its own explicit width/height inherits (parent scale / this) — "10/20 раз ниже" default, picked as a reasonable middle. */
    levelScaleCoefficient: 15,
    /** ~5 km/h, a common average walking pace. */
    walkSpeedMetersPerMinute: 83.33,
    timeDistanceEnabled: true,
    /** Ranks below this are excluded from the movement graph (abstract-only, e.g. Country/Region) — `null` = no ceiling, every ranked node is traversable. */
    minTraversableRank: null,
    /**
     * Real-world proximity auto-connect threshold (same units as
     * `mapWidthUnits`/`mapHeightUnits`) — `null` = off. Border-touch
     * adjacency (`findAdjacentNodeIds()`) requires the owner to actually
     * draw every region's polygon so its edges touch its neighbors'; if they
     * don't want to mark out full borders everywhere, any two nodes within
     * this distance of each other (regardless of shape — markers included)
     * auto-connect too. See `findNodesWithinDistance()`.
     */
    autoConnectDistanceUnits: null,
});

export function sanitizeSettings(input = {}) {
    const merged = { ...DEFAULT_SETTINGS, ...input };
    return {
        mapWidthUnits: Number(merged.mapWidthUnits) > 0 ? Number(merged.mapWidthUnits) : DEFAULT_SETTINGS.mapWidthUnits,
        mapHeightUnits: Number(merged.mapHeightUnits) > 0 ? Number(merged.mapHeightUnits) : DEFAULT_SETTINGS.mapHeightUnits,
        levelScaleCoefficient: Number(merged.levelScaleCoefficient) > 0 ? Number(merged.levelScaleCoefficient) : DEFAULT_SETTINGS.levelScaleCoefficient,
        walkSpeedMetersPerMinute: Number(merged.walkSpeedMetersPerMinute) > 0 ? Number(merged.walkSpeedMetersPerMinute) : DEFAULT_SETTINGS.walkSpeedMetersPerMinute,
        timeDistanceEnabled: merged.timeDistanceEnabled !== false,
        minTraversableRank: merged.minTraversableRank == null ? null : Number(merged.minTraversableRank),
        autoConnectDistanceUnits: (merged.autoConnectDistanceUnits == null || !(Number(merged.autoConnectDistanceUnits) > 0))
            ? null : Number(merged.autoConnectDistanceUnits),
    };
}

function clampUnit(value, fallback = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(1, Math.max(0, n));
}

function sanitizePoint(point) {
    if (!point || typeof point !== 'object') return null;
    return { x: clampUnit(point.x), y: clampUnit(point.y) };
}

function sanitizePolygon(polygon) {
    if (!Array.isArray(polygon) || polygon.length < 3) return null;
    const points = polygon.map(sanitizePoint).filter(Boolean);
    return points.length >= 3 ? points : null;
}

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** `null` (not the neutral fallback other `resolveX` helpers use) means "no custom color — the Module renders its own theme-accent default" — a real, meaningful value distinct from "malformed input", not a fallback to hide one. */
function sanitizeHexColor(value) {
    return typeof value === 'string' && HEX_COLOR_PATTERN.test(value) ? value : null;
}

/** A marker's own radius override, in the same normalized 0..1 units as everything else — `null` means "no override, Module's own default". Capped at 0.1 (10% of the map's square) against a mis-typed huge marker swallowing the whole canvas. */
function sanitizeRadius(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.min(0.1, n) : null;
}

/** Sanitizes a node's shape/hierarchy/metadata fields — does NOT assign `id`/timestamps, that's the Core's job (it owns identity/persistence). */
export function sanitizeNodeInput(input = {}, existing = null) {
    const base = existing ?? {};
    const name = String(input.name ?? base.name ?? '').trim();
    return {
        name,
        description: String(input.description ?? base.description ?? ''),
        parentId: input.parentId !== undefined ? (input.parentId || null) : (base.parentId ?? null),
        rank: input.rank !== undefined ? (input.rank == null ? null : Number(input.rank)) : (base.rank ?? null),
        polygon: input.polygon !== undefined ? sanitizePolygon(input.polygon) : (base.polygon ?? null),
        position: input.position !== undefined ? sanitizePoint(input.position) : (base.position ?? null),
        localMap: input.localMap !== undefined ? sanitizeLocalMap(input.localMap) : (base.localMap ?? null),
        image: input.image !== undefined ? (input.image ?? null) : (base.image ?? null),
        metadata: input.metadata !== undefined ? { ...(input.metadata ?? {}) } : { ...(base.metadata ?? {}) },
        traversable: input.traversable !== undefined ? input.traversable !== false : (base.traversable ?? true),
        /** Custom fill color (region or marker) — owner: "Нужно редактирование цветов регионов". `null` = no override, Module renders its own theme-accent default. */
        color: input.color !== undefined ? sanitizeHexColor(input.color) : (base.color ?? null),
        /** Marker-only display radius override — owner: "[маркеров] размер нужно регулировать". Meaningless for a polygon region (its own points already define its size); `null` = Module's own default radius. */
        radius: input.radius !== undefined ? sanitizeRadius(input.radius) : (base.radius ?? null),
        /** Reserved for future "bind this node's local sub-graph into the memory-graph's region system" (item 7) — untouched by anything in this file yet. */
        graphRegionId: input.graphRegionId !== undefined ? (input.graphRegionId ?? null) : (base.graphRegionId ?? null),
    };
}

function sanitizeLocalMap(localMap) {
    if (!localMap) return null;
    const widthUnits = Number(localMap.widthUnits);
    const heightUnits = Number(localMap.heightUnits);
    return {
        widthUnits: Number.isFinite(widthUnits) && widthUnits > 0 ? widthUnits : null,
        heightUnits: Number.isFinite(heightUnits) && heightUnits > 0 ? heightUnits : null,
    };
}

export function sanitizeEdgeInput(input = {}, existing = null) {
    const base = existing ?? {};
    return {
        fromId: input.fromId !== undefined ? input.fromId : base.fromId,
        toId: input.toId !== undefined ? input.toId : base.toId,
        auto: input.auto !== undefined ? Boolean(input.auto) : (base.auto ?? false),
        traversable: input.traversable !== undefined ? input.traversable !== false : (base.traversable ?? true),
        type: input.type !== undefined ? (input.type || null) : (base.type ?? null),
        costMultiplier: input.costMultiplier !== undefined
            ? (Number(input.costMultiplier) > 0 ? Number(input.costMultiplier) : 1)
            : (base.costMultiplier ?? 1),
        distanceOverrideUnits: input.distanceOverrideUnits !== undefined
            ? (Number.isFinite(Number(input.distanceOverrideUnits)) ? Number(input.distanceOverrideUnits) : null)
            : (base.distanceOverrideUnits ?? null),
    };
}

/** Walks `parentId` up from `nodeId`; throws-free — a broken chain (missing parent) just stops there. */
export function buildContainmentPath(nodes, nodeId) {
    const path = [];
    let currentId = nodeId;
    const seen = new Set();
    while (currentId && nodes[currentId] && !seen.has(currentId)) {
        seen.add(currentId);
        path.unshift(currentId);
        currentId = nodes[currentId].parentId;
    }
    return path;
}

/** True if setting `nodeId`'s parent to `candidateParentId` would make `nodeId` an ancestor of itself. */
export function wouldCreateCycle(nodes, nodeId, candidateParentId) {
    if (!candidateParentId) return false;
    if (candidateParentId === nodeId) return true;
    let currentId = candidateParentId;
    const seen = new Set();
    while (currentId) {
        if (currentId === nodeId) return true;
        if (seen.has(currentId)) return false;
        seen.add(currentId);
        currentId = nodes[currentId]?.parentId ?? null;
    }
    return false;
}

/** Nearest ancestor id that hosts its OWN coordinate space (`localMap` set), or `ROOT_HOST` if none — this, not `parentId` directly, decides which nodes share a coordinate system. */
export function resolveLocalMapHost(nodes, nodeId) {
    let currentId = nodes[nodeId]?.parentId ?? null;
    const seen = new Set();
    while (currentId) {
        if (seen.has(currentId)) return ROOT_HOST;
        seen.add(currentId);
        const node = nodes[currentId];
        if (!node) return ROOT_HOST;
        if (node.localMap) return currentId;
        currentId = node.parentId;
    }
    return ROOT_HOST;
}

/** Real-world {widthUnits, heightUnits} for the local coordinate space hosted by `hostId` (or the root main map) — explicit `localMap` values win, otherwise derived from the parent host divided by `levelScaleCoefficient`. */
export function computeLocalScale(nodes, settings, hostId) {
    if (hostId === ROOT_HOST) {
        return { widthUnits: settings.mapWidthUnits, heightUnits: settings.mapHeightUnits };
    }
    const hostNode = nodes[hostId];
    const localMap = hostNode?.localMap ?? null;
    if (localMap?.widthUnits != null && localMap?.heightUnits != null) {
        return { widthUnits: localMap.widthUnits, heightUnits: localMap.heightUnits };
    }
    const parentHostId = resolveLocalMapHost(nodes, hostId);
    const parentScale = computeLocalScale(nodes, settings, parentHostId);
    return {
        widthUnits: parentScale.widthUnits / settings.levelScaleCoefficient,
        heightUnits: parentScale.heightUnits / settings.levelScaleCoefficient,
    };
}

function polygonCentroid(polygon) {
    const sum = polygon.reduce((acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }), { x: 0, y: 0 });
    return { x: sum.x / polygon.length, y: sum.y / polygon.length };
}

/** A node's representative point in its local coordinate space — polygon centroid if it has one, else its plain marker `position`, else `null` (nothing placed yet). */
export function resolveNodePoint(node) {
    if (!node) return null;
    if (node.polygon) return polygonCentroid(node.polygon);
    if (node.position) return node.position;
    return null;
}

/** Geometric distance (real-world units) between two nodes, or `null` if they don't share a local coordinate space (crossing local maps has no shared geometry — see file doc-comment). */
export function computeDistanceBetweenNodes(nodes, settings, fromId, toId) {
    if (fromId === toId) return 0;
    const hostA = resolveLocalMapHost(nodes, fromId);
    const hostB = resolveLocalMapHost(nodes, toId);
    if (hostA !== hostB) return null;
    const pointA = resolveNodePoint(nodes[fromId]);
    const pointB = resolveNodePoint(nodes[toId]);
    if (!pointA || !pointB) return null;
    const scale = computeLocalScale(nodes, settings, hostA);
    const dx = (pointA.x - pointB.x) * scale.widthUnits;
    const dy = (pointA.y - pointB.y) * scale.heightUnits;
    return Math.sqrt(dx * dx + dy * dy);
}

/** `null` when geometry doesn't apply (cross-local-map manual edge) AND no override was given — pathfinding must skip such an edge rather than crash. */
export function resolveEdgeDistance(nodes, settings, edge) {
    const geometric = computeDistanceBetweenNodes(nodes, settings, edge.fromId, edge.toId);
    if (geometric != null) return geometric;
    return edge.distanceOverrideUnits ?? null;
}

export function computeTravelTimeMinutes(distanceUnits, settings, costMultiplier = 1) {
    if (!settings.timeDistanceEnabled || distanceUnits == null) return null;
    return (distanceUnits / settings.walkSpeedMetersPerMinute) * costMultiplier;
}

function segmentDistance(a1, a2, b1, b2) {
    // Min distance between two 2D segments — closed-form via the four
    // endpoint-to-segment distances, sufficient for border-touch detection
    // (exact segment-segment closest point isn't needed, just "close enough").
    const distToSegment = (p, s1, s2) => {
        const dx = s2.x - s1.x, dy = s2.y - s1.y;
        const lengthSq = dx * dx + dy * dy;
        if (lengthSq === 0) return Math.hypot(p.x - s1.x, p.y - s1.y);
        let t = ((p.x - s1.x) * dx + (p.y - s1.y) * dy) / lengthSq;
        t = Math.min(1, Math.max(0, t));
        return Math.hypot(p.x - (s1.x + t * dx), p.y - (s1.y + t * dy));
    };
    return Math.min(
        distToSegment(a1, b1, b2), distToSegment(a2, b1, b2),
        distToSegment(b1, a1, a2), distToSegment(b2, a1, a2),
    );
}

/** True if any edge segment of `polygonA` comes within `tolerance` (normalized units, same local coordinate space) of any edge segment of `polygonB`. */
export function detectPolygonAdjacency(polygonA, polygonB, tolerance = 0.01) {
    if (!polygonA || !polygonB) return false;
    for (let i = 0; i < polygonA.length; i += 1) {
        const a1 = polygonA[i];
        const a2 = polygonA[(i + 1) % polygonA.length];
        for (let j = 0; j < polygonB.length; j += 1) {
            const b1 = polygonB[j];
            const b2 = polygonB[(j + 1) % polygonB.length];
            if (segmentDistance(a1, a2, b1, b2) <= tolerance) return true;
        }
    }
    return false;
}

/** Every OTHER node sharing `nodeId`'s local coordinate space whose polygon border touches its own — the auto-adjacency scan run on node create/update. */
export function findAdjacentNodeIds(nodes, nodeId, tolerance = 0.01) {
    const node = nodes[nodeId];
    if (!node?.polygon) return [];
    const host = resolveLocalMapHost(nodes, nodeId);
    const result = [];
    for (const [otherId, other] of Object.entries(nodes)) {
        if (otherId === nodeId || !other.polygon) continue;
        if (resolveLocalMapHost(nodes, otherId) !== host) continue;
        if (detectPolygonAdjacency(node.polygon, other.polygon, tolerance)) result.push(otherId);
    }
    return result;
}

/**
 * Snaps `point` to the nearest existing polygon VERTEX among `nodes`
 * sharing `hostId`'s local coordinate space, if one is within `tolerance`
 * — lets a user drawing a new region's border land it EXACTLY on a
 * neighboring region's corner instead of a few pixels off (owner: "Если
 * регионы очень близко друг к другу... нужно их подтягивать для
 * формирования границ" — a visually-touching-but-not-quite border
 * silently misses `findAdjacentNodeIds()`'s own border-touch detection).
 * Same default `tolerance` as `findAdjacentNodeIds()` itself, so a snapped
 * point is GUARANTEED to register as touching, not just close-looking.
 * Returns `point` unchanged when nothing is within tolerance.
 */
export function snapPointToNearbyVertex(point, nodes, hostId, tolerance = 0.01) {
    let best = null;
    let bestDistance = tolerance;
    for (const [id, node] of Object.entries(nodes)) {
        if (!node.polygon) continue;
        if (resolveLocalMapHost(nodes, id) !== hostId) continue;
        for (const vertex of node.polygon) {
            const distance = Math.hypot(vertex.x - point.x, vertex.y - point.y);
            if (distance < bestDistance) { bestDistance = distance; best = vertex; }
        }
    }
    return best ? { x: best.x, y: best.y } : point;
}

/** Standard ray-casting point-in-polygon test — `polygon` and `point` share the same local normalized space. */
export function isPointInPolygon(point, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
        const a = polygon[i];
        const b = polygon[j];
        const crosses = (a.y > point.y) !== (b.y > point.y)
            && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
        if (crosses) inside = !inside;
    }
    return inside;
}

/** Shoelace formula — used only to pick the SMALLEST (most specific) enclosing region when a point falls inside several nested polygons at once. */
function computePolygonArea(polygon) {
    let sum = 0;
    for (let i = 0; i < polygon.length; i += 1) {
        const a = polygon[i];
        const b = polygon[(i + 1) % polygon.length];
        sum += a.x * b.y - b.x * a.y;
    }
    return Math.abs(sum) / 2;
}

/**
 * The automatic containment a newly placed marker/region gets (ROADMAP.md
 * 5.53, owner: "я все ещё не могу добавить локацию внутрь региона физически
 * нажав на него... Убери фишку с parental в меню, это должно быть
 * автоматически") — the smallest polygon-region, among nodes sharing
 * `hostId`'s local coordinate space, whose border actually contains
 * `point`. When several nested regions all contain the point, the smallest
 * one wins (a room inside a building inside a district — dropping a marker
 * in the room should parent it to the room, not the district). `excludeId`
 * skips a node checking against its own polygon (relevant if this is ever
 * re-run against an existing node's own shape). Returns `null` for "no
 * containing region" — top-level, exactly like before this existed.
 */
export function findContainingNodeId(nodes, point, hostId, excludeId = null) {
    let bestId = null;
    let bestArea = Infinity;
    for (const [id, node] of Object.entries(nodes)) {
        if (id === excludeId || !node.polygon) continue;
        if (resolveLocalMapHost(nodes, id) !== hostId) continue;
        if (!isPointInPolygon(point, node.polygon)) continue;
        const area = computePolygonArea(node.polygon);
        if (area < bestArea) { bestArea = area; bestId = id; }
    }
    return bestId;
}

/**
 * Every OTHER node sharing `nodeId`'s local coordinate space whose real-world
 * distance to it is within `maxDistanceUnits` — the proximity-based
 * alternative to `findAdjacentNodeIds()`'s polygon-border-touch requirement
 * (owner: "построение соединений - требует границ. А что если пользователь
 * не хочет отмечать границы всего? Добавь авто-дистанцию по расстоянию между
 * границами."). Works for ANY node with a resolvable point — markers
 * included, not just polygons. `maxDistanceUnits` of `null`/`0`/negative
 * means the feature is off (see `DEFAULT_SETTINGS.autoConnectDistanceUnits`).
 */
export function findNodesWithinDistance(nodes, settings, nodeId, maxDistanceUnits) {
    if (!(Number(maxDistanceUnits) > 0)) return [];
    if (!nodes[nodeId]) return [];
    const result = [];
    for (const otherId of Object.keys(nodes)) {
        if (otherId === nodeId) continue;
        const distance = computeDistanceBetweenNodes(nodes, settings, nodeId, otherId);
        if (distance != null && distance <= maxDistanceUnits) result.push(otherId);
    }
    return result;
}

function isNodeTraversable(nodes, settings, nodeId) {
    const node = nodes[nodeId];
    if (!node || node.traversable === false) return false;
    if (settings.minTraversableRank == null || node.rank == null) return true;
    return node.rank >= settings.minTraversableRank;
}

/** Weighted adjacency list keyed by node id, restricted to traversable nodes/edges — the graph `findRoutes()`/`findShortestPath()` actually walk. `edgeWeights` (edgeId -> distance) lets a caller re-total a path's distance without re-deriving it from geometry. */
function buildTraversalGraph(nodes, edges, settings) {
    const graph = new Map();
    const edgeWeights = new Map();
    for (const edge of Object.values(edges)) {
        if (edge.traversable === false) continue;
        if (!isNodeTraversable(nodes, settings, edge.fromId) || !isNodeTraversable(nodes, settings, edge.toId)) continue;
        const distance = resolveEdgeDistance(nodes, settings, edge);
        if (distance == null) continue;
        if (!graph.has(edge.fromId)) graph.set(edge.fromId, []);
        if (!graph.has(edge.toId)) graph.set(edge.toId, []);
        graph.get(edge.fromId).push({ nodeId: edge.toId, edgeId: edge.id, distance });
        graph.get(edge.toId).push({ nodeId: edge.fromId, edgeId: edge.id, distance });
        edgeWeights.set(edge.id, distance);
    }
    return { graph, edgeWeights };
}

function sameRootPath(routeNodeIds, rootNodeIds) {
    return rootNodeIds.every((id, index) => routeNodeIds[index] === id);
}

/** Plain Dijkstra over the traversal graph; `excludedEdgeIds`/`excludedNodeIds` support Yen's k-shortest-paths algorithm in `findRoutes()`. */
function findShortestPath(graph, fromId, toId, { excludedEdgeIds = new Set(), excludedNodeIds = new Set() } = {}) {
    const distances = new Map([[fromId, 0]]);
    const previous = new Map();
    const visited = new Set();
    const queue = new Set([fromId]);

    while (queue.size > 0) {
        let currentId = null;
        let currentDistance = Infinity;
        for (const candidate of queue) {
            const distance = distances.get(candidate) ?? Infinity;
            if (distance < currentDistance) { currentDistance = distance; currentId = candidate; }
        }
        queue.delete(currentId);
        if (currentId == null || visited.has(currentId)) continue;
        visited.add(currentId);
        if (currentId === toId) break;

        for (const neighbor of graph.get(currentId) ?? []) {
            if (excludedNodeIds.has(neighbor.nodeId) || excludedEdgeIds.has(neighbor.edgeId)) continue;
            if (visited.has(neighbor.nodeId)) continue;
            const candidateDistance = currentDistance + neighbor.distance;
            if (candidateDistance < (distances.get(neighbor.nodeId) ?? Infinity)) {
                distances.set(neighbor.nodeId, candidateDistance);
                previous.set(neighbor.nodeId, { nodeId: currentId, edgeId: neighbor.edgeId });
                queue.add(neighbor.nodeId);
            }
        }
    }

    if (!distances.has(toId)) return null;
    const nodeIds = [toId];
    const edgeIds = [];
    let cursor = toId;
    while (cursor !== fromId) {
        const step = previous.get(cursor);
        if (!step) return null;
        edgeIds.unshift(step.edgeId);
        nodeIds.unshift(step.nodeId);
        cursor = step.nodeId;
    }
    return { nodeIds, edgeIds, totalDistanceUnits: distances.get(toId) };
}

/**
 * Finds up to `maxRoutes` loopless routes from `fromId` to `toId`, shortest
 * first, via Yen's algorithm over `findShortestPath()`. Only walks
 * ADJACENCY edges among traversable nodes (see `isNodeTraversable` —
 * `settings.minTraversableRank` excludes abstract-only levels entirely).
 * Returns `{ routes: [], reason }` (never throws) when no route exists —
 * `reason` distinguishes "same node", "unknown node", and "no path" so a
 * caller (Core contract) can surface why.
 */
export function findRoutes(nodes, edges, settings, { fromId, toId, maxRoutes = 1 } = {}) {
    if (!nodes[fromId] || !nodes[toId]) return { routes: [], reason: 'unknown-node' };
    if (fromId === toId) return { routes: [{ nodeIds: [fromId], edgeIds: [], totalDistanceUnits: 0, totalTimeMinutes: 0 }], reason: null };

    const { graph, edgeWeights } = buildTraversalGraph(nodes, edges, settings);
    const first = findShortestPath(graph, fromId, toId);
    if (!first) return { routes: [], reason: 'no-path' };

    const found = [first];
    const candidates = [];
    const limit = Math.max(1, Number(maxRoutes) || 1);

    while (found.length < limit) {
        const previousRoute = found[found.length - 1];
        for (let i = 0; i < previousRoute.nodeIds.length - 1; i += 1) {
            const spurNodeId = previousRoute.nodeIds[i];
            const rootNodeIds = previousRoute.nodeIds.slice(0, i + 1);
            const rootEdgeIds = previousRoute.edgeIds.slice(0, i);

            // Yen's rule: any already-found route sharing this exact root
            // path must have its NEXT edge (position i) blocked, forcing the
            // spur search to diverge instead of just rediscovering it.
            const excludedEdgeIds = new Set();
            for (const route of found) {
                if (route.nodeIds.length > i && sameRootPath(route.nodeIds, rootNodeIds)) {
                    if (route.edgeIds[i] != null) excludedEdgeIds.add(route.edgeIds[i]);
                }
            }
            const excludedNodeIds = new Set(rootNodeIds.slice(0, i));
            const spurPath = findShortestPath(graph, spurNodeId, toId, { excludedEdgeIds, excludedNodeIds });
            if (!spurPath) continue;

            const totalNodeIds = [...rootNodeIds.slice(0, i), ...spurPath.nodeIds];
            const totalEdgeIds = [...rootEdgeIds, ...spurPath.edgeIds];
            const totalDistanceUnits = totalEdgeIds.reduce((sum, edgeId) => sum + (edgeWeights.get(edgeId) ?? 0), 0);
            const key = totalNodeIds.join('>');
            if (![...found, ...candidates].some(route => route.nodeIds.join('>') === key)) {
                candidates.push({ nodeIds: totalNodeIds, edgeIds: totalEdgeIds, totalDistanceUnits });
            }
        }
        if (candidates.length === 0) break;
        candidates.sort((a, b) => a.totalDistanceUnits - b.totalDistanceUnits);
        found.push(candidates.shift());
    }

    return {
        routes: found.map(route => ({ ...route, totalTimeMinutes: computeTravelTimeMinutes(route.totalDistanceUnits, settings) })),
        reason: null,
    };
}
