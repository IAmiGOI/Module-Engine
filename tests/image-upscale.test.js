import test from 'node:test';
import assert from 'node:assert/strict';
import {
    sanitizeScaleFactor, computeClampedScaleFactor, computeUpscaledImage, cropImagePixels, MAX_UPSCALE_DIMENSION,
} from '../libraries/shared/image-upscale.js';

/** A flat RGBA buffer for a `width`x`height` image where every pixel is the same `[r,g,b,a]`. */
function solidImage(width, height, [r, g, b, a]) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i += 1) {
        data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = a;
    }
    return { data, width, height };
}

test('sanitizeScaleFactor clamps into [1, 4] and treats garbage as 1 (no-op)', () => {
    assert.equal(sanitizeScaleFactor(2), 2);
    assert.equal(sanitizeScaleFactor(0.5), 1, 'below 1 is not a valid upscale factor');
    assert.equal(sanitizeScaleFactor(100), 4, 'ceiling at 4');
    assert.equal(sanitizeScaleFactor(NaN), 1);
    assert.equal(sanitizeScaleFactor(null), 1);
});

test('computeClampedScaleFactor shrinks the factor so neither output dimension exceeds the cap, but never grows it', () => {
    const shrunk = computeClampedScaleFactor(5000, 3000, 4, MAX_UPSCALE_DIMENSION);
    assert.ok(shrunk < 4, 'width*4 would exceed the cap, so the factor must be reduced');
    assert.ok(5000 * shrunk <= MAX_UPSCALE_DIMENSION + 0.001);

    const untouched = computeClampedScaleFactor(100, 100, 2, MAX_UPSCALE_DIMENSION);
    assert.equal(untouched, 2, 'well within the cap — the requested factor is used as-is');
});

test('computeUpscaledImage with scaleFactor 1 returns the same dimensions', () => {
    const source = solidImage(4, 3, [10, 20, 30, 255]);
    const result = computeUpscaledImage(source, 1);
    assert.equal(result.width, 4);
    assert.equal(result.height, 3);
});

test('computeUpscaledImage doubles both dimensions for scaleFactor 2', () => {
    const source = solidImage(10, 6, [0, 0, 0, 255]);
    const result = computeUpscaledImage(source, 2);
    assert.equal(result.width, 20);
    assert.equal(result.height, 12);
});

test('computeUpscaledImage keeps a solid-color image exactly the same color everywhere — no ringing/drift from the cubic kernel on flat input', () => {
    const source = solidImage(8, 8, [120, 60, 200, 255]);
    const result = computeUpscaledImage(source, 3);
    for (let i = 0; i < result.width * result.height; i += 1) {
        assert.equal(result.data[i * 4], 120);
        assert.equal(result.data[i * 4 + 1], 60);
        assert.equal(result.data[i * 4 + 2], 200);
        assert.equal(result.data[i * 4 + 3], 255);
    }
});

test('computeUpscaledImage on a single pixel stays that exact color at every output pixel (fully edge-clamped)', () => {
    const source = solidImage(1, 1, [50, 100, 150, 255]);
    const result = computeUpscaledImage(source, 4);
    assert.equal(result.width, 4);
    assert.equal(result.height, 4);
    for (let i = 0; i < 16; i += 1) {
        assert.equal(result.data[i * 4], 50);
        assert.equal(result.data[i * 4 + 1], 100);
        assert.equal(result.data[i * 4 + 2], 150);
    }
});

test('computeUpscaledImage preserves overall brightness trend across a gradient — darkest and lightest ends stay darkest/lightest', () => {
    const width = 4, height = 1;
    const data = new Uint8ClampedArray(width * height * 4);
    [0, 80, 170, 255].forEach((value, x) => {
        data[x * 4] = value; data[x * 4 + 1] = value; data[x * 4 + 2] = value; data[x * 4 + 3] = 255;
    });
    const result = computeUpscaledImage({ data, width, height }, 3);
    assert.ok(result.data[0] <= result.data[(result.width - 1) * 4], 'left end must stay darker than (or equal to) the right end');
});

test('cropImagePixels extracts exactly the requested pixel rect', () => {
    const width = 4, height = 4;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const i = (y * width + x) * 4;
            data[i] = x * 10; data[i + 1] = y * 10; data[i + 2] = 0; data[i + 3] = 255;
        }
    }
    const crop = cropImagePixels({ data, width, height }, { x: 1, y: 1, width: 2, height: 2 });
    assert.equal(crop.width, 2);
    assert.equal(crop.height, 2);
    // Top-left of the crop must be the source's pixel (1,1): r=10, g=10.
    assert.equal(crop.data[0], 10);
    assert.equal(crop.data[1], 10);
    // Bottom-right of the crop must be the source's pixel (2,2): r=20, g=20.
    const lastPixel = (crop.width * crop.height - 1) * 4;
    assert.equal(crop.data[lastPixel], 20);
    assert.equal(crop.data[lastPixel + 1], 20);
});

test('cropImagePixels clips a rect that partially overlaps the image instead of erroring or padding', () => {
    const source = solidImage(4, 4, [9, 9, 9, 255]);
    const crop = cropImagePixels(source, { x: 2, y: 2, width: 10, height: 10 });
    assert.equal(crop.width, 2, 'only 2 columns remain inside the 4-wide source from x=2');
    assert.equal(crop.height, 2);
});

test('cropImagePixels on the full image bounds returns an identical copy', () => {
    const source = solidImage(3, 2, [1, 2, 3, 255]);
    const crop = cropImagePixels(source, { x: 0, y: 0, width: 3, height: 2 });
    assert.deepEqual([...crop.data], [...source.data]);
});
