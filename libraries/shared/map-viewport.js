/**
 * Pure pan/zoom + quadtree-tile math for the map canvas (ROADMAP.md 5.52,
 * a follow-up to 5.51's whole-image upscale — owner: "Почему по кнопке?
 * Надо разбивать картинку на секторы, апскейлить только их при зуме" —
 * upscaling the ENTIRE root image once, manually, doesn't scale to a large
 * map; upscaling small per-tile CROPS on demand, only for whatever is
 * currently visible, does). No DOM, no canvas, no signals — the Module owns
 * the `viewportRect` signal and calls these as plain pure functions, same
 * split as `map-graph.js`/Ядро карты.
 *
 * **Viewport** is a normalized (0..1) axis-aligned square
 * `{minX, minY, maxX, maxY}` into the SAME coordinate space nodes/edges
 * already use (`libraries/core/map-graph.js`) — `{0,0,1,1}` (see
 * `FULL_VIEWPORT_RECT`) shows the whole image, a smaller square shows a
 * zoomed-in region of it. Always square (`maxX-minX === maxY-minY`) so a
 * single `zoomScale` number round-trips losslessly with it.
 *
 * **Quadtree tiles**: at level `L` the unit square is divided into a
 * `2^L x 2^L` grid; level 0 is the whole image as one "tile" (the base
 * layer the Module already shows at native resolution, no upscale needed —
 * see `listVisibleTiles`'s doc-comment). Deeper levels only ever get
 * computed for tiles the current viewport actually overlaps — the "dynamic
 * detail" the owner asked for, not a fixed grid regardless of what's on
 * screen.
 */

/** No zoom, no pan — the whole image visible, level 0. */
export const FULL_VIEWPORT_RECT = Object.freeze({ minX: 0, minY: 0, maxX: 1, maxY: 1 });

/** How many times "zoomed in" a viewport rect is — `1` at `FULL_VIEWPORT_RECT`, `2` at half-size, etc. */
export function viewportZoomScale(rect) {
    const size = rect.maxX - rect.minX;
    return size > 0 ? 1 / size : 1;
}

/** Keeps `rect`'s SIZE, repositions it (if needed) to stay fully inside the unit square — used after every pan/zoom so the viewport can never drift off the actual image. */
export function clampViewportRect(rect) {
    const width = rect.maxX - rect.minX;
    const height = rect.maxY - rect.minY;
    let minX = rect.minX;
    let minY = rect.minY;
    if (minX < 0) minX = 0;
    if (minY < 0) minY = 0;
    if (minX + width > 1) minX = 1 - width;
    if (minY + height > 1) minY = 1 - height;
    return { minX, minY, maxX: minX + width, maxY: minY + height };
}

/**
 * Zooms `rect` by `factor` (>1 zooms in, <1 zooms out) around a normalized
 * `pivot` point (e.g. the cursor position under the wheel event) — the
 * pivot stays at the same RELATIVE position within the new rect, the
 * standard "zoom toward the cursor" behavior. Clamped to
 * `[minZoom, maxZoom]` and to the unit square.
 */
export function computeZoomedViewportRect(rect, factor, pivot, { minZoom = 1, maxZoom = 16 } = {}) {
    const currentZoom = viewportZoomScale(rect);
    const nextZoom = Math.min(maxZoom, Math.max(minZoom, currentZoom * factor));
    const size = rect.maxX - rect.minX;
    const currentSize = size > 0 ? size : 1;
    const relX = (pivot.x - rect.minX) / currentSize;
    const relY = (pivot.y - rect.minY) / currentSize;
    const newSize = 1 / nextZoom;
    const minX = pivot.x - relX * newSize;
    const minY = pivot.y - relY * newSize;
    return clampViewportRect({ minX, minY, maxX: minX + newSize, maxY: minY + newSize });
}

/** Pans `rect` by a normalized `(deltaX, deltaY)`, clamped to stay inside the unit square (size never changes — a pan is not a zoom). */
export function computePannedViewportRect(rect, deltaX, deltaY) {
    return clampViewportRect({
        minX: rect.minX + deltaX, minY: rect.minY + deltaY,
        maxX: rect.maxX + deltaX, maxY: rect.maxY + deltaY,
    });
}

/** `log2`-rounded quadtree depth for a given zoom scale, clamped to `[0, maxLevel]` — level 0 at `zoomScale <= 1`, deeper as the viewport shrinks. */
export function computeQuadtreeLevel(zoomScale, maxLevel) {
    const level = Math.round(Math.log2(Math.max(1, zoomScale)));
    return Math.min(maxLevel, Math.max(0, level));
}

/**
 * Every quadtree tile at `level` whose rect overlaps `viewportRect` — the
 * ONLY tiles worth computing/rendering right now, not the full
 * `2^level x 2^level` grid. Level 0 always returns exactly one tile (the
 * whole image) regardless of `viewportRect`, since a `2^0 x 2^0` grid is a
 * single cell by definition.
 */
export function listVisibleTiles(viewportRect, level) {
    const gridSize = 2 ** level;
    if (gridSize <= 1) {
        return [{ level, col: 0, row: 0, rect: { minX: 0, minY: 0, maxX: 1, maxY: 1 } }];
    }
    const tileSize = 1 / gridSize;
    const startCol = Math.max(0, Math.floor(viewportRect.minX / tileSize));
    const endCol = Math.min(gridSize - 1, Math.floor((viewportRect.maxX - 1e-9) / tileSize));
    const startRow = Math.max(0, Math.floor(viewportRect.minY / tileSize));
    const endRow = Math.min(gridSize - 1, Math.floor((viewportRect.maxY - 1e-9) / tileSize));
    const tiles = [];
    for (let row = startRow; row <= endRow; row += 1) {
        for (let col = startCol; col <= endCol; col += 1) {
            tiles.push({
                level, col, row,
                rect: { minX: col * tileSize, minY: row * tileSize, maxX: (col + 1) * tileSize, maxY: (row + 1) * tileSize },
            });
        }
    }
    return tiles;
}

/**
 * Deterministic cache key for a tile — reused as BOTH the in-memory Map key
 * and the `image.*` Service's persisted blob id (same store the root image
 * itself already uses, just namespaced under the root asset).
 *
 * **`algorithmVersion` (ROADMAP.md 5.57)** — the persisted cache has no
 * expiry and no listing/GC, so a tile computed by an EARLIER, buggy version
 * of `loadOrComputeTile()`'s algorithm would otherwise keep being served
 * forever, unchanged, even after the bug is fixed (owner sent a second
 * screenshot proving the seam was STILL there — 5.56's fix was real, but
 * every tile from before it stayed cached under the same key and never got
 * recomputed). The Module bumps its own version constant whenever the tile
 * algorithm changes; a version bump changes every key, so old tiles are
 * simply never looked up again (orphaned in storage, not actively deleted
 * — no GC exists for this store, same as the rest of `image.*`, and it's
 * local per-browser storage, not worth the complexity to reclaim).
 */
export function tileCacheKey(rootAssetId, level, col, row, algorithmVersion) {
    return `${rootAssetId}__tile_v${algorithmVersion}_${level}_${col}_${row}`;
}

/**
 * Maps a normalized tile `rect` onto an EXACT integer pixel rect against a
 * `sourceWidth`x`sourceHeight` image — rounds the BOUNDARIES (`minX`/`maxX`/
 * `minY`/`maxY`), not the derived width/height, so two adjacent tiles
 * ALWAYS share an identical integer boundary pixel, with neither a gap nor
 * an overlap in the underlying source crop. Owner, live screenshot: a
 * drawn line was visibly OFFSET right at a tile boundary, not just
 * differently colored — tracked down to exactly this: a caller that
 * rounded `x`/`width` independently (or let `cropImagePixels()` round them
 * implicitly, downstream, after already doing its own unrounded padding
 * math) got two neighboring tiles disagreeing on where their shared edge
 * actually was, by a fraction of a source pixel — multiplied by the
 * upscale factor, that fraction becomes several real, visible pixels of
 * misalignment.
 */
export function computeTileSourcePixelRect(rect, sourceWidth, sourceHeight) {
    const x = Math.round(rect.minX * sourceWidth);
    const y = Math.round(rect.minY * sourceHeight);
    return {
        x, y,
        width: Math.round(rect.maxX * sourceWidth) - x,
        height: Math.round(rect.maxY * sourceHeight) - y,
    };
}
