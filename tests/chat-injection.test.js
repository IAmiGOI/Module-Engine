import test from 'node:test';
import assert from 'node:assert/strict';
import { computeInsertIndex } from '../libraries/shared/chat-injection.js';

test('computeInsertIndex() at depth 0 means "right before what the model is about to say" — the very end', () => {
    assert.equal(computeInsertIndex(10, 0), 10);
});

test('computeInsertIndex() clamps depth to the chat length instead of going negative', () => {
    assert.equal(computeInsertIndex(3, 50), 0);
});

test('computeInsertIndex() ignores a negative depth rather than inserting past the end', () => {
    assert.equal(computeInsertIndex(5, -3), 5);
});

test('computeInsertIndex() at a normal mid-range depth lands exactly depth messages before the end', () => {
    assert.equal(computeInsertIndex(20, 4), 16);
});
