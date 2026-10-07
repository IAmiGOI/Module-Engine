import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanSceneText, guessNames, normalizeNames } from '../libraries/shared/scene-text.js';
import { sceneNames } from '../modules/music/tracks.js';

test('names of the participants are cut out as whole words (with a possessive), other words that merely contain them stay', () => {
    const out = cleanSceneText('Hatsu held her breath. Hatsu\'s eyes were wide. Hatsune Miku sang. Sasha sighed, and Sasha waited.', { names: ['Hatsu', 'Sasha'] });
    assert.equal(out, 'held her breath. eyes were wide. Hatsune Miku sang. sighed, and waited.');
    assert.equal(cleanSceneText('Анна пришла, Анна ушла', { names: ['Анна'] }), 'пришла, ушла', 'non-Latin names too');
    assert.equal(cleanSceneText('Al said hello to Alan', { names: ['Al'] }), 'said hello to Alan', 'a short name does not eat longer words');
});

test('markup and service leftovers are removed: emphasis stars, HTML, links, code, macros, OOC inserts', () => {
    const out = cleanSceneText('*She smiled.* <b>Look</b> at https://x.example/a?b=1 {{user}} (OOC: next scene) ```code``` [OOC: skip] ok!!!!! fine', {});
    assert.equal(out, 'She smiled. Look at ok!! fine');
    assert.equal(cleanSceneText('', {}), '');
    assert.equal(cleanSceneText(null), '');
});

test('names are normalised: duplicates in any case collapse, one-letter names are dropped, longer first so "Anna Maria" goes before "Anna"', () => {
    assert.deepEqual(normalizeNames(['Anna', 'anna', 'A', ' Anna Maria ', '', null]), ['Anna Maria', 'Anna']);
    assert.equal(cleanSceneText('Anna Maria met Anna.', { names: ['Anna', 'Anna Maria'] }), 'met.');
});

test('guessNames finds capitalised words that recur in the MIDDLE of sentences — the old dictionary scenes do not remember their participants — and leaves ordinary words alone', () => {
    const scenes = [
        'She said to Hatsu, softly. Then Nyx left.', 'He looked at Hatsu and Nyx.', 'So Hatsu, Nyx and Kira walked home.',
        'Hatsu told Nyx that Kira slept. Monday was cold.', 'And Hatsu saw Nyx. The Monday came.',
    ];
    assert.deepEqual(guessNames(scenes, { minCount: 3 }).sort(), ['Hatsu', 'Nyx']);
    assert.deepEqual(guessNames(['He left. Rain fell. Snow came.', 'Dusk fell. Night came.'], { minCount: 1 }), [], 'sentence-initial words are not names');
    assert.deepEqual(guessNames(['I saw her, Her eyes shone.', 'Yes, Her hand shook.', 'And, His voice broke.'], { minCount: 1 }), [], 'pronouns and possessives capitalised after a comma are not names');
    assert.deepEqual(guessNames([], {}), []);
});

test('the Music module takes participant names from the messages (system lines excluded, no repeats)', () => {
    assert.deepEqual(sceneNames([{ name: 'Hatsu', text: 'a' }, { name: 'Sasha', text: 'b' }, { name: 'Hatsu', text: 'c' }, { name: 'System', isSystem: true, text: 'd' }, { text: 'no name' }]), ['Hatsu', 'Sasha']);
    assert.deepEqual(sceneNames('junk'), []);
});
