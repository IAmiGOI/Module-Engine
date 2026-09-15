/**
 * Pure, DOM-free image resampling (ROADMAP.md 5.42/5.44 deferred this
 * explicitly — "апскейл отдельно" — until now, ROADMAP.md 5.51). Operates
 * on plain `{data, width, height}` flat RGBA pixel buffers, row-major — the
 * same shape as the DOM's own `ImageData`, but deliberately decoupled from
 * it so this stays testable in Node without a canvas. The same "platform
 * capability, not a DOM violation" boundary already drawn around
 * `createImageBitmap` in modules/map/index.js applies here too: decoding a
 * Blob into pixels and encoding pixels back into a Blob are the Module's
 * job (real browser APIs, untestable in Node); the actual resampling
 * ALGORITHM lives here, in the engine, fully unit-testable.
 *
 * **Local algorithm, not an AI/network upscale service** — the owner chose
 * this over wiring a network-capable Ядро to an external super-resolution
 * API. Separable bicubic (Catmull-Rom) resampling: sharper than a plain
 * bilinear resize, but it only interpolates existing pixels — it does not
 * synthesize detail that wasn't in the source, unlike a real AI upscaler.
 *
 * **`cropImagePixels()` (ROADMAP.md 5.52)** — the map's per-tile upscale
 * pipeline decodes the root image's pixels ONCE, then crops out just the
 * small region a given tile needs before upscaling THAT — cropping first
 * keeps the resample pass working on a small buffer (tile-sized), not the
 * whole multi-megapixel source, however deep the zoom goes.
 */

/** A hard ceiling on either output dimension — protects against an accidental multi-gigabyte canvas from a large source image times a large factor. */
export const MAX_UPSCALE_DIMENSION = 8000;

/** Clamps a raw factor into a sane [1, 4] range — 1 = no-op (still a well-defined resample, not a special case callers need to branch around), 4 = a generous ceiling for a one-off manual action. */
export function sanitizeScaleFactor(factor) {
    const n = Number(factor);
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(4, n);
}

/**
 * Shrinks `scaleFactor` (never grows it) so neither resulting dimension
 * exceeds `maxDimension` — a silent, predictable cap instead of an
 * out-of-memory canvas allocation when a huge source map image gets a big
 * factor requested against it.
 */
export function computeClampedScaleFactor(width, height, scaleFactor, maxDimension = MAX_UPSCALE_DIMENSION) {
    const sanitized = sanitizeScaleFactor(scaleFactor);
    if (!(Number(width) > 0) || !(Number(height) > 0)) return sanitized;
    const limit = Math.min(maxDimension / width, maxDimension / height, sanitized);
    return Math.max(1, limit);
}

/**
 * Crops `rect` (in SOURCE PIXELS — `{x, y, width, height}`, not normalized)
 * out of `{data, width, height}`, clamped to the image's own bounds. A
 * `rect` that partially overlaps the image is silently clipped to the
 * overlapping part rather than padded/erroring — a tile at the very edge of
 * the map still gets whatever real pixels exist there.
 */
export function cropImagePixels(image, rect) {
    const { data, width, height } = image;
    const x0 = Math.max(0, Math.min(width, Math.round(rect.x)));
    const y0 = Math.max(0, Math.min(height, Math.round(rect.y)));
    const x1 = Math.max(x0, Math.min(width, Math.round(rect.x + rect.width)));
    const y1 = Math.max(y0, Math.min(height, Math.round(rect.y + rect.height)));
    const cropWidth = Math.max(1, x1 - x0);
    const cropHeight = Math.max(1, y1 - y0);
    const cropped = new Uint8ClampedArray(cropWidth * cropHeight * 4);
    for (let y = 0; y < cropHeight; y += 1) {
        const srcRowStart = ((y0 + y) * width + x0) * 4;
        const dstRowStart = y * cropWidth * 4;
        cropped.set(data.subarray(srcRowStart, srcRowStart + cropWidth * 4), dstRowStart);
    }
    return { data: cropped, width: cropWidth, height: cropHeight };
}

/** Catmull-Rom cubic kernel — a standard, widely-used interpolation kernel with a partition-of-unity property (its 4 taps around any sample position sum to ~1), which is what keeps a uniform-color region uniform after resampling instead of drifting. */
function catmullRomWeight(x) {
    const ax = Math.abs(x);
    if (ax <= 1) return 1.5 * ax ** 3 - 2.5 * ax ** 2 + 1;
    if (ax < 2) return -0.5 * ax ** 3 + 2.5 * ax ** 2 - 4 * ax + 2;
    return 0;
}

function clampIndex(i, length) {
    return Math.min(length - 1, Math.max(0, i));
}

/**
 * Precomputes the 4 source-sample indices + weights for EVERY output
 * position along one axis, ONCE — not per row/column that axis gets applied
 * to. This is the difference between O(outLength) and O(outLength*otherAxisLength)
 * weight computations; recomputing per-row (an earlier version of this file
 * did, closure-and-array-per-sample) turned a 5000x3000 image into a
 * multi-second stall. Flat typed arrays (not an array of small objects) —
 * this table is indexed millions of times in the hot loop below, so the
 * shape needs to stay monomorphic and allocation-free per access.
 *
 * Weights are Catmull-Rom's own 4 taps around a fractional source position —
 * their partition-of-unity property (they always sum to ~1, for any
 * fractional offset) is relied on directly: no runtime normalization/
 * division is needed per output sample.
 */
function buildResampleTable(length, outLength, scale) {
    const i0 = new Int32Array(outLength), i1 = new Int32Array(outLength), i2 = new Int32Array(outLength), i3 = new Int32Array(outLength);
    const w0 = new Float32Array(outLength), w1 = new Float32Array(outLength), w2 = new Float32Array(outLength), w3 = new Float32Array(outLength);
    for (let o = 0; o < outLength; o += 1) {
        const s = (o + 0.5) / scale - 0.5;
        const base = Math.floor(s);
        i0[o] = clampIndex(base - 1, length);
        i1[o] = clampIndex(base, length);
        i2[o] = clampIndex(base + 1, length);
        i3[o] = clampIndex(base + 2, length);
        w0[o] = catmullRomWeight(s - (base - 1));
        w1[o] = catmullRomWeight(s - base);
        w2[o] = catmullRomWeight(s - (base + 1));
        w3[o] = catmullRomWeight(s - (base + 2));
    }
    return { i0, i1, i2, i3, w0, w1, w2, w3 };
}

/**
 * Resamples `{data, width, height}` up by `scaleFactor` via two separable
 * Catmull-Rom passes (horizontal, then vertical) — far fewer taps than a
 * naive 2D 4x4-per-output-pixel convolution, which matters once a real map
 * image (thousands of pixels per side) is involved. `scaleFactor` is
 * sanitized here too (see `sanitizeScaleFactor`) — this function is safe to
 * call directly with a raw, unclamped caller value.
 */
export function computeUpscaledImage(image, scaleFactor) {
    const { data, width, height } = image;
    const factor = sanitizeScaleFactor(scaleFactor);
    const newWidth = Math.max(1, Math.round(width * factor));
    const newHeight = Math.max(1, Math.round(height * factor));

    // Pass 1: horizontal — width -> newWidth, height unchanged.
    const hTable = buildResampleTable(width, newWidth, newWidth / width);
    const horizontal = new Float32Array(newWidth * height * 4);
    for (let y = 0; y < height; y += 1) {
        const rowBase = y * width * 4;
        const outRowBase = y * newWidth * 4;
        for (let x = 0; x < newWidth; x += 1) {
            const s0 = rowBase + hTable.i0[x] * 4, s1 = rowBase + hTable.i1[x] * 4, s2 = rowBase + hTable.i2[x] * 4, s3 = rowBase + hTable.i3[x] * 4;
            const w0 = hTable.w0[x], w1 = hTable.w1[x], w2 = hTable.w2[x], w3 = hTable.w3[x];
            const outBase = outRowBase + x * 4;
            for (let channel = 0; channel < 4; channel += 1) {
                horizontal[outBase + channel] = w0 * data[s0 + channel] + w1 * data[s1 + channel] + w2 * data[s2 + channel] + w3 * data[s3 + channel];
            }
        }
    }

    // Pass 2: vertical — height -> newHeight, width already newWidth.
    const vTable = buildResampleTable(height, newHeight, newHeight / height);
    const result = new Uint8ClampedArray(newWidth * newHeight * 4);
    for (let y = 0; y < newHeight; y += 1) {
        const s0Row = vTable.i0[y] * newWidth, s1Row = vTable.i1[y] * newWidth, s2Row = vTable.i2[y] * newWidth, s3Row = vTable.i3[y] * newWidth;
        const w0 = vTable.w0[y], w1 = vTable.w1[y], w2 = vTable.w2[y], w3 = vTable.w3[y];
        const outRowBase = y * newWidth * 4;
        for (let x = 0; x < newWidth; x += 1) {
            const s0 = (s0Row + x) * 4, s1 = (s1Row + x) * 4, s2 = (s2Row + x) * 4, s3 = (s3Row + x) * 4;
            const outBase = outRowBase + x * 4;
            for (let channel = 0; channel < 4; channel += 1) {
                result[outBase + channel] = w0 * horizontal[s0 + channel] + w1 * horizontal[s1 + channel] + w2 * horizontal[s2 + channel] + w3 * horizontal[s3 + channel];
            }
        }
    }

    return { data: result, width: newWidth, height: newHeight };
}
