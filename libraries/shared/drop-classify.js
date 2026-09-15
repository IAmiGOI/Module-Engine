/**
 * Classifying what a user just dropped/pasted — a FILE from disk or a LINK
 * dragged from the browser. Pure (no DOM, no fetch): built for
 * [cores/ui/picture-panel.js](../../cores/ui/picture-panel.js), promoted to
 * a Library per LIBRARIES.md's own rule the moment a second real consumer
 * needed the exact same classification — [modules/map/index.js](../../modules/map/index.js)'s
 * map-image dropzone (ROADMAP.md 5.44).
 */

/** http(s) URL — the only thing the HTTP Service could ever legally fetch. */
export function isHttpUrl(url) {
    try { const parsed = new URL(url); return parsed.protocol === 'http:' || parsed.protocol === 'https:'; }
    catch { return false; }
}

/**
 * Classification of what was dropped. A mixed drop (both a file AND link
 * text, which real browsers do produce) takes the file — it's primary, the
 * text is usually just the same image's URL riding along. Neither a file
 * nor a recognizable link — an honest `{ kind: 'none' }`, never a guess.
 */
export function classifyDrop({ files, text } = {}) {
    const file = files?.[0];
    if (file) return { kind: 'file', file };
    const url = (text ?? '').trim().split(/\s+/)[0] || '';
    if (url && isHttpUrl(url)) return { kind: 'url', url };
    return { kind: 'none' };
}
