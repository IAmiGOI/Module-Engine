import test from 'node:test';
import assert from 'node:assert/strict';
import { diffElements } from '../cores/ui/memory-graph/elements-diff.js';

function nodeEntry(data, position) {
    return { group: 'nodes', data, position };
}

test('diffElements() adds every element present in "next" but absent from "current"', () => {
    const current = new Map();
    const next = new Map([['n1', nodeEntry({ id: 'n1', label: 'A' }, { x: 0, y: 0 })]]);
    const { add, remove, update } = diffElements(current, next);
    assert.deepEqual(add, [{ id: 'n1', group: 'nodes', data: { id: 'n1', label: 'A' }, position: { x: 0, y: 0 } }]);
    assert.deepEqual(remove, []);
    assert.deepEqual(update, []);
});

test('diffElements() removes every element present in "current" but absent from "next"', () => {
    const current = new Map([['n1', nodeEntry({ id: 'n1', label: 'A' }, { x: 0, y: 0 })]]);
    const next = new Map();
    const { add, remove, update } = diffElements(current, next);
    assert.deepEqual(add, []);
    assert.deepEqual(remove, ['n1']);
    assert.deepEqual(update, []);
});

test('diffElements() reports NOTHING for an element whose data and position are both unchanged', () => {
    const entry = nodeEntry({ id: 'n1', label: 'A' }, { x: 5, y: 5 });
    const current = new Map([['n1', entry]]);
    const next = new Map([['n1', nodeEntry({ id: 'n1', label: 'A' }, { x: 5, y: 5 })]]);
    const { add, remove, update } = diffElements(current, next);
    assert.deepEqual(add, []);
    assert.deepEqual(remove, []);
    assert.deepEqual(update, [], 'identical data and position must not produce an update entry — the whole point of diffing instead of rebuilding');
});

test('diffElements() updates ONLY data when the position is unchanged', () => {
    const current = new Map([['n1', nodeEntry({ id: 'n1', label: 'A' }, { x: 5, y: 5 })]]);
    const next = new Map([['n1', nodeEntry({ id: 'n1', label: 'B' }, { x: 5, y: 5 })]]);
    const { update } = diffElements(current, next);
    assert.deepEqual(update, [{ id: 'n1', data: { id: 'n1', label: 'B' }, position: null }]);
});

test('diffElements() updates ONLY position when the data is unchanged', () => {
    const current = new Map([['n1', nodeEntry({ id: 'n1', label: 'A' }, { x: 5, y: 5 })]]);
    const next = new Map([['n1', nodeEntry({ id: 'n1', label: 'A' }, { x: 9, y: 9 })]]);
    const { update } = diffElements(current, next);
    assert.deepEqual(update, [{ id: 'n1', data: null, position: { x: 9, y: 9 } }]);
});

test('diffElements() never moves the node whose id is passed as excludeId, even though its position changed — but still updates its data', () => {
    const current = new Map([['dragged', nodeEntry({ id: 'dragged', label: 'A' }, { x: 5, y: 5 })]]);
    const next = new Map([['dragged', nodeEntry({ id: 'dragged', label: 'B' }, { x: 999, y: 999 })]]);
    const { update } = diffElements(current, next, { excludeId: 'dragged' });
    assert.deepEqual(update, [{ id: 'dragged', data: { id: 'dragged', label: 'B' }, position: null }], 'the currently-dragged node must keep its live on-screen position — only its data may refresh');
});

test('diffElements() leaves the excluded node out of update entirely when only its position would have changed', () => {
    const current = new Map([['dragged', nodeEntry({ id: 'dragged', label: 'A' }, { x: 5, y: 5 })]]);
    const next = new Map([['dragged', nodeEntry({ id: 'dragged', label: 'A' }, { x: 999, y: 999 })]]);
    const { update } = diffElements(current, next, { excludeId: 'dragged' });
    assert.deepEqual(update, []);
});

test('diffElements() treats edges (no position field at all) the same as nodes for data comparison', () => {
    const edge = { group: 'edges', data: { id: 'edge:a|b', source: 'a', target: 'b', type: 'related' } };
    const current = new Map([['edge:a|b', edge]]);
    const next = new Map([['edge:a|b', { group: 'edges', data: { id: 'edge:a|b', source: 'a', target: 'b', type: 'mentions' } }]]);
    const { update } = diffElements(current, next);
    assert.deepEqual(update, [{ id: 'edge:a|b', data: { id: 'edge:a|b', source: 'a', target: 'b', type: 'mentions' }, position: null }]);
});

test('diffElements() handles a mixed batch — one add, one remove, one update, one untouched — all in a single call', () => {
    const current = new Map([
        ['stays', nodeEntry({ id: 'stays', label: 'same' }, { x: 1, y: 1 })],
        ['changes', nodeEntry({ id: 'changes', label: 'old' }, { x: 2, y: 2 })],
        ['gone', nodeEntry({ id: 'gone', label: 'bye' }, { x: 3, y: 3 })],
    ]);
    const next = new Map([
        ['stays', nodeEntry({ id: 'stays', label: 'same' }, { x: 1, y: 1 })],
        ['changes', nodeEntry({ id: 'changes', label: 'new' }, { x: 2, y: 2 })],
        ['fresh', nodeEntry({ id: 'fresh', label: 'hi' }, { x: 4, y: 4 })],
    ]);
    const { add, remove, update } = diffElements(current, next);
    assert.deepEqual(add.map(item => item.id), ['fresh']);
    assert.deepEqual(remove, ['gone']);
    assert.deepEqual(update.map(item => item.id), ['changes']);
});
