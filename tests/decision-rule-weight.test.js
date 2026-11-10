import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssessHandler } from '../cores/decision/handlers-assess.js';

const systems = [{ name: 'Gate Magic', rules: [{ name: 'Imaginative Synthesis (Freeform Visualization)', needs: ['A functional Gate and clear mental imagery of the effect'], yields: ['A silent working shaped by the caster\'s imagination'], weight: { level: 'moderate', rises: 'the picture wavers under terror or pain', falls: 'familiar Earth physics the caster pictures effortlessly' } }] }];
const handler = () => createAssessHandler({ state: { assessmentCounter: 0, runId: 'r', assessments: new Map() }, getSettings: () => ({ assessSeed: 1 }), getScales: async () => systems });

test('a magic attempt starts from its rule\'s weight, a step per named rise or fall, and the resolver\'s own level is not used', async () => {
    const result = await handler()({ character: 'Sasha', action: 'wings', kind: 'magic', size: 'heavy', difficulty: 'hard', experience: 'novice', why: 'x', rule: 'Gate Magic / Imaginative Synthesis', needs: 'clear mental imagery of the effect', yields: 'a silent working shaped by imagination',
        rises: ['scene: his Gate aches from two failed sweeps'], falls: ['rule: familiar Earth physics he pictures effortlessly'] });
    assert.equal(result.ok, true);
    assert.equal(result.difficulty, 'moderate');
    assert.equal(result.ruleBase, 'moderate');
    assert.equal(result.rule, 'Gate Magic / Imaginative Synthesis (Freeform Visualization)');
});

test('a magic attempt without a known rule is refused with the rules of the world', async () => {
    const result = await handler()({ character: 'Sasha', action: 'wings', kind: 'magic', size: 'heavy', difficulty: 'hard', experience: 'novice', why: 'x' });
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

test('steps must say where they come from, a rule step must be in the rule, and a trait is never a step', async () => {
    const { checkSteps } = await import('../libraries/core/decision-rule-weight.js');
    const rule = { weight: { level: 'very hard', rises: 'the number of other Gates in range', falls: 'the caster already knows one signature to compare against' } };
    assert.equal(checkSteps(rule, { falls: ['rule: he knows Puck\'s signature to compare against'] }).length, 0);
    assert.equal(checkSteps(rule, { falls: ['high vantage'] }).length, 1, 'no source');
    assert.equal(checkSteps(rule, { falls: ['rule: high vantage above the ward'] }).length, 1, 'not in the rule');
    assert.equal(checkSteps(rule, { falls: ['scene: his enormous mana capacity'] }).length, 1, 'a trait');
    assert.equal(checkSteps(rule, { rises: ['scene: his Gate aches from two failed sweeps'] }).length, 0);
});

test('experience is never a step, and a failed roll carries what it costs and that it touches only itself', async () => {
    const { checkSteps } = await import('../libraries/core/decision-rule-weight.js');
    assert.equal(checkSteps({ weight: { rises: 'the caster\'s inexperience at reading the return' } }, { rises: ['rule: the caster\'s inexperience at reading the return'] }).length, 1);
    const rule = { name: 'Probe', needs: ['A Gate and a still stance spreading mana wide'], yields: ['Where mana is drawn from, and how strongly'], weight: { level: 'nearly impossible', text: 'nearly impossible' }, cost: ['A thin draw of mana. Clumsy — a blurred read. Botched — nothing comes back.'] };
    const handler = createAssessHandler({ state: { assessmentCounter: 0, runId: 'r', assessments: new Map() }, getSettings: () => ({ assessSeed: 7 }), getScales: async () => [{ name: 'Gate Magic', rules: [rule] }] });
    const result = await handler({ character: 'Sasha', action: 'probe', kind: 'magic', size: 'medium', difficulty: 'nearly impossible', experience: 'none', why: 'x', rule: 'Gate Magic / Probe', needs: 'a still stance spreading mana wide', yields: 'where mana is drawn from' });
    assert.ok(['clumsy', 'botched'].includes(result.degree));
    assert.match(result.consequence, /blurred read|nothing comes back/);
    assert.match(result.consequence, /touches only this attempt/);
    const small = await handler({ character: 'Sasha', action: 'rays', kind: 'magic', size: 'small', difficulty: 'nearly impossible', experience: 'none', why: 'x', rule: 'Gate Magic / Probe', needs: 'a still stance spreading mana wide', yields: 'where mana is drawn from' });
    assert.match(small.consequence, /small working: failing means only that it does not work/);
    assert.doesNotMatch(small.consequence, /nothing comes back|blurred/);
    assert.equal((await handler({ character: 'Sasha', action: 'rays', kind: 'magic', difficulty: 'moderate', experience: 'none', why: 'x', rule: 'Gate Magic / Probe' })).ok, false, 'magic without a size is refused');
});

test('naming a rule shows it in full, and the roll waits until the method meets its Needs and the aim is in its Yields', async () => {
    const world = [{ name: 'Gate Magic', rules: [
        { name: 'Mana Sensing & Wide-Area Sweep', needs: ['A still stance, spreading the caster\'s own mana as a thin wide layer'], yields: ['Which direction mana is drawn from, and roughly how strongly'], limit: ['Cannot single out a source'], weight: { level: 'very hard', text: 'very hard' } },
        { name: 'Imaginative Synthesis', needs: ['Clear concrete mental imagery of the effect'], yields: ['A silent custom working'], weight: { level: 'moderate', text: 'moderate' } },
    ] }];
    const handler = createAssessHandler({ state: { assessmentCounter: 0, runId: 'r', assessments: new Map() }, getSettings: () => ({ assessSeed: 3 }), getScales: async () => world });
    const ask = extra => handler({ character: 'Sasha', action: 'radar rays', kind: 'magic', size: 'small', difficulty: 'very hard', experience: 'novice', why: 'x', rule: 'Gate Magic / Mana Sensing & Wide-Area Sweep', ...extra });
    const blind = await ask({});
    assert.equal(blind.ok, false);
    assert.match(blind.error, /Needs: A still stance/);
    assert.match(blind.error, /Imaginative Synthesis/, 'the freeform rule is offered');
    assert.equal((await ask({ needs: 'narrow rays aimed at one target', yields: 'which direction mana is drawn from' })).ok, false, 'a method the Needs do not describe is refused');
    assert.equal((await ask({ needs: 'spreading his own mana as a thin wide layer', yields: 'which direction mana is drawn from' })).ok, true);
});
