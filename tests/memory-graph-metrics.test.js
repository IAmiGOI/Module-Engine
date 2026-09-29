import test from 'node:test';
import assert from 'node:assert/strict';
import { METRICS, findMetric, metricColor, metricDomain, glowValue, averageHue } from '../cores/ui/memory-graph/metrics.js';

const weight = findMetric('weight');
const risk = findMetric('risk');
const region = findMetric('region');
const source = findMetric('source');
const connections = findMetric('connections');
const retrieved = findMetric('retrieved');

test('METRICS lists exactly the 9 metrics the plan names, each with the fields metricColor()/metricDomain() need', () => {
    const ids = METRICS.map(metric => metric.id).sort();
    assert.deepEqual(ids, ['age', 'connections', 'idle', 'importance', 'region', 'retrieved', 'risk', 'source', 'weight']);
    for (const metric of METRICS) {
        assert.equal(typeof metric.value, 'function', `${metric.id} needs value()`);
        assert.ok(['rank', 'linear', 'categorical'].includes(metric.scale), `${metric.id} needs a valid scale`);
        assert.equal(typeof metric.format, 'function', `${metric.id} needs format()`);
    }
});

test('findMetric() falls back to the first metric (weight) for an unknown id — the UI always has SOMETHING to render', () => {
    assert.equal(findMetric('does-not-exist'), METRICS[0]);
});

test('metricColor() for weight: 0 -> red, 1 -> green, 0.5 -> amber (plan\'s own example, Этап 6.7)', () => {
    assert.equal(metricColor(weight, 0), '#e74c3c');
    assert.equal(metricColor(weight, 1), '#2ecc71');
    assert.equal(metricColor(weight, 0.5), '#f1c40f');
});

test('risk value() is 0 for a node in an UNFILLED region, regardless of its own weight', () => {
    const node = { regionId: 'r1', weightRank: 0.1, protectedNode: false };
    const ctx = { regionsById: { r1: { count: 5, capacity: 23 } } }; // 5/23 ≈ 22%, well under the 80% floor
    assert.equal(risk.value(node, ctx), 0);
});

test('risk value() turns on only once the node\'s region is at least 80% full, and is 0 for a protected node even then', () => {
    const ctx = { regionsById: { r1: { count: 19, capacity: 23 } } }; // 19/23 ≈ 82.6%
    assert.ok(risk.value({ regionId: 'r1', weightRank: 0.2, protectedNode: false }, ctx) > 0);
    assert.equal(risk.value({ regionId: 'r1', weightRank: 0.2, protectedNode: true }, ctx), 0);
});

test('metricColor() for the categorical "region" metric gives the SAME color to two nodes in the same region, and a DIFFERENT color to a node in a different region', () => {
    const ctx = { hueByRegionId: new Map([['a', 0], ['b', 180]]) };
    const colorA1 = metricColor(region, region.value({ regionId: 'a' }, ctx));
    const colorA2 = metricColor(region, region.value({ regionId: 'a' }, ctx));
    const colorB = metricColor(region, region.value({ regionId: 'b' }, ctx));
    assert.equal(colorA1, colorA2);
    assert.notEqual(colorA1, colorB);
});

test('metricColor() for "region" gives an unplaced node (regionId: null) a distinct neutral color, not part of the region hue wheel', () => {
    const ctx = { hueByRegionId: new Map([['a', 0]]) };
    const unplacedColor = metricColor(region, region.value({ regionId: null }, ctx));
    const placedColor = metricColor(region, region.value({ regionId: 'a' }, ctx));
    assert.notEqual(unplacedColor, placedColor);
});

test('metricColor() for "source" maps each known origin to its own fixed color, and an unrecognized value to the same neutral gray as "unknown"', () => {
    const chatColor = metricColor(source, source.value({ source: 'chat' }));
    const lorebookColor = metricColor(source, source.value({ source: 'lorebook' }));
    assert.notEqual(chatColor, lorebookColor);
    assert.equal(metricColor(source, source.value({ source: undefined })), metricColor(source, 'unknown'));
});

test('metricDomain() for a linear metric returns the REAL min/max over the given nodes, not a made-up fixed range', () => {
    const nodes = [{ degree: 2 }, { degree: 9 }, { degree: 5 }];
    assert.deepEqual(metricDomain(connections, nodes), { min: 2, max: 9 });
});

test('metricDomain() for a linear metric on an empty node list falls back to a sane default instead of NaN/Infinity', () => {
    assert.deepEqual(metricDomain(connections, []), { min: 0, max: 1 });
});

test('metricDomain() for a categorical metric returns the distinct values actually present, not the full possible palette', () => {
    const nodes = [{ source: 'chat' }, { source: 'chat' }, { source: 'manual' }];
    assert.deepEqual(metricDomain(source, nodes).sort(), ['chat', 'manual']);
});

test('metricColor() treats retrievedCount 0 as a flat, distinct gray — not the cold end of the amber-to-white ramp', () => {
    const zeroColor = metricColor(retrieved, 0, { min: 0, max: 10 });
    const oneColor = metricColor(retrieved, 1, { min: 0, max: 10 });
    assert.notEqual(zeroColor, oneColor, '0 retrievals must look visibly different from "retrieved once", not just the ramp\'s starting shade');
});

test('metricColor() for a linear metric interpolates smoothly between its domain\'s min and max', () => {
    const low = metricColor(connections, 0, { min: 0, max: 10 });
    const mid = metricColor(connections, 5, { min: 0, max: 10 });
    const high = metricColor(connections, 10, { min: 0, max: 10 });
    assert.notEqual(low, mid);
    assert.notEqual(mid, high);
});

// --- glowValue() (реворк UI, ROADMAP.md 5.108м) -----------------------------
// Реальный баг, найденный по жалобе владельца ("свет активен всегда, а его включение активирует его второй раз
// поверх"): раньше КАЖДЫЙ режим, включая 'none', нёс безусловный floor 0.12 — настоящего "выключено" не было.

test('glowValue() in \'none\' mode is a HONEST zero for an ordinary node — no hidden floor', () => {
    const node = { protectedNode: false, weightRank: 0.9 };
    assert.equal(glowValue(node, 'none', {}, { min: 0, max: 1 }), 0);
});

test('glowValue() in \'none\' mode for a PROTECTED node is only its own bump (0.25) — the old 0.12 floor must not be added on top', () => {
    const node = { protectedNode: true, weightRank: 1 };
    assert.equal(glowValue(node, 'none', {}, { min: 0, max: 1 }), 0.25);
});

test('glowValue() in \'weight\' mode starts from 0 (not the old 0.12 floor) for the weakest node, and grows with weightRank', () => {
    const weakest = glowValue({ protectedNode: false, weightRank: 0 }, 'weight', {}, { min: 0, max: 1 });
    const strongest = glowValue({ protectedNode: false, weightRank: 1 }, 'weight', {}, { min: 0, max: 1 });
    assert.equal(weakest, 0);
    assert.ok(strongest > weakest);
});

test('glowValue() in \'retrieved\' mode starts from 0 for the least-retrieved node in the domain, not the old 0.12 floor', () => {
    const node = { protectedNode: false, retrievedCount: 0 };
    assert.equal(glowValue(node, 'retrieved', {}, { min: 0, max: 10 }), 0);
});

// --- averageHue() (реворк цвета рёбер по региону, прямой запрос владельца) --------------------------------------

test('averageHue() of two nearby hues is the ordinary midpoint', () => {
    assert.ok(Math.abs(averageHue(10, 30) - 20) < 0.001);
});

test('averageHue() wraps CORRECTLY across the 0/360 seam — the arithmetic mean would be wrong here on purpose', () => {
    const hue = averageHue(350, 10);
    // Правильная середина короткой дуги 350°→10° — это 0° (они соседи на цветовом круге); арифметическое
    // среднее (350+10)/2=180 дало бы противоположный, совершенно случайный цвет.
    const distance = Math.min(Math.abs(hue - 0), 360 - Math.abs(hue - 0));
    assert.ok(distance < 0.001, `expected ~0°, got ${hue}°`);
});

test('averageHue() of two opposite hues (180° apart) is symmetric either way round', () => {
    const a = averageHue(0, 180);
    const b = averageHue(180, 0);
    assert.ok(Math.abs(a - b) < 0.001 || Math.abs(Math.abs(a - b) - 360) < 0.001);
});
