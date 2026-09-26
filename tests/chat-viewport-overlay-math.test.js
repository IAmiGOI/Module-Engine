import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MIN_WIDTH_FRACTION, BOTTOM_THRESHOLD, computeMaxSideMargin, clampSideMargin, computeViewportWidth, isNearBottom,
} from '../libraries/shared/chat-viewport-overlay-math.js';
import { buildChatViewportBodyCss } from '../libraries/shared/chat-viewport-body-css.js';

test('the widest a side margin can get leaves exactly the ST-default half of the page', () => {
    const page = 1600;
    const margin = computeMaxSideMargin(page);
    assert.equal(computeViewportWidth(page, margin), page * MIN_WIDTH_FRACTION);
});

test('clampSideMargin never goes negative and never passes the maximum', () => {
    assert.equal(clampSideMargin(-40, 1000), 0);
    assert.equal(clampSideMargin(24, 1000), 24);
    assert.equal(clampSideMargin(9999, 1000), 250);
});

test('a zero-width page cannot produce a zero-width canvas', () => {
    assert.equal(computeViewportWidth(0, 0), 1);
    assert.equal(computeViewportWidth(10, 400), 1);
});

test('isNearBottom treats "within the threshold of the end" as pinned, and one pixel further as not', () => {
    const total = 5000;
    const clientHeight = 600;
    assert.equal(isNearBottom({ scrollTop: total - clientHeight, clientHeight, totalHeight: total }), true);
    assert.equal(isNearBottom({ scrollTop: total - clientHeight - BOTTOM_THRESHOLD, clientHeight, totalHeight: total }), true);
    assert.equal(isNearBottom({ scrollTop: total - clientHeight - BOTTOM_THRESHOLD - 1, clientHeight, totalHeight: total }), false);
});

test('the body css is the exact expected string (paragraph rules included)', () => {
    const expected = '.stme-chat-viewport-body { color: #111111; font-size: 15px; line-height: 1.4; font-family: Foo, serif; text-rendering: geometricPrecision; '
        + 'text-shadow: 0 0 5px rgba(0, 0, 0, .30), 0 0 2px rgba(0, 0, 0, .18); } '
        + '.stme-chat-viewport-body * { margin: 0; } '
        + '.stme-chat-viewport-body > * + * { margin-top: 10px; } '
        + '.stme-chat-viewport-body ul, .stme-chat-viewport-body ol { padding-left: 1.4em; } '
        + '.stme-chat-viewport-body blockquote { padding-left: 10px; } '
        + '.stme-chat-viewport-body q { color: #222222; } '
        + '.stme-chat-viewport-body em, .stme-chat-viewport-body i { color: #333333; } '
        + '.stme-chat-viewport-body q em, .stme-chat-viewport-body q i, '
        + '.stme-chat-viewport-body font[color] em, .stme-chat-viewport-body font[color] i, .stme-chat-viewport-body font[color] q { color: inherit; } '
        + ".stme-chat-viewport-body q:before, .stme-chat-viewport-body q:after { content: ''; }";
    assert.equal(buildChatViewportBodyCss({ bodyColor: '#111111', quoteColor: '#222222', emColor: '#333333', fontFamily: 'Foo, serif' }), expected);
});

test('missing theme variables fall back to readable colors instead of the browser default black', () => {
    const css = buildChatViewportBodyCss({});
    assert.match(css, /color: #dcdcd2;/);
    assert.match(css, /q \{ color: #e18a24; \}/);
    assert.match(css, /font-family: system-ui, sans-serif;/);
});

import { DEFAULT_MARGINS, resolveMargins, dragMargins, marginsWidth } from '../libraries/shared/chat-viewport-overlay-math.js';

test('linked margins stay symmetric (the old behaviour, raised to the left dock reach); unlinked ones are independent and free from the dock reach', () => {
    assert.deepEqual(resolveMargins({ ...DEFAULT_MARGINS }, 1000), { left: 24, right: 24 });
    assert.deepEqual(resolveMargins({ ...DEFAULT_MARGINS }, 1000, 167), { left: 167, right: 167 }, 'linked: both sides follow the raised left one, the column stays centred');
    assert.deepEqual(resolveMargins({ left: 24, right: 300, linked: false }, 1000, 167), { left: 24, right: 300 }, 'unlinked: the left edge may go past the dock reach (the dock only overlaps it while open)');
    assert.equal(marginsWidth(1000, { left: 24, right: 300 }), 676);
});

test('an unlinked pair too wide for the page is cut down to half the page, keeping the ratio', () => {
    const m = resolveMargins({ left: 400, right: 400, linked: false }, 1000, 0);
    assert.equal(m.left + m.right, 500);
    assert.deepEqual(m, { left: 250, right: 250 });
    assert.deepEqual(resolveMargins({ left: 450, right: 150, linked: false }, 1000, 0), { left: 375, right: 125 }, 'the ratio is kept');
});

test('dragging one handle moves only its own edge and unlinks the pair', () => {
    const start = { left: 24, right: 24 };
    assert.deepEqual(dragMargins('left', start, 100, 1000), { left: 124, right: 24, linked: false }, 'left edge dragged right — left margin grows');
    assert.deepEqual(dragMargins('left', start, -100, 1000), { left: 0, right: 24, linked: false }, 'left edge dragged left — the margin shrinks, at most down to the window edge');
    assert.deepEqual(dragMargins('right', start, -200, 1000), { left: 24, right: 224, linked: false }, 'right edge dragged left — right margin grows');
    assert.deepEqual(dragMargins('right', start, 500, 1000), { left: 24, right: 0, linked: false }, 'right edge dragged to the window edge — no margin');
    assert.deepEqual(dragMargins('left', start, 9999, 1000), { left: 476, right: 24, linked: false }, 'the column never gets narrower than half the page');
});

test('the mirror stylesheet uses the same paragraph rules as the raster texture, so measured height and drawn text agree', async () => {
    const { readFileSync } = await import('node:fs');
    const mirror = readFileSync(new URL('../styles/chat-viewport/mirror-row.css', import.meta.url), 'utf8');
    const { PARAGRAPH_GAP_PX } = await import('../libraries/shared/chat-viewport-body-css.js');
    assert.match(mirror, new RegExp(`\\.stme-chat-viewport-mirror > \\* \\+ \\* \\{ margin-top: ${PARAGRAPH_GAP_PX}px; \\}`));
    assert.match(mirror, /\.stme-chat-viewport-mirror \* \{ margin: 0; \}/);
    assert.match(mirror, /\.stme-chat-viewport-mirror ul, \.stme-chat-viewport-mirror ol \{ padding-left: 1\.4em; \}/);
});
