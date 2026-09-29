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

import { addDirectedEdge, timelineOf } from '../cores/memory-graph/edges.js';
import { pickEventsToFold } from '../cores/memory-graph/timeline-compact.js';

const make = (id, kind, extra = {}) => ({ id, kind, edges: [], degree: 0, createdTurn: 0, ...extra });

test('a directed edge is written at both ends with opposite directions and is not duplicated', () => {
    const a = make('a', 'entity');
    const e = make('e', 'event');
    assert.equal(addDirectedEdge(a, e).created, true);
    assert.equal(addDirectedEdge(a, e).created, false);
    assert.deepEqual([a.edges[0].dir, e.edges[0].dir, a.degree, e.degree], ['out', 'in', 1, 1]);
});

test('an ordinary node over the degree cap refuses a new edge but a core node does not', () => {
    const full = make('f', 'fact', { degree: 3 });
    assert.equal(addDirectedEdge(full, make('g', 'fact'), 'related', { maxDegree: 3 }).ok, false);
    assert.equal(addDirectedEdge(make('c', 'fact', { degree: 9, core: true }), make('h', 'fact'), 'related', { maxDegree: 3 }).ok, true);
});

test('the timeline of an anchor lists its events by time and follows next chains', () => {
    const anchor = make('anchor', 'entity');
    const late = make('late', 'event', { gameTime: 20 });
    const early = make('early', 'event', { gameTime: 10 });
    const after = make('after', 'event', { gameTime: 30 });
    addDirectedEdge(anchor, late);
    addDirectedEdge(anchor, early);
    addDirectedEdge(late, after);
    const byId = Object.fromEntries([anchor, late, early, after].map(n => [n.id, n]));
    assert.deepEqual(timelineOf(byId, 'anchor').map(n => n.id), ['early', 'late', 'after']);
});

test('folding picks the oldest events beyond the recent ones, skips core, and needs at least two', () => {
    const events = [1, 2, 3, 4, 5].map(i => make(`e${i}`, 'event', { gameTime: i }));
    assert.deepEqual(pickEventsToFold(events, { keepRecent: 2, foldBatch: 2 }).map(n => n.id), ['e1', 'e2']);
    assert.deepEqual(pickEventsToFold(events, { keepRecent: 4, foldBatch: 6 }), []);
    events[0].core = true;
    assert.deepEqual(pickEventsToFold(events, { keepRecent: 2, foldBatch: 6 }).map(n => n.id), ['e2', 'e3']);
});
