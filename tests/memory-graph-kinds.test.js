import test from 'node:test';
import assert from 'node:assert/strict';
import { checkEdge, edgeTypeFor, normalizeKind, kindOf, isCore, subtypeOf } from '../cores/memory-graph/kinds.js';

const node = (kind, core = false) => ({ kind, core });

test('a node without a kind reads as a fact and without core is not core', () => {
    assert.equal(kindOf({}), 'fact');
    assert.equal(kindOf({ kind: 'nonsense' }), 'fact');
    assert.equal(isCore({ protectedNode: true }), false);
});

test('lore nodes of any kinds may link both ways', () => {
    for (const a of ['entity', 'object', 'fact']) for (const b of ['entity', 'object', 'fact']) assert.equal(checkEdge(node(a), node(b)).ok, true);
});

test('any node may point into an event, and an event may continue into another event', () => {
    for (const kind of ['entity', 'object', 'fact', 'event']) assert.equal(checkEdge(node(kind), node('event')).ok, true);
});

test('an event may not point out to a non-event unless one end is core', () => {
    for (const kind of ['entity', 'object', 'fact']) {
        assert.equal(checkEdge(node('event'), node(kind)).ok, false);
        assert.equal(checkEdge(node('event', true), node(kind)).ok, true);
        assert.equal(checkEdge(node('event'), node(kind, true)).ok, true);
    }
});

test('edge type between events is next, into an event is participates, and otherwise the requested one', () => {
    assert.equal(edgeTypeFor(node('event'), node('event'), 'knows'), 'next');
    assert.equal(edgeTypeFor(node('entity'), node('event'), 'knows'), 'participates');
    assert.equal(edgeTypeFor(node('entity'), node('fact'), 'knows'), 'knows');
    assert.equal(edgeTypeFor(node('entity'), node('fact')), 'related');
});

test('normalizing keeps known kinds and object subtypes and drops the rest', () => {
    assert.deepEqual(normalizeKind('object', 'place'), { kind: 'object', subtype: 'place' });
    assert.deepEqual(normalizeKind('entity', 'place'), { kind: 'entity', subtype: null });
    assert.deepEqual(normalizeKind('weird', 'item'), { kind: 'fact', subtype: null });
    assert.equal(subtypeOf({ kind: 'object', subtype: 'group' }), 'group');
    assert.equal(subtypeOf({ kind: 'fact', subtype: 'group' }), null);
});
