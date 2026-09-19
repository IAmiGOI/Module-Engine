import test from 'node:test';
import assert from 'node:assert/strict';
import { computeVisibleRange, reconcileMeasuredHeight, computeGlyphs } from '../libraries/shared/chat-viewport-math.js';

function order(n) {
    return Array.from({ length: n }, (_, i) => String(i));
}

test('empty chat — visible range is empty, total height zero', () => {
    const range = computeVisibleRange({ order: [], heights: new Map(), scrollTop: 0, viewportHeight: 600 });
    assert.deepEqual(range, { startIndex: 0, endIndex: 0, offsetTop: 0, totalHeight: 0 });
});

test('scrolled to the very top — first rows visible, offsetTop is 0', () => {
    const heights = new Map(order(50).map(id => [id, 100]));
    // viewportHeight=250 deliberately avoids landing exactly on a row boundary (300 would be ambiguous: row 3 starts exactly at the bottom edge).
    const range = computeVisibleRange({ order: order(50), heights, scrollTop: 0, viewportHeight: 250, overscan: 0 });
    assert.equal(range.startIndex, 0);
    assert.equal(range.offsetTop, 0);
    assert.equal(range.endIndex, 3); // rows 0,1,2 fully cover [0,300), which is past the 250px viewport
    assert.equal(range.totalHeight, 5000);
});

test('scrolled into the middle — window follows scrollTop, not index 0', () => {
    const heights = new Map(order(100).map(id => [id, 50]));
    // Row i spans [i*50, i*50+50). scrollTop=1000 lands exactly on row 20's start.
    const range = computeVisibleRange({ order: order(100), heights, scrollTop: 1000, viewportHeight: 200, overscan: 0 });
    assert.equal(range.startIndex, 20);
    assert.equal(range.offsetTop, 1000);
});

test('overscan extends the window on both sides, clamped to the list bounds', () => {
    const heights = new Map(order(100).map(id => [id, 50]));
    const range = computeVisibleRange({ order: order(100), heights, scrollTop: 1000, viewportHeight: 200, overscan: 5 });
    assert.equal(range.startIndex, 15); // 20 - 5
    assert.ok(range.endIndex > 20);
});

test('overscan near the start clamps to zero instead of going negative', () => {
    const heights = new Map(order(20).map(id => [id, 50]));
    const range = computeVisibleRange({ order: order(20), heights, scrollTop: 0, viewportHeight: 100, overscan: 10 });
    assert.equal(range.startIndex, 0);
    assert.equal(range.offsetTop, 0);
});

test('overscan near the end clamps to the list length instead of overshooting', () => {
    const heights = new Map(order(20).map(id => [id, 50]));
    const range = computeVisibleRange({ order: order(20), heights, scrollTop: 900, viewportHeight: 200, overscan: 50 });
    assert.equal(range.endIndex, 20);
});

test('unmeasured rows fall back to estimatedHeight, not zero — an empty heights map does not collapse the whole list into one point', () => {
    const range = computeVisibleRange({ order: order(10), heights: new Map(), scrollTop: 0, viewportHeight: 100, estimatedHeight: 80, overscan: 0 });
    assert.equal(range.totalHeight, 800);
    assert.ok(range.endIndex >= 1 && range.endIndex < 10, 'only a few estimated-height rows should be considered visible, not the entire list');
});

test('one giant row taller than the whole viewport is still the single visible row, not zero rows', () => {
    const heights = new Map([['0', 5000]]);
    const range = computeVisibleRange({ order: ['0'], heights, scrollTop: 0, viewportHeight: 600, overscan: 0 });
    assert.deepEqual(range, { startIndex: 0, endIndex: 1, offsetTop: 0, totalHeight: 5000 });
});

test('reconcileMeasuredHeight returns a new Map with the entry updated, leaving other entries intact', () => {
    const heights = new Map([['0', 100], ['1', 50]]);
    const next = reconcileMeasuredHeight(heights, '1', 120);
    assert.notEqual(next, heights, 'must not mutate the map in place — the caller feeds this into a signal');
    assert.equal(next.get('0'), 100);
    assert.equal(next.get('1'), 120);
});

test('reconcileMeasuredHeight returns null when the rounded height did not actually change — avoids re-triggering a range recompute on ResizeObserver sub-pixel noise', () => {
    const heights = new Map([['0', 100]]);
    assert.equal(reconcileMeasuredHeight(heights, '0', 100.4), null);
    assert.notEqual(reconcileMeasuredHeight(heights, '0', 101), null);
});

// --- computeGlyphs — owner: "Глиф - одна цепочка сообщений от одного
// пользователя подряд" ---

test('computeGlyphs groups consecutive same-name messages into one glyph, splitting on any name change', () => {
    const glyphs = computeGlyphs([
        { mesid: '0', name: 'Lena' },
        { mesid: '1', name: 'Lena' },
        { mesid: '2', name: 'Sasha' },
        { mesid: '3', name: 'Lena' },
        { mesid: '4', name: 'Lena' },
        { mesid: '5', name: 'Lena' },
    ]);
    assert.deepEqual(glyphs, [
        { headerMesid: '0', mesids: ['0', '1'] },
        { headerMesid: '2', mesids: ['2'] },
        { headerMesid: '3', mesids: ['3', '4', '5'] },
    ]);
});

test('computeGlyphs folds a ToolCall message ("SillyTavern System", isToolCall:true) into the ALREADY OPEN glyph instead of starting its own — owner, second pass: "Тулл колл должен быть внутри глифа персонажа", not a separate glyph', () => {
    const glyphs = computeGlyphs([
        { mesid: '0', name: 'Lena' },
        { mesid: '1', name: 'SillyTavern System', isToolCall: true },
        { mesid: '2', name: 'Lena' },
    ]);
    assert.deepEqual(glyphs, [
        { headerMesid: '0', mesids: ['0', '1', '2'] },
    ]);
});

test('computeGlyphs does NOT let a passed-through ToolCall change the open glyph\'s name — the character after it is still compared against the character\'s own name, not "SillyTavern System"', () => {
    const glyphs = computeGlyphs([
        { mesid: '0', name: 'Lena' },
        { mesid: '1', name: 'SillyTavern System', isToolCall: true },
        { mesid: '2', name: 'Sasha' },
    ]);
    assert.deepEqual(glyphs, [
        { headerMesid: '0', mesids: ['0', '1'] },
        { headerMesid: '2', mesids: ['2'] },
    ]);
});

test('computeGlyphs lets a LEADING ToolCall (nothing open yet) start its own glyph — nothing to attach to', () => {
    const glyphs = computeGlyphs([
        { mesid: '0', name: 'SillyTavern System', isToolCall: true },
        { mesid: '1', name: 'Lena' },
    ]);
    assert.deepEqual(glyphs, [
        { headerMesid: '0', mesids: ['0'] },
        { headerMesid: '1', mesids: ['1'] },
    ]);
});

test('computeGlyphs does NOT fold a merely-hidden message (isSystem:true but isToolCall:false) into the open glyph — НАЙДЕНО ЖИВЬЁМ: `is_system` is also set on regular hidden replies from DIFFERENT characters (stChat.setHidden reuses the same field), not only on ToolCall notices; treating plain isSystem as passthrough collapsed genuinely different speakers into one glyph', () => {
    const glyphs = computeGlyphs([
        { mesid: '0', name: 'Lena' },
        { mesid: '1', name: 'Sasha', isSystem: true, isToolCall: false },
        { mesid: '2', name: 'Lena', isSystem: true, isToolCall: false },
    ]);
    assert.deepEqual(glyphs, [
        { headerMesid: '0', mesids: ['0'] },
        { headerMesid: '1', mesids: ['1'] },
        { headerMesid: '2', mesids: ['2'] },
    ]);
});

test('computeGlyphs on an empty list returns an empty list, not a throw', () => {
    assert.deepEqual(computeGlyphs([]), []);
    assert.deepEqual(computeGlyphs(undefined), []);
});

test('computeGlyphs treats two same-named messages separated by a DIFFERENT name as two separate glyphs, not one — the run must be truly consecutive', () => {
    const glyphs = computeGlyphs([
        { mesid: '0', name: 'Lena' },
        { mesid: '1', name: 'Sasha' },
        { mesid: '2', name: 'Lena' },
    ]);
    assert.deepEqual(glyphs, [
        { headerMesid: '0', mesids: ['0'] },
        { headerMesid: '1', mesids: ['1'] },
        { headerMesid: '2', mesids: ['2'] },
    ]);
});

test('two finished assistant replies in a row (e.g. after the user message between them was deleted) stay TWO glyphs; a tool-loop chain of the same turn is still ONE', () => {
    const afterDeletion = computeGlyphs([
        { mesid: '0', name: 'Lena', text: 'First full reply.' },
        { mesid: '1', name: 'Lena', text: 'Second full reply.' },
    ]);
    assert.deepEqual(afterDeletion, [
        { headerMesid: '0', mesids: ['0'] },
        { headerMesid: '1', mesids: ['1'] },
    ]);

    const toolLoop = computeGlyphs([
        { mesid: '0', name: 'Lena', text: '' },                                   // рассуждение без ответа
        { mesid: '1', name: 'SillyTavern System', isToolCall: true, text: 'x' },
        { mesid: '2', name: 'Lena', text: 'Now the real answer.' },              // продолжение после инструмента
        { mesid: '3', name: 'Lena', text: 'A separate later reply.' },            // законченный ответ уже был — это новый глиф
    ]);
    assert.deepEqual(toolLoop, [
        { headerMesid: '0', mesids: ['0', '1', '2'] },
        { headerMesid: '3', mesids: ['3'] },
    ]);
});

test('consecutive USER messages from the same user still merge into one glyph', () => {
    const glyphs = computeGlyphs([
        { mesid: '0', name: 'Sasha', isUser: true, text: 'one' },
        { mesid: '1', name: 'Sasha', isUser: true, text: 'two' },
    ]);
    assert.deepEqual(glyphs, [{ headerMesid: '0', mesids: ['0', '1'] }]);
});

test('Chat Viewport starts enabled by default on a phone, disabled on a computer, and an explicit choice always wins', async () => {
    const { resolveChatViewportEnabled } = await import('../libraries/shared/chat-viewport-math.js');
    assert.equal(resolveChatViewportEnabled({}, { mobile: true }), true, 'phone, nothing chosen yet');
    assert.equal(resolveChatViewportEnabled(undefined, { mobile: true }), true);
    assert.equal(resolveChatViewportEnabled({}, { mobile: false }), false, 'computer, nothing chosen yet');
    assert.equal(resolveChatViewportEnabled({ enabled: false }, { mobile: true }), false, 'a phone user who turned it off stays off');
    assert.equal(resolveChatViewportEnabled({ enabled: true }, { mobile: false }), true, 'a computer user who turned it on stays on');
    assert.equal(resolveChatViewportEnabled({ enabled: 'yes' }, { mobile: true }), true, 'a garbage value is not a choice');
    assert.equal(resolveChatViewportEnabled({ sideMargin: 20 }, { mobile: false }), false);
});
