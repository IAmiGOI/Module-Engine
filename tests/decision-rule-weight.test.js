import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssessHandler } from '../cores/decision/handlers-assess.js';

const systems = [{ name: 'Gate Magic', rules: [{ name: 'Imaginative Synthesis (Freeform Visualization)', weight: { level: 'moderate', rises: 'the picture wavers under terror or pain', falls: 'familiar Earth physics the caster pictures effortlessly' } }] }];
const handler = () => createAssessHandler({ state: { assessmentCounter: 0, runId: 'r', assessments: new Map() }, getSettings: () => ({ assessSeed: 1 }), getScales: async () => systems });

test('a magic attempt starts from its rule\'s weight, a step per named rise or fall, and the resolver\'s own level is not used', async () => {
    const result = await handler()({ character: 'Sasha', action: 'wings', kind: 'magic', difficulty: 'hard', experience: 'novice', why: 'x', rule: 'Gate Magic / Imaginative Synthesis',
        rises: ['his Gate aches from two failed sweeps'], falls: ['built step by step from atoms, the way he made iron'] });
    assert.equal(result.ok, true);
    assert.equal(result.difficulty, 'moderate');
    assert.equal(result.ruleBase, 'moderate');
    assert.equal(result.rule, 'Gate Magic / Imaginative Synthesis (Freeform Visualization)');
});

test('a magic attempt without a known rule is refused with the rules of the world', async () => {
    const result = await handler()({ character: 'Sasha', action: 'wings', kind: 'magic', difficulty: 'hard', experience: 'novice', why: 'x' });
    assert.equal(result.ok, false);
    assert.match(result.error, /Gate Magic \/ Imaginative Synthesis/);
});

test('a rule whose weight names two levels lets the Resolver pick between them, and nothing outside them', async () => {
    const { ruleDifficulty } = await import('../libraries/core/decision-rule-weight.js');
    const rule = { weight: { level: 'moderate', text: 'moderate for single-concept spells; hard for complex multi-property spells; rises if the picture wavers' } };
    assert.equal(ruleDifficulty(rule, { chosen: 'hard' }).difficulty, 'hard', 'the complex tier the rule names');
    assert.equal(ruleDifficulty(rule, { chosen: 'nearly impossible' }).difficulty, 'moderate', 'a level the rule does not name falls back to its base');
    assert.equal(ruleDifficulty(rule, { chosen: 'hard', rises: ['aching Gate'], falls: ['familiar Earth physics'] }).difficulty, 'hard');
});
