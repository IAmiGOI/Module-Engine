import test from 'node:test';
import assert from 'node:assert/strict';
import { departedFrom, lastAcceptedForm, renderCurrentScene } from '../libraries/core/decision-scene.js';
import { createSubmitTurnHandler } from '../cores/decision/handlers-turn.js';
import { buildDeciderContext } from '../libraries/core/decision-context.js';

const previous = {
    scene: { minutes: 2, place: 'Main thoroughfare, by the fountain' }, meta: { place: 'Main thoroughfare, by the fountain' },
    resolution: 'Emilia has answered, and Diethard, refused her name twice, closes his notebook and walks off to file the theft.',
    userResult: 'The question was heard.',
    characters: [
        { name: 'Emilia', action: 'answers flatly: the insignia first' },
        { name: 'Kadomon', idle: true },
    ],
};

test('who left in the ending is found by name and leave words; the user is never counted', () => {
    assert.deepEqual(departedFrom(previous.resolution, ['Emilia', 'Diethard Diethain', 'Kadomon']), ['Diethard Diethain']);
    assert.deepEqual(departedFrom('Sasha walks off.', ['Sasha'], { user: 'Sasha' }), []);
});

test('CURRENT SCENE lists the place, the ending, who did what, who is idle and who left', () => {
    const scene = renderCurrentScene({ form: previous, roster: ['Emilia', 'Diethard Diethain', 'Kadomon'], user: 'Sasha' });
    assert.match(scene, /^CURRENT SCENE/);
    assert.match(scene, /Place: Main thoroughfare, by the fountain\./);
    assert.match(scene, /Emilia last: answers flatly/);
    assert.match(scene, /Present, doing nothing notable: Kadomon\./);
    assert.match(scene, /Left the scene in that ending: Diethard Diethain\. Remove them with update_roster/);
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
    const submit = createSubmitTurnHandler({ store, publishEvent: () => {}, state, resolvePlace: async () => '', lastTimeMark: async () => '', userName: () => 'Sasha' });
    const character = name => ({ name, decision: 'd', decisionReason: 'r', action: 'plants himself in the path', actionReason: 'r', outcome: 'o', noCheck: 'n' });
    const form = { scene: { minutes: 2 }, resolution: 'The guard blocks them.', userResult: 'Sasha waits.', characters: [character('Emilia'), character('Diethard Diethain')], comment: 'Ready.' };
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
