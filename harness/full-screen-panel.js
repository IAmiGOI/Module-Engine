/**
 * A page-width overlay, appended to `document.body` — same shape as Alpha's
 * own core/full-screen-panel.js (`.stme-fullscreen`), needed for the exact
 * same reason: SillyTavern's own extensions drawer is a narrow sidebar, and
 * a real panel with several rows of fields simply doesn't fit it. The
 * drawer itself stays down to a one-line description + an "Open" button
 * (see ../index.js) — everything else renders here instead, full width.
 */
export function createFullScreenPanel({ title = '' } = {}) {
    const overlay = document.createElement('div');
    overlay.className = 'stmeBeta-fullscreen';
    overlay.hidden = true;
    overlay.innerHTML = `
        <div class="stmeBeta-fullscreen-head">
            <strong>${title}</strong>
            <button type="button" class="menu_button stmeBeta-fullscreen-close">Close</button>
        </div>
        <div class="stmeBeta-fullscreen-body"></div>`;
    document.body.append(overlay);

    const body = overlay.querySelector('.stmeBeta-fullscreen-body');
    const open = () => { overlay.hidden = false; };
    const close = () => { overlay.hidden = true; };
    overlay.querySelector('.stmeBeta-fullscreen-close').addEventListener('click', close);

    return { body, open, close, toggle: () => (overlay.hidden ? open() : close()) };
}
