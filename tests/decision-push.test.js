import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPush } from '../libraries/core/decision-push.js';

const form = {
    scene: { minutes: 12, place: 'east corridor' },
    resolution: 'She gets out before the guard turns the corner.',
    userResult: 'The user pushes the door; it opens but the sleeve tears.',
    characters: [{
        name: 'Lena', decision: 'Leave the keep.', decisionReason: 'She is out of time.',
        action: 'opens the east door', actionReason: 'she needs air',
        assessId: 'a1', outcome: 'The lock gives after a hard pull.',
        speech: 'Not tonight.',
    }],
};
const assessments = new Map([['a1', { words: 'cleanly, without a hitch' }]]);

test('the push carries the time, place, resolution, the user result and the character line with degree words', () => {
    const push = buildPush({ form, assessments, place: 'KEEP → EAST WING → EAST CORRIDOR', timeAfter: 'Day 1, 08:12 (Morning)' });
    assert.match(push, /took 12 minutes/);
    assert.match(push, /Place: KEEP → EAST WING → EAST CORRIDOR/);
    assert.match(push, /Time: Day 1, 08:12 \(Morning\)/);
    assert.match(push, /Resolution: She gets out/);
    assert.match(push, /The user's action: The user pushes the door/);
    assert.match(push, /Lena does: opens the east door — cleanly, without a hitch\./);
    assert.match(push, /\(Why — for you, not for the page: she needs air\)/);
    assert.match(push, /Lena's aim — for you, not for the page: Leave the keep\./);
    assert.match(push, /Why it goes this way: The lock gives/);
    assert.match(push, /Lena says: "Not tonight\."/);
});

test('a missing assessment leaves the character line without invented degree words', () => {
    const push = buildPush({ form, assessments: new Map() });
    const actionLine = push.split('\n').find(line => line.startsWith('Lena does:'));
    assert.equal(actionLine, 'Lena does: opens the east door.');
});

test('the place and time are omitted honestly when the engine has no source, not made up', () => {
    const push = buildPush({ form: { ...form, scene: { minutes: 0 } }, assessments });
    assert.match(push, /no measurable time/);
    assert.doesNotMatch(push, /^Place:/m);
    assert.doesNotMatch(push, /^Time:/m);
});

test('what a character says goes on its own line, in meaning only, with the instruction to write it once', () => {
    const push = buildPush({ form: { scene: { minutes: 1 }, resolution: 'r', userResult: 'u', characters: [{ name: 'Puck', action: 'looks at Sasha', actionReason: 'x', says: 'he will take the answer, and sets his own condition' }] } });
    assert.match(push, /^Puck does: looks at Sasha\.$/m);
    assert.match(push, /^Puck says, in meaning only \(write it once, as Puck's spoken line in their own voice; do not also narrate it\): he will take the answer/m);
});

test('idle characters busy with their own concerns reach the writer as a background touch, without lines', () => {
    const push = buildPush({ form: { scene: { minutes: 2 }, resolution: 'They wait.', userResult: 'u', beats: [{ who: 'Puck', kind: 'line', text: 'sit down' }],
        characters: [{ name: 'Puck', action: 'speaks', actionReason: 'x', decision: 'd', decisionReason: 'e' }, { name: 'Ram', idle: true, busy: 'counting the minutes to the bell' }, { name: 'Rom', idle: true }] } });
    assert.match(push, /In the background, busy with their own concerns — at most a passing touch, no lines:\n- Ram: counting the minutes to the bell/);
    assert.match(push, /In the background, doing nothing notable this turn: Rom\./);
});
