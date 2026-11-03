import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandlers } from '../cores/decision/handlers.js';

function handlers() {
    const state = { assessments: new Map(), assessmentCounter: 0, turnCounter: 0, runId: 'run_1' };
    return {
        state,
        assess: createHandlers({
            store: {}, call: async () => null, publishEvent: () => {}, getSettings: () => ({ assessSeed: 1 }),
            state, resolvePlace: async () => '', lastTimeMark: async () => '',
        }).assess,
    };
}

const args = (overrides = {}) => ({
    character: 'Lena', action: 'picks the lock', kind: 'body', difficulty: 'hard', experience: 'novice',
    why: 'Wet stone and no tools.', comment: 'The chance decides the outcome.', ...overrides,
});

test('a valid assess returns the table probability and stores the id for the form', async () => {
    const { state, assess } = handlers();
    const result = await assess(args());
    assert.equal(result.ok, true);
    assert.equal(result.difficulty, 'hard');
    assert.equal(result.experience, 'novice');
    assert.ok(Math.abs(result.probability - 0.15) < 0.001);
    assert.equal(result.why, 'Wet stone and no tools.');
    assert.equal(state.assessments.has(result.id), true);
});

test('an unknown difficulty is refused with the allowed list, not guessed into 0.5', async () => {
    const { state, assess } = handlers();
    const result = await assess(args({ kind: 'body', difficulty: 'legendary' }));
    assert.equal(result.ok, false);
    assert.match(result.error, /Unknown difficulty "legendary"/);
    assert.match(result.error, /trivial, easy, moderate, hard, very hard, nearly impossible/);
    assert.equal(state.assessments.size, 0);
});

test('an unknown experience is refused with the allowed list', async () => {
    const { assess } = handlers();
    const result = await assess(args({ experience: 'legendary' }));
    assert.equal(result.ok, false);
    assert.match(result.error, /none, novice, practised, skilled, expert, master/);
});

test('assess without "why" is refused: the levels decide the chance, why explains it', async () => {
    const { assess } = handlers();
    const result = await assess(args({ why: '   ' }));
    assert.equal(result.ok, false);
    assert.match(result.error, /needs "why"/);
});

test('talk is never rolled: a social assess is refused with the rule, and a missing kind is refused with the list', async () => {
    const { ASSESS_SOCIAL_REFUSAL } = await import('../libraries/core/decision-prompts.js');
    const { assess } = handlers();
    const social = await assess(args({ kind: 'social', action: 'convince Puck that the warning is true' }));
    assert.equal(social.ok, false);
    assert.equal(social.error, ASSESS_SOCIAL_REFUSAL);
    const missing = await assess(args({ kind: undefined }));
    assert.equal(missing.ok, false);
    assert.match(missing.error, /body \/ stealth \/ perception \/ craft \/ magic \/ social/);
    const stealth = await assess(args({ kind: 'stealth', action: 'whisper so that Emilia does not overhear' }));
    assert.equal(stealth.ok, true, 'not being overheard is stealth and may be rolled');
});
