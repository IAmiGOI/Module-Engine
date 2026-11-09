import test from 'node:test';
import assert from 'node:assert/strict';
import { repairInscription, normalizeConflict, DEFAULT_NO_CHECK } from '../libraries/core/decision-inscription.js';
import { durationMinutes, DURATION_SCALE } from '../libraries/core/decision-duration.js';
import { buildInscription } from '../libraries/core/decision-push.js';

const base = (overrides = {}) => ({
    stop: 'They are at the door.',
    userResult: 'The user pushes the door.',
    scene: { duration: 'half an hour' },
    beats: [{ who: 'Lena', kind: 'action', text: 'Opens the east door.' }],
    characters: [{ name: 'Lena', feels: 'calm', decreeWants: 'to be out before the guard turns', conflict: { level: 'none' }, does: 'Opens the east door.', says: 'this is the only way out', assessId: 'a1', outcome: 'The lock gives.' }],
    ...overrides,
});
const assessments = new Map([['a1', { words: 'cleanly' }]]);

test('the duration is a scale of words: the engine counts the minutes, the model never does', () => {
    assert.deepEqual(durationMinutes('a moment'), 1);
    assert.deepEqual(durationMinutes('a few minutes'), 5);
    assert.deepEqual(durationMinutes('a quarter hour'), 15);
    assert.deepEqual(durationMinutes('half an hour'), 30);
    assert.deepEqual(durationMinutes('an hour'), 60);
    assert.deepEqual(durationMinutes('a few hours'), 180);
    for (const step of DURATION_SCALE) assert.ok(durationMinutes(step) !== null || /^until/.test(step), step);
    assert.equal(durationMinutes('seventeen minutes'), null, 'a made-up number is not on the scale');
});

test('"until …" is counted from the current RP moment, and dawn comes from the setting', () => {
    const morning = new Date('2026-03-07T04:15:00Z').getTime();
    assert.equal(durationMinutes('until dawn', { nowValue: 4 * 60 + 15 }), 105, 'from 04:15 to 06:00');
    assert.equal(durationMinutes('until dawn', { nowValue: 4 * 60 + 15, timeOfDay: { dawn: '05:00' } }), 45);
    assert.equal(durationMinutes('until tomorrow', { nowValue: 4 * 60 + 15 }), 1440 - (4 * 60 + 15));
    assert.ok(Number.isFinite(morning));
});

test('a complete template passes with the fields the resolver writes', () => {
    const repaired = repairInscription({ form: base(), roster: ['Lena'], assessments, user: 'Sasha' });
    assert.equal(repaired.ok, true, JSON.stringify(repaired.missing));
    const [lena] = repaired.form.characters;
    assert.equal(lena.feels, 'calm');
    assert.equal(lena.decreeWants, 'to be out before the guard turns');
    assert.equal(lena.does, 'Opens the east door.');
    assert.equal(lena.says, 'this is the only way out');
    assert.equal(repaired.form.scene.minutes, 30);
    assert.equal(repaired.form.stop, 'They are at the door.');
    assert.deepEqual(repaired.form.roster.active, ['Lena']);
});

test('the engine repairs instead of refusing: a duplicate is a warning, someone here and not listed stays in the background', () => {
    const repaired = repairInscription({
        form: base({ characters: [
            { name: 'Lena', does: 'Opens the door.', feels: 'calm' },
            { name: 'Lena', does: 'again' },
        ] }),
        roster: ['Lena', 'Marek'], assessments, user: 'Sasha',
    });
    assert.equal(repaired.ok, true);
    const names = repaired.form.characters.map(character => character.name);
    assert.deepEqual(names, ['Lena', 'Marek'], 'the duplicate is dropped and the missing member is filled in');
    assert.equal(repaired.form.characters[1].idle, true);
    assert.match(repaired.warnings.join(' '), /listed twice/);
    assert.doesNotMatch(repaired.warnings.join(' '), /not filled in/, 'only those who act are listed — the background is not a fault');
});

test('the background keeps its last occupation, and someone gone in the previous ending and not in this turn leaves', () => {
    const repaired = repairInscription({
        form: base({ characters: [{ name: 'Lena', heard: 'the guard is coming', next: 'hide the key first', does: 'Pockets the key.' }] }),
        roster: ['Lena', 'Marek', 'Puck'], assessments, user: 'Sasha',
        previous: { characters: [{ name: 'Marek', idle: true, busy: 'counting coins' }] }, departed: ['Puck'],
    });
    assert.equal(repaired.ok, true);
    assert.deepEqual(repaired.form.roster.active, ['Lena', 'Marek']);
    const marek = repaired.form.characters.find(character => character.name === 'Marek');
    assert.equal(marek.idle, true);
    assert.equal(marek.busy, 'counting coins');
    const lena = repaired.form.characters.find(character => character.name === 'Lena');
    assert.equal(lena.decreeWants, 'hide the key first', 'next is the step toward the aim');
    assert.equal(lena.heard, 'the guard is coming');
});

test('no scene duration is a short scene without a warning', () => {
    const repaired = repairInscription({ form: base({ scene: undefined }), roster: ['Lena'], assessments, user: 'Sasha' });
    assert.equal(repaired.ok, true);
    assert.ok(repaired.form.scene.minutes > 0);
    assert.doesNotMatch(repaired.warnings.join(' '), /duration/);
});

test('the only refusal is a turn without beats while someone acts', () => {
    const repaired = repairInscription({ form: base({ beats: [] }), roster: ['Lena'], assessments });
    assert.equal(repaired.ok, false);
    assert.match(repaired.missing.join('\n'), /beats/);
    const idle = repairInscription({ form: base({ beats: [], characters: [{ name: 'Lena', idle: true, busy: 'counting' }] }), roster: ['Lena'], assessments });
    assert.equal(idle.ok, true, 'a turn where nobody acts needs no beats');
});

test('a conflict is on the scale none / minor / strong, and a strong one is flagged when it has no reason', () => {
    assert.equal(normalizeConflict({ level: 'strong' }).level, 'strong');
    assert.equal(normalizeConflict({ level: 'big' }).level, 'strong');
    assert.equal(normalizeConflict({ level: 'small' }).level, 'minor');
    assert.equal(normalizeConflict({ level: 'nothing' }).level, 'none');
    assert.equal(normalizeConflict(null).level, 'none');
    const repaired = repairInscription({ form: base({ characters: [{ name: 'Lena', does: 'x', feels: 'y', conflict: { level: 'strong' } }] }), roster: ['Lena'], assessments });
    assert.match(repaired.warnings.join(' '), /strong conflict with no reason/);
});

test('a character with no aim gets the Decree-free default rather than a refusal', () => {
    const repaired = repairInscription({ form: base({ characters: [{ name: 'Lena', does: 'Opens the door.', feels: 'calm' }] }), roster: ['Lena'], assessments });
    assert.equal(repaired.ok, true);
    assert.equal(repaired.form.characters[0].noCheck, DEFAULT_NO_CHECK);
});

test('a scene duration that is not on the scale falls back to a few minutes and warns', () => {
    const repaired = repairInscription({ form: base({ scene: { duration: 'some time later' } }), roster: ['Lena'], assessments });
    assert.equal(repaired.form.scene.minutes, 5);
    assert.match(repaired.warnings.join(' '), /was not on the scale/);
});

test('the old field names are accepted, so a form written before the template is not thrown away', () => {
    const repaired = repairInscription({
        form: base({ scene: { minutes: 12 }, characters: [{ name: 'Lena', feeling: 'cold', action: 'Opens the door.', actionReason: 'the only exit', speech: 'out', outcome: 'ok' }] }),
        roster: ['Lena'], assessments,
    });
    assert.equal(repaired.ok, true);
    const [lena] = repaired.form.characters;
    assert.equal(lena.feels, 'cold');
    assert.equal(lena.does, 'Opens the door.');
    assert.equal(lena.decreeWants, 'the only exit');
    assert.equal(repaired.form.scene.minutes, 12, 'the old minute count is still usable');
});

test('the inscription is built from the template: beats, the user result, END, and the reasons off the page', () => {
    const repaired = repairInscription({ form: base(), roster: ['Lena'], assessments });
    const inscription = buildInscription({ form: repaired.form, assessments, place: 'EAST CORRIDOR', timeAfter: 'Day 1, 08:30' });
    assert.match(inscription, /took 30 minutes/);
    assert.match(inscription, /Place: EAST CORRIDOR/);
    assert.match(inscription, /THE USER'S ACTION, AND HOW IT LANDS: The user pushes the door\./);
    assert.match(inscription, /1\. Lena — ACTION: Opens the east door\./);
    assert.match(inscription, /END: They are at the door\. Stop there\./);
    assert.match(inscription, /NOT FOR THE PAGE[\s\S]*- Lena: Feels: calm\. Wants: to be out before the guard turns\./);
});
