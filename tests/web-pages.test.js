import test from 'node:test';
import assert from 'node:assert/strict';
import { computeOutline, sliceText, pickSection, findInText, createPageStore, VIEW_MAX_CHARS } from '../libraries/core/web-pages.js';

const PAGE = 'Intro line.\n## Appearance\nFive tails and white hair.\n## Abilities\nImmense strength, tails as weapons.';

test('the outline lists the sections with their start and size, text before the first heading is the "Beginning", and a page without headings is one section', () => {
    const outline = computeOutline(PAGE);
    assert.deepEqual(outline.map(item => [item.number, item.title, item.offset]), [[1, 'Beginning', 0], [2, 'Appearance', 12], [3, 'Abilities', 53]]);
    assert.equal(outline.reduce((sum, item) => sum + item.chars, 0), PAGE.length);
    assert.deepEqual(computeOutline('just text').map(item => item.title), ['Beginning']);
});

test('a slice is bounded and tells where to continue; past the end there is nothing more', () => {
    assert.deepEqual([sliceText(PAGE, { offset: 0, chars: 200 }).next, sliceText(PAGE, { offset: 0, chars: 200 }).to], [null, PAGE.length]);
    const long = 'x'.repeat(30000);
    const piece = sliceText(long, { offset: 100, chars: 999999 });
    assert.deepEqual([piece.text.length, piece.next], [VIEW_MAX_CHARS, 100 + VIEW_MAX_CHARS]);
    assert.equal(sliceText(PAGE, { offset: -5, chars: 200 }).from, 0);
});

test('a section is found by its number or by part of its title, otherwise nothing', () => {
    const outline = computeOutline(PAGE);
    assert.equal(pickSection(outline, 2).title, 'Appearance');
    assert.equal(pickSection(outline, '3').title, 'Abilities');
    assert.equal(pickSection(outline, 'abil').title, 'Abilities');
    assert.equal(pickSection(outline, 'nope'), null);
    assert.equal(pickSection(outline, undefined), null);
});

test('a search ranks the places where several of the words meet, with the section of each, and does not repeat overlapping places', () => {
    const outline = computeOutline(PAGE);
    const places = findInText(PAGE, 'tails hair', outline);
    assert.equal(places[0].section, '2. Appearance');
    assert.equal(places[0].score, 2);
    assert.ok(places.length <= 8);
    assert.deepEqual(findInText(PAGE, '   ', outline), []);
    assert.deepEqual(findInText(PAGE, 'zebra', outline), []);
});

test('the store keeps the latest pages, replaces a page opened again from the same address, drops the oldest over the limit, and knows nothing about a wrong id', () => {
    const store = createPageStore({ limit: 2 });
    const first = store.open({ url: 'https://a.org', text: 'one' });
    store.open({ url: 'https://b.org', text: 'two' });
    assert.equal(store.get(first.id).text, 'one');
    const again = store.open({ url: 'https://a.org', text: 'one again' });
    assert.notEqual(again.id, first.id);
    assert.equal(store.get(first.id), null);
    store.open({ url: 'https://c.org', text: 'three' });
    assert.deepEqual(store.list().map(item => item.url), ['https://a.org', 'https://c.org']);
    assert.equal(store.get('p404'), null);
});
