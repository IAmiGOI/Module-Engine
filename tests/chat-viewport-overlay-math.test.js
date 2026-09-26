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

test('the body css matches the exact string the panel built inline before it was extracted', () => {
    const expected = '.stme-chat-viewport-body { color: #111111; font-size: 15px; line-height: 1.4; font-family: Foo, serif; '
        + 'text-shadow: 0 0 5px rgba(0, 0, 0, .30), 0 0 2px rgba(0, 0, 0, .18); } '
        + '.stme-chat-viewport-body * { margin: 0; padding: 0; } '
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
