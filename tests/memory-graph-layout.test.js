import test from 'node:test';
import assert from 'node:assert/strict';
import {
    NODE_RADIUS, nodeRadius, GAP, minCenterDistance, layoutRegion, layoutGraph, zoneAt, zonePath,
} from '../cores/ui/memory-graph/layout.js';

// --- 3.1 nodeRadius() ------------------------------------------------------

test('nodeRadius() grows with the number of connections and caps at NODE_RADIUS.max', () => {
    const r0 = nodeRadius({ degree: 0 });
    const r5 = nodeRadius({ degree: 5 });
    const r50 = nodeRadius({ degree: 50 });
    assert.equal(r0, NODE_RADIUS.min);
    assert.ok(r5 > r0, 'more connections must mean a visibly bigger node');
    assert.ok(r50 > r5);
    assert.equal(r50, NODE_RADIUS.max, 'growth must stop exactly at the configured ceiling, not overshoot it');
});

test('nodeRadius() adds the protected bonus ON TOP of the cap — a protected node can exceed NODE_RADIUS.max', () => {
    const protectedAtCap = nodeRadius({ degree: 999, protectedNode: true });
    assert.equal(protectedAtCap, NODE_RADIUS.max + NODE_RADIUS.protectedBonus);
});

// --- 3.2 minCenterDistance() -------------------------------------------------

test('minCenterDistance() grows with the LARGER of the two radii, not their sum alone', () => {
    const small = minCenterDistance(4, 4);
    const big = minCenterDistance(4, 16);
    assert.ok(big > small + 12, 'the gap component itself must scale with the bigger node, not just add a flat constant');
    assert.equal(minCenterDistance(4, 16), 4 + 16 + GAP.base + GAP.perRadius * 16);
});

// --- 3.3 layoutRegion() ------------------------------------------------------

/** 23 ноды разного "веса" (разная degree -> разный радиус) — тот же реальный потолок региона, что у Ядра (maxNodesPerRegion). */
function buildRegionMembers(count, { withCenter = true } = {}) {
    const members = [];
    for (let i = 0; i < count; i += 1) {
        members.push({ id: `n${i}`, degree: i % 7, protectedNode: withCenter && i === 0, createdAt: i });
    }
    return members;
}

test('layoutRegion() keeps EVERY pair of nodes at least minCenterDistance apart, even with 23 differently-sized nodes', () => {
    const members = buildRegionMembers(23);
    const { positions } = layoutRegion(members, { centerId: 'n0', subCenterIds: ['n1', 'n2'] });
    const entries = [...positions.entries()].map(([id, pos]) => ({ id, pos, r: nodeRadius(members.find(m => m.id === id)) }));
    for (let i = 0; i < entries.length; i += 1) {
        for (let j = i + 1; j < entries.length; j += 1) {
            const dx = entries[i].pos.x - entries[j].pos.x;
            const dy = entries[i].pos.y - entries[j].pos.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            const required = minCenterDistance(entries[i].r, entries[j].r);
            assert.ok(distance >= required - 1e-6, `${entries[i].id} and ${entries[j].id} are ${distance.toFixed(2)}px apart, need >= ${required.toFixed(2)}`);
        }
    }
});

test('layoutRegion() never shifts an already-placed node when a NEW (latest createdAt) node joins', () => {
    const members = buildRegionMembers(10);
    const before = layoutRegion(members, { centerId: 'n0', subCenterIds: ['n1'] }).positions;

    const withNewcomer = [...members, { id: 'newcomer', degree: 3, createdAt: 999 }];
    const after = layoutRegion(withNewcomer, { centerId: 'n0', subCenterIds: ['n1'] }).positions;

    for (const [id, pos] of before) {
        assert.deepEqual(after.get(id), pos, `${id}'s position must not move when a later node is added`);
    }
    assert.ok(after.has('newcomer'));
});

test('layoutRegion() seats the center at the anchor (0,0), and the first ordinary node there instead if there is no center', () => {
    const members = buildRegionMembers(3, { withCenter: false });
    const { positions } = layoutRegion(members, { centerId: null, subCenterIds: [] });
    assert.deepEqual(positions.get('n0'), { x: 0, y: 0 }, 'no center at all — the first node by creation order takes the anchor');
});

test('layoutRegion() is deterministic — the same input always produces the same positions', () => {
    const members = buildRegionMembers(15);
    const first = layoutRegion(members, { centerId: 'n0', subCenterIds: ['n1', 'n2'] });
    const second = layoutRegion(members, { centerId: 'n0', subCenterIds: ['n1', 'n2'] });
    assert.deepEqual([...first.positions.entries()], [...second.positions.entries()]);
    assert.equal(first.radius, second.radius);
});

// --- 3.4/3.5 layoutGraph() / zoneAt() ----------------------------------------

/** 15 регионов дартборда (5 секторов x 3 кольца), каждый с несколько нод — тот же масштаб, что реальный полный граф. */
function buildFullGraph() {
    const nodes = [];
    const regions = {};
    let nodeIndex = 0;
    for (let sector = 0; sector < 5; sector += 1) {
        for (let ring = 0; ring < 3; ring += 1) {
            const key = `${sector}:${ring}`;
            const memberIds = [];
            const memberCount = 1 + ((sector + ring) % 4); // 1..4 нод на регион — разная площадь диска у разных зон
            for (let i = 0; i < memberCount; i += 1) {
                const id = `node${nodeIndex}`;
                nodeIndex += 1;
                nodes.push({ id, regionId: key, degree: i, protectedNode: i === 0, createdAt: nodeIndex });
                memberIds.push(id);
            }
            regions[key] = { centerNodeId: memberIds[0], subCenterIds: [], nodeIds: memberIds, label: key };
        }
    }
    return { nodes, regions };
}

test('layoutGraph() with 15 regions: zones do not overlap by angle, and every node lands inside its OWN zone via zoneAt()', () => {
    const { nodes, regions } = buildFullGraph();
    const { positions, zones } = layoutGraph(nodes, regions);

    assert.equal(zones.length, 15, 'sanity: one zone per region, no staging zone (nothing unplaced)');

    // Никакие две зоны не пересекаются по углу — сумма промежутков равна полному кругу, без наложений.
    const sorted = [...zones].sort((a, b) => a.a0 - b.a0);
    for (let i = 1; i < sorted.length; i += 1) {
        assert.ok(sorted[i].a0 >= sorted[i - 1].a1 - 1e-9, `zone ${sorted[i].regionId} starts before the previous zone ${sorted[i - 1].regionId} ends`);
    }

    for (const node of nodes) {
        const pos = positions.get(node.id);
        const zone = zoneAt(pos.x, pos.y, zones);
        assert.ok(zone, `node ${node.id} at (${pos.x},${pos.y}) must land inside SOME zone`);
        assert.equal(zone.regionId, node.regionId, `node ${node.id} landed in zone "${zone.regionId}", expected its own region "${node.regionId}"`);
    }
});

test('layoutGraph() keeps a node inside its own zone even when that zone is NARROW but the region\'s disk is large (stresses the tangent-circle anchorRadius formula, not just "anchor beyond the disk")', () => {
    // 150 крошечных регионов "съедают" почти весь круг через floor minAngle — после перенормировки (которая
    // делит ВСЕ углы на один и тот же коэффициент) региону "big" достаётся угол в разы уже, чем его площадь
    // "заслуживает" (halfAngle получается около 1-2°). Наивная anchorRadius = innerHole + R отодвигает диск
    // региона "big" от центра ровно на его радиус — этого достаточно, только если halfAngle >= 90°, что здесь
    // заведомо не так. Формула по касательной окружности (R / sin(halfAngle)) обязана отодвинуть диск в разы
    // дальше, чтобы он весь остался внутри своего узкого углового клина.
    const nodes = [];
    const regions = {};
    const key = 'big';
    const memberIds = [];
    for (let m = 0; m < 20; m += 1) {
        const id = `bigN${m}`;
        nodes.push({ id, regionId: key, degree: m % 5, protectedNode: m === 0, createdAt: m });
        memberIds.push(id);
    }
    regions[key] = { centerNodeId: memberIds[0], subCenterIds: [], nodeIds: memberIds, label: key };
    for (let i = 0; i < 150; i += 1) {
        const smallKey = `tiny${i}`;
        const id = `tiny${i}n0`;
        nodes.push({ id, regionId: smallKey, degree: 0, protectedNode: true, createdAt: 1000 + i });
        regions[smallKey] = { centerNodeId: id, subCenterIds: [], nodeIds: [id], label: smallKey };
    }
    const { positions, zones } = layoutGraph(nodes, regions, { innerHole: 0 });
    const bigZone = zones.find(zone => zone.regionId === 'big');
    assert.ok(bigZone.a1 - bigZone.a0 < Math.PI / 15, 'sanity: the flooded floor must actually squeeze "big" into a narrow angle for this check to mean anything');
    for (const node of nodes.filter(n => n.regionId === 'big')) {
        const pos = positions.get(node.id);
        const zone = zoneAt(pos.x, pos.y, zones);
        assert.equal(zone?.regionId, 'big', `node ${node.id} must land inside its OWN zone even when that zone is squeezed narrow by many other floored regions`);
    }
});

test('layoutGraph() keeps sane, finite coordinates for a graph with EXACTLY ONE region — no staging wedge to share the circle with, so that region\'s halfAngle approaches π', () => {
    // Реальный найденный баг (не поймали тесты выше — все берут 2+ региона): при ОДНОМ регионе он получает ПОЧТИ
    // весь круг, halfAngle → π, а `R/sin(halfAngle)` (без зажима сверху π/2) делит на sin(π) ≈ 1.2e-16 и раздувает
    // anchorRadius до ~1.5e17 — координаты узла улетают в астрономические числа вместо разумных десятков пикселей.
    const nodes = [{ id: 'n0', regionId: 'Solo', degree: 0, protectedNode: true, createdAt: 0 }];
    const regions = { Solo: { centerNodeId: 'n0', subCenterIds: [], nodeIds: ['n0'], label: 'Solo' } };
    const { positions, zones } = layoutGraph(nodes, regions);
    const pos = positions.get('n0');
    assert.ok(Number.isFinite(pos.x) && Number.isFinite(pos.y), 'position must be finite');
    assert.ok(Math.hypot(pos.x, pos.y) < 1000, `a single tiny node's distance from the canvas center must stay sane (got ${Math.hypot(pos.x, pos.y)}), not astronomical`);
    assert.equal(zoneAt(pos.x, pos.y, zones)?.regionId, 'Solo', 'the node must still land inside its own (now correctly finite) zone');
});

test('layoutGraph() is deterministic — the same graph always produces the same positions and zones', () => {
    const { nodes, regions } = buildFullGraph();
    const first = layoutGraph(nodes, regions);
    const second = layoutGraph(nodes, regions);
    assert.deepEqual([...first.positions.entries()], [...second.positions.entries()]);
    assert.deepEqual(first.zones, second.zones);
});

test('layoutGraph() gives the накопитель (regionId: null) its OWN zone, separate from every real region', () => {
    const { nodes, regions } = buildFullGraph();
    nodes.push({ id: 'staged1', regionId: null, degree: 0, createdAt: 9999 });
    nodes.push({ id: 'staged2', regionId: null, degree: 1, createdAt: 10000 });
    const { positions, zones } = layoutGraph(nodes, regions);

    const stagingZone = zones.find(zone => zone.regionId === null);
    assert.ok(stagingZone, 'a null-regionId zone must exist once there is at least one staged node');
    assert.equal(stagingZone.label, 'Unplaced');

    for (const id of ['staged1', 'staged2']) {
        const pos = positions.get(id);
        assert.equal(zoneAt(pos.x, pos.y, zones)?.regionId, null, `${id} must land in the staging zone, not a real region`);
    }
});

test('zoneAt() returns null for an empty spot far outside every zone', () => {
    const { nodes, regions } = buildFullGraph();
    const { zones } = layoutGraph(nodes, regions);
    assert.equal(zoneAt(100000, 100000, zones), null);
});

test('zonePath() returns a well-formed SVG path for both a wedge-from-center zone and a ring-segment zone', () => {
    const { nodes, regions } = buildFullGraph();
    const { zones } = layoutGraph(nodes, regions);
    for (const zone of zones) {
        const path = zonePath(zone);
        assert.match(path, /^M /, `zone ${zone.regionId}'s path must start with a moveto`);
        assert.match(path, /Z$/, `zone ${zone.regionId}'s path must close`);
    }
});
