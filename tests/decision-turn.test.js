import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTurn } from '../libraries/core/decision-turn.js';

const assessment = { id: 'a1', probability: 0.7, words: 'cleanly, without a hitch' };
const valid = (overrides = {}) => ({
    scene: { minutes: 5 },
    resolution: 'She gets out before the guard turns the corner.',
    userResult: 'The user holds the door; it works.',
    characters: [{
        name: 'Lena', decision: 'Leave the keep.', decisionReason: 'She is out of time.',
        action: 'Opens the east door.', actionReason: 'It is the only exit.',
        assessId: 'a1', outcome: 'The lock gives after a hard pull.',
    }],
    ...overrides,
});

test('a complete form passes: every active character once, every assess id real', () => {
    const result = validateTurn({ form: valid(), roster: ['Lena'], assessments: new Map([['a1', assessment]]) });
    assert.equal(result.ok, true);
    assert.deepEqual(result.missing, []);
    assert.equal(result.normalized.scene.minutes, 5);
});

test('a missing active character is named in the refusal, and the form is not accepted', () => {
    const result = validateTurn({ form: valid(), roster: ['Lena', 'Marek'], assessments: new Map([['a1', assessment]]) });
    assert.equal(result.ok, false);
    assert.match(result.missing.join('\n'), /Marek/);
});

test('a character outside the active roster is rejected — the form is not a way to add people silently', () => {
    const form = valid();
    form.characters.push({ ...form.characters[0], name: 'Marek' });
    const result = validateTurn({ form, roster: ['Lena'], assessments: new Map([['a1', assessment]]) });
    assert.equal(result.ok, false);
    assert.match(result.missing.join('\n'), /Marek.*not in the active roster/);
});

test('every form field is required: decision, its reason, action, its reason and the outcome', () => {
    const form = valid();
    const result = validateTurn({ form: { ...form, characters: [{ ...form.characters[0], actionReason: '' }] }, roster: ['Lena'], assessments: new Map([['a1', assessment]]) });
    assert.equal(result.ok, false);
    assert.ok(result.missing.some(item => /actionReason/.test(item)));
});

test('an assess id the engine never returned is rejected, not trusted', () => {
    const form = valid();
    form.characters[0].assessId = 'made-up';
    const result = validateTurn({ form, roster: ['Lena'], assessments: new Map([['a1', assessment]]) });
    assert.equal(result.ok, false);
    assert.match(result.missing.join('\n'), /was not returned by assess/);
});

test('scene minutes must be a real number inside a day; resolution and the user result cannot be empty', () => {
    const base = valid();
    for (const scene of [{ minutes: -1 }, { minutes: 2000 }, { minutes: 'soon' }, {}]) {
        const result = validateTurn({ form: { ...base, scene }, roster: ['Lena'], assessments: new Map([['a1', assessment]]) });
        assert.equal(result.ok, false, `scene ${JSON.stringify(scene)} is rejected`);
        assert.ok(result.missing.some(item => /scene\.minutes/.test(item)));
    }
    const empty = validateTurn({ form: { ...base, resolution: '  ', userResult: '' }, roster: ['Lena'], assessments: new Map([['a1', assessment]]) });
    assert.deepEqual(empty.missing.filter(item => item === 'resolution' || item === 'userResult').sort(), ['resolution', 'userResult']);
});

test('a form that names the same active character twice is rejected rather than silently picking one', () => {
    const form = valid();
    form.characters.push({ ...form.characters[0] });
    const result = validateTurn({ form, roster: ['Lena'], assessments: new Map([['a1', assessment]]) });
    assert.equal(result.ok, false);
    assert.match(result.missing.join('\n'), /more than once/);
});

test('without an assessId the form needs a noCheck reason; with it the form is accepted', () => {
    const form = valid();
    delete form.characters[0].assessId;
    form.characters[0].noCheck = 'She only decides whether to accept the apology.';
    const accepted = validateTurn({ form, roster: ['Lena'], assessments: new Map() });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.normalized.characters[0].noCheck, 'She only decides whether to accept the apology.');

    const missing = validateTurn({ form: { ...form, characters: [{ ...form.characters[0], noCheck: '' }] }, roster: ['Lena'], assessments: new Map() });
    assert.equal(missing.ok, false);
    assert.match(missing.missing.join('\n'), /noCheck.*assessId/);
});

test('a made-up assessId is still rejected even when noCheck is also present', () => {
    const form = valid();
    form.characters[0].assessId = 'made-up';
    form.characters[0].noCheck = 'A decision, not a roll.';
    const result = validateTurn({ form, roster: ['Lena'], assessments: new Map() });
    assert.equal(result.ok, false);
    assert.match(result.missing.join('\n'), /was not returned by assess/);
});
