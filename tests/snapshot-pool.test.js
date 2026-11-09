import test from 'node:test';
import assert from 'node:assert/strict';
import { packSnapshot, unpackSnapshot, prunePool } from '../libraries/core/snapshot-pool.js';

const character = (lines, known) => ({ name: 'Emilia', material: { 1: lines }, decree: { 1: ['aim'] }, history: lines.map(line => ({ new: line })), knowledge: { items: known.map(fact => ({ fact })) } });

test('every snapshot keeps its banks and ledger in full, and what did not change is stored once', () => {
    const pool = {};
    const first = { clock: 1, greatBank: { emilia: character(['a'], ['x']) }, ledger: [{ turn: 1 }] };
    const second = { clock: 2, greatBank: { emilia: character(['a', 'b'], ['x', 'y']) }, ledger: [{ turn: 1 }, { turn: 2 }] };
    const snapshots = { 1: packSnapshot(pool, first), 2: packSnapshot(pool, second) };
    assert.deepEqual(unpackSnapshot(pool, snapshots[1]), first);
    assert.deepEqual(unpackSnapshot(pool, snapshots[2]), second);
    const size = Object.keys(pool).length;
    delete snapshots[2];
    assert.ok(prunePool(pool, snapshots) > 0 && Object.keys(pool).length < size, 'parts only the deleted snapshot used are dropped');
    assert.deepEqual(unpackSnapshot(pool, snapshots[1]), first, 'the remaining snapshot is still whole');
});

test('a part missing from the pool is reported, not silently skipped; old unpacked snapshots read as they are', () => {
    const pool = {};
    const packed = packSnapshot(pool, { greatBank: { emilia: character(['a'], []) }, ledger: [] });
    for (const key of Object.keys(pool)) delete pool[key];
    assert.ok(unpackSnapshot(pool, packed).missing > 0);
    const legacy = { clock: 3, roster: { active: [] } };
    assert.deepEqual(unpackSnapshot(pool, legacy), legacy);
});
