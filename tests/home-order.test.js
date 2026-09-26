import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOrder, reorderAt } from '../libraries/shared/home-order.js';
import { attachReorder } from '../cores/ui/home/reorder.js';

const box = (id, x, y, w = 100, h = 100) => ({ id, x, y, w, h });

test('applyOrder puts known ids in the saved order, new blocks follow in their usual order, stale ids are ignored', () => {
    const blocks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    assert.deepEqual(applyOrder(blocks, ['c', 'gone', 'a']).map(b => b.id), ['c', 'a', 'b', 'd']);
    assert.deepEqual(applyOrder(blocks, []).map(b => b.id), ['a', 'b', 'c', 'd'], 'nothing saved — usual order');
});

test('reorderAt drops the block before/after the block under the point, or next to the nearest one', () => {
    const placements = [box('a', 0, 0), box('b', 110, 0), box('c', 0, 110)];
    assert.deepEqual(reorderAt(placements, 'a', { x: 190, y: 50 }), ['b', 'a', 'c'], 'right half of b — after b');
    assert.deepEqual(reorderAt(placements, 'c', { x: 120, y: 50 }), ['a', 'c', 'b'], 'left half of b — before b');
    assert.deepEqual(reorderAt(placements, 'a', { x: 50, y: 400 }), ['b', 'c', 'a'], 'far below — after the nearest (c)');
    assert.deepEqual(reorderAt([box('a', 0, 0)], 'a', { x: 5, y: 5 }), ['a'], 'a single block stays');
});

function fakeWin() {
    const timers = [];
    return {
        listeners: {}, timers, navigator: {},
        addEventListener(t, f) { (this.listeners[t] ??= []).push(f); },
        removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] ?? []).filter(x => x !== f); },
        setTimeout(fn) { timers.push(fn); return timers.length; },
        clearTimeout(id) { timers[id - 1] = null; },
        fire(type, event) { (this.listeners[type] ?? []).slice().forEach(fn => fn(event)); },
    };
}
const fakeEl = () => { const l = {}; return { addEventListener(t, f) { (l[t] ??= []).push(f); }, removeEventListener(t, f) { l[t] = (l[t] ?? []).filter(x => x !== f); }, emit(t, e) { (l[t] ?? []).forEach(f => f(e)); } }; };

test('touch: holding still lifts the block, then it follows the finger and drops on release; moving early is a scroll and lifts nothing', () => {
    const win = fakeWin();
    const el = fakeEl();
    const log = [];
    attachReorder(el, { win, onStart: p => log.push(['start', p.clientY]), onMove: p => log.push(['move', p.clientY]), onEnd: p => log.push(['end', p.clientY]) });

    el.emit('pointerdown', { clientX: 10, clientY: 10, button: 0, pointerType: 'touch' });
    win.fire('pointermove', { clientX: 10, clientY: 40 });
    win.timers.forEach(fn => fn?.());
    win.fire('pointerup', {});
    assert.deepEqual(log, [], 'a swipe before the long press cancels it (the page scrolls)');

    el.emit('pointerdown', { clientX: 10, clientY: 10, button: 0, pointerType: 'touch' });
    win.timers.filter(Boolean).at(-1)();
    assert.equal(el.__dragged, true);
    win.fire('pointermove', { clientX: 10, clientY: 90 });
    win.fire('pointerup', {});
    assert.deepEqual(log, [['start', 10], ['move', 90], ['end', 90]]);
    assert.equal((win.listeners.pointermove ?? []).length, 0);
});

test('mouse: a small move stays a click, a bigger one reorders at once', () => {
    const win = fakeWin();
    const el = fakeEl();
    const log = [];
    attachReorder(el, { win, onStart: () => log.push('start'), onMove: () => log.push('move'), onEnd: () => log.push('end') });
    el.emit('pointerdown', { clientX: 0, clientY: 0, button: 0, pointerType: 'mouse' });
    win.fire('pointermove', { clientX: 2, clientY: 1 });
    win.fire('pointerup', {});
    assert.deepEqual(log, []);
    el.emit('pointerdown', { clientX: 0, clientY: 0, button: 0, pointerType: 'mouse' });
    win.fire('pointermove', { clientX: 30, clientY: 0 });
    win.fire('pointerup', {});
    assert.deepEqual(log, ['start', 'move', 'end']);
});
