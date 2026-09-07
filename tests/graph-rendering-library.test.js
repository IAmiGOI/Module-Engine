import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCytoscape, resetGraphRenderingCache } from '../libraries/core/graph-rendering.js';

function fakeImporter({ useCalls } = {}) {
    const fakeEdgehandles = () => {};
    const fakeCytoscape = Object.assign(() => ({ mock: 'instance' }), {
        use: plugin => { (useCalls ?? []).push(plugin); },
    });
    return {
        cytoscape: async () => ({ default: fakeCytoscape }),
        edgehandles: async () => ({ default: fakeEdgehandles }),
    };
}

test('loadCytoscape() registers the edgehandles plugin via cytoscape.use() exactly once', async () => {
    resetGraphRenderingCache();
    const useCalls = [];
    const cytoscape = await loadCytoscape({ importer: fakeImporter({ useCalls }) });

    assert.equal(useCalls.length, 1, 'cytoscape.use(edgehandles) must be called');
    assert.equal(typeof cytoscape, 'function', 'must return the cytoscape constructor itself, not the module wrapper');
});

test('loadCytoscape() loads the library only ONCE across multiple calls', async () => {
    resetGraphRenderingCache();
    let cytoscapeImportCount = 0;
    let edgehandlesImportCount = 0;
    const importer = {
        cytoscape: async () => { cytoscapeImportCount += 1; return fakeImporter().cytoscape(); },
        edgehandles: async () => { edgehandlesImportCount += 1; return fakeImporter().edgehandles(); },
    };

    await loadCytoscape({ importer });
    await loadCytoscape({ importer });

    assert.equal(cytoscapeImportCount, 1, 'a second loadCytoscape() call must reuse the already-loaded module, not re-import');
    assert.equal(edgehandlesImportCount, 1);
});

test('resetGraphRenderingCache() forces a real re-import on the next call', async () => {
    resetGraphRenderingCache();
    let importCount = 0;
    const importer = { cytoscape: async () => { importCount += 1; return fakeImporter().cytoscape(); }, edgehandles: fakeImporter().edgehandles };

    await loadCytoscape({ importer });
    resetGraphRenderingCache();
    await loadCytoscape({ importer });

    assert.equal(importCount, 2);
});
