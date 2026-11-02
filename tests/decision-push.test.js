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
    assert.match(push, /Lena will opens the east door because she needs air — cleanly, without a hitch\./);
    assert.match(push, /Lena's decision: Leave the keep\./);
    assert.match(push, /Why it goes this way: The lock gives/);
    assert.match(push, /Lena says: "Not tonight\."/);
});

test('a missing assessment leaves the character line without invented degree words', () => {
    const push = buildPush({ form, assessments: new Map() });
    const actionLine = push.split('\n').find(line => line.startsWith('Lena will'));
    assert.equal(actionLine, 'Lena will opens the east door because she needs air.');
});

test('the place and time are omitted honestly when the engine has no source, not made up', () => {
    const push = buildPush({ form: { ...form, scene: { minutes: 0 } }, assessments });
    assert.match(push, /no measurable time/);
    assert.doesNotMatch(push, /^Place:/m);
    assert.doesNotMatch(push, /^Time:/m);
});
