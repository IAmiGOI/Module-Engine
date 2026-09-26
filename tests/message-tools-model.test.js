import test from 'node:test';
import assert from 'node:assert/strict';
import { MESSAGE_TOOLS, NATIVE_ACTION_IDS, buildToolList, hideToolId, isInToolsZone, computeToolsLayout, toolsPanelWidth, TOOLS_MAX_COLUMNS } from '../libraries/shared/message-tools-model.js';

test('the tools cover the native message buttons of ST (hide/include, prompt, embed file, copy, swipe picker, checkpoint, branch) — but not the extension buttons translate / image / narrate', () => {
    const ids = MESSAGE_TOOLS.map(tool => tool.id);
    for (const id of ['hide', 'unhide', 'prompt', 'embed', 'copy', 'swipes', 'checkpoint', 'branch']) assert.ok(ids.includes(id), id);
    for (const id of ['translate', 'image', 'narrate']) assert.equal(ids.includes(id), false, `${id} is not offered (owner)`);
    assert.equal(new Set(ids).size, ids.length, 'ids are unique');
    assert.ok(NATIVE_ACTION_IDS.includes('embed') && NATIVE_ACTION_IDS.includes('prompt'));
    assert.equal(NATIVE_ACTION_IDS.includes(null), false);
});

test('a visible message offers "exclude" (eye), a hidden one offers "include" (crossed eye) — never both', () => {
    const shown = buildToolList({ available: new Set(['hide', 'unhide']), hidden: false }).map(tool => tool.id);
    assert.ok(shown.includes('hide') && !shown.includes('unhide'));
    const hiddenList = buildToolList({ available: new Set(['hide', 'unhide']), hidden: true }).map(tool => tool.id);
    assert.ok(hiddenList.includes('unhide') && !hiddenList.includes('hide'));
    assert.equal(hideToolId(true), 'unhide');
    assert.equal(hideToolId(false), 'hide');
});

test('native tools appear only when the native button is available now; copy is always there', () => {
    const list = buildToolList({ available: new Set(['embed']) });
    assert.deepEqual(list.map(tool => tool.id), ['hide', 'embed', 'copy']);
    assert.equal(list.find(tool => tool.id === 'copy').viaNative, false);
    assert.equal(list.find(tool => tool.id === 'embed').viaNative, true);
    assert.deepEqual(buildToolList({ available: new Set(['prompt', 'translate', 'branch', 'swipePicker']) }).map(tool => tool.id), ['hide', 'prompt', 'copy', 'swipes', 'branch'], 'translate is available in ST but never shown');
});

test('a message ST never rendered (no native .mes) can still be hidden/included — done by us, not through the native button', () => {
    const list = buildToolList({ available: new Set(), hidden: false, hasNativeMessage: false });
    const hide = list.find(tool => tool.id === 'hide');
    assert.ok(hide);
    assert.equal(hide.viaNative, false);
    assert.deepEqual(list.map(tool => tool.id), ['hide', 'copy']);
});

test('the hover zone covers the plate, the gap and the panel, and nothing further right', () => {
    assert.equal(isInToolsZone({ x: 300, columnWidth: 600 }), true);
    assert.equal(isInToolsZone({ x: 606, columnWidth: 600 }), true, 'in the gap');
    assert.equal(isInToolsZone({ x: 640, columnWidth: 600 }), true, 'over the panel');
    assert.equal(isInToolsZone({ x: 700, columnWidth: 600 }), false);
    assert.equal(isInToolsZone({ x: -20, columnWidth: 600 }), false);
});

test('the panel layout follows the VISIBLE part of the glyph: not below a short message, not cut at the bottom edge, more columns when the buttons do not fit one', () => {
    // Высокий глиф целиком на экране: один столбец, по всей высоте глифа.
    const tall = computeToolsLayout({ glyphTop: 100, glyphHeight: 400, viewportHeight: 700, count: 5 });
    assert.deepEqual([tall.y, tall.height, tall.columns], [100, 400, 1]);
    assert.equal(tall.width, toolsPanelWidth(1));
    // Невысокий глиф: столько столбцов, чтобы кнопки уместились в его высоту (не выезжают вниз).
    const short = computeToolsLayout({ glyphTop: 100, glyphHeight: 136, viewportHeight: 700, count: 5 });
    assert.deepEqual([short.y, short.height, short.columns], [100, 136, 2]);
    // Глиф у нижнего края видимой области: панель по видимой части, а не по всему глифу.
    const bottom = computeToolsLayout({ glyphTop: 600, glyphHeight: 300, viewportHeight: 700, count: 5 });
    assert.equal(bottom.y + bottom.height <= 700, true, 'never below the visible area');
    assert.ok(bottom.y >= 590 && bottom.y <= 600, 'stays near the glyph (moved up only to fit every button)');
    // Глиф, верх которого уже ушёл за верхний край: панель прилипает к верху видимой области.
    const above = computeToolsLayout({ glyphTop: -150, glyphHeight: 400, viewportHeight: 700, count: 5 });
    assert.equal(above.y, 0);
    assert.equal(above.height, 250);
});

test('a tiny visible piece of a glyph still gets a usable panel (minimum height, moved up so it stays inside), and the column count never exceeds the reserved room', () => {
    const tiny = computeToolsLayout({ glyphTop: 660, glyphHeight: 300, viewportHeight: 700, count: 7 });
    assert.ok(tiny.height >= 96);
    assert.ok(tiny.y + tiny.height <= 700);
    assert.ok(tiny.columns <= TOOLS_MAX_COLUMNS);
    const many = computeToolsLayout({ glyphTop: 0, glyphHeight: 60, viewportHeight: 700, count: 9 });
    assert.equal(many.columns, TOOLS_MAX_COLUMNS);
    assert.ok(many.rows * 32 - 6 + 14 <= many.height, 'stretched to hold every button');
});
