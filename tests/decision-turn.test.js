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

test('without an assessId a noCheck reason is kept; without both the form is still accepted with a default reason and a warning', () => {
    const form = valid();
    delete form.characters[0].assessId;
    form.characters[0].noCheck = 'She only decides whether to accept the apology.';
    const accepted = validateTurn({ form, roster: ['Lena'], assessments: new Map() });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.normalized.characters[0].noCheck, 'She only decides whether to accept the apology.');

    const missing = validateTurn({ form: { ...form, characters: [{ ...form.characters[0], noCheck: '' }] }, roster: ['Lena'], assessments: new Map() });
    assert.equal(missing.ok, true, 'a forgotten noCheck no longer costs a whole extra model call');
    assert.equal(missing.normalized.characters[0].noCheck, "no roll — decided from the character's psychology");
    assert.match(missing.warnings.join('\n'), /no roll and no noCheck for Lena/);
});

test('a made-up assessId is still rejected even when noCheck is also present', () => {
    const form = valid();
    form.characters[0].assessId = 'made-up';
    form.characters[0].noCheck = 'A decision, not a roll.';
    const result = validateTurn({ form, roster: ['Lena'], assessments: new Map() });
    assert.equal(result.ok, false);
    assert.match(result.missing.join('\n'), /was not returned by assess/);
});

test('the user\'s own character is never required in the form, and if the director lists it, it is dropped', async () => {
    const { validateTurn: validate } = await import('../libraries/core/decision-turn.js');
    const base = { scene: { minutes: 5 }, resolution: 'She leaves.', userResult: 'Sasha waits.' };
    const emilia = { name: 'Emilia', decision: 'Leave.', decisionReason: 'Late.', action: 'Leaves.', actionReason: 'The door.', outcome: 'Gone.', noCheck: 'No contest.' };
    const without = validate({ form: { ...base, characters: [emilia] }, roster: ['Emilia', 'Sasha'], user: 'Sasha' });
    assert.equal(without.ok, true, 'Sasha from the roster is not demanded');
    const withUser = validate({ form: { ...base, characters: [emilia, { name: 'Sasha' }] }, roster: ['Emilia', 'Sasha'], user: 'Sasha' });
    assert.equal(withUser.ok, true, 'a listed user character is not checked');
    assert.deepEqual(withUser.normalized.characters.map(character => character.name), ['Emilia']);
});

test('an idle character needs only a name and stays in the background of the push', async () => {
    const { validateTurn: validate } = await import('../libraries/core/decision-turn.js');
    const { buildPush } = await import('../libraries/core/decision-push.js');
    const base = { scene: { minutes: 5 }, resolution: 'She leaves.', userResult: 'Sasha waits.' };
    const emilia = { name: 'Emilia', decision: 'Leave.', decisionReason: 'Late.', action: 'leaves', actionReason: 'the door is open', outcome: 'Gone.', noCheck: 'No contest.' };
    const result = validate({ form: { ...base, characters: [emilia, { name: 'Elsa', idle: true }] }, roster: ['Emilia', 'Elsa'] });
    assert.equal(result.ok, true);
    const push = buildPush({ form: result.normalized });
    assert.doesNotMatch(push, /Elsa will/);
    assert.match(push, /In the background, doing nothing notable this turn: Elsa\. Do not give them actions or lines\./);
});
