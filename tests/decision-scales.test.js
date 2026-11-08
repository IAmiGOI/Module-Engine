import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeWeight, weightParts, levelInWords, normalizeScaleRule, normalizeScaleSystem,
    renderScaleSystem, renderScales, appendDiscovery, discoveriesAfter, findScaleSystem,
} from '../libraries/core/decision-scales.js';

test('a weight string gives the roll-scale level and what raises and lowers it', () => {
    assert.equal(levelInWords('very hard, rises with pain'), 'very hard', '"very hard" is not read down to "hard"');
    assert.equal(levelInWords('nearly impossible'), 'nearly impossible');
    assert.equal(levelInWords('moderate'), 'moderate');
    assert.equal(levelInWords('something else entirely'), '');
    const weight = normalizeWeight('moderate; rises with distance and a wound; falls with a prepared circle');
    assert.deepEqual({ level: weight.level, rises: weight.rises, falls: weight.falls }, {
        level: 'moderate', rises: 'distance and a wound', falls: 'a prepared circle',
    });
    assert.deepEqual(weightParts('hard — falls when the caster is rested'), { rises: '', falls: 'the caster is rested' });
});

test('a weight object is accepted as well as a string, with the level, rises and falls kept', () => {
    const weight = normalizeWeight({ level: 'hard', rises: 'distance', falls: 'a circle' });
    assert.deepEqual({ level: weight.level, rises: weight.rises, falls: weight.falls }, { level: 'hard', rises: 'distance', falls: 'a circle' });
    assert.equal(normalizeWeight('easy').level, 'easy');
});

test('a scale rule keeps every field of the owner\'s format, and a rule without a name is dropped', () => {
    const rule = normalizeScaleRule({
        name: 'Shape', needs: 'a clear image', yields: ['matter', 'a tool'],
        weight: 'moderate', scaling: 'larger with more mana', limit: 'never a living body',
        cost: 'exhaustion', links: 'Fire', examples: ['a coin', 'a blade'],
    });
    assert.equal(rule.name, 'Shape');
    assert.deepEqual(rule.needs, ['a clear image']);
    assert.deepEqual(rule.yields, ['matter', 'a tool']);
    assert.equal(rule.weight.level, 'moderate');
    assert.deepEqual(rule.examples, ['a coin', 'a blade']);
    assert.equal(normalizeScaleRule({ needs: 'nothing' }), null);
});

test('a system renders as a table a weak model can apply, one rule per row', () => {
    const system = normalizeScaleSystem({
        system: 'Mana', principle: 'Will made real.', payment: 'mana and focus',
        rules: [
            { name: 'Shape', needs: 'an image', yields: 'matter', weight: 'moderate; rises with distance' },
            { name: 'Burn', needs: 'touch', yields: 'fire', weight: 'hard' },
        ],
    });
    const text = renderScaleSystem(system);
    assert.match(text, /### Mana/);
    assert.match(text, /\*\*Principle:\*\* Will made real\./);
    assert.match(text, /\*\*Payment:\*\* mana and focus/);
    assert.match(text, /\| Rule \| Needs \| Yields \| Weight \|/);
    assert.match(text, /\*\*Shape\*\* \| an image \| matter \| moderate; rises with distance/);
    assert.match(text, /\*\*Burn\*\* \| touch \| fire \| hard/, 'an empty weight tail is just the level');
    assert.doesNotMatch(text, /hard — hard|moderate — moderate/, 'the level is not repeated in the body');
});

test('Discoveries belong to their system and are appended, never rewritten', () => {
    const systems = [normalizeScaleSystem({ system: 'Mana', principle: 'Will made real.', rules: [{ name: 'Shape', needs: 'an image', yields: 'matter', weight: 'moderate' }] })];
    const added = appendDiscovery(systems, { system: 'mana', rule: 'Shape', text: 'Iron can be shaped into a bomb.', at: '[Day 1, 08:00]', seq: 1 });
    assert.equal(added.added, true);
    assert.equal(added.system, 'Mana');
    assert.equal(added.systems[0].rules.length, 1, 'the rules of the system are untouched');
    assert.equal(added.systems[0].discoveries.length, 1);
    const text = renderScaleSystem(added.systems[0]);
    assert.match(text, /DISCOVERIES/);
    assert.match(text, /\[Shape\] Iron can be shaped into a bomb\./);
    assert.deepEqual(discoveriesAfter(added.systems, 0).map(item => item.system), ['Mana']);
    assert.deepEqual(discoveriesAfter(added.systems, 1), [], 'a seen Discovery is not shown again');
});

test('a Discovery for an unknown system creates the system honestly instead of dropping it', () => {
    const added = appendDiscovery([], { system: 'Dragons', text: 'A dragon remembers every debt.' });
    assert.equal(added.added, true);
    assert.equal(added.systems.length, 1);
    assert.equal(added.systems[0].name, 'Dragons');
    assert.equal(added.systems[0].discoveries.length, 1);
    assert.equal(appendDiscovery([], { system: 'X', text: '  ' }).added, false, 'an empty Discovery is not a Discovery');
});

test('systems are found by exact name and then by a close one, in any case', () => {
    const systems = [normalizeScaleSystem({ system: 'Systems of Weight: Mana', rules: [] }), normalizeScaleSystem({ system: 'Craft', rules: [] })];
    assert.equal(findScaleSystem(systems, 'craft')?.name, 'Craft');
    assert.equal(findScaleSystem(systems, 'mana')?.name, 'Systems of Weight: Mana');
    assert.equal(findScaleSystem(systems, 'nothing like it'), null);
    assert.equal(renderScales(systems), systems.map(system => renderScaleSystem(system)).join('\n\n'));
});
