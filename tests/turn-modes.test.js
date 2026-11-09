import test from 'node:test';
import assert from 'node:assert/strict';
import { TURN_MODES, modeScene, parseModeAnswer, chooseModes, modesAllowRolls, resolverModeBlock, writerModeLine } from '../libraries/core/turn-modes.js';

test('eight modes, each says what it changes for the Resolver and the Writer', () => {
    assert.deepEqual(TURN_MODES.map(mode => mode.id), ['peasant', 'elder', 'merchant', 'king', 'warrior', 'hunter', 'artist', 'bard']);
    for (const mode of TURN_MODES) assert.ok(mode.resolver && mode.writer && mode.when);
});

test('one or two modes: the best if sure, a second if also sure, Peasant when nobody is sure', () => {
    assert.deepEqual(chooseModes({ merchant: 0.9, elder: 0.7, bard: 0.2 }), ['merchant', 'elder']);
    assert.deepEqual(chooseModes({ warrior: 0.8, hunter: 0.3 }), ['warrior']);
    assert.deepEqual(chooseModes({ bard: 0.3 }), ['peasant']);
    assert.deepEqual(chooseModes({}), ['peasant']);
});

test('a talk-only turn has no rolls; a fight or an everyday turn keeps them', () => {
    assert.equal(modesAllowRolls(['merchant', 'elder']), false);
    assert.equal(modesAllowRolls(['warrior']), true);
    assert.equal(modesAllowRolls(['peasant']), true);
    assert.match(resolverModeBlock(['merchant']), /Nothing is rolled this turn\./);
    assert.match(resolverModeBlock(['merchant', 'king']), /^THIS TURN — Merchant \+ King:/);
    assert.match(writerModeLine(['bard']), /^HOW THIS TURN READS \(Bard\):/);
});

test('the answer is read even around prose, and the scene is the last messages within 1800 characters', () => {
    assert.deepEqual(parseModeAnswer({ text: 'Sure: {"merchant": 0.8, "elder": 1.4, "nope": 1}' }), { merchant: 0.8, elder: 1 });
    assert.deepEqual(parseModeAnswer('no json'), {});
    const scene = modeScene([{ mes: 'a' }, { mes: 'b', is_user: true }, { mes: '<b>c</b>' }, { mes: 'x'.repeat(3000), is_user: true }]);
    assert.ok(scene.length <= 1800);
    assert.match(modeScene([{ mes: 'hi', is_user: true }, { mes: 'hello' }]), /^User: hi\nCharacter: hello$/);
});
