import test from 'node:test';
import assert from 'node:assert/strict';
import { auditTurnInputs } from '../libraries/core/decision-audit.js';

const bank = {
    emilia: { name: 'Emilia', sourceKey: 'lorebook:x:1', importance: 'main', spiritual: { 3: ['a'], 5: ['b'] }, decree: { 1: ['x'] } },
    otto: { name: 'Otto Suwen', sourceKey: 'lorebook:x:2', importance: 'side', spiritual: { 3: ['a'], 5: ['b'] }, decree: {} },
    clerk: { name: 'Guild Clerk', sourceKey: 'history:x', importance: 'temporary', spiritual: {}, decree: {} },
    sasha: { name: 'Sasha', sourceKey: 'persona:user', importance: 'main', spiritual: { 3: ['a'] }, decree: { 3: ['Today: plan'] } },
};

test('the audit names what the roles would otherwise fill in silently', () => {
    const found = auditTurnInputs({ greatBank: bank, roster: ['Emilia', 'Otto Suwen', 'Guild Clerk', 'Ram', 'Sasha'], user: 'Sasha', windowEntries: [{ kind: 'turn', turn: 70 }], turn: 65 }).map(item => item.key);
    assert.deepEqual(found.sort(), ['empty:Guild Clerk', 'nobank:Ram', 'nodecree:Otto Suwen', 'userdecree:Sasha', 'window:65'].sort());
});

test('a whole scene raises nothing', () => {
    assert.deepEqual(auditTurnInputs({ greatBank: { emilia: bank.emilia }, roster: ['Emilia'], user: 'Sasha', windowEntries: [{ kind: 'turn', turn: 64 }], turn: 65 }), []);
});

test('someone silent in the scene for many turns is named by the audit and shown to the Resolver with the gap', async () => {
    const { renderCurrentScene } = await import('../libraries/core/decision-scene.js');
    const puck = { name: 'Puck', sourceKey: 'lorebook:x:3', importance: 'main', spiritual: { 3: ['a'], 5: ['b'] }, decree: { 1: ['x'] } };
    const found = auditTurnInputs({ greatBank: { puck }, roster: ['Puck'], user: 'Sasha', turn: 70, lastActed: { puck: 29 } }).map(item => item.key);
    assert.deepEqual(found, ['silent:Puck']);
    const scene = renderCurrentScene({ form: { characters: [], resolution: 'They walk on.' }, roster: ['Puck'], user: 'Sasha', lastActed: { puck: 29 }, turn: 70 });
    assert.match(scene, /Puck \(last acted 41 turns ago\)/);
    assert.match(scene, /leaves the scene with the roster field/);
});
