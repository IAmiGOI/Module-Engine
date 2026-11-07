import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MOOD_AXES, normalizeMood, normalizeDecree, normalizeDecrees, decreeSections, sameDecree,
} from '../libraries/core/decision-decree.js';
import { applyDecree, findCharacter } from '../libraries/core/decision-great-bank.js';

const decree = {
    character: 'Lena',
    valuesAndFacts: 'Freedom above all.\nThe east gate is watched.',
    selfView: 'A prisoner who was never caught.',
    goals: { long: 'Leave the keep for good.', today: 'Find the east key.' },
    mood: { calm: 'slightly', warm: 'neutral', lively: 'strongly' },
    resolving: 'When cornered, she offers a bargain before she runs.',
};

test('the three mood axes never lose the pole or the strength', () => {
    const line = normalizeMood('slightly agitated, strongly warm, neutral lively');
    assert.match(line, /calm ↔ agitated: slightly toward agitated/);
    assert.match(line, /warm ↔ cold: strongly toward warm/);
    assert.match(line, /lively ↔ tired: neutral/);
    assert.equal(MOOD_AXES.length, 3);
    assert.match(normalizeMood({ calm: 'strongly', warm: 'slightly', lively: 'neutral' }), /calm ↔ agitated: strongly toward calm/);
    assert.equal(normalizeMood(''), 'calm ↔ agitated: neutral; warm ↔ cold: neutral; lively ↔ tired: neutral');
    assert.equal(normalizeMood('a quiet uneasy day'), 'a quiet uneasy day', 'unknown wording is kept, not lost');
});

test('a Decree becomes the five Great Bank fields', () => {
    const parsed = normalizeDecree(decree);
    assert.equal(parsed.character, 'Lena');
    assert.deepEqual(parsed.valuesAndFacts, ['Freedom above all.', 'The east gate is watched.']);
    assert.deepEqual(parsed.goals.lines, ['Long goal: Leave the keep for good.', 'Today: Find the east key.']);
    const sections = decreeSections(parsed);
    assert.equal(Object.keys(sections).length, 5);
    assert.match(sections[4][0], /calm ↔ agitated/);
    assert.equal(normalizeDecree({ valuesAndFacts: 'x' }), null, 'a Decree without a character is dropped');
    assert.equal(normalizeDecrees([decree, { ...decree, selfView: 'Second view.' }]).length, 1, 'the last entry for a name wins');
});

test('applyDecree writes the block, stamps RP time and keeps the old Decree in history', () => {
    const first = applyDecree({}, normalizeDecree(decree), { at: 'Day 1, 10:00', comment: 'First Decree.' });
    assert.equal(first.changed, true);
    const lena = findCharacter(first.state, 'Lena');
    assert.equal(lena.decree[1].length, 2);
    assert.match(lena.decree[1][0], /\[Day 1, 10:00\]/);
    assert.equal(lena.decreeAt, 'Day 1, 10:00');
    assert.equal(first.history.length, 5);

    const next = { ...normalizeDecree(decree), selfView: 'A prisoner who chose to stay.' };
    const second = applyDecree(first.state, next, { at: 'Day 1, 12:00', comment: 'The report changed her.' });
    assert.equal(second.changed, true);
    assert.ok(second.history.some(item => item.part === 'decree' && item.section === 2 && /never caught/.test(item.old)));
    assert.match(findCharacter(second.state, 'Lena').decree[2][0], /chose to stay/);

    const same = applyDecree(second.state, next, { at: '[Day 1, 13:00]', comment: 'No change.' });
    assert.equal(same.changed, false, 'the same Decree does not grow history');
    assert.equal(same.history.length, 0);
    assert.equal(sameDecree(next, next), true);
});
