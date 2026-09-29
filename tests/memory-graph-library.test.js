import test from 'node:test';
import assert from 'node:assert/strict';
import { quantizeEmbedding, dequantizeEmbedding, buildRecord, restoreGraph, parseImportedRecord, checkLibraryLimits, lorebookFingerprint, summarizeRecord, LIBRARY_LIMITS } from '../cores/memory-graph/graph-snapshot.js';
import { cosineSimilarity } from '../libraries/core/embedding.js';

const vector = seed => Array.from({ length: 64 }, (_, i) => Math.sin(seed * 7 + i * 0.37) + (i % 5) * 0.1);

function graph() {
    return {
        nodes: {
            a: { id: 'a', label: 'A', content: 'first', embedding: vector(1), core: true, protectedNode: true, kind: 'entity', wiUid: 4, wiBook: 'Other', createdTurn: 40, lastTouchedTurn: 50, edges: [], degree: 0 },
            b: { id: 'b', label: 'B', content: 'second', embedding: vector(2), kind: 'event', createdTurn: 41, lastTouchedTurn: 42, edges: [], degree: 0 },
        },
        regions: { R: { centerNodeId: 'a', subCenterIds: [], nodeIds: ['a', 'b'] } },
        mergeQueue: {}, reconsolidationQueue: {}, staging: {}, distanceStats: { mean: 1 }, noveltyStats: null,
    };
}

test('a quantized embedding keeps its cosine similarity within 0.005 of the original', () => {
    const original = vector(3);
    const restored = dequantizeEmbedding(quantizeEmbedding(original));
    assert.ok(Math.abs(cosineSimilarity(original, restored) - 1) < 0.005);
    const other = vector(9);
    assert.ok(Math.abs(cosineSimilarity(original, other) - cosineSimilarity(restored, dequantizeEmbedding(quantizeEmbedding(other)))) < 0.005);
});

test('a zero vector survives quantization', () => {
    assert.deepEqual(dequantizeEmbedding(quantizeEmbedding([0, 0, 0])), [0, 0, 0]);
});

test('a record carries counts, source and quantized embeddings without mirror links to another chat lorebook', () => {
    const record = buildRecord({ id: 'g1', name: 'Kira world', mode: 'structured', now: 1000, source: { characterName: 'Kira' }, graph: graph() });
    assert.deepEqual(record.counts, { nodes: 2, regions: 1, cores: 1, events: 1 });
    assert.equal(record.format, 'stme-memory-graph');
    assert.equal(record.graph.nodes.a.wiUid, undefined);
    assert.equal(typeof record.graph.nodes.a.embedding.q, 'string');
    assert.ok(record.size > 0);
});

test('restoring a record gives the same graph up to quantization, without mirror links and with the current clock', () => {
    const record = buildRecord({ id: 'g1', name: 'x', mode: 'structured', now: 1, graph: graph() });
    const restored = restoreGraph(record, 7);
    assert.equal(restored.nodes.a.wiUid, undefined);
    assert.deepEqual([restored.nodes.a.createdTurn, restored.nodes.b.lastTouchedTurn], [7, 7]);
    assert.ok(Math.abs(cosineSimilarity(restored.nodes.a.embedding, vector(1)) - 1) < 0.005);
    assert.deepEqual(restored.regions, graph().regions);
    assert.deepEqual(restored.distanceStats, { mean: 1 });
});

test('a thumbnail over 8 KB is dropped and the summary leaves the graph out', () => {
    assert.equal(buildRecord({ id: 'g', name: 'x', mode: 'legacy', now: 1, graph: graph(), thumbnail: 'x'.repeat(9000) }).thumbnail, null);
    assert.equal(summarizeRecord(buildRecord({ id: 'g', name: 'x', mode: 'legacy', now: 1, graph: graph() })).graph, undefined);
});

test('an import refuses a foreign format, a wrong version and an incomplete file with a readable message', () => {
    assert.match(parseImportedRecord('not json').error, /not valid JSON/);
    assert.match(parseImportedRecord('{"format":"other"}').error, /not a Memory Graph export/);
    assert.match(parseImportedRecord('{"format":"stme-memory-graph","version":9}').error, /Unsupported/);
    assert.match(parseImportedRecord('{"format":"stme-memory-graph","version":1}').error, /incomplete/);
    const record = buildRecord({ id: 'g', name: 'x', mode: 'legacy', now: 1, graph: graph() });
    assert.equal(parseImportedRecord(JSON.stringify(record)).ok, true);
});

test('the library limits stop a 51st record and an overflow of the total size, but allow replacing an existing record', () => {
    const many = Array.from({ length: LIBRARY_LIMITS.maxRecords }, (_, i) => ({ id: `g${i}`, size: 10 }));
    assert.equal(checkLibraryLimits(many, 10).ok, false);
    assert.equal(checkLibraryLimits(many, 10, 'g0').ok, true);
    assert.equal(checkLibraryLimits([{ id: 'a', size: LIBRARY_LIMITS.maxBytes }], 1).ok, false);
});

test('the lorebook fingerprint is stable for the same entries in any order and changes when an entry changes', async () => {
    const entries = [{ book: 'B', uid: 1, name: 'One', length: 10 }, { book: 'B', uid: 2, name: 'Two', length: 20 }];
    const first = await lorebookFingerprint(entries);
    assert.equal(await lorebookFingerprint([...entries].reverse()), first);
    assert.notEqual(await lorebookFingerprint([entries[0], { ...entries[1], length: 21 }]), first);
    assert.equal(await lorebookFingerprint([]), null);
});
