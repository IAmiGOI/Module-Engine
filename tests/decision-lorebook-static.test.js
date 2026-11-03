import test from 'node:test';
import assert from 'node:assert/strict';
import { staticDirectorLorebook } from '../libraries/core/decision-lorebook-static.js';

const book = () => [
    { uid: 1, book: 'World', comment: 'Old Mill', key: ['mill'], content: 'The mill stands by the river.' },
    { uid: 2, book: 'World', comment: 'The River', key: ['river'], content: 'The river is cold.', constant: true },
];

test('the director lorebook head is frozen: a new entry from the memory graph goes to the changes block, the head stays byte for byte', () => {
    const first = staticDirectorLorebook(null, book());
    assert.equal(first.refreshed, true);
    assert.match(first.head, /Old Mill/);
    const grown = [...book(), { uid: 3, book: 'World', comment: 'Alley ambush fight', content: 'The memory graph wrote this.' }];
    const second = staticDirectorLorebook(first.snapshot, grown);
    assert.equal(second.refreshed, false);
    assert.equal(second.head, first.head, 'the cached head does not change');
    assert.match(second.changes, /LOREBOOK CHANGES/);
    assert.match(second.changes, /Alley ambush fight/);
    assert.doesNotMatch(second.changes, /Old Mill/, 'unchanged entries are not repeated');
});

test('an edited entry and a removed entry are reported as changes, not rewritten into the head', () => {
    const first = staticDirectorLorebook(null, book());
    const edited = [{ ...book()[0], content: 'The mill burned down.' }];
    const next = staticDirectorLorebook(first.snapshot, edited);
    assert.equal(next.head, first.head);
    assert.match(next.changes, /The mill burned down/);
    assert.match(next.changes, /Removed entries: The River/);
});

test('when the changes block grows past the limit, the snapshot is rebuilt once and the changes block is empty again', () => {
    const first = staticDirectorLorebook(null, book());
    const many = [...book(), ...Array.from({ length: 30 }, (_, index) => ({ uid: 10 + index, book: 'World', comment: `Event ${index}`, content: 'detail '.repeat(60) }))];
    const next = staticDirectorLorebook(first.snapshot, many, { refreshTokens: 500, smallTokens: 1e9 });
    assert.equal(next.refreshed, true);
    assert.equal(next.changes, '');
    assert.match(next.head, /Event 29/);
});

test('character entries stay out of the frozen head and of the changes, because they travel as data banks', () => {
    const entries = [
        { uid: 1, book: 'World', comment: '-- CHARACTERS --', content: '' },
        { uid: 2, book: 'World', comment: 'Lena', content: 'Lena runs the ferry.' },
        { uid: 3, book: 'World', comment: '-- PLACES --', content: '' },
        { uid: 4, book: 'World', comment: 'The Port', content: 'A wet harbour.' },
    ];
    const first = staticDirectorLorebook(null, entries);
    assert.match(first.head, /The Port/);
    assert.doesNotMatch(first.head, /runs the ferry/);
    const next = staticDirectorLorebook(first.snapshot, [...entries, { uid: 5, book: 'World', comment: 'Character: Bram', content: 'Bram sells rope.' }]);
    assert.doesNotMatch(next.changes, /sells rope/);
});
