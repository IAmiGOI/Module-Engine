import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyColor } from '../libraries/shared/text-layout/legacy-color.js';

test('a hex value without # is read the way the browser reads the legacy <font color> attribute (ST writes it that way)', () => {
    assert.equal(legacyColor('a635a7'), '#a635a7');
    assert.equal(legacyColor('#A635A7'), '#A635A7', 'already valid CSS — as is');
    assert.equal(legacyColor('#f80'), '#f80', 'with # the short form is valid CSS — as is');
    assert.equal(legacyColor('f80'), '#0f0800', 'without # each character is its own component (as the browser reads <font color=f80>)');
});

test('names pass through for the canvas to resolve; empty and transparent are ignored, like the browser does', () => {
    assert.equal(legacyColor('red'), 'red');
    assert.equal(legacyColor('  RebeccaPurple '), 'RebeccaPurple');
    assert.equal(legacyColor(''), null);
    assert.equal(legacyColor(null), null);
    assert.equal(legacyColor('transparent'), null);
});

test('odd lengths and non-hex characters follow the legacy algorithm', () => {
    assert.equal(legacyColor('12345'), '#123450', '5 chars are padded to 6 with a zero, then split in 3 pairs');
    assert.equal(legacyColor('zz1122'), '#001122', 'non-hex characters become zeros');
    assert.equal(legacyColor('#123456789abc'), '#12569a', 'four characters per component — the first two of each');
});
