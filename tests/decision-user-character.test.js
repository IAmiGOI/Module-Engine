import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDecree } from '../libraries/core/decision-great-bank.js';
import { mainWithoutDecree, mainCharacters } from '../libraries/core/decision-director.js';
import { renderDecreeForResolver } from '../libraries/core/decision-bank-projections.js';

const user = { name: 'Sasha', sourceKey: 'persona:user', importance: 'main', material: {}, spiritual: {}, decree: { 3: ['Today: something the user never said'] } };
const emilia = { name: 'Emilia', sourceKey: 'lorebook:x:1', importance: 'main', material: {}, spiritual: {}, decree: {} };

test('the user\'s character never gets a Decree, never wakes the Director for one, and never reaches the Resolver as one', () => {
    assert.deepEqual(mainWithoutDecree({ sasha: { ...user, decree: {} }, emilia }), ['Emilia']);
    assert.deepEqual(mainCharacters({ sasha: user, emilia }), ['Emilia']);
    const result = applyDecree({ sasha: { ...user, decree: {} } }, { character: 'Sasha', sections: { 3: ['Today: plan'] } });
    assert.equal(result.refused, true);
    assert.equal(result.changed, false);
    assert.doesNotMatch(renderDecreeForResolver([{ character: user }]), /something the user never said/);
});

test('the Resolver gets how the characters in the scene feel and speak, not the user\'s character and not those elsewhere', async () => {
    const { renderTemperForResolver } = await import('../libraries/core/decision-bank-projections.js');
    const otto = { name: 'Otto Suwen', sourceKey: 'lorebook:x:2', spiritual: { 3: ['Fear and panic are loud.'], 5: ['Talks fast, in merchant cadence.'], 1: ['Loyal.'] } };
    const far = { name: 'Rem', sourceKey: 'lorebook:x:3', spiritual: { 3: ['Calm.'] } };
    const out = renderTemperForResolver([{ character: otto }, { character: far }, { character: { ...user, spiritual: { 5: ['user speech'] } } }], { names: ['Otto Suwen', 'Sasha'] });
    assert.match(out, /panic are loud/);
    assert.match(out, /merchant cadence/);
    assert.doesNotMatch(out, /Loyal|Calm|user speech/);
});
