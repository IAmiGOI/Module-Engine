import test from 'node:test';
import assert from 'node:assert/strict';
import { HUB_GROUPS, HUB_TILES, tilesForGroup, tileById, tileForCard, tileStatus, layoutGrid, resolveView, HUB_TILE_H } from '../libraries/shared/hub-model.js';
import { tileBodyHtml } from '../libraries/shared/hub-html.js';

test('the hub covers every card of the main panel and of the settings screen, each tile pointing at a real card title', () => {
    assert.deepEqual(tilesForGroup(HUB_GROUPS.WORK).map(tile => tile.card), ['Model connections', 'Classifiers', 'Modules', 'Macros', 'Lorebook', 'Chat Summary']);
    assert.deepEqual(tilesForGroup(HUB_GROUPS.SETTINGS).map(tile => tile.card), ['Engine', 'Chat Viewport (experimental)', 'Preset', 'Updates', 'Sync', 'Backgrounds']);
    assert.equal(new Set(HUB_TILES.map(tile => tile.id)).size, HUB_TILES.length, 'ids are unique');
    assert.equal(tileById('models').card, 'Model connections');
    assert.equal(tileForCard('Modules').id, 'modules', 'a card title finds its tile (the checklist step opens it)');
    assert.equal(tileForCard('Nope'), null);
});

test('the source panel really has those card titles (so a tile can never point at nothing)', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const dir = new URL('../cores/ui/panel-cards/', import.meta.url);
    const sources = [...readdirSync(dir).map(name => readFileSync(new URL(name, dir), 'utf8')), readFileSync(new URL('../cores/ui/sync-card.js', import.meta.url), 'utf8')].join('\n');
    for (const tile of HUB_TILES) assert.ok(sources.includes(`Card('${tile.card}'`), `no Card('${tile.card}') found`);
});

test('models: no data → the description, an empty list → a warning, workers → ok with up to three names', () => {
    const models = tileById('models');
    assert.equal(tileStatus(models, {}).status, 'info');
    assert.deepEqual(tileStatus(models, { workerNames: [] }), { status: 'warn', lines: ['No connections yet', 'Add one to let the engine call a model'] });
    assert.deepEqual(tileStatus(models, { workerNames: ['Local', 'Router'] }), { status: 'ok', lines: ['2 connections', 'Local, Router'] });
    assert.deepEqual(tileStatus(models, { workerNames: ['A'] }).lines[0], '1 connection');
    assert.equal(tileStatus(models, { workerNames: ['a', 'b', 'c', 'd', 'e'] }).lines[1], 'a, b, c +2');
});

test('modules: none enabled → off, some enabled → ok with the count and names', () => {
    const modules = tileById('modules');
    assert.equal(tileStatus(modules, {}).status, 'info');
    assert.deepEqual(tileStatus(modules, { modules: { enabled: [], total: 8 } }), { status: 'off', lines: ['None enabled (8 available)', 'Switch on what you need'] });
    assert.deepEqual(tileStatus(modules, { modules: { enabled: ['Tracker', 'Music'], total: 8 } }), { status: 'ok', lines: ['2 of 8 enabled', 'Tracker, Music'] });
    assert.deepEqual(tileStatus(tileById('sync'), {}).lines, ['Keep devices in step over WebRTC and GitHub', '']);
});

test('the grid is fixed and adaptive: as many columns as fit, tiles stretch within limits and stay centered, height covers every row', () => {
    const ids = Array.from({ length: 5 }, (_, i) => `t${i}`);
    const wide = layoutGrid({ width: 1100, ids });
    assert.equal(wide.columns, 4);
    assert.equal(wide.tiles.length, 5);
    assert.ok(wide.tiles.every(tile => tile.w >= 250 && tile.w <= 380 && tile.h === HUB_TILE_H));
    assert.equal(wide.height, 2 * HUB_TILE_H + 14, 'two rows');
    const narrow = layoutGrid({ width: 300, ids });
    assert.equal(narrow.columns, 1);
    assert.equal(new Set(narrow.tiles.map(tile => tile.x)).size, 1, 'a phone gets one column');
    assert.equal(narrow.height, 5 * HUB_TILE_H + 4 * 14);
    const few = layoutGrid({ width: 1100, ids: ['a', 'b'] });
    const used = few.tiles.at(-1).x + few.tiles.at(-1).w - few.tiles[0].x;
    assert.ok(Math.abs(few.tiles[0].x - (1100 - used) / 2) <= 1, 'two tiles sit in the middle, not stuck to the left');
    assert.deepEqual(layoutGrid({ width: 500, ids: [] }).tiles, []);
    assert.equal(layoutGrid({ width: 500, ids: [] }).height, 0);
    for (const tile of wide.tiles) assert.ok(tile.x >= 0 && tile.x + tile.w <= 1100, 'inside the width');
});

test('navigation: null is the overview, a known tile id opens its form, an unknown one falls back to the overview', () => {
    assert.equal(resolveView(null), null);
    assert.equal(resolveView('models'), 'models');
    assert.equal(resolveView('ghost'), null);
});

test('the tile body is escaped text with the title and both status lines; the second line is optional', () => {
    const tile = { id: 'x', title: '<b>T</b>' };
    const html = tileBodyHtml(tile, { status: 'ok', lines: ['a & b', 'c'] });
    assert.ok(html.includes('&lt;b&gt;T&lt;/b&gt;') && html.includes('a &amp; b') && html.includes('>c<'));
    assert.ok(!tileBodyHtml(tile, { status: 'info', lines: ['only', ''] }).includes('wg-muted'));
});

test('the CSS keeps the tiles clickable: the scene layer passes the mouse through (pointer-events: none), so the tile itself MUST re-enable it — a scripted .click() would not notice a missing rule, a real mouse would', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync(new URL('../styles/hub/hub.css', import.meta.url), 'utf8');
    assert.match(css, /\.stme-hub-scene\s*\{[^}]*pointer-events:\s*none/);
    assert.match(css, /\.stme-hub-tile\s*\{[^}]*pointer-events:\s*auto/);
    const home = readFileSync(new URL('../styles/home/blocks.css', import.meta.url), 'utf8');
    assert.match(home, /\.stme-home-block\s*\{[^}]*pointer-events:\s*auto/, 'the desktop blocks have the same rule');
});

test('the old forms are pulled to the tile style: the same plate formula and accent ring, pill buttons and fields, no pulsing — scoped to the full-screen panels only', async () => {
    const { readFileSync } = await import('node:fs');
    const forms = readFileSync(new URL('../styles/hub/forms.css', import.meta.url), 'utf8');
    const hub = readFileSync(new URL('../styles/hub/hub.css', import.meta.url), 'utf8');
    const plate = /background:\s*color-mix\(in srgb,\s*color-mix\(in srgb,\s*#fff 9%,\s*var\(--stme-surface\)\)\s*var\(--stme-glyph-opacity, 78%\),\s*transparent\)/;
    assert.match(forms, plate, 'cards use the tile plate formula');
    assert.match(hub, plate, 'the tile uses it too');
    assert.match(forms, /\.stme-card\s*\{[^}]*border:\s*1\.5px solid color-mix\(in srgb, var\(--stme-accent\) 55%/);
    assert.match(forms, /\.menu_button[^{]*\{[^}]*border-radius:\s*999px/);
    assert.match(forms, /input\.text_pole[^{]*\{[^}]*border-radius:\s*999px/);
    assert.ok(!/animation:\s*stme-pulse/.test(forms), 'no pulsing');
    const selectors = forms.match(/^[^\s/@}][^{]*\{/gm).join('\n');
    assert.ok(!/^\.stme-(?!hub)/m.test(selectors.split('\n').filter(line => !line.includes('.stmeBeta-fullscreen')).join('\n')), 'every rule is scoped under .stmeBeta-fullscreen — floating windows are untouched');
});

test('the panel shell matches the desktop: a translucent glass background (not black), an unboxed header and a ROUND close button; module rows tile as a grid', async () => {
    const { readFileSync } = await import('node:fs');
    const forms = readFileSync(new URL('../styles/hub/forms.css', import.meta.url), 'utf8');
    assert.match(forms, /\.stmeBeta-fullscreen\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--stme-surface\) 48%, transparent\)/, 'translucent glass');
    assert.match(forms, /body:has\(\.stmeBeta-fullscreen:not\(\[hidden\]\)\) \.stme-home\s*\{[^}]*visibility:\s*hidden/, 'the desktop is hidden while a panel is open');
    assert.match(forms, /stmeBeta-fullscreen-close\s*\{[^}]*border-radius:\s*999px/);
    assert.match(forms, /\.stme-card-body:has\(> \.stme-section\)\s*\{[^}]*display:\s*grid/);
    const shell = readFileSync(new URL('../harness/full-screen-panel.js', import.meta.url), 'utf8');
    assert.match(shell, /class="stme-icon-button stmeBeta-fullscreen-close"[^>]*aria-label="Close"/, 'the close button is an icon button with a label for screen readers');
    assert.ok(!shell.includes('>Close<'), 'no text "Close" button any more');
});

test('the panel does not hide under the left side bar (it is above the panel): the header and the body get an offset when the side bar is active; the Back row has no slab of its own', async () => {
    const { readFileSync } = await import('node:fs');
    const forms = readFileSync(new URL('../styles/hub/forms.css', import.meta.url), 'utf8');
    assert.match(forms, /html\.stme-side-bar-active \.stmeBeta-fullscreen \.stmeBeta-fullscreen-head\s*\{[^}]*padding-left:\s*calc\(var\(--stme-side-bar-w, 42px\)/);
    assert.match(forms, /html\.stme-side-bar-active \.stmeBeta-fullscreen \.stmeBeta-fullscreen-body\s*\{[^}]*padding-left:/);
    assert.match(forms, /\.stme-hub-bar\s*\{[^}]*background:\s*none[^}]*\}/);
});

test('module tiles are one size and the switch is not repeated in words: closed tiles clamp the description to three lines on equal-height grid rows; the switch label is visually hidden (kept for screen readers)', async () => {
    const { readFileSync } = await import('node:fs');
    const forms = readFileSync(new URL('../styles/hub/forms.css', import.meta.url), 'utf8');
    assert.match(forms, /grid-auto-rows:\s*minmax\(112px, auto\)/);
    assert.match(forms, /align-items:\s*stretch/);
    assert.match(forms, /-webkit-line-clamp:\s*3/);
    assert.match(forms, /\.stme-section-head \.stme-switch-label\s*\{[^}]*clip:\s*rect\(0 0 0 0\)/);
    assert.ok(!/\.stme-section-head \.stme-switch-label\s*\{[^}]*display:\s*none/.test(forms), 'hidden visually, not removed from the accessibility tree');
});
