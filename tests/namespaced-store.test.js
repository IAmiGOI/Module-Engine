import test from 'node:test';
import assert from 'node:assert/strict';
import { readNamespacedValue, writeNamespacedValue, removeNamespacedValue, listNamespacedKeys } from '../libraries/core/namespaced-store.js';

test('readNamespacedValue() returns the fallback for a missing namespace, missing key, or a completely empty/undefined raw object', () => {
    assert.equal(readNamespacedValue(undefined, 'ns', 'key', 'fallback'), 'fallback');
    assert.equal(readNamespacedValue({}, 'ns', 'key', 'fallback'), 'fallback');
    assert.equal(readNamespacedValue({ ns: {} }, 'ns', 'key', 'fallback'), 'fallback');
});

test('writeNamespacedValue() then readNamespacedValue() round-trips a value under its namespace/key', () => {
    const raw = {};

    writeNamespacedValue(raw, 'core.tracking', 'lastSeen', 42);

    assert.equal(readNamespacedValue(raw, 'core.tracking', 'lastSeen'), 42);
});

test('two different namespaces never see each other\'s keys, even with the same key name', () => {
    const raw = {};
    writeNamespacedValue(raw, 'core.tracking', 'value', 'tracking-value');
    writeNamespacedValue(raw, 'module.notebook', 'value', 'notebook-value');

    assert.equal(readNamespacedValue(raw, 'core.tracking', 'value'), 'tracking-value');
    assert.equal(readNamespacedValue(raw, 'module.notebook', 'value'), 'notebook-value');
});

test('writeNamespacedValue() mutates the passed raw object in place and also returns it', () => {
    const raw = {};

    const returned = writeNamespacedValue(raw, 'ns', 'key', 'value');

    assert.equal(returned, raw);
    assert.equal(raw.ns.key, 'value');
});

test('removeNamespacedValue() returns true and deletes an existing key; false and no-ops for one that never existed', () => {
    const raw = {};
    writeNamespacedValue(raw, 'ns', 'key', 'value');

    assert.equal(removeNamespacedValue(raw, 'ns', 'key'), true);
    assert.equal(readNamespacedValue(raw, 'ns', 'key', 'gone'), 'gone');
    assert.equal(removeNamespacedValue(raw, 'ns', 'key'), false, 'removing again must be a harmless no-op, not throw');
    assert.equal(removeNamespacedValue({}, 'never-existed', 'key'), false);
});

test('listNamespacedKeys() lists exactly one namespace\'s own keys, empty array for an unknown namespace', () => {
    const raw = {};
    writeNamespacedValue(raw, 'ns', 'a', 1);
    writeNamespacedValue(raw, 'ns', 'b', 2);
    writeNamespacedValue(raw, 'other', 'c', 3);

    assert.deepEqual(listNamespacedKeys(raw, 'ns').sort(), ['a', 'b']);
    assert.deepEqual(listNamespacedKeys(raw, 'unknown'), []);
    assert.deepEqual(listNamespacedKeys(undefined, 'ns'), []);
});

test('a value that is explicitly falsy (0, "", false) round-trips correctly — readNamespacedValue must not treat it as absent', () => {
    const raw = {};
    writeNamespacedValue(raw, 'ns', 'zero', 0);
    writeNamespacedValue(raw, 'ns', 'empty', '');
    writeNamespacedValue(raw, 'ns', 'no', false);

    assert.equal(readNamespacedValue(raw, 'ns', 'zero', 'fallback'), 0);
    assert.equal(readNamespacedValue(raw, 'ns', 'empty', 'fallback'), '');
    assert.equal(readNamespacedValue(raw, 'ns', 'no', 'fallback'), false);
});
