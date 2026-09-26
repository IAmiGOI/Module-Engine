import test from 'node:test';
import assert from 'node:assert/strict';
import { createHomeScene } from '../cores/ui/home/scene.js';
import { attachDrag } from '../cores/ui/home/drag.js';

/** Минимальный фейк DOM-узла: класс, стиль, дети, слушатели. */
function fakeEl(tag = 'div') {
    const listeners = {};
    const el = {
        tag, className: '', style: {}, children: [], removed: false,
        append(...nodes) { this.children.push(...nodes); },
        remove() { this.removed = true; },
        addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
        removeEventListener(type, fn) { listeners[type] = (listeners[type] ?? []).filter(item => item !== fn); },
        emit(type, event) { for (const fn of listeners[type] ?? []) fn(event); },
        count: type => (listeners[type] ?? []).length,
    };
    return el;
}

function harness({ dpr = 2 } = {}) {
    const calls = [];
    const doc = { createElement: fakeEl };
    const call = async (contract, params) => { calls.push({ contract, params }); return { ok: true, value: contract === 'htmlRasterizer.rasterize' ? { image: { fake: true }, width: params.width * params.scale, height: params.height * params.scale } : true }; };
    const scene = createHomeScene({ document: doc, call, getDevicePixelRatio: () => dpr });
    return { scene, calls, names: name => calls.filter(item => item.contract === name) };
}

test('the scene mounts a DOM layer and a transparent canvas, attached to WebGL at PHYSICAL size', async () => {
    const h = harness();
    const parent = fakeEl();
    assert.equal(await h.scene.mount(parent), true);
    assert.equal(parent.children[0], h.scene.root);
    assert.equal(h.scene.root.children[0], h.scene.blocksLayer, 'DOM blocks below');
    assert.equal(h.scene.root.children[1], h.scene.canvas, 'canvas above');
    await h.scene.setRect({ left: 52, top: 8, width: 600, height: 400 });
    assert.deepEqual(h.names('webglChat.resize').at(-1).params, { canvas: h.scene.canvas, width: 1200, height: 800 });
    assert.deepEqual([h.scene.root.style.left, h.scene.root.style.width], ['52px', '600px']);
});

test('a block texture is rasterized once: the same html is not re-rasterized, changed html is', async () => {
    const h = harness();
    await h.scene.mount(fakeEl());
    const body = { html: '<div>a</div>', width: 300, height: 100, css: '.x{}' };
    assert.equal(await h.scene.setBody('b1', body), true);
    assert.equal(await h.scene.setBody('b1', body), false);
    assert.equal(await h.scene.setBody('b1', { ...body, html: '<div>b</div>' }), true);
    assert.equal(h.names('htmlRasterizer.rasterize').length, 2);
    assert.equal(h.names('htmlRasterizer.rasterize')[0].params.scale, 2);
});

test('drawing sends one quad per block that has a texture, in physical pixels, and skips an identical frame', async () => {
    const h = harness();
    await h.scene.mount(fakeEl());
    await h.scene.setBody('b1', { html: 'x', width: 300, height: 100, css: '' });
    const placements = [{ id: 'b1', x: 10, y: 20, w: 300, h: 100 }, { id: 'nobody', x: 0, y: 0, w: 5, h: 5 }];
    await h.scene.draw(placements);
    assert.deepEqual(h.names('webglChat.drawFrame')[0].params.quads, [{ textureId: 'b1', x: 20, y: 40, width: 600, height: 200 }]);
    await h.scene.draw(placements);
    assert.equal(h.names('webglChat.drawFrame').length, 1, 'same frame — no redraw');
    await h.scene.draw([{ ...placements[0], x: 11 }]);
    assert.equal(h.names('webglChat.drawFrame').length, 2);
});

test('removing a block releases its texture; dispose releases the rest, detaches WebGL and removes the layer', async () => {
    const h = harness();
    await h.scene.mount(fakeEl());
    await h.scene.setBody('b1', { html: '1', width: 10, height: 10, css: '' });
    await h.scene.setBody('b2', { html: '2', width: 10, height: 10, css: '' });
    await h.scene.removeBody('b1');
    await h.scene.removeBody('b1');
    assert.equal(h.names('webglChat.releaseTexture').length, 1, 'a second removal of the same block does nothing');
    await h.scene.dispose();
    assert.equal(h.names('webglChat.releaseTexture').length, 2);
    assert.equal(h.names('webglChat.detach').length, 1);
    assert.equal(h.scene.root.removed, true);
});

test('drag: a small move is a click (no drag), a big one drags and reports start/move/end; touch is ignored; the listener can be removed', () => {
    const el = fakeEl();
    const win = { listeners: {}, addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }, removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] ?? []).filter(x => x !== f); }, setTimeout: fn => fn() };
    const log = [];
    const detach = attachDrag(el, { win, onStart: () => log.push('start'), onMove: delta => log.push(['move', delta.dx, delta.dy]), onEnd: () => log.push('end') });
    const fire = (type, event) => (win.listeners[type] ?? []).slice().forEach(fn => fn(event));

    el.emit('pointerdown', { clientX: 100, clientY: 100, button: 0, pointerType: 'mouse' });
    fire('pointermove', { clientX: 102, clientY: 101 });
    fire('pointerup', {});
    assert.deepEqual(log, [], 'a 2px wiggle is a click, not a drag');
    assert.equal(el.__dragged, false);

    el.emit('pointerdown', { clientX: 100, clientY: 100, button: 0, pointerType: 'mouse' });
    fire('pointermove', { clientX: 130, clientY: 100 });
    assert.equal(el.__dragged, true, 'during the drag the trailing click is suppressed');
    fire('pointermove', { clientX: 140, clientY: 110 });
    fire('pointerup', {});
    assert.deepEqual(log, ['start', ['move', 30, 0], ['move', 40, 10], 'end']);
    assert.equal(win.listeners.pointermove.length, 0, 'window listeners are released');

    log.length = 0;
    el.emit('pointerdown', { clientX: 0, clientY: 0, button: 0, pointerType: 'touch' });
    assert.equal((win.listeners.pointermove ?? []).length, 0, 'touch does not start a drag');
    el.emit('pointerdown', { clientX: 0, clientY: 0, button: 2, pointerType: 'mouse' });
    assert.equal((win.listeners.pointermove ?? []).length, 0, 'only the primary button drags');
    detach();
    assert.equal(el.count('pointerdown'), 0);
});

test('when devicePixelRatio changes (page zoom, another monitor) the canvas is re-sized to the new physical size — otherwise the WebGL text drifts away from the DOM plates', async () => {
    let dpr = 1;
    const calls = [];
    const doc = { createElement: fakeEl };
    const scene = createHomeScene({ document: doc, call: async (contract, params) => { calls.push({ contract, params }); return { ok: true, value: true }; }, getDevicePixelRatio: () => dpr });
    await scene.mount(fakeEl());
    await scene.setRect({ left: 0, top: 0, width: 600, height: 400 });
    const resizes = () => calls.filter(item => item.contract === 'webglChat.resize');
    assert.deepEqual([resizes().length, resizes().at(-1).params.width], [1, 600]);
    await scene.setRect({ left: 0, top: 0, width: 600, height: 400 });
    assert.equal(resizes().length, 1, 'nothing changed — no resize');
    dpr = 1.25;
    await scene.setRect({ left: 0, top: 0, width: 600, height: 400 });
    assert.equal(resizes().length, 2, 'same CSS size, new ratio — resized');
    assert.deepEqual([resizes().at(-1).params.width, resizes().at(-1).params.height], [750, 500]);
});
