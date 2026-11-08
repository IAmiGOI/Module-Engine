import test from 'node:test';
import assert from 'node:assert/strict';
import { sortSources, parseSort, fallbackImportance } from '../cores/decision/bank-sort.js';

const sources = [
    { sourceKey: 'card:emilia', sourceKind: 'card', name: 'Emilia', source: 'A half-elf mage.' },
    { sourceKey: 'lore:guard', sourceKind: 'lorebook entry', name: 'Gate Guard', source: 'A guard at the gate.' },
    { sourceKey: 'persona:me', sourceKind: 'persona', name: 'Subaru', source: 'The user.' },
];

test('cold start sorts characters by importance in one call and builds nothing', async () => {
    const calls = [];
    const call = async (contract, params) => { calls.push({ contract, params }); return { text: '[{"name": "Emilia", "importance": "main"}, {"name": "Gate Guard", "importance": "mass"}]' }; };
    const levels = await sortSources({ call, getSettings: () => ({ researcher: { workerId: 'banks' } }), sources });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].contract, 'model.generate');
    assert.doesNotMatch(calls[0].params.messages[1].content, /Subaru/, 'the user is not sorted');
    assert.equal(levels.get('card:emilia'), 'main');
    assert.equal(levels.get('lore:guard'), 'mass');
    assert.equal(levels.get('persona:me'), 'temporary');
});

test('without a bank model or a usable answer the source kind decides', async () => {
    const levels = await sortSources({ call: async () => { throw new Error('down'); }, getSettings: () => ({ researcher: { workerId: 'banks' } }), sources });
    assert.equal(levels.get('card:emilia'), 'main');
    assert.equal(levels.get('lore:guard'), 'side');
    assert.equal(fallbackImportance({ sourceKind: 'persona' }), 'temporary');
    assert.equal(parseSort('no json').size, 0);
});
