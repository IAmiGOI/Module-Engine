import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBaseHue, computeAutoSpeakerColor, hexToRgba } from '../libraries/shared/color-palette.js';

test('resolveBaseHue falls back to a fixed neutral hue for a malformed/absent hex, never producing NaN', () => {
    assert.equal(resolveBaseHue(undefined), 210);
    assert.equal(resolveBaseHue('not-a-color'), 210);
    assert.equal(resolveBaseHue('#12'), 210);
});

test('resolveBaseHue reads pure red as hue 0', () => {
    assert.equal(resolveBaseHue('#ff0000'), 0);
});

test('resolveBaseHue reads pure green as hue 120', () => {
    assert.equal(resolveBaseHue('#00ff00'), 120);
});

test('computeAutoSpeakerColor is DETERMINISTIC — the same base color and index always produce the same color, across separate calls', () => {
    const first = computeAutoSpeakerColor('#3f51b5', 2);
    const second = computeAutoSpeakerColor('#3f51b5', 2);
    assert.equal(first, second);
});

test('computeAutoSpeakerColor gives DIFFERENT speakers DIFFERENT colors, in a stable rotation (index 0 and index 1 never collide)', () => {
    const a = computeAutoSpeakerColor('#3f51b5', 0);
    const b = computeAutoSpeakerColor('#3f51b5', 1);
    assert.notEqual(a, b);
});

test('computeAutoSpeakerColor always returns a well-formed 6-digit hex string', () => {
    const color = computeAutoSpeakerColor('#3f51b5', 5);
    assert.match(color, /^#[0-9a-f]{6}$/);
});

test('hexToRgba converts a real hex color and alpha into the equivalent rgba() string', () => {
    assert.equal(hexToRgba('#ff8800', 0.5), 'rgba(255, 136, 0, 0.5)');
});

test('hexToRgba clamps an out-of-range alpha into [0, 1]', () => {
    assert.equal(hexToRgba('#000000', 5), 'rgba(0, 0, 0, 1)');
    assert.equal(hexToRgba('#000000', -1), 'rgba(0, 0, 0, 0)');
});

test('hexToRgba falls back to fully transparent for malformed input instead of throwing', () => {
    assert.equal(hexToRgba('not-a-color', 0.5), 'transparent');
    assert.equal(hexToRgba(undefined, 0.5), 'transparent');
});
