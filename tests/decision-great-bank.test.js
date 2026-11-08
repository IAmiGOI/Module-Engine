import test from 'node:test';
import assert from 'node:assert/strict';
import {
    applyEdits, resolveSection, normalizeGreatBank, blankCharacter, nearestLine,
    findCharacter, ensureCharacter, canEdit, normalizeImportance, MATERIAL_SECTIONS, SPIRITUAL_SECTIONS,
} from '../libraries/core/decision-great-bank.js';
import { parseBankSections } from '../libraries/core/decision-bank-parse.js';
import { renderFarBanks, renderNearBanks, renderDecreeSection } from '../libraries/core/decision-bank-projections.js';
import { rpInstant } from '../libraries/core/decision-bank-time.js';

const AT = '2026-03-07 04:15';
const VALUE = rpInstant(AT, 0);

const entries = state => Object.values(state).map(character => ({ character }));
const run = (state, edits, extra = {}) => applyEdits(state, { edits, comment: 'The turn changed this.', at: AT, nowValue: VALUE, ...extra });

test('the Great Bank has the owner\'s sections: material 1–7 and spiritual 1–6', () => {
    assert.deepEqual(MATERIAL_SECTIONS.map(section => section.no), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(SPIRITUAL_SECTIONS.map(section => section.no), [1, 2, 3, 4, 5, 6]);
    const blank = blankCharacter('Rem', { importance: 'main', aliases: ['Rem-tan'] });
    assert.equal(Object.keys(blank.material).length, 7);
    assert.equal(Object.keys(blank.spiritual).length, 7, 'spiritual also keeps an internal "other" bucket');
    assert.equal(blank.importance, 'main');
    assert.deepEqual(blank.aliases, ['Rem-tan']);
    assert.deepEqual(blank.decree, { 1: [], 2: [], 3: [], 4: [], 5: [] }, 'Decree has its five fields and no tool yet');
});

test('a section is found by number, by name and by a close word; an unknown one goes to Other facts of its part', () => {
    assert.deepEqual(resolveSection('3'), { kind: 'section', part: 'material', no: 3, bareNumber: true });
    assert.equal(resolveSection('Material 6').no, 6);
    assert.equal(resolveSection('Spiritual 4').part, 'spiritual');
    assert.equal(resolveSection('abilities').no, 6);
    assert.equal(resolveSection('what she wears').no, 5);
    assert.equal(resolveSection('values').no, 1);
    assert.equal(resolveSection('Spiritual: how she chooses').part, 'spiritual');
    assert.equal(resolveSection('a nonsense heading').no, 7, 'unknown goes to Material 7');
    assert.equal(resolveSection('a nonsense spiritual heading').no, 0, 'unknown in the spiritual part goes to its other bucket');
    assert.equal(resolveSection('knowledge').kind, 'knowledge', 'Knowledge stays its own existing system');
    assert.equal(resolveSection('decree').kind, 'decree', 'Decree is a separate block with no tool yet');
});

test('a line is found by meaning, not byte for byte: case, spacing and punctuation do not matter', () => {
    const lines = ['Blue hair, one horn.', 'Wants to be seen as herself.'];
    assert.equal(nearestLine(lines, 'blue hair one horn')?.index, 0);
    assert.equal(nearestLine(lines, 'WANTS to be seen as herself!')?.index, 1);
    assert.equal(nearestLine(lines, 'wants to be seen')?.index, 1);
    assert.equal(nearestLine(lines, 'a lighthouse keeper'), null);
});

test('old is replaced, an unfound old appends new, an empty new removes the line, and nothing is refused', () => {
    let applied = run({}, [{ character: 'Rem', section: 'appearance', old: '', new: 'Blue hair, one horn.' }]);
    assert.equal(applied.created.length, 1, 'an unknown character is created, not refused');
    assert.equal(findCharacter(applied.state, 'rem').importance, 'temporary');
    assert.match(applied.state.rem.material[1][0], /^Blue hair, one horn\.$/, 'the first line of an empty part is a constant: no RP time');

    applied = run(applied.state, [{ character: 'Rem', section: '1', old: 'blue hair one horn', new: 'Blue hair, one horn, chipped.' }]);
    assert.equal(applied.state.rem.material[1].length, 1, 'the closest line was replaced, not duplicated');
    assert.match(applied.state.rem.material[1][0], /^\[2026-03-07 04:15\] Blue hair, one horn, chipped\.$/, 'a later change is news of the turn: stamped');
    assert.equal(applied.changes[0].old, 'Blue hair, one horn.');

    applied = run(applied.state, [{ character: 'Rem', section: '1', old: 'nothing like this line', new: 'A second fact.' }]);
    assert.equal(applied.state.rem.material[1].length, 2, 'no close line — new is appended');

    applied = run(applied.state, [{ character: 'Rem', section: '1', old: 'a second fact', new: '' }]);
    assert.equal(applied.state.rem.material[1].length, 1, 'an empty new removes the line');
});

test('a name is matched by alias and in any case', () => {
    let state = {};
    state = run(state, [{ character: 'Rem', section: 'values', old: '', new: 'Her sister above all.' }]).state;
    const applied = run(state, [{ character: 'rem', section: 'material 3', old: '', new: 'Still comatose.' }]);
    assert.equal(Object.keys(applied.state).length, 1, 'no second character for a different case');
    assert.equal(applied.state.rem.material[3].length, 1);
    const withAlias = normalizeGreatBank({ rem: { ...blankCharacter('Rem'), aliases: ['Rem-tan'] } });
    assert.equal(findCharacter(withAlias, 'REM-TAN').name, 'Rem');
});

test('a bare section number is settled by the line: the same number exists in both parts', () => {
    let state = run({}, [{ character: 'Rem', section: 'spiritual 4', old: '', new: 'Wants to be recognised.' }]).state;
    const applied = run(state, [{ character: 'Rem', section: '4', old: 'wants to be recognised', new: 'Wants to be recognised as herself.' }]);
    assert.equal(applied.state.rem.spiritual[4].length, 1, 'the spiritual line was found by its text');
    assert.equal(applied.state.rem.material[4].length, 0, 'material 4 was not touched');
});

test('every changed line is stamped with the turn\'s RP time, except the first fill of an empty part', () => {
    const first = run({}, [{ character: 'Rem', section: 'values', old: '', new: 'Her sister above all.' }]);
    assert.match(first.state.rem.spiritual[1][0], /^Her sister above all\.$/, 'the first fill of a part carries no RP time');
    const applied = run(first.state, [{ character: 'Rem', section: 'likes', old: '', new: 'Sweet things.' }]);
    assert.match(applied.state.rem.spiritual[2][0], /^\[2026-03-07 04:15\] Sweet things\.$/);
    assert.equal(applied.at, AT, 'the answer names the time of the change');
});

test('for and until are words: the engine turns them into an absolute deadline, and an unreadable one keeps the text', () => {
    let applied = run({}, [{ character: 'Rem', section: 'carried', old: '', new: 'A lantern.', until: 'an hour' }]);
    assert.match(applied.state.rem.material[4][0], /\[until 2026-03-07 05:15\]$/);
    applied = run(applied.state, [{ character: 'Rem', section: 'carried', old: '', new: 'A map to the village.', until: 'when the moon falls' }]);
    assert.doesNotMatch(applied.state.rem.material[4][1], /\[until/, 'an unreadable deadline leaves the text as it is');
});

test('the resolver edits only the material part: a spiritual edit is kept as a proposal, not refused', () => {
    const state = run({}, [{ character: 'Rem', section: 'appearance', old: '', new: 'Blue hair.' }]).state;
    const applied = run(state, [{ character: 'Rem', section: 'values', old: '', new: 'Hates being pitied.' }], { by: 'resolver' });
    assert.equal(applied.state.rem.spiritual[1].length, 0, 'nothing was written to the spiritual section');
    assert.equal(applied.state.rem.pending.length, 1);
    assert.equal(applied.state.rem.pending[0].new, 'Hates being pitied.');
    assert.equal(applied.changes[0].pending, true);
    const material = run(state, [{ character: 'Rem', section: 'clothing', old: '', new: 'A maid dress.' }], { by: 'resolver' });
    assert.equal(material.state.rem.material[5].length, 1, 'the material edit goes through');
    assert.equal(canEdit('resolver', 'material'), true);
    assert.equal(canEdit('resolver', 'spiritual'), false);
    assert.equal(canEdit('director', 'spiritual'), true);
});

test('every section has its history of edits: RP time, who, old → new, comment', () => {
    const applied = run({}, [{ character: 'Rem', section: 'appearance', old: '', new: 'Blue hair.' }]);
    const [entry] = applied.state.rem.history;
    assert.equal(entry.at, AT);
    assert.equal(entry.by, 'director');
    assert.equal(entry.part, 'material');
    assert.equal(entry.section, 1);
    assert.equal(entry.old, '');
    assert.equal(entry.new, 'Blue hair.');
    assert.equal(entry.comment, 'The turn changed this.');
});

test('one call edits several characters at once', () => {
    const applied = run({}, [
        { character: 'Rem', section: 'values', old: '', new: 'Her sister.' },
        { character: 'Ram', section: 'values', old: '', new: 'The mansion.' },
    ]);
    assert.equal(applied.changes.length, 2);
    assert.equal(applied.state.rem.spiritual[1].length, 1);
    assert.equal(applied.state.ram.spiritual[1].length, 1);
    assert.deepEqual(applied.created, ['Rem', 'Ram']);
});

test('importance is one of the four levels; an old key/minor value maps onto the new ones', () => {
    assert.equal(normalizeImportance('main'), 'main');
    assert.equal(normalizeImportance('mass'), 'mass');
    assert.equal(normalizeImportance('key'), 'main');
    assert.equal(normalizeImportance('minor'), 'side');
    assert.equal(normalizeImportance('nonsense'), 'side');
});

test('the builder\'s section headings are parsed into the Great Bank; a legacy free-text card is not', () => {
    const bank = [
        '***Rem***',
        'Material 1 — Appearance',
        '- Blue hair, one horn (people notice the horn first).',
        'Material 3 — Life facts',
        '- **Timeline lock** — still comatose.',
        'Spiritual 6 — Resolving',
        '- Family before law.',
        'IMPORTANCE: key',
    ].join('\n');
    const parsed = parseBankSections(bank);
    assert.equal(parsed.ready, true);
    assert.equal(parsed.identity, 'Rem');
    assert.deepEqual(parsed.material[1], ['Blue hair, one horn (people notice the horn first).']);
    assert.deepEqual(parsed.material[3], ['**Timeline lock** — still comatose.']);
    assert.deepEqual(parsed.spiritual[6], ['Family before law.'], 'the IMPORTANCE line is not a fact');

    const legacy = parseBankSections('***Aria***\n**Core goal** — Escape.\n**Appearance** — A grey coat.\n- Loyal.');
    assert.equal(legacy.ready, false, 'an old free-text bank is not translated');
    assert.deepEqual(legacy.material, {});
});

test('the far projection is Material 1, 3, 6 + Spiritual 4, 6; the near one is every section', () => {
    let state = {};
    state = run(state, [
        { character: 'Rem', section: 'appearance', old: '', new: 'Blue hair.' },
        { character: 'Rem', section: 'property', old: '', new: 'A room in the mansion.' },
        { character: 'Rem', section: 'abilities', old: '', new: 'Water magic up to a small stream.' },
        { character: 'Rem', section: 'needs', old: '', new: 'To be seen as herself.' },
        { character: 'Rem', section: 'resolving', old: '', new: 'Family before law.' },
        { character: 'Rem', section: 'likes', old: '', new: 'Sweet things.' },
    ]).state;
    const far = renderFarBanks(entries(state), { nowValue: VALUE });
    assert.match(far, /Blue hair/);
    assert.match(far, /Water magic/);
    assert.match(far, /To be seen as herself/);
    assert.match(far, /Family before law/);
    assert.doesNotMatch(far, /A room in the mansion/, 'Property (Material 2) is not in the far projection');
    assert.doesNotMatch(far, /Sweet things/, 'Spiritual 2 is not in the far projection');
    const near = renderNearBanks(entries(state), { nowValue: VALUE });
    assert.match(near, /A room in the mansion/);
    assert.match(near, /Sweet things/);
});

test('a line with an expired deadline is marked as past in the projections', () => {
    const state = run({}, [{ character: 'Rem', section: 'life', old: '', new: 'Her arm is broken.', until: 'an hour' }]).state;
    const now = renderNearBanks(entries(state), { nowValue: VALUE + 30 });
    assert.doesNotMatch(now, /\(past\)/);
    const later = renderNearBanks(entries(state), { nowValue: VALUE + 120 });
    assert.match(later, /Her arm is broken\. \[until 2026-03-07 05:15\] \(past\)/);
});

test('a legacy bank goes into the projections as its own text, with sections empty', () => {
    const legacy = { name: 'Aria', sectionsReady: false, fallbackText: '***Aria***\n**Core goal** — Escape.' };
    const near = renderNearBanks([{ character: legacy }], { nowValue: VALUE });
    assert.match(near, /Aria/);
    assert.match(near, /Core goal/);
    assert.match(near, /Escape/);
});

test('Decrees stay out of the projections while the block is empty; the writer block is empty too', () => {
    const state = run({}, [{ character: 'Rem', section: 'values', old: '', new: 'Her sister.' }]).state;
    assert.equal(renderDecreeSection(entries(state), { nowValue: VALUE }), '');
});

test('the times of day come from the setting: what "dawn" means is decided by the settings, not by the code', () => {
    const applied = run({}, [{ character: 'Rem', section: 'life', old: '', new: 'A long walk ahead.', until: 'dawn' }], { timeOfDay: { dawn: '05:30' } });
    assert.match(applied.state.rem.material[3][0], /\[until 2026-03-07 05:30\]$/);
    const broken = run({}, [{ character: 'Rem', section: 'life', old: '', new: 'A long walk ahead.', until: 'dawn' }], { timeOfDay: { dawn: 'nonsense' } });
    assert.doesNotMatch(broken.state.rem.material[3][0], /\[until/, 'a broken setting leaves the line without a deadline');
});
