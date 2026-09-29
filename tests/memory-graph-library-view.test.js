import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTab, filterAndSort, cardModel, formatSize } from '../cores/ui/memory-graph/library-view.js';
import { buildThumbnailSvg } from '../cores/ui/memory-graph/thumbnail.js';
import { registerGraphLibraryService } from '../services/graph-library.js';
import { createEngine } from '../libraries/shared/engine.js';

const entries = [
    { id: 'a', name: 'Beta world', updatedAt: 200, size: 5000, source: { characterName: 'Kira' } },
    { id: 'b', name: 'alpha realm', updatedAt: 300, size: 9000, source: { characterName: 'Marcus' } },
    { id: 'c', name: 'Gamma', updatedAt: 100, size: 100, source: {} },
];

test('an unknown tab from an old window state falls back to the Graph tab', () => {
    assert.equal(normalizeTab('library'), 'library');
    assert.equal(normalizeTab('nonsense'), 'graph');
    assert.equal(normalizeTab(undefined), 'graph');
});

test('the library list is sorted by newest date, by name, or by size, and does not change the source list', () => {
    assert.deepEqual(filterAndSort(entries).map(e => e.id), ['b', 'a', 'c']);
    assert.deepEqual(filterAndSort(entries, { sort: 'name' }).map(e => e.id), ['b', 'a', 'c']);
    assert.deepEqual(filterAndSort(entries, { sort: 'size' }).map(e => e.id), ['b', 'a', 'c']);
    assert.deepEqual(entries.map(e => e.id), ['a', 'b', 'c']);
});

test('search matches the graph name or the character name ignoring case', () => {
    assert.deepEqual(filterAndSort(entries, { query: 'REALM' }).map(e => e.id), ['b']);
    assert.deepEqual(filterAndSort(entries, { query: 'kira' }).map(e => e.id), ['a']);
    assert.deepEqual(filterAndSort(entries, { query: 'nothing' }), []);
});

test('a card shows mode, counts, dates, source and size', () => {
    const model = cardModel({ id: 'x', name: 'World', mode: 'structured', counts: { nodes: 40, regions: 6, cores: 9 }, savedAt: Date.UTC(2026, 0, 2), updatedAt: Date.UTC(2026, 0, 5), source: { characterName: 'Kira' }, size: 2048 });
    assert.deepEqual([model.modeLabel, model.countsText, model.fromText, model.sizeText], ['Structured', '40 nodes · 6 regions · 9 core', 'from: Kira', '2 KB']);
    assert.match(model.datesText, /saved 2026-01-02, updated 2026-01-05/);
    assert.equal(cardModel({ id: 'y', name: 'Old', mode: 'legacy' }).modeLabel, 'Legacy');
    assert.equal(formatSize(3 * 1048576), '3.0 MB');
});

test('the thumbnail is an svg within 8 KB even for a big graph, and empty graphs have none', () => {
    const nodes = Array.from({ length: 800 }, (_, i) => ({ id: `n${i}`, core: i % 40 === 0 }));
    const positions = new Map(nodes.map((n, i) => [n.id, { x: Math.cos(i) * (50 + i), y: Math.sin(i) * (50 + i) }]));
    const svg = buildThumbnailSvg({ zones: [{ a0: 0, a1: 1, rInner: 10, rOuter: 100, hue: 200 }], positions, nodes });
    assert.match(svg, /^<svg /);
    assert.ok(svg.length <= 8192);
    assert.ok(svg.includes('<circle'));
    assert.equal(buildThumbnailSvg({ zones: [], positions: new Map(), nodes: [] }), null);
});

test('the graph library service lists records without their graph, gets a whole record, and deletes', async () => {
    const engine = createEngine();
    const rows = new Map();
    registerGraphLibraryService(engine.buses.services, { store: { all: async () => [...rows.values()], get: async id => rows.get(id), put: async r => { rows.set(r.id, r); }, delete: async id => { rows.delete(id); } } });
    const client = engine.registerCaller('core.probe', 'cores', { tier: 'official' });
    const call = (contract, params) => new Promise(resolve => client.services.subscribe(contract, { params }, resolve));

    await call('graphLibrary.put', { record: { id: 'g1', name: 'One', graph: { nodes: {} } } });

    assert.deepEqual((await call('graphLibrary.list')).value, [{ id: 'g1', name: 'One' }]);
    assert.equal((await call('graphLibrary.get', { id: 'g1' })).value.graph.nodes !== undefined, true);
    assert.equal((await call('graphLibrary.get', { id: 'missing' })).value, null);
    await call('graphLibrary.delete', { id: 'g1' });
    assert.deepEqual((await call('graphLibrary.list')).value, []);
});
