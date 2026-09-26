import test from 'node:test';
import assert from 'node:assert/strict';
import { splitFontFamilies, resolveRasterFontFamily } from '../libraries/shared/raster-font.js';

test('a font stack is split on commas outside quotes', () => {
    assert.deepEqual(splitFontFamilies('"Noto Sans", sans-serif'), ['"Noto Sans"', 'sans-serif']);
    assert.deepEqual(splitFontFamilies("'A, B', Arial ,serif"), ["'A, B'", 'Arial', 'serif']);
    assert.deepEqual(splitFontFamilies(''), []);
});

test('only installed families and generic keywords survive — a web font the raster cannot see is dropped, so the mirror measures what will be drawn', async () => {
    const installed = name => name === 'Arial';
    assert.equal(await resolveRasterFontFamily('"Noto Sans", sans-serif', installed), 'sans-serif');
    assert.equal(await resolveRasterFontFamily('"Noto Sans", Arial, sans-serif', installed), 'Arial, sans-serif');
    assert.equal(await resolveRasterFontFamily('"Noto Sans"', installed), 'sans-serif', 'nothing left — the generic fallback');
    assert.equal(await resolveRasterFontFamily('"Noto Sans"', async () => true), '"Noto Sans"', 'installed — kept as is');
});
