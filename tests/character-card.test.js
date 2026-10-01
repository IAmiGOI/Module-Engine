import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeCardFields, computeFlatCard, buildCreateForm, buildMergeBody, buildRestoreBody, computeBookAfterPatch, computeChangedFieldNames, CARD_FIELD_NAMES,
} from '../libraries/core/character-card.js';

test('a new card needs a name, and an unknown field is refused with the list of real fields instead of being dropped silently', () => {
    assert.equal(normalizeCardFields({ description: 'x' }, { isNewCard: true }).ok, false);
    const refused = normalizeCardFields({ name: 'Aria', hair: 'red' }, { isNewCard: true });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /Unknown character field: hair\. The fields are: name, description/);
    assert.ok(CARD_FIELD_NAMES.includes('post_history_instructions'));
});

test('every field the card can hold is accepted and cleaned: texts trimmed and capped, lists deduplicated, numbers clamped', () => {
    const made = normalizeCardFields({
        name: '  Aria  ', description: 'A\r\nB', personality: 'p', scenario: 's', first_mes: 'hi', mes_example: '<START>\n{{char}}: hm', creator_notes: 'n',
        system_prompt: 'sp', post_history_instructions: 'phi', creator: 'me', character_version: '1.2', world: 'Book',
        alternate_greetings: ['a', 'a', 'b'], tags: 'x, y, x', talkativeness: 4, fav: true,
        depth_prompt: { prompt: 'dp', depth: 2000, role: 'user' }, extensions: { regex_scripts: [], talkativeness: 0.1 },
    }, { isNewCard: true });
    assert.equal(made.ok, true);
    assert.equal(made.value.name, 'Aria');
    assert.equal(made.value.description, 'A\nB');
    assert.deepEqual(made.value.alternate_greetings, ['a', 'b']);
    assert.deepEqual(made.value.tags, ['x', 'y']);
    assert.equal(made.value.talkativeness, 1);
    assert.deepEqual(made.value.depth_prompt, { prompt: 'dp', depth: 999, role: 'user' });
    assert.deepEqual(made.value.extensions, { regex_scripts: [] }, 'keys the engine owns as separate fields are not accepted inside "extensions"');
    assert.equal(normalizeCardFields({ description: 'x'.repeat(50000) }, {}).value.description.length, 40000);
});

test('an edit names only what changes, and an edit that names nothing is refused', () => {
    assert.deepEqual(normalizeCardFields({ avatar: 'Aria.png', first_mes: 'Hello' }).value, { first_mes: 'Hello' });
    assert.equal(normalizeCardFields({ avatar: 'Aria.png' }).ok, false);
    assert.equal(normalizeCardFields({ name: '   ' }).ok, false, 'a rename to nothing is refused');
});

test('a card lorebook: a new card needs text and trigger keys in every entry; an edit may touch an existing entry by id with only the changed field', () => {
    assert.equal(normalizeCardFields({ name: 'A', character_book: { entries: [{ content: 'no keys' }] } }, { isNewCard: true }).ok, false);
    assert.equal(normalizeCardFields({ name: 'A', character_book: { entries: [{ keys: ['k'], content: 'ok' }, { constant: true, content: 'always' }] } }, { isNewCard: true }).ok, true);
    const edit = normalizeCardFields({ character_book: { entries: [{ id: 3, enabled: false }], removeEntries: [1, 'x'] } });
    assert.equal(edit.ok, true);
    assert.deepEqual(edit.value.character_book.entries, [{ id: 3, enabled: false }]);
    assert.deepEqual(edit.value.character_book.removeEntries, [1]);
});

test('ST JSON is read in either shape: V2 data wins over nothing, the flat V1 field wins over data, and missing things get the defaults ST itself uses', () => {
    const flat = computeFlatCard({
        name: 'Aria', description: 'flat description', data: { name: 'Aria', description: 'nested', system_prompt: 'sp', creator_notes: 'notes', alternate_greetings: ['g'], tags: ['t'], extensions: { talkativeness: '0.7', fav: true, world: 'W', depth_prompt: { prompt: 'dp', depth: 6, role: 'user' }, chub: { id: 1 } }, character_book: { name: 'B', entries: [{ id: 0 }] } },
    });
    assert.equal(flat.description, 'flat description');
    assert.equal(flat.system_prompt, 'sp');
    assert.equal(flat.creator_notes, 'notes');
    assert.equal(flat.talkativeness, 0.7);
    assert.equal(flat.fav, true);
    assert.equal(flat.world, 'W');
    assert.deepEqual(flat.depth_prompt, { prompt: 'dp', depth: 6, role: 'user' });
    assert.deepEqual(flat.extensions, { chub: { id: 1 } }, 'foreign extensions stay visible, the ones the engine owns do not repeat there');
    const bare = computeFlatCard({ name: 'Old', description: 'v1 only' });
    assert.deepEqual([bare.description, bare.tags, bare.talkativeness, bare.depth_prompt.depth, bare.character_book], ['v1 only', [], 0.5, 4, null]);
});

test('the create form carries only the name, because a multipart form would turn every newline of the texts into CRLF', () => {
    assert.deepEqual(buildCreateForm({ name: 'Aria', description: 'two\nlines', tags: ['a'] }), { ch_name: 'Aria' });
});

test('the merge body writes each field both flat (V1) and inside data (V2) so that neither kind of reader sees an old value, and leaves unnamed fields out', () => {
    const body = buildMergeBody({ description: 'new', creator_notes: 'cn', system_prompt: 'sp', tags: ['t'], talkativeness: 0, fav: true, depth_prompt: { depth: 3 }, extensions: { regex_scripts: [] } }, { entries: [] });
    assert.deepEqual(body, {
        description: 'new', creatorcomment: 'cn', tags: ['t'], talkativeness: 0, fav: true,
        data: { description: 'new', creator_notes: 'cn', system_prompt: 'sp', tags: ['t'], character_book: { entries: [] }, extensions: { talkativeness: 0, fav: true, depth_prompt: { depth: 3 }, regex_scripts: [] } },
    });
    assert.deepEqual(buildMergeBody({ first_mes: 'x' }, null), { first_mes: 'x', data: { first_mes: 'x' } });
});

test('a lorebook edit keeps untouched entries and the hidden ST extensions of a changed one, appends new entries with fresh ids, and removes the listed ones', () => {
    const existing = { name: 'B', extensions: {}, entries: [{ id: 0, keys: ['a'], content: 'A', extensions: { depth: 4 } }, { id: 1, keys: ['b'], content: 'B', extensions: {} }, { id: 5, keys: ['c'], content: 'C', extensions: {} }] };
    const made = computeBookAfterPatch(existing, { entries: [{ id: 0, content: 'A2' }, { keys: ['d'], content: 'D' }], removeEntries: [1] });
    assert.equal(made.ok, true);
    assert.deepEqual(made.value.entries.map(entry => [entry.id, entry.content]), [[0, 'A2'], [5, 'C'], [6, 'D']]);
    assert.deepEqual(made.value.entries[0].extensions, { depth: 4 }, 'the ST-only settings of a changed entry survive');
    assert.equal(made.value.entries[2].enabled, true, 'a new entry gets the defaults a card entry needs');
    assert.equal(computeBookAfterPatch(existing, { entries: [{ id: 99, enabled: false }] }).ok, false, 'changing an entry that does not exist is refused');
    assert.equal(computeBookAfterPatch(null, { entries: [{ keys: ['k'], content: 'first' }] }).value.entries[0].id, 0, 'a card with no book starts one');
});

test('a restore writes back the saved fields and data but never the chat, creation date or avatar path', () => {
    const body = buildRestoreBody({ name: 'Aria', description: 'old', chat: 'Aria - 2026', create_date: 'x', avatar: 'none', talkativeness: '0.5', data: { description: 'old', extensions: {} } });
    assert.deepEqual(Object.keys(body).sort(), ['data', 'description', 'name', 'talkativeness']);
    assert.notEqual(body.data, undefined);
});

test('the changed-fields list says which fields differ between two flat cards', () => {
    const before = computeFlatCard({ name: 'A', description: 'one', tags: ['x'] });
    const after = computeFlatCard({ name: 'A', description: 'two', tags: ['x'] });
    assert.deepEqual(computeChangedFieldNames(before, after), ['description']);
});
