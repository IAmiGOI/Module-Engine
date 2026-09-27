import test from 'node:test';
import assert from 'node:assert/strict';
import widget, { segmentLayout } from '../widgets/guide/widget.js';
import { normalizeWidget } from '../libraries/shared/widget-contract.js';

const build = status => {
    const instance = widget.create({ request: async () => ({ ok: true, value: status }), invalidate: () => {}, subscribe: () => () => {} });
    return instance.start().then(() => instance);
};

test('the guide widget is a valid widget definition with a portrait row (3×4 on the left, full height)', async () => {
    assert.equal(normalizeWidget(widget).ok, true);
    const instance = await build({ name: 'Mea', avatar: '/a.png', checklist: [] });
    assert.deepEqual(instance.rows(), [{ id: 'guide', portrait: true, image: '/a.png', imageFallback: 'M', click: 'open', actions: [] }]);
});

test('the checklist bar is one segment per item, filled for the done ones, evenly spread inside the text column', () => {
    const segments = segmentLayout(4, 3, { left: 100, right: 300, gap: 5 });
    assert.deepEqual(segments.map(segment => segment.done), [true, true, true, false]);
    assert.equal(segments[0].left, 100);
    assert.ok(segments.at(-1).left + segments.at(-1).width <= 300);
    assert.deepEqual(segmentLayout(0, 0), []);
});

test('the body carries the name, her last line and the progress; her text is escaped; "thinking" wins while she works', async () => {
    const idle = await build({ name: 'Mea', lastLine: '<b>hi</b> & bye', checklist: [{ done: true }, { done: false }] });
    const html = idle.html();
    assert.match(html, /Mea/);
    assert.match(html, /&lt;b&gt;hi&lt;\/b&gt; &amp; bye/);
    assert.match(html, /First start — 1 of 2 done/);
    assert.equal((html.match(/class="wg-fill"/g) ?? []).length, 1);
    assert.equal((html.match(/class="wg-track"/g) ?? []).length, 1);
    assert.match((await build({ name: 'Mea', busy: true, lastLine: 'old', checklist: [] })).html(), /Thinking…/);
    assert.match((await build({ name: 'Mea', checklist: [{ done: true }] })).html(), /all done/);
});
