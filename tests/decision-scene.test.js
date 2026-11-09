import test from 'node:test';
import assert from 'node:assert/strict';
import { departedFrom, lastAcceptedForm, renderAlreadySaid, renderCurrentScene } from '../libraries/core/decision-scene.js';
import { createInscribeHandler } from '../cores/decision/handlers-inscribe.js';
import { buildDeciderContext } from '../libraries/core/decision-context.js';

const previous = {
    scene: { minutes: 2, place: 'Main thoroughfare, by the fountain' }, meta: { place: 'Main thoroughfare, by the fountain' },
    resolution: 'Emilia has answered, and Diethard, refused her name twice, closes his notebook and walks off to file the theft.',
    userResult: 'The question was heard.',
    beats: [{ who: 'Someone', kind: 'action', text: 'acts' }], characters: [
        { name: 'Emilia', action: 'answers flatly: the insignia first' },
        { name: 'Kadomon', idle: true },
    ],
};

test('who left in the ending is found by name and leave words; the user is never counted', () => {
    assert.deepEqual(departedFrom(previous.resolution, ['Emilia', 'Diethard Diethain', 'Kadomon']), ['Diethard Diethain']);
    assert.deepEqual(departedFrom('Sasha walks off.', ['Sasha'], { user: 'Sasha' }), []);
});

test('CURRENT SCENE gives one place to everyone: here, in the background, gone', () => {
    const scene = renderCurrentScene({ form: previous, roster: ['Emilia', 'Diethard Diethain', 'Kadomon'], user: 'Sasha' });
    assert.match(scene, /^CURRENT SCENE/);
    assert.match(scene, /Place: Main thoroughfare, by the fountain\./);
    assert.match(scene, /Here with Sasha:\n  - Emilia — last: answers flatly/);
    assert.match(scene, /Here in the background, on their own: Kadomon\./);
    assert.match(scene, /Gone in that ending: Diethard Diethain\./);
    assert.doesNotMatch(scene, /active roster|update_roster/, 'no second list of the same people to argue with');
});

test('ALREADY SAID AND DONE lists what each character said and did in the last accepted turns', () => {
    const cycles = [
        { event: 'turn', turn: 4, form: { characters: [{ name: 'Lena', does: 'hands over the sealed copy' }, { name: 'Rook', idle: true, busy: 'away' }] } },
        { event: 'turn', turn: 5, form: { characters: [{ name: 'Puck', says: 'give me one landmark' }] } },
        { event: 'turn', turn: 6, form: { characters: [{ name: 'Puck', says: 'one landmark and I go' }, { name: 'Sasha', says: 'no' }] } },
        { event: 'turn', turn: 7, rejected: true, form: { characters: [{ name: 'Puck', says: 'discarded' }] } },
    ];
    const said = renderAlreadySaid(cycles, { user: 'Sasha' });
    assert.match(said, /^ALREADY SAID AND DONE/);
    assert.match(said, /\(turn 4\) did: hands over the sealed copy/);
    assert.match(said, /\(turn 5\) said: give me one landmark/);
    assert.match(said, /\(turn 6\) said: one landmark and I go/);
    assert.doesNotMatch(said, /discarded|Sasha|Rook/);
    assert.equal(renderAlreadySaid([]), '');
});

test('the last accepted form skips rejected attempts and the current turn', () => {
    const cycles = [
        { event: 'turn', turn: 3, form: { resolution: 'three' } },
        { event: 'turn', turn: 4, form: { resolution: 'four, discarded' }, rejected: true },
        { event: 'regenerate', turn: 4, form: { resolution: 'four, current' } },
    ];
    assert.equal(lastAcceptedForm(cycles).resolution, 'four, current');
    assert.equal(lastAcceptedForm(cycles, { beforeTurn: 4 }).resolution, 'three');
});

test('the scene sits in the director\'s mutable tail, right before the plan', () => {
    const context = buildDeciderContext({ chat: [{ mes: 'Hi', is_user: true }], sceneText: 'CURRENT SCENE (where the previous turn left things — start from here):\n- Place: fountain.' });
    const index = context.messages.findIndex(message => String(message.content).startsWith('CURRENT SCENE'));
    assert.equal(index, context.messages.length - 3, 'scene, then plan @2, then the task');
});

test('a character who left last turn and acts again is sent back once, then accepted', async () => {
    const state = { assessments: new Map(), formWarnings: [], departureWarned: false, sceneText: '' };
    const store = {
        plan: () => ({ direction: 'Go.' }), roster: () => ({ active: ['Emilia', 'Diethard Diethain'] }),
        cycles: () => [{ event: 'turn', turn: 3, form: previous }],
        clock: () => ({ minutes: 0 }), saveClock: async () => {}, saveRoster: async () => {}, saveTurn: async () => {},
    };
    const submit = createInscribeHandler({ store, publishEvent: () => {}, state, applyRoster: async () => ({ ok: true }), resolvePlace: async () => '', lastTimeMark: async () => '', userName: () => 'Sasha' });
    const character = name => ({ name, decreeWants: 'd', does: 'plants himself in the path', feels: 'calm' });
    const form = { scene: { duration: 'a few minutes' }, stop: 'The guard blocks them.', userResult: 'Sasha waits.', beats: [{ who: 'Someone', kind: 'action', text: 'acts' }], characters: [character('Emilia'), character('Diethard Diethain')], comment: 'Ready.' };
    const first = await submit(form);
    assert.equal(first.ok, false);
    assert.match(first.missing[0], /"Diethard Diethain" left the scene at the end of the previous turn/);
    const second = await submit(form);
    assert.notEqual(second.missing?.[0]?.includes?.('left the scene'), true, 'only one reminder per turn');
});

test('departedFrom: words like left/leaving/gone without a real exit are not a departure', () => {
    const roster = ['Emilia', 'Felt', 'Diethard Diethain'];
    for (const line of [
        'Emilia turns for the steps, telling Sasha to keep up or be left behind.',
        'Felt stepped back to meet him, leaving Sasha against the wall.',
        'Felt has gone quiet and dangerous at his shoulder.',
        'Felt agrees on condition that Sasha leaves his quarter first.',
    ]) assert.deepEqual(departedFrom(line, roster, { user: 'Sasha' }), [], line);
    assert.deepEqual(departedFrom('Felt tears free and is gone into the crowd.', roster, { user: 'Sasha' }), ['Felt']);
    assert.deepEqual(departedFrom('Diethard closes his notebook and walks off.', roster, { user: 'Sasha' }), ['Diethard Diethain']);
});

test('departedFrom: leaving an object, a possessive or running out of something is not a departure', () => {
    const roster = ['Emilia', 'Felt'];
    for (const line of [
        'Emilia leaves the plate and comes closer to Sasha.',
        "Emilia's smile disappears.",
        'Felt runs out of patience.',
        'Emilia walks off the ramp toward Sasha.',
    ]) assert.deepEqual(departedFrom(line, roster, { user: 'Sasha' }), [], line);
});

test('validateTurn of the old form is gone: the repair engine fills what it can and never derives an aim', async () => {
    const { repairInscription } = await import('../libraries/core/decision-inscription.js');
    const base = { stop: 'r', userResult: 'u', scene: { duration: 'a moment' }, beats: [{ who: 'Emilia', kind: 'action', text: 'acts' }] };
    const ok = repairInscription({ form: { ...base, characters: [{ name: 'Emilia', does: 'a', feels: 'calm', decreeWants: 'to be safe' }] }, roster: ['Emilia'] });
    assert.equal(ok.ok, true, JSON.stringify(ok.missing));
    assert.equal(ok.form.characters[0].does, 'a');
    const rolled = repairInscription({ form: { ...base, characters: [{ name: 'Emilia', does: 'a', feels: 'calm', assessId: 'x' }] }, roster: ['Emilia'], assessments: new Map([['x', {}]]) });
    assert.match(rolled.warnings.join(' '), /assess id but no outcome/);
    const fresh = repairInscription({ form: { ...base, characters: [{ name: 'Emilia', does: 'a', feels: 'calm' }] }, roster: ['Emilia'] });
    assert.equal(fresh.ok, true, 'a character without a Decree aim is not sent back');
});

test('character notes: a made-up id falls back to the title, set creates a missing note, and a full set replaces the oldest', async () => {
    const { applyCharacterNote, MAX_NOTES_PER_CHARACTER } = await import('../libraries/core/decision-state.js');
    let t = 0;
    const opts = { now: () => (t += 1), rid: () => 'r' };
    let notes = {};
    for (let i = 0; i < MAX_NOTES_PER_CHARACTER; i += 1) notes = applyCharacterNote(notes, { character: 'Emilia', op: 'add', title: `N${i}`, text: 'x' }, opts).notes;
    const byTitle = applyCharacterNote(notes, { character: 'Emilia', op: 'set', id: 'note_emilia_alias', title: 'N1', text: 'updated' }, opts);
    assert.equal(byTitle.ok, true);
    assert.equal(byTitle.notes.emilia.find(note => note.title === 'N1').text, 'updated');
    const full = applyCharacterNote(byTitle.notes, { character: 'Emilia', op: 'add', title: 'Right now — mid-fall', text: 'airborne' }, opts);
    assert.equal(full.ok, true);
    assert.equal(full.replaced, 'N0');
    assert.equal(full.notes.emilia.length, MAX_NOTES_PER_CHARACTER);
    const created = applyCharacterNote({}, { character: 'Ram', op: 'set', id: 'note_ram_x', title: 'Eyes', text: 'grey' }, opts);
    assert.equal(created.ok, true);
    assert.equal(created.notes.ram[0].title, 'Eyes');
    const same = applyCharacterNote(created.notes, { character: 'Ram', op: 'add', title: 'Eyes', text: 'clear' }, opts);
    assert.equal(same.notes.ram.length, 1);
    assert.equal(same.notes.ram[0].text, 'clear');
});

test('after a window switch the next turn is numbered from the last turn, not from how many turns the window holds', async () => {
    const { lastTurnNumber, windowTurnCount } = await import('../libraries/core/decision-window.js');
    const entries = Array.from({ length: 26 }, (_, index) => ({ kind: 'turn', turn: 61 + index, text: `TURN ${61 + index}` }));
    entries.splice(16, 0, { kind: 'fact', turn: 76, text: 'a fact' });
    assert.equal(windowTurnCount(entries), 26);
    assert.equal(lastTurnNumber(entries) + 1, 87);
    assert.equal(lastTurnNumber([]), 0);
});
