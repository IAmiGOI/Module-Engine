import test from 'node:test';
import assert from 'node:assert/strict';
import { LEAF_TYPES, describeCondition, newLeaf, newGroup, ensureRoot, updateAt, addTo, removeAt, normalizeCondition } from '../cores/ui/prompt-manager/condition-model.js';
import { evaluateCondition } from '../libraries/core/pm-conditions.js';

test('every rule type the builder offers can be created and is understood by the evaluator', () => {
    const facts = { messages: [{ role: 'user', text: 'x' }], chatLength: 10, vars: new Map(), tracker: () => 1, random: () => 0.1, timed: {} };
    for (const type of Object.keys(LEAF_TYPES)) {
        const leaf = newLeaf(type);
        assert.equal(leaf.type, type);
        assert.doesNotThrow(() => evaluateCondition(leaf, facts), type);
    }
});

test('a condition is read back as a plain sentence', () => {
    assert.equal(describeCondition(null), 'always');
    assert.equal(describeCondition({ ...newLeaf('keyword'), words: ['dragon', 'fire'], scan: 2 }), 'the last 2 messages by anyone mention "dragon" or "fire"');
    assert.equal(describeCondition({ type: 'all', items: [newLeaf('chance'), newLeaf('everyN')] }), '(50% chance AND every 5th message)');
    assert.equal(describeCondition({ type: 'not', item: newLeaf('chance') }), 'NOT 50% chance');
    assert.equal(describeCondition({ type: 'mood' }), 'plugin "mood"');
});

test('rules are added to, changed in and removed from any nested group without touching the original', () => {
    let root = ensureRoot(null);
    root = addTo(root, [], newLeaf('chance'));
    root = addTo(root, [], newGroup('any'));
    root = addTo(root, [1], newLeaf('everyN'));
    assert.equal(root.items[1].items.length, 1);
    const changed = updateAt(root, [0], { percent: 10 });
    assert.equal(changed.items[0].percent, 10);
    assert.equal(root.items[0].percent, 50);
    assert.equal(removeAt(root, [1, 0]).items[1].items.length, 0);
    assert.equal(removeAt(root, [0]).items.length, 1);
    assert.equal(updateAt(root, [], { type: 'any' }).type, 'any');
});

test('a single rule is wrapped into a root group and an empty group means no condition at all', () => {
    assert.equal(ensureRoot(newLeaf('chance')).items.length, 1);
    assert.equal(normalizeCondition(newGroup('all')), null);
    assert.equal(normalizeCondition(ensureRoot(newLeaf('chance'))).type, 'all');
});
