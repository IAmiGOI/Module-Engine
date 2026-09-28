import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutGraph } from '../cores/ui/memory-graph/layout.js';
import { renderZonesSvg, zonesHalfExtent, zonesSignature, ZONES_SVG_ID } from '../cores/ui/memory-graph/zones-svg.js';

function buildSmallGraph() {
    const nodes = [
        { id: 'n0', regionId: 'Locations', degree: 2, protectedNode: true, createdAt: 0 },
        { id: 'n1', regionId: 'Locations', degree: 1, protectedNode: false, createdAt: 1 },
        { id: 'n2', regionId: 'People', degree: 0, protectedNode: true, createdAt: 2 },
    ];
    const regions = {
        Locations: { centerNodeId: 'n0', subCenterIds: [], nodeIds: ['n0', 'n1'], label: 'Locations' },
        People: { centerNodeId: 'n2', subCenterIds: [], nodeIds: ['n2'], label: 'People' },
    };
    return { nodes, regions };
}

test('renderZonesSvg() returns an empty string for an empty graph — nothing to draw, not a malformed <svg>', () => {
    assert.equal(renderZonesSvg([]), '');
});

test('renderZonesSvg() emits one <path> per zone plus a matching <text> label with "label · count/capacity"', () => {
    const { nodes, regions } = buildSmallGraph();
    const { zones } = layoutGraph(nodes, regions);
    const svg = renderZonesSvg(zones);
    for (const zone of zones) {
        assert.match(svg, new RegExp(`data-region-id="${zone.regionId}"`), `zone ${zone.regionId} must have its own <path>`);
    }
    assert.match(svg, /Locations · 2\/23/);
    assert.match(svg, /People · 1\/23/);
});

test('renderZonesSvg() sizes the <svg> in EXPLICIT pixels (2x the outermost zone radius), not a percentage — so the live pan/zoom transform scales it correctly', () => {
    const { nodes, regions } = buildSmallGraph();
    const { zones } = layoutGraph(nodes, regions);
    const half = zonesHalfExtent(zones);
    const svg = renderZonesSvg(zones);
    assert.match(svg, new RegExp(`id="${ZONES_SVG_ID}"[^>]*width="${(half * 2).toFixed(1)}"`));
});

/** Вытаскивает атрибуты одного `<path .../>` по его `data-region-id` — порядок атрибутов в самой строке не важен. */
function pathAttributes(svg, regionId) {
    const match = svg.match(new RegExp(`<path[^>]*data-region-id="${regionId}"[^>]*/>`));
    return match ? match[0] : '';
}

test('renderZonesSvg() highlights exactly the zone matching highlightRegionId with a brighter, thicker stroke', () => {
    const { nodes, regions } = buildSmallGraph();
    const { zones } = layoutGraph(nodes, regions);
    const svg = renderZonesSvg(zones, { highlightRegionId: 'People' });
    assert.match(pathAttributes(svg, 'People'), /stroke="rgba\(255,255,255,0\.8\)"/);
    assert.doesNotMatch(pathAttributes(svg, 'Locations'), /stroke="rgba\(255,255,255,0\.8\)"/);
});

test('renderZonesSvg() escapes a region label containing XML-special characters instead of breaking the markup', () => {
    const nodes = [{ id: 'n0', regionId: 'A & B', degree: 0, protectedNode: true, createdAt: 0 }];
    const regions = { 'A & B': { centerNodeId: 'n0', subCenterIds: [], nodeIds: ['n0'], label: 'A & B <script>' } };
    const { zones } = layoutGraph(nodes, regions);
    const svg = renderZonesSvg(zones);
    assert.doesNotMatch(svg, /<script>/, 'a literal "<script>" in a label must never appear unescaped in the SVG string');
    assert.match(svg, /A &amp; B &lt;script&gt;/);
});

test('zonesSignature() is identical for two independently-computed layouts of the SAME graph (layoutGraph() is deterministic, so the signature must not spuriously differ)', () => {
    const { nodes, regions } = buildSmallGraph();
    const first = layoutGraph(nodes, regions).zones;
    const second = layoutGraph(nodes, regions).zones;
    assert.equal(zonesSignature(first), zonesSignature(second));
});

test('zonesSignature() differs once a node moves to a different region, changing the zones\' relative sizes', () => {
    const { nodes, regions } = buildSmallGraph();
    const before = zonesSignature(layoutGraph(nodes, regions).zones);
    const movedNodes = nodes.map(node => (node.id === 'n1' ? { ...node, regionId: 'People' } : node));
    const movedRegions = {
        Locations: { ...regions.Locations, nodeIds: ['n0'] },
        People: { ...regions.People, nodeIds: ['n2', 'n1'] },
    };
    const after = zonesSignature(layoutGraph(movedNodes, movedRegions).zones);
    assert.notEqual(before, after);
});

test('zonesSignature() differs when a THIRD region grows large enough to redistribute everyone else\'s ANGLE — even though the two original zones\' count/label/regionId stay exactly the same', () => {
    const { nodes, regions } = buildSmallGraph();
    const before = zonesSignature(layoutGraph(nodes, regions).zones);
    const bigRegionNodes = [];
    for (let i = 0; i < 20; i += 1) bigRegionNodes.push({ id: `bigN${i}`, regionId: 'Big', degree: 0, protectedNode: i === 0, createdAt: 100 + i });
    const grownNodes = [...nodes, ...bigRegionNodes];
    const grownRegions = { ...regions, Big: { centerNodeId: 'bigN0', subCenterIds: [], nodeIds: bigRegionNodes.map(n => n.id), label: 'Big' } };
    const zonesAfter = layoutGraph(grownNodes, grownRegions).zones;
    const after = zonesSignature(zonesAfter.filter(zone => zone.regionId === 'Locations' || zone.regionId === 'People'));
    assert.notEqual(before, after, 'Locations/People must show up as CHANGED once a big neighbor squeezes their angular share, even though their own count/label/regionId never moved');
});

test('zonesHalfExtent() returns 0 for an empty zone list — no <svg> is drawn, so there is nothing to size', () => {
    assert.equal(zonesHalfExtent([]), 0);
});
