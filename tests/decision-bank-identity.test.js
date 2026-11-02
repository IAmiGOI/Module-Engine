import test from 'node:test';
import assert from 'node:assert/strict';
import { findBankSource, bankPromptFor, bankSizeBand } from '../libraries/core/decision-banks.js';

test('a roster name or an alias finds the marked bank by its clean name', () => {
    const sources = [{ sourceKey: 'lorebook:Story:2', sourceKind: 'lorebook entry', name: 'Rem', aliases: ['Rem-tan', 'the maid'], source: 'A demon maid.' }];
    assert.equal(findBankSource(sources, 'Rem')?.sourceKey, 'lorebook:Story:2');
    assert.equal(findBankSource(sources, 'rem-tan')?.sourceKey, 'lorebook:Story:2');
    assert.equal(findBankSource(sources, 'Rem (Still comatose lmao)'), null);
});

test('the subagent prompt carries aliases and the franchise, and leaves the franchise empty when there is none', () => {
    const withFranchise = bankPromptFor({ name: 'Rem', sourceKind: 'lorebook entry', source: 'A demon maid.', canonHint: 'Re:Zero', aliases: 'Rem-tan, the maid' });
    assert.match(withFranchise, /FRANCHISE: Re:Zero/);
    assert.match(withFranchise, /ALSO KNOWN AS: Rem-tan, the maid/);
    const original = bankPromptFor({ name: 'Mira', sourceKind: 'history', source: 'A courier.' });
    assert.match(original, /FRANCHISE: \n/);
    assert.match(original, /ALSO KNOWN AS: \n/);
});

test('importance key gives the key size band; an ordinary character stays minor', () => {
    assert.equal(bankSizeBand({ isMain: true }), 'key');
    assert.equal(bankSizeBand({ level: 2 }), 'key');
    assert.equal(bankSizeBand({}), 'minor');
});
