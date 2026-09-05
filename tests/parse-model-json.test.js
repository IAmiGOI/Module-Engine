import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelJson } from '../libraries/core/parse-model-json.js';

test('parseModelJson() parses plain, unwrapped JSON', () => {
    assert.deepEqual(parseModelJson('{"health": 100}'), { health: 100 });
});

test('parseModelJson() strips a ```json ... ``` markdown fence before parsing', () => {
    assert.deepEqual(parseModelJson('```json\n{"health": 100}\n```'), { health: 100 });
});

test('parseModelJson() strips a fence with no language tag too', () => {
    assert.deepEqual(parseModelJson('```\n{"health": 100}\n```'), { health: 100 });
});

test('parseModelJson() trims surrounding whitespace/newlines', () => {
    assert.deepEqual(parseModelJson('\n\n  {"health": 100}  \n'), { health: 100 });
});

test('parseModelJson() returns undefined for malformed JSON, never throws', () => {
    assert.equal(parseModelJson('not json at all'), undefined);
    assert.equal(parseModelJson(''), undefined);
    assert.equal(parseModelJson(undefined), undefined);
});
