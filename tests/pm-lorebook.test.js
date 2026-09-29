import test from 'node:test';
import assert from 'node:assert/strict';
import { activateEntries } from '../libraries/core/pm-lorebook.js';

const entry = (uid, patch) => ({ uid, key: [], keysecondary: [], content: `text ${uid}`, position: 0, order: 100, ...patch });
const run = (entries, messages, options) => activateEntries(entries, { messages, random: () => 0.5, ...options });

test('a constant entry is always active and a keyed one only when its key is in the scanned messages', () => {
    const result = run([entry(1, { constant: true }), entry(2, { key: ['dragon'] }), entry(3, { key: ['castle'] })], ['A DRAGON appears']);
    assert.deepEqual(result.activated.map(a => a.uid).sort(), [1, 2]);
});

test('only the last scanDepth messages are scanned', () => {
    const messages = ['now', 'later', 'earlier dragon'];
    assert.equal(run([entry(1, { key: ['dragon'] })], messages, { scanDepth: 2 }).activated.length, 0);
    assert.equal(run([entry(1, { key: ['dragon'] })], messages, { scanDepth: 3 }).activated.length, 1);
    assert.equal(run([entry(1, { key: ['dragon'], scanDepth: 3 })], messages, { scanDepth: 1 }).activated.length, 1);
});

test('regex keys, case sensitivity and whole words follow the entry settings', () => {
    assert.equal(run([entry(1, { key: ['/dra(g|k)on/i'] })], ['Drakon']).activated.length, 1);
    assert.equal(run([entry(1, { key: ['Dragon'], caseSensitive: true })], ['dragon']).activated.length, 0);
    assert.equal(run([entry(1, { key: ['art'], matchWholeWords: true })], ['party']).activated.length, 0);
    assert.equal(run([entry(1, { key: ['art'], matchWholeWords: true })], ['an art show']).activated.length, 1);
});

test('selective logic combines the secondary keys as AND_ANY, NOT_ALL, NOT_ANY and AND_ALL', () => {
    const e = logic => entry(1, { key: ['a'], keysecondary: ['x', 'y'], selective: true, selectiveLogic: logic });
    assert.equal(run([e(0)], ['a x']).activated.length, 1);
    assert.equal(run([e(0)], ['a']).activated.length, 0);
    assert.equal(run([e(1)], ['a x y']).activated.length, 0);
    assert.equal(run([e(1)], ['a x']).activated.length, 1);
    assert.equal(run([e(2)], ['a x']).activated.length, 0);
    assert.equal(run([e(2)], ['a']).activated.length, 1);
    assert.equal(run([e(3)], ['a x']).activated.length, 0);
    assert.equal(run([e(3)], ['a x y']).activated.length, 1);
});

test('a disabled or empty entry never activates', () => {
    assert.equal(run([entry(1, { constant: true, disable: true }), entry(2, { constant: true, content: '  ' })], []).activated.length, 0);
});

test('probability uses the given random source', () => {
    const e = entry(1, { constant: true, useProbability: true, probability: 40 });
    assert.equal(activateEntries([e], { messages: [], random: () => 0.3 }).activated.length, 1);
    assert.equal(activateEntries([e], { messages: [], random: () => 0.9 }).skipped[0].reason, 'probability');
});

test('recursion activates entries keyed by another entry and preventRecursion hides an entry from it', () => {
    const chain = [entry(1, { key: ['dragon'], content: 'the dragon guards a castle' }), entry(2, { key: ['castle'] })];
    assert.equal(run(chain, ['dragon']).activated.length, 2);
    chain[0].preventRecursion = true;
    assert.equal(run(chain, ['dragon']).activated.length, 1);
});

test('sticky keeps an entry for the next messages and cooldown mutes it afterwards', () => {
    const e = entry(1, { key: ['dragon'], sticky: 2, cooldown: 2 });
    const timed = {};
    assert.equal(activateEntries([e], { messages: ['dragon'], chatLength: 10, timed }).activated.length, 1);
    assert.equal(activateEntries([e], { messages: ['nothing'], chatLength: 11, timed }).activated[0].reason, 'sticky');
    assert.equal(activateEntries([e], { messages: ['dragon'], chatLength: 13, timed }).skipped[0].reason, 'cooldown');
    assert.equal(activateEntries([e], { messages: ['dragon'], chatLength: 15, timed }).activated.length, 1);
});

test('delay keeps an entry silent in a short chat', () => {
    assert.equal(run([entry(1, { constant: true, delay: 5 })], [], { chatLength: 3 }).skipped[0].reason, 'delay');
});

test('the budget drops the lowest order entries first while constants stay outside of it', () => {
    const big = 'word '.repeat(60);
    const result = run([entry(1, { constant: true, content: big }), entry(2, { key: ['k'], content: big, order: 10 }), entry(3, { key: ['k'], content: big, order: 900 })], ['k'], { budgetTokens: 80 });
    assert.deepEqual(result.activated.map(a => a.uid).sort(), [1, 3]);
    assert.ok(result.skipped.some(s => s.uid === 2 && s.reason === 'budget'));
});

test('positions are split into before, after, notes, depth injections and examples in ascending order', () => {
    const result = run([
        entry(1, { constant: true, position: 0, order: 20, content: 'B2' }), entry(2, { constant: true, position: 0, order: 10, content: 'B1' }),
        entry(3, { constant: true, position: 1, content: 'A' }), entry(4, { constant: true, position: 4, depth: 2, role: 1, content: 'D' }),
        entry(5, { constant: true, position: 2, content: 'ANT' }),
    ], []);
    assert.deepEqual(result.before, ['B1', 'B2']);
    assert.deepEqual(result.after, ['A']);
    assert.deepEqual(result.anTop, ['ANT']);
    assert.deepEqual(result.depth.map(d => [d.depth, d.role, d.content]), [[2, 'user', 'D']]);
});
