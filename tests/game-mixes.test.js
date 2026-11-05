import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MAX_GAME_MIXES, addGameMix, clampGameMixes, findGameMix, matchGameMix, nextGameMixId,
    removeGameMix, renameGameMix, updateGameMix,
} from '../libraries/core/game-mixes.js';
import { DEFAULT_GAME_SETTINGS, modeValues } from '../libraries/core/game-settings.js';

const values = (patch = {}) => ({ ...DEFAULT_GAME_SETTINGS, ...patch });

test('a mix is saved under a player name, applied by its values, renamed and removed', () => {
    const first = addGameMix([], { id: 'noir', name: '  Noir  ', values: values({ tone: 'dark' }) });
    assert.equal(first.ok, true);
    assert.equal(first.mix.name, 'Noir');
    assert.equal(first.mix.values.tone, 'dark');
    assert.equal(first.mixes.length, 1);

    const renamed = renameGameMix(first.mixes, 'noir', 'Rainy noir');
    assert.equal(renamed.ok, true);
    assert.equal(renamed.mixes[0].name, 'Rainy noir');
    assert.equal(renamed.mixes[0].values.tone, 'dark', 'renaming keeps the values');

    const updated = updateGameMix(renamed.mixes, 'noir', values({ tone: 'light' }));
    assert.equal(updated.ok, true);
    assert.equal(updated.mixes[0].values.tone, 'light');

    const removed = removeGameMix(updated.mixes, 'noir');
    assert.equal(removed.ok, true);
    assert.deepEqual(removed.mixes, []);
});

test('the limit is eight mixes, and the next one is refused', () => {
    let mixes = [];
    for (let index = 0; index < MAX_GAME_MIXES; index += 1) {
        const result = addGameMix(mixes, { id: `m${index}`, name: `Mix ${index}`, values: values() });
        assert.equal(result.ok, true, `mix ${index}`);
        mixes = result.mixes;
    }
    const ninth = addGameMix(mixes, { name: 'One too many', values: values() });
    assert.equal(ninth.ok, false);
    assert.match(ninth.error, /At most 8/);
    assert.equal(mixes.length, MAX_GAME_MIXES);
});

test('a mix needs a name, and a missing mix is reported instead of silently succeeding', () => {
    assert.equal(addGameMix([], { name: '   ', values: values() }).ok, false);
    assert.equal(renameGameMix([], 'nope', 'Name').ok, false);
    assert.equal(removeGameMix([], 'nope').ok, false);
    assert.equal(updateGameMix([], 'nope', values()).ok, false);
    assert.equal(findGameMix([], 'nope'), null);
});

test('garbage and duplicates are clamped out of the stored list', () => {
    const list = clampGameMixes([
        { id: 'a', name: 'One', values: { tone: 'dark' } },
        { id: 'a', name: 'Duplicate', values: {} },
        { id: '', name: 'No id', values: {} },
        { id: 'b', name: '', values: {} },
        { id: 'c', name: 'Three', values: 'nonsense' },
        null,
    ]);
    assert.equal(list.length, 1, 'a mix without a valid set is dropped, not guessed');
    assert.deepEqual(list.map(mix => mix.id), ['a']);
    assert.equal(list[0].values.tone, 'dark');
    assert.deepEqual(clampGameMixes('nonsense'), []);
});

test('the current set matches a saved mix by every option, not by name', () => {
    const mix = addGameMix([], { id: 'story', name: 'Story mix', values: modeValues('story') }).mix;
    assert.equal(matchGameMix([mix], modeValues('story')).id, 'story');
    assert.equal(matchGameMix([mix], modeValues('hardcore')), null);
    assert.equal(matchGameMix([mix], { ...modeValues('story'), tone: 'dark' }), null);
});

test('a generated id never collides with an existing mix', () => {
    const mixes = [{ id: 'mix_noir', name: 'Noir', values: values() }];
    const id = nextGameMixId(mixes, 'noir');
    assert.equal(id, 'mix_noir_2');
    assert.equal(nextGameMixId([], 'noir'), 'mix_noir');
});
