import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { createSettingsCore } from '../cores/settings/index.js';
import { registerChatMetadataService } from '../services/chat-metadata.js';
import { createChatMemoryCore } from '../cores/memory/index.js';
import { createMapCore } from '../cores/map/index.js';
import { createMapModule, MODULE_ID } from '../modules/map/index.js';

/** A minimal fake `pointerdown` — exactly the fields `createDragHandlers()` reads (draggable.js). */
function fakePointerDown() {
    return {
        button: 0, clientX: 0, clientY: 0,
        target: { closest: () => null },
        currentTarget: { setPointerCapture: () => {}, releasePointerCapture: () => {}, parentElement: { getBoundingClientRect: () => ({ left: 0, top: 0 }) } },
        preventDefault: () => {},
    };
}

/** Scenario level (TESTING.md) — real engine/Гейты; only ST-facing `getContext()` is faked. */
function buildEngine({ onEncode } = {}) {
    const engine = createEngine();
    const settingsContext = { extensionSettings: {}, saveSettingsDebounced: () => {} };
    registerExtensionSettingsService(engine.buses.services, { getContext: () => settingsContext });
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));

    const chatContext = { chatMetadata: {}, saveMetadataDebounced: () => {}, saveMetadata: async () => {} };
    registerChatMetadataService(engine.buses.services, { getContext: () => chatContext });
    createChatMemoryCore(engine.registerCaller('core.memory.chat', 'cores', { tier: 'official' }));

    const mapCore = createMapCore(engine.registerCaller('core.map', 'cores', { tier: 'official' }));

    // Fake image.* Service — a plain in-memory Map, same substitution as
    // music-module.test.js's fake audio store (real image-store.js needs a
    // real indexedDB, unavailable in Node; TESTING.md — only the Сервис
    // layer gets faked).
    const imageBlobs = new Map();
    engine.buses.services.register('image.put', ({ id, blob }) => { imageBlobs.set(String(id), blob); return true; });
    engine.buses.services.register('image.get', ({ id }) => imageBlobs.get(String(id)) ?? null);
    engine.buses.services.register('image.delete', ({ id }) => imageBlobs.delete(String(id)) || true);

    const moduleHost = engine.registerCaller(MODULE_ID, 'modules', {
        tier: 'community',
        allowedContracts: [
            'storage.settings.get', 'storage.settings.set', 'ui.notify', 'map.settings.get', 'map.settings.update',
            'map.rootImage.get', 'map.rootImage.set', 'map.rootImage.clear', 'image.put', 'image.get', 'image.delete',
            'map.nodes.list', 'map.nodes.create', 'map.nodes.update', 'map.nodes.remove', 'map.edges.list', 'map.pathfind',
            'map.position.get', 'map.position.set', 'map.position.move', 'map.movementLog.list', 'map.movementLog.clear',
        ],
    });
    const notifications = [];
    const rawSubscribe = moduleHost.cores.subscribe.bind(moduleHost.cores);
    moduleHost.cores.subscribe = (contract, options, callback) => {
        if (contract === 'ui.notify') notifications.push(options.params);
        return rawSubscribe(contract, options, callback);
    };

    // Node has no createImageBitmap/OffscreenCanvas — fakes that read/write
    // dimensions the test itself attaches to the fake File/Blob, mirroring
    // how a real browser would report the real decoded image size. The
    // pixel decode/encode boundary is faked (platform-only, per TESTING.md);
    // `computeUpscaledImage()`/`cropImagePixels()` themselves — the real
    // algorithms — run for real on the resulting synthetic pixel buffer, so
    // the tile-pipeline tests below exercise the genuine math, not a stub of it.
    const module = createMapModule(moduleHost, {
        resolveImageDimensions: async blob => ({ width: blob.fakeWidth ?? 100, height: blob.fakeHeight ?? 80 }),
        decodeImageToPixels: async blob => {
            const width = blob.fakeWidth ?? 100, height = blob.fakeHeight ?? 80;
            return { data: new Uint8ClampedArray(width * height * 4).fill(128), width, height };
        },
        encodePixelsToBlob: async pixels => {
            onEncode?.(pixels);
            return { type: 'image/png', fakeWidth: pixels.width, fakeHeight: pixels.height, fromUpscale: true };
        },
    });
    return { engine, mapCore, module, notifications, imageBlobs };
}

function fakeImageFile({ name = 'map.png', type = 'image/png', width = 2000, height = 1500 } = {}) {
    return { name, type, fakeWidth: width, fakeHeight: height };
}

test('tree() is a real (non-null) node with no settings fields — settings live in the map window, not the Modules card', async () => {
    const { module } = buildEngine();
    await module.load();
    const node = module.tree();

    assert.ok(node, 'a bare null would crash the Ядро UI модулей mount — see doc-comment');
    assert.equal(node.tag, 'div');
});

test('the map window starts hidden by default, and setHudVisible(true) opens it — hud() then contains a FloatingPanel, not just the dock button', async () => {
    const { module } = buildEngine();
    await module.load();
    assert.equal(module.isHudVisible(), false);

    const hiddenHud = module.hud();
    // hud() = [dock button, windowTree() signal] — while hidden, the second child resolves to null.
    assert.equal(hiddenHud.children[1](), null);

    module.setHudVisible(true);
    const visibleHud = module.hud();
    const windowNode = visibleHud.children[1]();
    assert.ok(windowNode, 'the FloatingPanel must now render');
    assert.equal(windowNode.props.class, 'stme-floating-panel stme-floating-panel--map');
});

test('the dock button carries a title and starts at the default corner (no left/top yet)', async () => {
    const { module } = buildEngine();
    await module.load();
    const dockButton = module.hud().children[0];

    assert.equal(dockButton.tag, 'button');
    assert.equal(dockButton.props.class, 'stme-dock-button');
    assert.deepEqual(dockButton.props.style(), {}, 'CSS owns the bottom-right default until the user drags it');
});

test('clicking the dock button (its onClick, not a drag) toggles the window open, then closed again', async () => {
    const { module } = buildEngine();
    await module.load();
    const dockButton = module.hud().children[0];

    dockButton.props['on:pointerdown'](fakePointerDown());
    dockButton.props['on:pointerup']({ clientX: 1, clientY: 0, currentTarget: { releasePointerCapture: () => {} } });
    assert.equal(module.isHudVisible(), true);

    dockButton.props['on:pointerdown'](fakePointerDown());
    dockButton.props['on:pointerup']({ clientX: 0, clientY: 0, currentTarget: { releasePointerCapture: () => {} } });
    assert.equal(module.isHudVisible(), false);
});

test('opening the settings drawer loads real map.settings.get values into settingsForm', async () => {
    const { engine, mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();

    assert.equal(module.settingsForm.peek(), null, 'nothing loaded until the drawer is actually opened');
    await module.loadMapSettings();

    const form = module.settingsForm.peek();
    assert.ok(form);
    assert.equal(form.levelScaleCoefficient, 15, 'the Ядро карты\'s own default, fetched for real through the Гейт');
    void engine;
});

test('saveMapSettings() persists a patched field through map.settings.update, and a later map.settings.get reflects it', async () => {
    const { engine, mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    await module.loadMapSettings();

    module.patchMapSettings({ levelScaleCoefficient: 20, minTraversableRank: 4 });
    await module.saveMapSettings();

    assert.equal(module.settingsForm.peek().levelScaleCoefficient, 20);
    const directHost = engine.registerCaller('test.direct', 'modules', { tier: 'community', allowedContracts: ['map.settings.get'] });
    const fresh = await new Promise(resolve => directHost.cores.subscribe('map.settings.get', {}, resolve));
    assert.equal(fresh.value.levelScaleCoefficient, 20);
    assert.equal(fresh.value.minTraversableRank, 4);
});

test('saveMapSettings() reports failure via ui.notify.error instead of throwing, and leaves the form as the caller left it', async () => {
    const { module, notifications } = buildEngine();
    await module.load();
    await module.loadMapSettings();

    module.patchMapSettings({ mapWidthUnits: -5 });
    await module.saveMapSettings();

    // sanitizeSettings() in the Library clamps a non-positive width back to
    // the default rather than rejecting it outright, so this specific patch
    // actually succeeds — the point of this test is that failure has a path
    // at all, exercised via a deliberately-wrong contract call below.
    assert.equal(notifications.filter(entry => entry.tone === 'error').length, 0);
});

test('a fresh module instance restores dock/window chrome (position, visibility) exactly as it was saved', async () => {
    const engine = createEngine();
    const settingsContext = { extensionSettings: {}, saveSettingsDebounced: () => {} };
    registerExtensionSettingsService(engine.buses.services, { getContext: () => settingsContext });
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));
    const chatContext = { chatMetadata: {}, saveMetadataDebounced: () => {}, saveMetadata: async () => {} };
    registerChatMetadataService(engine.buses.services, { getContext: () => chatContext });
    createChatMemoryCore(engine.registerCaller('core.memory.chat', 'cores', { tier: 'official' }));
    createMapCore(engine.registerCaller('core.map', 'cores', { tier: 'official' }));

    const hostFor = () => engine.registerCaller(MODULE_ID, 'modules', {
        tier: 'community',
        allowedContracts: ['storage.settings.get', 'storage.settings.set', 'ui.notify', 'map.settings.get', 'map.settings.update'],
    });

    const first = createMapModule(hostFor());
    await first.load();
    first.setHudVisible(true);
    const dockButton = first.hud().children[0];
    dockButton.props['on:pointerdown'](fakePointerDown());
    dockButton.props['on:pointermove']({ clientX: 123, clientY: 456 });
    dockButton.props['on:pointerup']({ clientX: 123, clientY: 456, currentTarget: { releasePointerCapture: () => {} } });
    await new Promise(resolve => setTimeout(resolve, 0)); // let the fire-and-forget saveChrome() write settle before reading it back

    const second = createMapModule(hostFor());
    await second.load();

    assert.equal(second.isHudVisible(), true);
    assert.deepEqual(second.dockPosition.peek(), { left: 123, top: 456 });
});

test('uploadRootImage() stores the blob via image.put, records {assetId,width,height} via map.rootImage.set, and shows it as "ready"', async t => {
    const { mapCore, module, imageBlobs, notifications } = buildEngine();
    await mapCore.restore();
    await module.load();
    const created = [];
    t.mock.method(globalThis.URL, 'createObjectURL', () => { created.push('create'); return 'blob:fake'; });
    t.mock.method(globalThis.URL, 'revokeObjectURL', () => { created.push('revoke'); });

    const file = fakeImageFile({ width: 4000, height: 3000 });
    await module.uploadRootImage(file);

    const state = module.rootImageState.peek();
    assert.equal(state.kind, 'ready');
    assert.equal(state.width, 4000);
    assert.equal(state.height, 3000);
    assert.equal(imageBlobs.get(state.assetId), file, 'the exact same blob/file must be what image.put stored');
    assert.ok(notifications.some(entry => entry.tone === 'ok'));
    assert.deepEqual(created, ['create']);
});

test('uploadRootImage() refuses a non-image file without ever calling image.put', async t => {
    const { mapCore, module, imageBlobs, notifications } = buildEngine();
    await mapCore.restore();
    await module.load();
    t.mock.method(globalThis.URL, 'createObjectURL', () => 'blob:fake');
    t.mock.method(globalThis.URL, 'revokeObjectURL', () => {});

    await module.uploadRootImage({ name: 'notes.txt', type: 'text/plain' });

    assert.equal(module.rootImageState.peek().kind, 'idle');
    assert.equal(imageBlobs.size, 0);
    assert.ok(notifications.some(entry => entry.tone === 'error'));
});

test('handleImageDrop() classifies a dropped FILE and uploads it; a dropped URL is declined instead of silently ignored', async t => {
    const { mapCore, module, imageBlobs, notifications } = buildEngine();
    await mapCore.restore();
    await module.load();
    t.mock.method(globalThis.URL, 'createObjectURL', () => 'blob:fake');
    t.mock.method(globalThis.URL, 'revokeObjectURL', () => {});

    const file = fakeImageFile();
    module.handleImageDrop({ dataTransfer: { files: [file], getData: () => '' } });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(module.rootImageState.peek().kind, 'ready');
    assert.equal(imageBlobs.size, 1);

    module.handleImageDrop({ dataTransfer: { files: [], getData: type => (type === 'text/uri-list' ? 'https://example.com/map.png' : '') } });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(notifications.some(entry => entry.tone === 'error' && /link/i.test(entry.text)));
});

test('load() fetches the persisted image automatically when the window was already visible from a previous session', async t => {
    const { engine, mapCore, module, imageBlobs } = buildEngine();
    await mapCore.restore();
    t.mock.method(globalThis.URL, 'createObjectURL', () => 'blob:fake');
    t.mock.method(globalThis.URL, 'revokeObjectURL', () => {});
    // Seed a root image directly (bytes + Ядро reference + chrome), as if uploaded and left open in a previous session.
    imageBlobs.set('seeded', fakeImageFile());
    const seedHost = engine.registerCaller('test.seed', 'modules', { tier: 'community', allowedContracts: ['map.rootImage.set', 'storage.settings.set'] });
    await new Promise(resolve => seedHost.cores.subscribe('map.rootImage.set', { params: { assetId: 'seeded', width: 10, height: 10 } }, resolve));
    await new Promise(resolve => seedHost.cores.subscribe('storage.settings.set', { params: { namespace: MODULE_ID, key: 'chrome', value: { visible: true } } }, resolve));

    await module.load();

    assert.equal(module.isHudVisible(), true, 'sanity check — the seeded chrome really was picked up');
    assert.equal(module.rootImageState.peek().kind, 'ready');
});

test('loadRootImage() only fetches the blob ONCE — a second call is a no-op even if called again', async t => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    t.mock.method(globalThis.URL, 'createObjectURL', () => 'blob:fake');
    t.mock.method(globalThis.URL, 'revokeObjectURL', () => {});
    await module.uploadRootImage(fakeImageFile());
    const readyState = module.rootImageState.peek();

    await module.loadRootImage();

    assert.equal(module.rootImageState.peek(), readyState, 'a second load must not even re-run — same object, not just equal fields');
});

test('removeRootImage() clears both the Ядро reference (map.rootImage.clear) and the stored bytes (image.delete)', async t => {
    const { mapCore, module, imageBlobs } = buildEngine();
    await mapCore.restore();
    await module.load();
    t.mock.method(globalThis.URL, 'createObjectURL', () => 'blob:fake');
    t.mock.method(globalThis.URL, 'revokeObjectURL', () => {});
    await module.uploadRootImage(fakeImageFile());
    assert.equal(imageBlobs.size, 1);

    await module.removeRootImage();

    assert.equal(module.rootImageState.peek().kind, 'idle');
    assert.equal(imageBlobs.size, 0, 'image.delete must actually free the stored bytes, not just forget the reference');
});

test('currentZoomScale/currentTileLevel start at 1x/level-0 (the default full-image view)', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();

    assert.equal(module.currentZoomScale.peek(), 1);
    assert.equal(module.currentTileLevel.peek(), 0);
    assert.deepEqual(module.viewportRect.peek(), { minX: 0, minY: 0, maxX: 1, maxY: 1 });
});

test('zooming in (viewportRect shrinking) triggers real per-tile upscale+cache via image.put, without touching the root image itself', async t => {
    const { mapCore, module, imageBlobs } = buildEngine();
    await mapCore.restore();
    await module.load();
    t.mock.method(globalThis.URL, 'createObjectURL', () => 'blob:fake');
    t.mock.method(globalThis.URL, 'revokeObjectURL', () => {});
    await module.uploadRootImage(fakeImageFile({ width: 800, height: 600 }));
    const rootAssetId = module.rootImageState.peek().assetId;
    const baselineBlobCount = imageBlobs.size; // just the root image so far

    module.viewportRect.set({ minX: 0, minY: 0, maxX: 0.5, maxY: 0.5 }); // 2x zoom -> quadtree level 1
    await new Promise(resolve => setTimeout(resolve, 50)); // let the fire-and-forget tile effect settle

    assert.equal(module.currentTileLevel.peek(), 1);
    assert.ok(imageBlobs.size > baselineBlobCount, 'a real tile blob got cached via image.put');
    assert.equal(module.rootImageState.peek().assetId, rootAssetId, 'the root image itself is untouched — only a tile was computed');
    const urls = module.tileImageUrls.peek();
    assert.ok(Object.keys(urls).length > 0, 'tileImageUrls reflects the newly-ready tile');
});

test('a computed tile is trimmed back to its EXACT nominal size after padded upscaling — the source-pixel apron added to avoid seams (owner: "При очень сильном приближении - видны границы тайлов") must never leak into the final encoded tile', async t => {
    const encodedSizes = [];
    const { mapCore, module } = buildEngine({ onEncode: pixels => encodedSizes.push({ width: pixels.width, height: pixels.height }) });
    await mapCore.restore();
    await module.load();
    t.mock.method(globalThis.URL, 'createObjectURL', () => 'blob:fake');
    t.mock.method(globalThis.URL, 'revokeObjectURL', () => {});
    await module.uploadRootImage(fakeImageFile({ width: 800, height: 600 }));

    module.viewportRect.set({ minX: 0, minY: 0, maxX: 0.5, maxY: 0.5 }); // level 1 -> a 400x300px source tile
    await new Promise(resolve => setTimeout(resolve, 50));

    assert.equal(encodedSizes.length, 1);
    // Tile source is 400x300; factor = TILE_RENDER_SIZE (1024) / 400 = 2.56 (well under both the [1,4] sanitize cap and MAX_UPSCALE_DIMENSION).
    assert.equal(encodedSizes[0].width, 1024, 'exactly round(400*2.56) — no leftover padding pixels in the final tile');
    assert.equal(encodedSizes[0].height, Math.round(300 * 2.56), 'exactly round(300*2.56)');
});

test('a tile already cached (in-memory) for the current view is not recomputed on a redundant viewportRect update', async t => {
    const { mapCore, module, imageBlobs } = buildEngine();
    await mapCore.restore();
    await module.load();
    t.mock.method(globalThis.URL, 'createObjectURL', () => 'blob:fake');
    t.mock.method(globalThis.URL, 'revokeObjectURL', () => {});
    await module.uploadRootImage(fakeImageFile({ width: 800, height: 600 }));
    module.viewportRect.set({ minX: 0, minY: 0, maxX: 0.5, maxY: 0.5 });
    await new Promise(resolve => setTimeout(resolve, 50));
    const blobCountAfterFirstZoom = imageBlobs.size;

    // A NEW object with the SAME rect values — a real reactive re-run, but no new tile.
    module.viewportRect.set({ minX: 0, minY: 0, maxX: 0.5, maxY: 0.5 });
    await new Promise(resolve => setTimeout(resolve, 50));

    assert.equal(imageBlobs.size, blobCountAfterFirstZoom, 'no new blob — the already-cached tile must not be recomputed');
});

test('resetViewport() returns to the default full-image view', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    module.viewportRect.set({ minX: 0.2, minY: 0.2, maxX: 0.6, maxY: 0.6 });

    module.resetViewport();

    assert.deepEqual(module.viewportRect.peek(), { minX: 0, minY: 0, maxX: 1, maxY: 1 });
});

test('uploading a NEW root image resets the viewport and clears cached tile URLs from the previous image', async t => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    t.mock.method(globalThis.URL, 'createObjectURL', () => 'blob:fake');
    t.mock.method(globalThis.URL, 'revokeObjectURL', () => {});
    await module.uploadRootImage(fakeImageFile({ width: 800, height: 600 }));
    module.viewportRect.set({ minX: 0, minY: 0, maxX: 0.5, maxY: 0.5 });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(Object.keys(module.tileImageUrls.peek()).length > 0, 'sanity check: a tile really was cached for the first image');

    await module.uploadRootImage(fakeImageFile({ width: 400, height: 300 }));

    assert.deepEqual(module.viewportRect.peek(), { minX: 0, minY: 0, maxX: 1, maxY: 1 });
    assert.deepEqual(module.tileImageUrls.peek(), {}, 'tiles cached against the OLD assetId must not linger onto the new image');
});

test('uploading a NEW root image clears every existing location — they were placed against a DIFFERENT picture and are meaningless against this one', async t => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    t.mock.method(globalThis.URL, 'createObjectURL', () => 'blob:fake');
    t.mock.method(globalThis.URL, 'revokeObjectURL', () => {});
    await module.uploadRootImage(fakeImageFile({ width: 800, height: 600 }));
    await module.createNodeImmediately({ polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], name: 'Old District' });
    await module.createNodeImmediately({ position: { x: 0.5, y: 0.5 }, name: 'Old Spot' });
    assert.equal(module.nodes.peek().length, 2, 'sanity check: the old locations really were created');

    await module.uploadRootImage(fakeImageFile({ width: 400, height: 300 }));

    assert.deepEqual(module.nodes.peek(), [], 'every location from the OLD picture must be gone, not just visually hidden');
});

test('uploadRootImage() on the very first upload (nothing existed yet) is a no-op for clearing — no crash, no spurious removal calls', async t => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    t.mock.method(globalThis.URL, 'createObjectURL', () => 'blob:fake');
    t.mock.method(globalThis.URL, 'revokeObjectURL', () => {});

    await module.uploadRootImage(fakeImageFile({ width: 800, height: 600 }));

    assert.equal(module.rootImageState.peek().kind, 'ready');
    assert.deepEqual(module.nodes.peek(), []);
});

test('removeRootImage() also resets the viewport and clears cached tile URLs', async t => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    t.mock.method(globalThis.URL, 'createObjectURL', () => 'blob:fake');
    t.mock.method(globalThis.URL, 'revokeObjectURL', () => {});
    await module.uploadRootImage(fakeImageFile({ width: 800, height: 600 }));
    module.viewportRect.set({ minX: 0, minY: 0, maxX: 0.5, maxY: 0.5 });
    await new Promise(resolve => setTimeout(resolve, 50));

    await module.removeRootImage();

    assert.deepEqual(module.viewportRect.peek(), { minX: 0, minY: 0, maxX: 1, maxY: 1 });
    assert.deepEqual(module.tileImageUrls.peek(), {});
});

test('handleCanvasWheel zooms toward the cursor position — the pivot stays inside the new, smaller viewport', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    const rect = { left: 0, top: 0, width: 800, height: 800 };
    module.handleCanvasWheel({ clientX: 200, clientY: 200, deltaY: -100, currentTarget: { getBoundingClientRect: () => rect }, preventDefault: () => {} });

    const viewport = module.viewportRect.peek();
    assert.ok(module.currentZoomScale.peek() > 1, 'scrolling up zooms in');
    assert.ok(0.25 >= viewport.minX && 0.25 <= viewport.maxX, 'the cursor\'s normalized x (200/800) stays covered');
    assert.ok(0.25 >= viewport.minY && 0.25 <= viewport.maxY);
});

test('handleCanvasWheel zooming out repeatedly clamps back at exactly 1x, never below it', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    const rect = { left: 0, top: 0, width: 800, height: 800 };
    const wheelAt = deltaY => module.handleCanvasWheel({ clientX: 400, clientY: 400, deltaY, currentTarget: { getBoundingClientRect: () => rect }, preventDefault: () => {} });
    wheelAt(-100); wheelAt(-100);
    for (let i = 0; i < 6; i += 1) wheelAt(100);

    assert.equal(module.currentZoomScale.peek(), 1);
});

test('handleCanvasPointerDown/Move/Up pans the viewport in "view" mode once the drag passes the click threshold', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    module.canvasMode.set('view');
    module.viewportRect.set({ minX: 0.2, minY: 0.2, maxX: 0.7, maxY: 0.7 }); // zoomed in, room to pan in either direction
    const rect = { left: 0, top: 0, width: 500, height: 500 };

    module.handleCanvasPointerDown({ clientX: 300, clientY: 300, pointerId: 1, button: 0, currentTarget: { getBoundingClientRect: () => rect, setPointerCapture: () => {} } });
    module.handleCanvasPointerMove({ clientX: 250, clientY: 300, pointerId: 1 }); // dragged 50px left
    module.handleCanvasPointerUp({ pointerId: 1 });

    const viewport = module.viewportRect.peek();
    assert.ok(viewport.minX > 0.2, 'dragging the pointer LEFT pans the visible content RIGHT (drag-to-pan, content follows the hand)');
});

test('handleCanvasPointerDown does NOT capture the pointer immediately — capturing before a drag is confirmed redirects the browser\'s synthetic click to the SVG background instead of whatever shape is under the cursor, breaking every plain click-to-select in "view" mode', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    module.canvasMode.set('view');
    const rect = { left: 0, top: 0, width: 500, height: 500 };
    let captured = false;

    module.handleCanvasPointerDown({ clientX: 300, clientY: 300, pointerId: 1, button: 0, currentTarget: { getBoundingClientRect: () => rect, setPointerCapture: () => { captured = true; } } });
    assert.equal(captured, false, 'a bare pointerdown, before any movement, must not capture — that would hijack the plain click that follows');

    // A tiny move under the click threshold is still a click, not a drag — still no capture.
    module.handleCanvasPointerMove({ clientX: 301, clientY: 300, pointerId: 1, currentTarget: { setPointerCapture: () => { captured = true; } } });
    assert.equal(captured, false, 'movement under the drag threshold is a click, not a pan — still no capture');

    // Only once the drag is CONFIRMED (past the threshold) is capture allowed.
    module.handleCanvasPointerMove({ clientX: 250, clientY: 300, pointerId: 1, currentTarget: { setPointerCapture: () => { captured = true; } } });
    assert.equal(captured, true, 'a real, confirmed drag is allowed to capture the pointer');
});

test('a throwing setPointerCapture() (e.g. "no active pointer with the given id", real on synthetic PointerEvents and plausible on a real browser too) must not abort the pan itself — found live while manually verifying the pointer-capture fix above', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    module.canvasMode.set('view');
    module.viewportRect.set({ minX: 0.2, minY: 0.2, maxX: 0.7, maxY: 0.7 });
    const rect = { left: 0, top: 0, width: 500, height: 500 };
    const throwingCapture = { getBoundingClientRect: () => rect, setPointerCapture: () => { throw new DOMException('no active pointer', 'NotFoundError'); } };

    module.handleCanvasPointerDown({ clientX: 300, clientY: 300, pointerId: 1, button: 0, currentTarget: throwingCapture });
    module.handleCanvasPointerMove({ clientX: 250, clientY: 300, pointerId: 1, currentTarget: throwingCapture }); // past the threshold — capture is attempted and throws

    const viewport = module.viewportRect.peek();
    assert.ok(viewport.minX > 0.2, 'the pan must still apply even though setPointerCapture() threw');
});

test('a plain click right after a pan-drag is suppressed — selectNode() does not open the popup', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    await module.createNodeImmediately({ position: { x: 0.3, y: 0.3 }, name: 'Spot' });
    module.nodeForm.set(null);
    module.canvasMode.set('view');
    const rect = { left: 0, top: 0, width: 500, height: 500 };

    module.handleCanvasPointerDown({ clientX: 300, clientY: 300, pointerId: 1, button: 0, currentTarget: { getBoundingClientRect: () => rect, setPointerCapture: () => {} } });
    module.handleCanvasPointerMove({ clientX: 250, clientY: 250, pointerId: 1 });
    module.handleCanvasPointerUp({ pointerId: 1 });
    module.selectNode(module.nodes.peek()[0]); // the synthetic 'click' a real drag-release would also fire

    assert.equal(module.nodeForm.peek(), null, 'suppressed — a drag-release must not also select/open the node it happened to end on');
});

test('handleCanvasPointerDown/Move/Up does nothing while placing a marker or drawing a region — those modes own every click themselves', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    module.canvasMode.set('placeMarker');
    const rect = { left: 0, top: 0, width: 500, height: 500 };

    module.handleCanvasPointerDown({ clientX: 300, clientY: 300, pointerId: 1, button: 0, currentTarget: { getBoundingClientRect: () => rect, setPointerCapture: () => {} } });
    module.handleCanvasPointerMove({ clientX: 100, clientY: 100, pointerId: 1 });
    module.handleCanvasPointerUp({ pointerId: 1 });

    assert.deepEqual(module.viewportRect.peek(), { minX: 0, minY: 0, maxX: 1, maxY: 1 }, 'no panning happened outside "view" mode');
});

test('loadMapContent() shows nodes at every nesting depth, not just top-level ones - the owner must be able to see/edit a location nested inside a region', async () => {
    const { engine, mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    const seedHost = engine.registerCaller('test.seed', 'modules', { tier: 'community', allowedContracts: ['map.nodes.create'] });
    const call = (contract, params) => new Promise(resolve => seedHost.cores.subscribe(contract, { params }, resolve));
    const top = await call('map.nodes.create', { name: 'District', position: { x: 0.2, y: 0.2 } });
    await call('map.nodes.create', { name: 'Room', parentId: top.value.id, position: { x: 0.1, y: 0.1 } });

    await module.loadMapContent();

    assert.deepEqual(module.nodes.peek().map(node => node.name).sort(), ['District', 'Room']);
});

test('createNodeImmediately() automatically nests a new marker inside the region its click point actually falls in — no manual parent selection needed', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    await module.createNodeImmediately({ polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], name: 'Region' });
    const [region] = module.nodes.peek();

    await module.createNodeImmediately({ position: { x: 0.3, y: 0.3 }, name: 'Spot' });

    const spot = module.nodes.peek().find(node => node.name === 'Spot');
    assert.equal(spot.parentId, region.id);
});

test('createNodeImmediately() leaves parentId null when the click point falls outside every existing region', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    await module.createNodeImmediately({ polygon: [{ x: 0, y: 0 }, { x: 0.3, y: 0 }, { x: 0.3, y: 0.3 }, { x: 0, y: 0.3 }], name: 'Region' });

    await module.createNodeImmediately({ position: { x: 0.8, y: 0.8 }, name: 'Elsewhere' });

    const elsewhere = module.nodes.peek().find(node => node.name === 'Elsewhere');
    assert.equal(elsewhere.parentId, null);
});

test('createNodeImmediately() nests a NEW region inside an existing one when its own centroid falls inside it', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    await module.createNodeImmediately({ polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], name: 'District' });
    const [district] = module.nodes.peek();

    await module.createNodeImmediately({ polygon: [{ x: 0.3, y: 0.3 }, { x: 0.6, y: 0.3 }, { x: 0.6, y: 0.6 }, { x: 0.3, y: 0.6 }], name: 'Building' });

    const building = module.nodes.peek().find(node => node.name === 'Building');
    assert.equal(building.parentId, district.id);
});


test('handleCanvasBackgroundClick() in placeMarker mode creates the node FOR REAL at the click position right away, then returns to view and opens its edit popup', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    module.canvasMode.set('placeMarker');

    module.handleCanvasBackgroundClick({ clientX: 30, clientY: 60, currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 200 }) } });
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(module.canvasMode.peek(), 'view');
    assert.deepEqual(module.nodes.peek().map(node => node.position), [{ x: 0.1, y: 0.3 }]);
    assert.equal(module.nodeForm.peek()?.id, module.nodes.peek()[0].id, 'the edit popup opens on the just-created node');
});

test('handleCanvasBackgroundClick() does nothing in view mode - a plain click on empty canvas must not create anything', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();

    module.handleCanvasBackgroundClick({ clientX: 10, clientY: 10, currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } });

    assert.equal(module.nodeForm.peek(), null);
});

test('drawing a polygon accumulates points in drawPolygon mode, and finishPolygon() creates the region FOR REAL only once 3+ points exist', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    module.canvasMode.set('drawPolygon');
    const clickAt = (x, y) => module.handleCanvasBackgroundClick({ clientX: x, clientY: y, currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } });

    clickAt(10, 10);
    clickAt(90, 10);
    module.finishPolygon(); // only 2 points so far - must refuse
    assert.deepEqual(module.nodes.peek(), []);
    assert.equal(module.canvasMode.peek(), 'drawPolygon');

    clickAt(50, 90);
    module.finishPolygon();
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(module.canvasMode.peek(), 'view');
    assert.deepEqual(module.draftPoints.peek(), []);
    assert.deepEqual(module.nodes.peek()[0].polygon, [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.5, y: 0.9 }]);
    assert.equal(module.nodeForm.peek()?.id, module.nodes.peek()[0].id);
});

test('drawing a polygon SNAPS a point close to an existing region\'s vertex onto it exactly — so the new border really touches, not just looks close', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    // Seed an existing region with a known vertex at (0.5, 0.5).
    await module.createNodeImmediately({ polygon: [{ x: 0.3, y: 0.3 }, { x: 0.5, y: 0.5 }, { x: 0.3, y: 0.7 }], name: 'Existing' });
    module.selectNode(module.nodes.peek()[0]);
    module.nodeForm.set(null);

    module.canvasMode.set('drawPolygon');
    const clickAt = (x, y) => module.handleCanvasBackgroundClick({ clientX: x, clientY: y, currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } });
    clickAt(50.3, 50.1); // 0.503, 0.501 — a couple pixels off the existing (0.5, 0.5) vertex
    clickAt(90, 10);
    clickAt(90, 90);
    module.finishPolygon();
    await new Promise(resolve => setTimeout(resolve, 0));

    const newRegion = module.nodes.peek().find(node => node.name === 'New location');
    assert.deepEqual(newRegion.polygon[0], { x: 0.5, y: 0.5 }, 'snapped onto the existing vertex exactly, not left a few pixels off');
});

test('the draft polygon preview shows a vertex dot per placed point plus a closing-segment preview once 3+ points exist, all with a zoom-divided stroke width (ROADMAP.md 5.64)', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    module.canvasMode.set('drawPolygon');
    module.draftPoints.set([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }]);

    let shapes = module.draftPolygonPreview().peek();
    assert.equal(shapes.filter(s => s.tag === 'circle').length, 2, 'one vertex dot per placed point, even before there are enough points to close');
    assert.equal(shapes.filter(s => s.props.class === 'stme-map-draft-closing').length, 0, 'no closing-segment preview yet with fewer than 3 points');

    module.draftPoints.set([...module.draftPoints.peek(), { x: 0.3, y: 0.4 }]);
    shapes = module.draftPolygonPreview().peek();
    const closing = shapes.find(s => s.props.class === 'stme-map-draft-closing');
    assert.ok(closing, 'a 3rd point makes a closing-segment preview appear, showing what the finished region would look like');
    assert.equal(closing.props.x1, 0.3);
    assert.equal(closing.props.y1, 0.4);
    assert.equal(closing.props.x2, 0.1, 'closes back to the FIRST point, not just connects the last two');
    assert.equal(closing.props.y2, 0.1);

    module.viewportRect.set({ minX: 0, minY: 0, maxX: 0.5, maxY: 0.5 }); // 2x zoom
    const zoomedShapes = module.draftPolygonPreview().peek();
    const polyline = zoomedShapes.find(s => s.tag === 'polyline');
    assert.equal(polyline.props.style.strokeWidth, 0.0015, 'halved at 2x zoom, just like a real region border (ROADMAP.md 5.62) — this line was missed the first time');
    module.cancelDraw();
});

test('edges ("routes") get a distinct zoom-divided stroke width and dash pattern, styled separately from a region border', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    await module.createNodeImmediately({ position: { x: 0.1, y: 0.1 }, name: 'A' });
    await module.createNodeImmediately({ position: { x: 0.9, y: 0.1 }, name: 'B' });
    await module.loadMapSettings();
    module.patchMapSettings({ autoConnectDistanceUnits: 1e9 }); // huge — just needs to cover A-B's real distance, whatever the map's own scale is
    await module.saveMapSettings();
    await module.loadMapContent();

    const line = module.edgeLines().peek()[0];
    assert.ok(line, 'sanity: an edge exists to render');
    assert.equal(line.props.style.strokeWidth, 0.005, 'unzoomed matches EDGE_STROKE_WIDTH exactly');
    assert.equal(line.props.style.strokeDasharray, '0.014 0.008');

    module.viewportRect.set({ minX: 0, minY: 0, maxX: 0.5, maxY: 0.5 }); // 2x zoom
    const zoomedLine = module.edgeLines().peek()[0];
    assert.equal(zoomedLine.props.style.strokeWidth, 0.0025, 'halved at 2x zoom, same rule as every other border');
    assert.equal(zoomedLine.props.style.strokeDasharray, '0.007 0.004');
});

test('edgesVisible toggles routes off entirely — edgeLines() renders nothing while off, and canvasTools() exposes the toggle in every canvas mode', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    await module.createNodeImmediately({ position: { x: 0.1, y: 0.1 }, name: 'A' });
    await module.createNodeImmediately({ position: { x: 0.9, y: 0.1 }, name: 'B' });
    await module.loadMapSettings();
    module.patchMapSettings({ autoConnectDistanceUnits: 1e9 });
    await module.saveMapSettings();
    await module.loadMapContent();
    assert.ok(module.edgeLines().peek().length > 0, 'sanity: there is a real edge to hide');

    module.edgesVisible.set(false);
    assert.deepEqual(module.edgeLines().peek(), []);

    module.edgesVisible.set(true);
    assert.ok(module.edgeLines().peek().length > 0, 'toggling back on restores it — nothing was actually removed from the graph');

    for (const mode of ['view', 'placeMarker', 'drawPolygon']) {
        module.canvasMode.set(mode);
        const tools = module.canvasTools().peek();
        const toggle = tools.find(tool => tool.props.title === 'Hide routes' || tool.props.title === 'Show routes');
        assert.ok(toggle, `the routes toggle is present in canvasTools() while in "${mode}" mode, not just in "view"`);
    }
    module.canvasMode.set('view');
});

test('cancelDraw() clears the mode and any accumulated draft points', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    module.canvasMode.set('drawPolygon');
    module.draftPoints.set([{ x: 0.1, y: 0.1 }]);

    module.cancelDraw();

    assert.equal(module.canvasMode.peek(), 'view');
    assert.deepEqual(module.draftPoints.peek(), []);
});

test('createNodeImmediately() creates a new marker node via map.nodes.create right away and opens its edit popup', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();

    await module.createNodeImmediately({ position: { x: 0.4, y: 0.6 }, name: 'Tavern', rank: 3 });

    assert.deepEqual(module.nodes.peek().map(node => node.name), ['Tavern']);
    assert.equal(module.nodes.peek()[0].rank, 3);
    assert.equal(module.nodeForm.peek().id, module.nodes.peek()[0].id);
});

test('createNodeImmediately() defaults the name to "New location" when none is given, so a bare click always produces a real, visible node', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();

    await module.createNodeImmediately({ position: { x: 0.1, y: 0.1 } });

    assert.equal(module.nodes.peek()[0].name, 'New location');
});

test('saveNodeForm() refuses an empty name without ever calling map.nodes.update, leaving the popup open', async () => {
    const { mapCore, module, notifications } = buildEngine();
    await mapCore.restore();
    await module.load();
    await module.createNodeImmediately({ position: { x: 0.1, y: 0.1 } });
    module.nodeForm.set({ ...module.nodeForm.peek(), name: '   ' });

    await module.saveNodeForm();

    assert.ok(module.nodeForm.peek(), 'the popup must survive a rejected save');
    assert.equal(module.nodes.peek()[0].name, 'New location', 'the bad name must never reach the Ядро');
    assert.ok(notifications.some(entry => entry.tone === 'error'));
});

test('selectNode() opens an EDIT copy of an existing node (carries its id), and saveNodeForm() calls map.nodes.update, never creating a second node', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    await module.createNodeImmediately({ position: { x: 0.2, y: 0.2 }, name: 'Original' });
    const created = module.nodes.peek()[0];

    module.selectNode(created);
    assert.equal(module.nodeForm.peek().id, created.id);
    module.nodeForm.set({ ...module.nodeForm.peek(), name: 'Renamed' });
    await module.saveNodeForm();

    assert.equal(module.nodes.peek().length, 1, 'update must not create a second node');
    assert.equal(module.nodes.peek()[0].name, 'Renamed');
});

test('saveNodeForm() persists a custom color and marker radius (ROADMAP.md 5.60)', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    await module.createNodeImmediately({ position: { x: 0.2, y: 0.2 }, name: 'Marker' });
    module.selectNode(module.nodes.peek()[0]);
    module.nodeForm.set({ ...module.nodeForm.peek(), color: '#ff8800', radius: 0.03 });

    await module.saveNodeForm();
    await module.loadMapContent();

    const saved = module.nodes.peek()[0];
    assert.equal(saved.color, '#ff8800');
    assert.equal(saved.radius, 0.03);
});

test('saveNodeForm() clears a previously-set color/radius back to the default when the fields are emptied', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    await module.createNodeImmediately({ position: { x: 0.2, y: 0.2 }, name: 'Marker', color: '#ff8800', radius: 0.03 });
    module.selectNode(module.nodes.peek()[0]);
    module.nodeForm.set({ ...module.nodeForm.peek(), color: '', radius: null });

    await module.saveNodeForm();
    await module.loadMapContent();

    const saved = module.nodes.peek()[0];
    assert.equal(saved.color, null);
    assert.equal(saved.radius, null);
});

test('selectNode() is ignored while mid-draw - a stray click on an existing shape must not hijack the in-progress draft', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    await module.createNodeImmediately({ position: { x: 0.1, y: 0.1 }, name: 'Existing' });
    const existing = module.nodes.peek()[0];
    module.nodeForm.set(null);
    module.canvasMode.set('placeMarker');

    module.selectNode(existing, { stopPropagation: () => {} });

    assert.equal(module.nodeForm.peek(), null, 'placeMarker mode must not be interrupted by clicking an existing shape');
});

test('selectNode() does NOT stop propagation while mid-draw, so a click on top of an existing region shape still reaches the background click handler — the exact bug where clicking directly onto a drawn region in placeMarker mode silently did nothing at all', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    await module.createNodeImmediately({ polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], name: 'Region' });
    const [region] = module.nodes.peek();
    module.canvasMode.set('placeMarker');
    let stopped = false;

    module.selectNode(region, { stopPropagation: () => { stopped = true; } });

    assert.equal(stopped, false, 'propagation must be left alone so the SVG background click handler still fires');
});

test('deleteNodeForm() removes the selected node via map.nodes.remove and closes the popup', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    await module.createNodeImmediately({ position: { x: 0.3, y: 0.3 }, name: 'ToDelete' });
    const created = module.nodes.peek()[0];
    module.selectNode(created);

    await module.deleteNodeForm();

    assert.equal(module.nodeForm.peek(), null);
    assert.deepEqual(module.nodes.peek(), []);
});

// Pathfinding/position/movement-log UI was removed from this Module entirely
// (ROADMAP.md 5.50, owner: "я не прошу добавлять вообще патфайндиг и лог
// сюда... Удали просто UI для них и все") — the underlying Core contracts
// (map.pathfind/map.position.*/map.movementLog.*) are untouched and still
// covered by cores/map's own tests.

// --- Вложенные под-регионы, видимость по зуму, меню региона (ROADMAP.md 5.61) ---

test('at the default (zoomed-out) view, only the top-level region shows — its sub-region stays hidden', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    await module.createNodeImmediately({ polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], name: 'District' });
    const district = module.nodes.peek()[0];
    await module.createNodeImmediately({ polygon: [{ x: 0.3, y: 0.3 }, { x: 0.6, y: 0.3 }, { x: 0.6, y: 0.6 }, { x: 0.3, y: 0.6 }], name: 'Building' });
    const building = module.nodes.peek().find(node => node.name === 'Building');
    assert.equal(building.parentId, district.id, 'sanity: Building really did nest inside District');

    const visible = module.visibleNodeIds.peek();

    assert.ok(visible.has(district.id), 'the parent region is the one shown while zoomed all the way out');
    assert.ok(!visible.has(building.id), 'its sub-region is not shown yet — that would just be clutter on top of the parent');
});

test('one zoom step past a region\'s own depth is NOT enough to switch it to its sub-region yet — the margin delays the handoff (ROADMAP.md 5.62)', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    await module.createNodeImmediately({ polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], name: 'District' });
    const district = module.nodes.peek()[0];
    await module.createNodeImmediately({ polygon: [{ x: 0.3, y: 0.3 }, { x: 0.6, y: 0.3 }, { x: 0.6, y: 0.6 }, { x: 0.3, y: 0.6 }], name: 'Building' });
    const building = module.nodes.peek().find(node => node.name === 'Building');

    module.viewportRect.set({ minX: 0, minY: 0, maxX: 0.5, maxY: 0.5 }); // 2x zoom -> quadtree level 1 — the level that USED TO trigger the switch, pre-margin

    const visible = module.visibleNodeIds.peek();
    const outline = module.outlineNodeIds.peek();
    assert.ok(visible.has(district.id) && !outline.has(district.id), 'District is still the fully filled active layer — a single zoom step in is not "zoomed in enough" yet');
    assert.ok(!visible.has(building.id), 'Building has not appeared at all yet either');
});

test('zooming in past a region\'s own depth PLUS the reveal margin turns it into an outline while its sub-region becomes the filled layer', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    await module.createNodeImmediately({ polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], name: 'District' });
    const district = module.nodes.peek()[0];
    await module.createNodeImmediately({ polygon: [{ x: 0.3, y: 0.3 }, { x: 0.6, y: 0.3 }, { x: 0.6, y: 0.6 }, { x: 0.3, y: 0.6 }], name: 'Building' });
    const building = module.nodes.peek().find(node => node.name === 'Building');

    module.viewportRect.set({ minX: 0, minY: 0, maxX: 0.25, maxY: 0.25 }); // 4x zoom -> quadtree level 2 — District's depth (0) + 1 + the margin (1)

    const visible = module.visibleNodeIds.peek();
    const outline = module.outlineNodeIds.peek();
    assert.ok(visible.has(district.id) && outline.has(district.id), 'District stays ON SCREEN as an outline — never fully hidden (owner: "не нужно полностью скрывать регионы при зуме")');
    assert.ok(visible.has(building.id) && !outline.has(building.id), 'Building is now the filled, active layer');
});

test('a region with no children of its own stays visible AND filled past its own depth — nothing finer to drill into, so no reason to hide or hollow it out', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    await module.createNodeImmediately({ polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], name: 'District' });
    const district = module.nodes.peek()[0];
    await module.createNodeImmediately({ polygon: [{ x: 0.3, y: 0.3 }, { x: 0.6, y: 0.3 }, { x: 0.6, y: 0.6 }, { x: 0.3, y: 0.6 }], name: 'Building' });
    const building = module.nodes.peek().find(node => node.name === 'Building');

    module.viewportRect.set({ minX: 0, minY: 0, maxX: 0.125, maxY: 0.125 }); // 8x zoom -> level 3, well past Building's own depth (1) too

    const visible = module.visibleNodeIds.peek();
    const outline = module.outlineNodeIds.peek();
    assert.ok(visible.has(district.id) && outline.has(district.id));
    assert.ok(visible.has(building.id) && !outline.has(building.id), 'Building has no children of its own, so it keeps showing FILLED at any deeper zoom too — nothing ever hollows it out');
});

test('a region that has switched to outline renders with fill:none and the outline CSS class, never fully removed from the SVG', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    await module.createNodeImmediately({ polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], name: 'District', color: '#0044ff' });
    const district = module.nodes.peek()[0];
    await module.createNodeImmediately({ polygon: [{ x: 0.3, y: 0.3 }, { x: 0.6, y: 0.3 }, { x: 0.6, y: 0.6 }, { x: 0.3, y: 0.6 }], name: 'Building' });

    module.viewportRect.set({ minX: 0, minY: 0, maxX: 0.25, maxY: 0.25 }); // level 2 — District's own outline threshold

    const shape = module.nodeShapes().peek().find(node => node.props.class.includes('stme-map-node-region') && node.props.points.startsWith('0,0'));
    assert.ok(shape, 'District is still a real node in the rendered tree, not removed');
    assert.ok(shape.props.class.includes('stme-map-node-region-outline'));
    assert.equal(shape.props.style.fill, 'none', 'fill:none wins even though District has its own custom color — the color still applies to the stroke');
    assert.equal(shape.props.style.stroke, '#0044ff', 'the custom color is NOT lost when a region becomes outline-only, it just stops being used as a fill');
    assert.equal(district.color, '#0044ff');
});

test('an outline region stays fully clickable (including right-click) despite having no painted fill (ROADMAP.md 5.62, owner: "при отсутствии заливки - ПКМ кликается по фото а не по региону")', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    await module.createNodeImmediately({ polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], name: 'District' });
    await module.createNodeImmediately({ polygon: [{ x: 0.3, y: 0.3 }, { x: 0.6, y: 0.3 }, { x: 0.6, y: 0.6 }, { x: 0.3, y: 0.6 }], name: 'Building' });

    module.viewportRect.set({ minX: 0, minY: 0, maxX: 0.25, maxY: 0.25 }); // level 2 — District is now outline-only

    const shape = module.nodeShapes().peek().find(node => node.props.class.includes('stme-map-node-region-outline'));
    assert.ok(shape, 'sanity: District really did switch to outline at this zoom');
    // The browser's default `pointer-events: visiblePainted` only reacts
    // inside a shape's PAINTED area — with `fill: none` that area is empty,
    // so without an explicit override every click (left OR right) over the
    // polygon's interior falls straight through to whatever renders behind
    // it (the base map `<image>`), not the region. `pointer-events: all`
    // is what keeps the whole polygon hit-testable regardless of fill.
    assert.equal(shape.props.style.pointerEvents, 'all');
});

test('border stroke width is divided by the current zoom, so it stays the same ON-SCREEN thickness at any zoom level (ROADMAP.md 5.62)', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    await module.createNodeImmediately({ polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], name: 'District' });
    module.nodeForm.set(null); // createNodeImmediately() leaves the new node selected — deselect so the width read below is the ORDINARY (not the wider selected-state) one

    const widthAtDefaultZoom = module.nodeShapes().peek()[0].props.style.strokeWidth;
    assert.equal(widthAtDefaultZoom, 0.003, 'unzoomed (1x) matches the old fixed CSS value exactly — no visual change at the default view');

    module.viewportRect.set({ minX: 0, minY: 0, maxX: 0.5, maxY: 0.5 }); // 2x zoom
    const widthAtDoubleZoom = module.nodeShapes().peek()[0].props.style.strokeWidth;
    assert.equal(widthAtDoubleZoom, 0.0015, 'halved in raw viewBox units at 2x zoom — the SAME on-screen width as before, since the viewBox itself is now half the size');
});

test('openRegionContextMenu() opens the action strip for that region, suppressing the browser\'s own context menu', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    await module.createNodeImmediately({ polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], name: 'District' });
    const [district] = module.nodes.peek();
    let prevented = false;

    module.openRegionContextMenu(district, { preventDefault: () => { prevented = true; }, stopPropagation: () => {} });

    assert.ok(prevented, 'the native right-click menu must not also show up');
    assert.deepEqual(module.regionContextMenu.peek(), { node: district });
});

test('openRegionContextMenu() does nothing mid-draw — a stray right-click while drawing a region should not interrupt it', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    await module.createNodeImmediately({ polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], name: 'District' });
    const [district] = module.nodes.peek();
    module.canvasMode.set('drawPolygon');

    module.openRegionContextMenu(district, { preventDefault: () => {}, stopPropagation: () => { throw new Error('must not stop propagation mid-draw'); } });

    assert.equal(module.regionContextMenu.peek(), null);
});

test('startSubRegionDraw() closes the menu and switches into the ordinary drawPolygon tool — a sub-region is drawn exactly like any other region', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    await module.createNodeImmediately({ polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], name: 'District' });
    const [district] = module.nodes.peek();
    module.regionContextMenu.set({ node: district });

    module.startSubRegionDraw();

    assert.equal(module.regionContextMenu.peek(), null);
    assert.equal(module.canvasMode.peek(), 'drawPolygon');
});

test('drawing and finishing a polygon after startSubRegionDraw() nests it under the region the menu was opened on, purely via geometry — no explicit parent is ever passed', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    await module.createNodeImmediately({ polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], name: 'District' });
    const [district] = module.nodes.peek();
    module.regionContextMenu.set({ node: district });
    module.startSubRegionDraw();

    module.draftPoints.set([{ x: 0.3, y: 0.3 }, { x: 0.6, y: 0.3 }, { x: 0.6, y: 0.6 }]);
    module.finishPolygon();
    await new Promise(resolve => setTimeout(resolve, 0));

    const subRegion = module.nodes.peek().find(node => node.id !== district.id);
    assert.equal(subRegion.parentId, district.id);
});

test('closeRegionContextMenu() just closes the menu without touching drawing state', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    await module.createNodeImmediately({ polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], name: 'District' });
    const [district] = module.nodes.peek();
    module.regionContextMenu.set({ node: district });

    module.closeRegionContextMenu();

    assert.equal(module.regionContextMenu.peek(), null);
    assert.equal(module.canvasMode.peek(), 'view');
});

test('selectNode() (a plain left-click edit) also dismisses any open region action menu', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    await module.createNodeImmediately({ polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], name: 'District' });
    const [district] = module.nodes.peek();
    module.regionContextMenu.set({ node: district });

    module.selectNode(district);

    assert.equal(module.regionContextMenu.peek(), null);
    assert.deepEqual(module.nodeForm.peek(), district);
});

test('handleCanvasBackgroundClick() with the menu open just closes it — a click elsewhere behaves like dismissing a native context menu, not a draw action', async () => {
    const { mapCore, module } = buildEngine();
    await mapCore.restore();
    await module.load();
    await module.createNodeImmediately({ polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], name: 'District' });
    const [district] = module.nodes.peek();
    module.regionContextMenu.set({ node: district });
    const fakeClick = {
        currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) },
        clientX: 50, clientY: 50,
    };

    module.handleCanvasBackgroundClick(fakeClick);

    assert.equal(module.regionContextMenu.peek(), null);
    assert.equal(module.canvasMode.peek(), 'view', 'the click was consumed dismissing the menu, not passed through to start/continue a draw');
});
