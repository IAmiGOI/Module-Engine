import test from 'node:test';
import assert from 'node:assert/strict';
import { embed, cosineSimilarity, resetEmbeddingCache } from '../libraries/core/embedding.js';

test('cosineSimilarity of a vector with itself is 1', () => {
    assert.ok(Math.abs(cosineSimilarity([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
});

test('cosineSimilarity of orthogonal vectors is 0', () => {
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test('cosineSimilarity of opposite vectors is -1', () => {
    assert.ok(Math.abs(cosineSimilarity([1, 0], [-1, 0]) - -1) < 1e-9);
});

test('cosineSimilarity returns 0 for mismatched lengths or empty vectors, never throws', () => {
    assert.equal(cosineSimilarity([1, 2], [1]), 0);
    assert.equal(cosineSimilarity([], []), 0);
    assert.equal(cosineSimilarity(null, [1]), 0);
});

function fakeImporter(recordCalls) {
    return async () => ({
        pipeline: async (task, model, options) => {
            recordCalls.pipelineArgs = { task, model, options };
            return async (text, extractOptions) => {
                recordCalls.extractCalls = recordCalls.extractCalls ?? [];
                recordCalls.extractCalls.push({ text, extractOptions });
                // a trivial, deterministic "embedding": length of the (prefixed) text, padded
                return { data: new Float32Array([text.length, 0, 0]) };
            };
        },
    });
}

test('embed() prefixes with "passage: " by default (E5 protocol) and normalizes/pools', async () => {
    resetEmbeddingCache();
    const calls = {};
    const vector = await embed('a tavern door', { importer: fakeImporter(calls) });

    assert.equal(calls.extractCalls[0].text, 'passage: a tavern door');
    assert.deepEqual(calls.extractCalls[0].extractOptions, { pooling: 'mean', normalize: true });
    assert.deepEqual(vector, ['passage: a tavern door'.length, 0, 0]);
});

test('embed() with kind: "query" prefixes with "query: " instead — E5 is asymmetric, not a style choice', async () => {
    resetEmbeddingCache();
    const calls = {};
    await embed('what happened at the tavern', { kind: 'query', importer: fakeImporter(calls) });

    assert.match(calls.extractCalls[0].text, /^query: /);
});

test('embed() loads the pipeline only ONCE across multiple calls — the model must not be re-downloaded per call', async () => {
    resetEmbeddingCache();
    const calls = {};
    const importer = fakeImporter(calls);
    let importCount = 0;
    const countingImporter = async () => { importCount += 1; return importer(); };

    await embed('first', { importer: countingImporter });
    await embed('second', { importer: countingImporter });

    assert.equal(importCount, 1, 'a second embed() call must reuse the already-loaded pipeline, not re-import');
});

test('embed() truncates very long text before handing it to the model, rather than crashing or silently exceeding the token budget', async () => {
    resetEmbeddingCache();
    const calls = {};
    const longText = 'x'.repeat(10000);

    await embed(longText, { importer: fakeImporter(calls) });

    assert.ok(calls.extractCalls[0].text.length < 10000, 'must be truncated, not passed through whole');
});
