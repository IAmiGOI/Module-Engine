import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSort } from '../cores/decision/bank-sort.js';
import { createGreatBank } from '../cores/decision/bank-great.js';
import { createBankHandlers } from '../cores/decision/handlers-bank.js';
import { unsplitCards, mainWithoutDecree, directorReason } from '../libraries/core/decision-director.js';

test('the sorter marks a card that holds several people; one name is not "several"', () => {
    const levels = parseSort('[{"name": "Takagi and Chi", "importance": "main", "several": ["Takagi", "Chi"]}, {"name": "Rem", "importance": "side", "several": ["Rem"]}]');
    assert.equal(levels.get('takagi and chi'), 'main');
    assert.deepEqual(levels.several.get('takagi and chi'), ['Takagi', 'Chi']);
    assert.equal(levels.several.has('rem'), false);
});

function bankWith(state) {
    const memory = new Map([['greatBank', state]]);
    const call = async (contract, params = {}) => {
        if (contract === 'storage.chatMemory.get') return memory.has(params.key) ? structuredClone(memory.get(params.key)) : params.fallback;
        if (contract === 'storage.chatMemory.set') { memory.set(params.key, structuredClone(params.value)); return true; }
        if (contract === 'chatHistory.annotations') return {};
        return undefined;
    };
    return createGreatBank({ call, store: { clock: () => ({ minutes: 0 }) }, banks: { records: () => [] } });
}

test('an unsplit card waits for the Director instead of getting a Decree as one person', () => {
    const state = { 'takagi and chi': { name: 'Takagi and Chi', importance: 'main', several: ['Takagi', 'Chi'], fallbackText: 'Chi: 4 years old. Takagi: her mother.' } };
    assert.deepEqual(unsplitCards(state), ['Takagi and Chi (Takagi, Chi)']);
    assert.deepEqual(mainWithoutDecree(state), []);
    assert.match(directorReason({ banks: { great: state } }).wake.detail, /Cards to split into their characters: Takagi and Chi \(Takagi, Chi\)/);
});

test('the Director splits a card: each person is a character with the shared card, the card itself leaves the cast', async () => {
    const great = bankWith({
        'takagi and chi': { name: 'Takagi and Chi', importance: 'main', several: ['Takagi', 'Chi'], fallbackText: 'Chi: 4 years old. Takagi: her mother.' },
        chi: { name: 'Chi', importance: 'temporary' },
        nishikata: { name: 'Nishikata', sourceKey: 'persona:me' },
    });
    const handlers = createBankHandlers({ banks: { great } });
    assert.equal((await handlers.split_character({ character: 'Takagi and Chi', into: [{ name: 'Takagi', importance: 'main' }], comment: 'x' })).ok, false, 'one person is not a split');
    const result = await handlers.split_character({ character: 'Takagi and Chi', into: [{ name: 'Takagi', importance: 'main' }, { name: 'Chi', importance: 'main' }], comment: 'Two people, one card.' });
    assert.deepEqual(result.into, ['Takagi', 'Chi']);
    const state = await great.load();
    assert.equal(state.chi.importance, 'main');
    assert.match(state.chi.fallbackText, /this file is for Chi[\s\S]*Chi: 4 years old/);
    assert.equal(state['takagi and chi'].importance, 'mass');
    assert.deepEqual(unsplitCards(state), []);
    assert.deepEqual(mainWithoutDecree(state).sort(), ['Chi', 'Takagi']);
});
