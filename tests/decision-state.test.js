import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCharacterNote, applyArc, applyPlan, notesFor, notesSection, planSection, arcsSection, MAX_NOTES_PER_CHARACTER } from '../libraries/core/decision-state.js';

const now = () => 1000;
const rid = () => 'x';

test('a character holds at most four notes; the fifth add replaces the one updated longest ago and says so', () => {
    let notes = {};
    for (let index = 0; index < MAX_NOTES_PER_CHARACTER; index += 1) {
        const applied = applyCharacterNote(notes, { character: 'Lena', op: 'add', title: `T${index}`, text: `Text ${index}` }, { now, rid });
        assert.equal(applied.ok, true);
        notes = applied.notes;
    }
    const fifth = applyCharacterNote(notes, { character: 'Lena', op: 'add', title: 'One more', text: 'Room made.' }, { now, rid });
    assert.equal(fifth.ok, true);
    assert.equal(fifth.replaced, 'T0');
    assert.equal(notesFor(fifth.notes, 'lena').length, MAX_NOTES_PER_CHARACTER);
    assert.ok(notesFor(fifth.notes, 'lena').some(note => note.title === 'One more'));
});

test('notes are set, removed and kept per character, and the writer gets them as blocks', () => {
    let notes = applyCharacterNote({}, { character: 'Lena', op: 'add', title: 'Goal', text: 'Leave.' }, { now, rid }).notes;
    notes = applyCharacterNote(notes, { character: 'Marek', op: 'add', title: 'Secret', text: 'He knows.' }, { now, rid }).notes;
    const id = notesFor(notes, 'Lena')[0].id;
    notes = applyCharacterNote(notes, { character: 'Lena', op: 'set', id, text: 'Leave tonight.' }, { now, rid }).notes;
    assert.equal(notesFor(notes, 'Lena')[0].title, 'Goal');
    assert.equal(notesFor(notes, 'Lena')[0].text, 'Leave tonight.');
    assert.match(notesSection(notes), /Lena: Goal/);
    assert.match(notesSection(notes), /Marek: Secret/);
    notes = applyCharacterNote(notes, { character: 'Lena', op: 'remove', id }, { now, rid }).notes;
    assert.equal(notesFor(notes, 'Lena').length, 0);
});

test('a plan always has a direction; stages clamp the current stage', () => {
    const missing = applyPlan(null, { stages: ['a'] }, { now });
    assert.equal(missing.ok, false);
    const plan = applyPlan(null, { direction: 'Get her out.', stages: ['door', 'road'], currentStage: 9 }, { now });
    assert.equal(plan.ok, true);
    assert.equal(plan.plan.currentStage, 1);
    assert.match(planSection(plan.plan), /YOUR PLAN/);
    assert.match(planSection(plan.plan), /Get her out\./);
});

test('arcs open, take stages and close; a closed arc takes no new stages and is never reopened', () => {
    const opened = applyArc([], { op: 'open', title: 'The escape' }, { now, rid });
    assert.equal(opened.ok, true);
    const id = opened.arc.id;
    const staged = applyArc(opened.arcs, { op: 'stage', id, note: 'She reaches the door.' }, { now, rid });
    assert.equal(staged.arc.stages.length, 1);
    const closed = applyArc(staged.arcs, { op: 'close', id }, { now, rid });
    assert.equal(closed.arc.status, 'closed');
    assert.equal(applyArc(closed.arcs, { op: 'stage', id, note: 'Too late.' }, { now, rid }).ok, false);
    assert.equal(applyArc(closed.arcs, { op: 'close', id }, { now, rid }).ok, false);
    assert.match(arcsSection(closed.arcs), /\[closed\] The escape/);
});

test('a character note is found by its title, and removing a note that does not exist is an honest error', async () => {
    const { applyCharacterNote } = await import('../libraries/core/decision-state.js');
    const notes = { sasha: [{ id: 'note_a', character: 'Sasha', title: 'What Sasha has on them', text: 'no gate' }] };
    const set = applyCharacterNote(notes, { character: 'Sasha', op: 'set', id: 'Sasha: What Sasha has on them', text: 'a large gate' });
    assert.equal(set.ok, true);
    assert.equal(set.notes.sasha[0].text, 'a large gate');
    const missing = applyCharacterNote(notes, { character: 'Sasha', op: 'remove', id: 'nope' });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /Notes: "What Sasha has on them"/);
});
