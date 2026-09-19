import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, entryCostTokens, packEntriesIntoChunks } from '../libraries/core/entry-chunker.js';

const entry = (uid, chars) => ({ uid, label: `E${uid}`, content: 'x'.repeat(chars) });

test('estimateTokens() is a conservative chars/3.5 estimate and tolerates missing text', () => {
    assert.equal(estimateTokens('x'.repeat(35)), 10);
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens(undefined), 0);
});

test('packEntriesIntoChunks() keeps EVERY entry whole, exactly once, in original order — the no-loss guarantee', () => {
    const entries = Array.from({ length: 40 }, (_, i) => entry(i, 200 + i * 37));
    const chunks = packEntriesIntoChunks(entries, 800);
    const flat = chunks.flat();
    assert.deepEqual(flat.map(e => e.uid), entries.map(e => e.uid), 'same entries, same order, none dropped or duplicated');
    assert.ok(flat.every((e, i) => e === entries[i]), 'entries are passed through by reference — never truncated or copied');
    assert.ok(chunks.length > 1);
});

test('packEntriesIntoChunks() respects the budget (except a single oversized entry) and balances chunk sizes', () => {
    const entries = Array.from({ length: 30 }, (_, i) => entry(i, 700));
    const budget = 1000;
    const chunks = packEntriesIntoChunks(entries, budget);
    for (const chunk of chunks) assert.ok(chunk.reduce((sum, e) => sum + entryCostTokens(e), 0) <= budget, 'no chunk over budget');
    const sizes = chunks.map(chunk => chunk.length);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `balanced, not "N full plus a stub": ${sizes}`);
});

test('packEntriesIntoChunks() gives an entry that alone exceeds the budget its OWN chunk instead of cutting it', () => {
    const entries = [entry(0, 100), entry(1, 50000), entry(2, 100)];
    const chunks = packEntriesIntoChunks(entries, 500);
    const huge = chunks.find(chunk => chunk.some(e => e.uid === 1));
    assert.deepEqual(huge.map(e => e.uid), [1], 'the oversized entry travels alone');
    assert.equal(huge[0].content.length, 50000, 'and is untouched');
});

test('packEntriesIntoChunks() returns one chunk when everything fits, or when the budget is 0/invalid (chunking disabled), and [] for no entries', () => {
    const entries = [entry(0, 100), entry(1, 100)];
    assert.equal(packEntriesIntoChunks(entries, 100000).length, 1);
    assert.equal(packEntriesIntoChunks(entries, 0).length, 1);
    assert.equal(packEntriesIntoChunks(entries, NaN).length, 1);
    assert.deepEqual(packEntriesIntoChunks([], 1000), []);
});
