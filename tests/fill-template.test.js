import test from 'node:test';
import assert from 'node:assert/strict';
import { fillTemplate } from '../libraries/core/fill-template.js';

test('fillTemplate() substitutes {key}-style placeholders with matching values', () => {
    assert.equal(fillTemplate('Hello, {name}!', { name: 'world' }), 'Hello, world!');
});

test('fillTemplate() substitutes multiple distinct placeholders, including repeats of the same one', () => {
    assert.equal(fillTemplate('{a} + {a} = {b}', { a: '1', b: '2' }), '1 + 1 = 2');
});

test('fillTemplate() leaves a placeholder with no matching key untouched, rather than blanking it', () => {
    assert.equal(fillTemplate('Hello, {typo}!', { name: 'world' }), 'Hello, {typo}!');
});

test('fillTemplate() coerces a non-string value to a string', () => {
    assert.equal(fillTemplate('count: {n}', { n: 42 }), 'count: 42');
});

test('fillTemplate() with no template/values at all does not throw', () => {
    assert.equal(fillTemplate(undefined, undefined), '');
    assert.equal(fillTemplate('plain text, no placeholders', undefined), 'plain text, no placeholders');
});
