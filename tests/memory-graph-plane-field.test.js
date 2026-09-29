import test from 'node:test';
import assert from 'node:assert/strict';
import { computePlaneOutline, planeRadiusAt, regionFieldAt, dominantBlend, hslToRgb } from '../cores/ui/memory-graph/plane-field.js';

function buildZones(specs) {
    return specs.map((spec, index) => ({
        regionId: spec.regionId ?? `r${index}`, label: spec.regionId ?? `r${index}`,
        a0: spec.a0, a1: spec.a1, rInner: 0, rOuter: spec.rOuter, anchor: { x: 0, y: 0 },
        count: 1, capacity: 23, hue: (360 * index) / specs.length,
    }));
}

// --- planeRadiusAt() / computePlaneOutline() --------------------------------

test('planeRadiusAt() returns 0 for an empty zone list — nothing to draw', () => {
    assert.equal(planeRadiusAt(0, []), 0);
});

test('computePlaneOutline() returns an empty outline for an empty zone list', () => {
    assert.deepEqual(computePlaneOutline([]), { points: [] });
});

test('planeRadiusAt() always stays outside the real outer edge of every zone, even at the harmonics\' worst combined phase', () => {
    const zones = buildZones([
        { a0: -Math.PI, a1: -Math.PI / 3, rOuter: 60 },
        { a0: -Math.PI / 3, a1: Math.PI / 3, rOuter: 200 },
        { a0: Math.PI / 3, a1: Math.PI, rOuter: 90 },
    ]);
    for (const zone of zones) {
        const angle = (zone.a0 + zone.a1) / 2;
        const radius = planeRadiusAt(angle, zones);
        assert.ok(radius > zone.rOuter, `at ${zone.regionId}'s own bisector, plane radius ${radius.toFixed(1)} must exceed its rOuter ${zone.rOuter}`);
    }
});

test('planeRadiusAt() never dips below a single zone\'s own rOuter at ANY angle — a dense angular sweep must pass through the harmonics\' actual worst combined phase, not just a few incidental bisectors', () => {
    // Один-единственный регион на весь круг: smoothZoneRadiusAt() тогда возвращает ровно rOuter на ЛЮБОЙ угол
    // (короткий путь при zoneSamples.length===1) — planeRadiusAt(angle) = rOuter * expansion * wobbleFactor(angle).
    // Плотный перебор (720 точек) гарантированно проходит рядом с ХУДШЕЙ комбинированной фазой всех гармоник —
    // в отличие от теста выше (всего 3 фиксированных биссектрисы, которые могут случайно её не задеть).
    const zones = buildZones([{ a0: -Math.PI, a1: Math.PI, rOuter: 100 }]);
    let worst = Infinity;
    for (let i = 0; i < 720; i += 1) {
        const angle = (i / 720) * 2 * Math.PI - Math.PI;
        worst = Math.min(worst, planeRadiusAt(angle, zones));
    }
    assert.ok(worst > zones[0].rOuter, `worst-case plane radius across a dense sweep (${worst.toFixed(2)}) must still exceed rOuter (${zones[0].rOuter})`);
});

test('computePlaneOutline() is smooth — no sharp jump in radius between adjacent sampled points, even across a big size difference between neighboring zones', () => {
    const zones = buildZones([
        { a0: -Math.PI, a1: -Math.PI / 3, rOuter: 50 },
        { a0: -Math.PI / 3, a1: Math.PI / 3, rOuter: 220 },
        { a0: Math.PI / 3, a1: Math.PI, rOuter: 50 },
    ]);
    const { points } = computePlaneOutline(zones);
    for (let i = 0; i < points.length; i += 1) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        const step = Math.hypot(b.x - a.x, b.y - a.y);
        assert.ok(step < 40, `outline step ${i}->${i + 1} moved ${step.toFixed(1)}px in one sample — too abrupt for a smooth blob`);
    }
});

test('computePlaneOutline() is deterministic — the same zones always produce the same outline', () => {
    const zones = buildZones([{ a0: 0, a1: Math.PI, rOuter: 80 }, { a0: Math.PI, a1: 2 * Math.PI, rOuter: 120 }]);
    assert.deepEqual(computePlaneOutline(zones), computePlaneOutline(zones));
});

// --- regionFieldAt() ---------------------------------------------------------

test('regionFieldAt() strength from a single node strictly decreases as distance grows', () => {
    const nodePoints = [{ x: 0, y: 0, regionId: 'a' }];
    const near = regionFieldAt(30, 0, nodePoints).get('a');
    const far = regionFieldAt(300, 0, nodePoints).get('a');
    assert.ok(near > far);
});

test('regionFieldAt() sums contributions — a two-node cluster gives noticeably MORE combined strength than a single lone node at essentially the same distance (density is emergent, not a separate formula)', () => {
    const clusterPoints = [{ x: -5, y: 0, regionId: 'dense' }, { x: 5, y: 0, regionId: 'dense' }];
    const lonePoints = [{ x: 0, y: 0, regionId: 'sparse' }];
    const denseStrength = regionFieldAt(0, 100, clusterPoints).get('dense');
    const sparseStrength = regionFieldAt(0, 100, lonePoints).get('sparse');
    assert.ok(denseStrength > sparseStrength * 1.8, `a 2-node cluster (${denseStrength}) must clearly beat a lone node (${sparseStrength}) at ~the same distance`);
});

test('regionFieldAt() keeps different regions independent, attributed by regionId', () => {
    const nodePoints = [{ x: 0, y: 0, regionId: 'a' }, { x: 100, y: 0, regionId: 'b' }];
    const fields = regionFieldAt(0, 0, nodePoints);
    assert.ok(fields.get('a') > fields.get('b'));
});

test('regionFieldAt() guarantees a minimum zone around a lone node even when a large, properly-spaced dense foreign cluster would otherwise out-sum it', () => {
    // Ручной расчёт (см. doc-comment MIN_REGION_RADIUS в plane-field.js): точка (10,0), слабая нода в (0,0) —
    // дистанция 10, база 1/(100+100)=0.005. 20 чужих нод РОВНО на дистанции 30 (вне MIN_REGION_RADIUS=26, бонуса
    // не получают вовсе) — суммарная база 20*1/(900+100)=0.02, БЕЗ бонуса чужой кластер выигрывает (0.02 > 0.005).
    // С бонусом слабая нода должна выигрывать за явным перевесом.
    const weakNode = { x: 0, y: 0, regionId: 'weak' };
    const denseCluster = Array.from({ length: 20 }, () => ({ x: 40, y: 0, regionId: 'dense' }));
    const fields = regionFieldAt(10, 0, [weakNode, ...denseCluster]);
    const [dominantRegion] = [...fields.entries()].sort((a, b) => b[1] - a[1])[0];
    assert.equal(dominantRegion, 'weak', `close to the lone node its own region must dominate — got fields ${JSON.stringify([...fields])}`);
});

// --- dominantBlend() ---------------------------------------------------------

test('dominantBlend() returns the pure color of the only region present, with real (non-zero) alpha', () => {
    const fields = new Map([['a', 5]]);
    const result = dominantBlend(fields, new Map([['a', 0]]));
    const [er, eg, eb] = hslToRgb(0, 60, 55);
    assert.ok(Math.abs(result.r - er) < 0.01 && Math.abs(result.g - eg) < 0.01 && Math.abs(result.b - eb) < 0.01);
    assert.ok(result.a > 0.1, 'a single, reasonably close region must not render nearly invisible');
});

test('dominantBlend() returns transparent black for an empty field map', () => {
    assert.deepEqual(dominantBlend(new Map(), new Map()), { r: 0, g: 0, b: 0, a: 0 });
});

test('dominantBlend() blends two EQUALLY strong regions 50/50 — the average of their pure colors', () => {
    const fields = new Map([['a', 3], ['b', 3]]);
    const hueByRegionId = new Map([['a', 0], ['b', 240]]);
    const result = dominantBlend(fields, hueByRegionId);
    const [ar, ag, ab] = hslToRgb(0, 60, 55);
    const [br, bg, bb] = hslToRgb(240, 60, 55);
    assert.ok(Math.abs(result.r - (ar + br) / 2) < 0.01);
    assert.ok(Math.abs(result.g - (ag + bg) / 2) < 0.01);
    assert.ok(Math.abs(result.b - (ab + bb) / 2) < 0.01);
});

test('dominantBlend() alpha does not depend on the field\'s absolute magnitude — only on border-vs-fill (real bug found live: alpha used to fade with distance, leaving almost the whole "plane" unpainted; then a second live bug — flat full alpha everywhere made borders and fills look equally bright)', () => {
    const weakFill = dominantBlend(new Map([['a', 0.0001]]), new Map([['a', 0]]));
    const strongFill = dominantBlend(new Map([['a', 50]]), new Map([['a', 0]]));
    assert.equal(weakFill.a, strongFill.a, 'a lone region\'s alpha must not depend on the field\'s absolute magnitude at all');
    const weakBorder = dominantBlend(new Map([['a', 0.0001], ['b', 0.0001]]), new Map([['a', 0], ['b', 240]]));
    const strongBorder = dominantBlend(new Map([['a', 50], ['b', 50]]), new Map([['a', 0], ['b', 240]]));
    assert.equal(weakBorder.a, strongBorder.a, 'a border\'s alpha must not depend on the field\'s absolute magnitude either');
});

test('dominantBlend() paints the BORDER between two equally strong regions at full brightness, and the FILL deep inside a single dominant region much more transparently — real bug found live: the whole blob used to be painted at flat full opacity, borders and fills looked identically bright, screenshot complaint was "borders should stay this bright, but the fill should be much more transparent"', () => {
    const border = dominantBlend(new Map([['a', 5], ['b', 5]]), new Map([['a', 0], ['b', 240]]));
    const fill = dominantBlend(new Map([['a', 5], ['b', 0.0001]]), new Map([['a', 0], ['b', 240]]));
    assert.equal(border.a, 1, 'an even tie between two regions is the definition of a border — must render at full alpha');
    assert.ok(fill.a < 0.3, `deep inside one region's own territory the fill must be noticeably dimmer than the border (got ${fill.a})`);
    assert.ok(border.a > fill.a);
});

test('dominantBlend() treats a single region with no competitor in the field as pure fill (dim), not as a border — there is no neighbor to form a seam with', () => {
    const result = dominantBlend(new Map([['a', 10]]), new Map([['a', 0]]));
    assert.ok(result.a < 0.3, `a lone region with no neighbor in reach must render as dim fill (got ${result.a})`);
});

test('dominantBlend() narrows the color transition as sharpness increases, for the same unequal field strengths', () => {
    const fields = new Map([['a', 2], ['b', 1]]);
    const hueByRegionId = new Map([['a', 0], ['b', 240]]);
    const soft = dominantBlend(fields, hueByRegionId, { sharpness: 1 });
    const sharp = dominantBlend(fields, hueByRegionId, { sharpness: 6 });
    const [ar, ag, ab] = hslToRgb(0, 60, 55);
    const distSoft = Math.hypot(soft.r - ar, soft.g - ag, soft.b - ab);
    const distSharp = Math.hypot(sharp.r - ar, sharp.g - ag, sharp.b - ab);
    assert.ok(distSharp < distSoft, `higher sharpness (${distSharp.toFixed(1)}) must land closer to the dominant region's pure color than lower sharpness (${distSoft.toFixed(1)})`);
});
