import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssessHandler } from '../cores/decision/handlers-assess.js';
import { checkSteps, ruleDifficulty } from '../libraries/core/decision-rule-weight.js';

const world = [{ name: 'Gate Magic', rules: [
    { name: 'Mana Sensing & Wide-Area Sweep', needs: ['A still stance, spreading the caster\'s own mana outward as a thin wide layer'], yields: ['Which direction mana is drawn from, and roughly how strongly'], limit: ['Cannot single out a source'],
        weight: { level: 'very hard', text: 'very hard', rises: 'the number of other Gates and charms in range', falls: 'the caster already knows one signature to compare against' },
        cost: ['A share of mana. Clumsy — a half map and ringing ears. Botched — every Gate in range strikes the caster at once.'] },
    { name: 'Imaginative Synthesis (Freeform Visualization)', needs: ['A functional Gate and clear concrete mental imagery of the effect'], yields: ['A silent custom working'],
        weight: { level: 'moderate', text: 'moderate for a single-concept working; hard for a complex multi-property one', rises: 'the picture wavers under terror or pain', falls: 'familiar Earth physics the caster pictures effortlessly' } },
] }];
const handler = (userMessage = '') => createAssessHandler({ state: { assessmentCounter: 0, runId: 'r', assessments: new Map(), userMessage }, getSettings: () => ({ assessSeed: 3 }), getScales: async () => world, userName: () => 'Sasha' });
const base = { character: 'Sasha', action: 'x', kind: 'magic', experience: 'novice', why: 'x' };

test('a rule-based roll starts from the rule, a step per counted rise or fall, and the base may be any level the weight names', async () => {
    const result = await handler()({ ...base, size: 'heavy', difficulty: 'hard', rule: 'Gate Magic / Imaginative Synthesis', rises: ['scene: his Gate aches from two failed sweeps'], falls: ['rule: familiar Earth physics he pictures effortlessly'] });
    assert.equal(result.ok, true);
    assert.equal(result.ruleBase, 'hard');
    assert.equal(result.difficulty, 'hard');
    assert.match(result.ruleText, /Needs: A functional Gate/);
    assert.equal(ruleDifficulty(world[0].rules[1], { chosen: 'nearly impossible' }).base, 'moderate', 'a level the weight does not name falls back to its base');
});

test('steps that are not the rule\'s, traits and experience are not counted — the roll goes on, with a note', async () => {
    const result = await handler()({ ...base, difficulty: 'very hard', rule: 'Gate Magic / Mana Sensing', rises: ['rule: the caster\'s inexperience at reading the return'], falls: ['scene: his enormous mana capacity', 'high vantage'] });
    assert.equal(result.ok, true);
    assert.equal(result.difficulty, 'very hard');
    assert.equal(result.notes.length, 3);
    assert.equal(checkSteps(world[0].rules[0], { falls: ['rule: he knows Puck\'s signature to compare against'] }).length, 0);
});

test('the user\'s own technique the chosen rule does not describe is rolled under the freeform rule', async () => {
    const result = await handler('Instead of waves, I send tiny rays of mana, seeing how it will bend.')({ ...base, size: 'small', difficulty: 'very hard', rule: 'Gate Magic / Mana Sensing & Wide-Area Sweep', rises: ['rule: the number of other Gates and charms in range'] });
    assert.equal(result.ok, true);
    assert.match(result.rule, /Imaginative Synthesis/);
    assert.equal(result.ruleBase, 'moderate');
    assert.match(result.notes.join(' '), /rolled under "Gate Magic \/ Imaginative Synthesis/);
    const sweep = await handler('I spread my own mana outward as a thin wide layer across the ward, standing still.')({ ...base, size: 'medium', difficulty: 'very hard', rule: 'Gate Magic / Mana Sensing & Wide-Area Sweep' });
    assert.match(sweep.rule, /Mana Sensing/, 'a method the Needs describe keeps its rule');
});

test('a failure is the size of the working and touches only itself; no size means medium', async () => {
    const small = await handler()({ ...base, size: 'small', difficulty: 'very hard', experience: 'none', rule: 'Gate Magic / Mana Sensing' });
    const medium = await handler()({ ...base, difficulty: 'very hard', experience: 'none', rule: 'Gate Magic / Mana Sensing' });
    assert.equal(medium.size, 'medium');
    if (['clumsy', 'botched'].includes(small.degree)) {
        assert.match(small.consequence, /small working: failing means only that it does not work/);
        assert.doesNotMatch(small.consequence, /strikes the caster/);
    }
    if (['clumsy', 'botched'].includes(medium.degree)) assert.match(medium.consequence, /touches only this attempt/);
});
