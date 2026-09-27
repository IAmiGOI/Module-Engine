import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { avatarSourceUrl, registerImageScaleService, sharpenImageData, fitInside, isSameOriginPath } from '../services/image-scale.js';

test('ST thumbnails are swapped for the full-size originals (96×144 previews are too small for our avatar)', () => {
    assert.equal(avatarSourceUrl('/thumbnail?type=persona&file=user-default.png'), '/User Avatars/user-default.png');
    assert.equal(avatarSourceUrl('thumbnail?type=avatar&file=Aria.png'), '/characters/Aria.png');
    assert.equal(avatarSourceUrl('/characters/Aria.png'), '/characters/Aria.png', 'anything else is left alone');
});

test('imageScale.toBlobUrl crops "cover" to the target proportions, resizes once in high quality, and caches per url+size', async () => {
    const engine = createEngine();
    const calls = { fetch: [], bitmap: [], drawn: 0 };
    registerImageScaleService(engine.buses.services, {
        fetch: async url => { calls.fetch.push(url); return { ok: true, blob: async () => ({ size: 1 }) }; },
        createBitmap: async (...args) => { calls.bitmap.push(args); return { width: 900, height: 888, close() {} }; },
        createCanvas: () => ({ getContext: () => ({ drawImage: () => { calls.drawn += 1; } }), convertToBlob: async () => ({ size: 5 }) }),
        createObjectUrl: () => 'blob:scaled',
    });
    const caller = engine.registerCaller('test.caller', 'cores', { tier: 'official' });
    const ask = params => new Promise(resolve => caller.services.subscribe('imageScale.toBlobUrl', { params }, resolve));

    const first = await ask({ url: '/characters/Aria.png', width: 255, height: 340 });
    assert.equal(first.value, 'blob:scaled');
    const resizeArgs = calls.bitmap.at(-1);
    assert.deepEqual(resizeArgs[5], { resizeWidth: 255, resizeHeight: 340, resizeQuality: 'high' });
    // 900×888 (почти квадрат) под пропорции 3:4 — режется по ширине: sw = 888 * 0.75 = 666
    assert.equal(resizeArgs[3], 666);
    assert.equal(resizeArgs[4], 888);

    await ask({ url: '/characters/Aria.png', width: 255, height: 340 });
    assert.equal(calls.fetch.length, 1, 'the same avatar at the same size is prepared only once');
});

test('sharpenImageData boosts a soft edge, leaves flat areas, alpha and the border untouched, and amount 0 is a no-op', () => {
    const w = 5;
    const h = 5;
    const build = () => {
        const data = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) { const i = (y * w + x) * 4; const v = x < 2 ? 100 : 150; data.set([v, v, v, 200], i); }
        return data;
    };
    const original = build();
    const sharpened = sharpenImageData(build(), w, h, 1);
    const at = (data, x, y) => data[(y * w + x) * 4];
    assert.ok(at(sharpened, 1, 2) < at(original, 1, 2), 'the dark side of the edge gets darker');
    assert.ok(at(sharpened, 2, 2) > at(original, 2, 2), 'the bright side of the edge gets brighter');
    assert.equal(at(sharpened, 3, 2), at(original, 3, 2), 'a flat area does not change');
    assert.equal(sharpened[(2 * w + 1) * 4 + 3], 200, 'alpha is untouched');
    assert.equal(at(sharpened, 0, 0), at(original, 0, 0), 'the border row/column is left as is');
    assert.deepEqual([...sharpenImageData(build(), w, h, 0)], [...original]);
});

// --- Референсы для генерации картинок ---

test('fitInside keeps proportions within the square and never enlarges', () => {
    assert.deepEqual(fitInside(2000, 1000, 1024), { width: 1024, height: 512 });
    assert.deepEqual(fitInside(600, 900, 1024), { width: 600, height: 900 });
});

test('only paths of the same server are accepted as a reference source', () => {
    assert.equal(isSameOriginPath('/characters/a.png'), true);
    assert.equal(isSameOriginPath('/User Avatars/b.png'), true);
    for (const url of ['https://evil.example/x.png', '//evil.example/x.png', 'data:image/png;base64,AA', '', null]) assert.equal(isSameOriginPath(url), false, String(url));
});

function buildScaler(fetched) {
    const engine = createEngine();
    registerImageScaleService(engine.buses.services, {
        fetch: async url => { fetched.push(url); return { ok: true, blob: async () => ({ size: 1 }) }; },
        createBitmap: async () => ({ width: 2048, height: 1024, close() {} }),
        createCanvas: () => ({ getContext: () => ({ fillRect() {}, drawImage() {} }), convertToBlob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }) }),
    });
    const caller = engine.registerCaller('test.caller', 'cores', { tier: 'official' });
    return params => new Promise(resolve => caller.services.subscribe('imageScale.toDataUrl', { params }, resolve));
}

test('imageScale.toDataUrl turns an avatar into a JPEG data URL and refuses addresses of other servers', async () => {
    const fetched = [];
    const ask = buildScaler(fetched);

    assert.equal((await ask({ url: '/characters/Aria.png' })).value, 'data:image/jpeg;base64,AQID');
    assert.equal((await ask({ url: 'https://evil.example/x.png' })).value, null);
    assert.deepEqual(fetched, ['/characters/Aria.png']);
});
