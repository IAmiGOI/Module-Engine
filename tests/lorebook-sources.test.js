import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBookNames, summarizeEntry, matchesFilter, mergeBooks, nextUid, blankEntry } from '../libraries/core/lorebook-sources.js';

// --- resolveBookNames() -----------------------------------------------------

test('resolveBookNames() collects all four real sources: global selection, character primary book, chat book, persona book', () => {
    const names = resolveBookNames({
        selectedWorldInfo: ['Global Lore'],
        chatBook: 'Chat Book',
        personaBook: 'Persona Book',
        characterId: 0,
        characters: [{ avatar: 'hero.png', data: { extensions: { world: 'Hero Book' } } }],
        charLore: [],
    });

    assert.deepEqual(new Set(names), new Set(['Global Lore', 'Chat Book', 'Persona Book', 'Hero Book']));
});

test('resolveBookNames() adds a character\'s extra books from charLore, matched by avatar filename without extension', () => {
    const names = resolveBookNames({
        characterId: 0,
        characters: [{ avatar: 'hero.png', data: {} }],
        charLore: [{ name: 'hero', extraBooks: ['Extra One', 'Extra Two'] }],
    });

    assert.deepEqual(new Set(names), new Set(['Extra One', 'Extra Two']));
});

test('resolveBookNames() in a GROUP chat collects books from every ENABLED member, not just characterId', () => {
    const names = resolveBookNames({
        groupId: 'g1',
        groups: [{ id: 'g1', members: ['a.png', 'b.png', 'c.png'], disabled_members: ['b.png'] }],
        characters: [
            { avatar: 'a.png', data: { extensions: { world: 'Book A' } } },
            { avatar: 'b.png', data: { extensions: { world: 'Book B' } } },
            { avatar: 'c.png', data: { extensions: { world: 'Book C' } } },
        ],
        charLore: [],
    });

    assert.deepEqual(new Set(names), new Set(['Book A', 'Book C']), 'B is disabled — its book must not appear');
});

test('resolveBookNames() dedupes when the same book is active through multiple sources', () => {
    const names = resolveBookNames({
        selectedWorldInfo: ['Shared'],
        chatBook: 'Shared',
        characterId: 0,
        characters: [{ avatar: 'hero.png', data: { extensions: { world: 'Shared' } } }],
        charLore: [],
    });

    assert.deepEqual(names, ['Shared']);
});

test('resolveBookNames() on an empty/missing snapshot returns an empty list, not a throw', () => {
    assert.deepEqual(resolveBookNames(), []);
    assert.deepEqual(resolveBookNames({}), []);
});

// --- summarizeEntry() / matchesFilter() -------------------------------------

test('summarizeEntry() reduces to metadata only — never leaks the full content string', () => {
    const summary = summarizeEntry({ uid: 3, comment: 'Tavern', key: ['tavern', 'inn'], content: 'A long description...', disable: true, constant: false }, 'MyBook');

    assert.deepEqual(summary, { uid: 3, book: 'MyBook', name: 'Tavern', keys: ['tavern', 'inn'], length: 'A long description...'.length, disabled: true, constant: false });
    assert.ok(!('content' in summary));
});

test('matchesFilter() treats an omitted field as always matching, and checks every provided field', () => {
    const summary = summarizeEntry({ uid: 1, comment: 'Tavern Door', key: ['tavern'], content: '12345', disable: false, constant: true }, 'B');

    assert.equal(matchesFilter(summary, {}), true);
    assert.equal(matchesFilter(summary, { name: 'tavern' }), true);
    assert.equal(matchesFilter(summary, { name: 'castle' }), false);
    assert.equal(matchesFilter(summary, { key: 'tav' }), true);
    assert.equal(matchesFilter(summary, { minLength: 10 }), false);
    assert.equal(matchesFilter(summary, { maxLength: 10 }), true);
    assert.equal(matchesFilter(summary, { constant: true }), true);
    assert.equal(matchesFilter(summary, { disabled: true }), false);
});

// --- mergeBooks() ------------------------------------------------------------

test('mergeBooks() keys entries by book+uid — two different active books sharing a numeric uid do not collide', () => {
    const merged = mergeBooks({
        BookA: { entries: { 0: { uid: 0, comment: 'From A' } } },
        BookB: { entries: { 0: { uid: 0, comment: 'From B' } } },
    });

    assert.equal(merged.summaries.length, 2);
    assert.equal(merged.byUid.get('BookA:0').comment, 'From A');
    assert.equal(merged.byUid.get('BookB:0').comment, 'From B');
});

test('mergeBooks() skips a book that failed to load (null/undefined data) without throwing', () => {
    const merged = mergeBooks({ BookA: null, BookB: { entries: { 0: { uid: 0, comment: 'ok' } } } });

    assert.equal(merged.summaries.length, 1);
});

// --- nextUid() / blankEntry() ------------------------------------------------

test('nextUid() is one past the highest existing numeric uid, 0 for an empty book', () => {
    assert.equal(nextUid({}), 0);
    assert.equal(nextUid({ 0: {}, 1: {}, 3: {} }), 4);
});

test('blankEntry() matches ST\'s real newWorldInfoEntryDefinition defaults (verified against the real source, not guessed)', () => {
    const entry = blankEntry(5);

    assert.equal(entry.uid, 5);
    assert.deepEqual(entry.key, []);
    assert.equal(entry.selective, true);
    assert.equal(entry.selectiveLogic, 0); // world_info_logic.AND_ANY
    assert.equal(entry.order, 100);
    assert.equal(entry.probability, 100);
    assert.equal(entry.useProbability, true);
    assert.equal(entry.depth, 4); // DEFAULT_DEPTH
    assert.equal(entry.groupWeight, 100); // DEFAULT_WEIGHT
    assert.equal(entry.role, 0);
    assert.equal(entry.scanDepth, null);
});
