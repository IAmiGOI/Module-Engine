import test from 'node:test';
import assert from 'node:assert/strict';
import { signal } from '../cores/ui/reactive.js';
import { createDragHandlers, clampToViewport } from '../libraries/shared/draggable.js';

/** Поддельное событие указателя — ровно те поля, что читает библиотека, и ничего сверх. */
function pointer(x, y, { target, currentTarget, button = 0 } = {}) {
    const captured = [];
    const released = [];
    return {
        button,
        pointerId: 1,
        clientX: x,
        clientY: y,
        target: target ?? { closest: () => null },
        currentTarget: currentTarget ?? {
            setPointerCapture: id => captured.push(id),
            releasePointerCapture: id => released.push(id),
            parentElement: null,
        },
        preventDefault: () => {},
        captured,
        released,
    };
}

test('dragging moves the position by exactly the pointer delta — the window follows the cursor, it does not lead it', () => {
    const position = signal({ left: 100, top: 50 });
    const handlers = createDragHandlers(position);

    handlers['on:pointerdown'](pointer(200, 200));
    handlers['on:pointermove'](pointer(230, 180));

    assert.deepEqual(position(), { left: 130, top: 30 });
});

test('a window that has never been moved starts from where it actually IS on screen, not from zero', () => {
    const position = signal({});
    const handlers = createDragHandlers(position);
    // Ручка лежит внутри окна, поэтому его коробку библиотека берёт у родителя.
    const inWindow = { setPointerCapture: () => {}, releasePointerCapture: () => {}, parentElement: { getBoundingClientRect: () => ({ left: 900, top: 600 }) } };

    handlers['on:pointerdown'](pointer(950, 650, { currentTarget: inWindow }));
    handlers['on:pointermove'](pointer(940, 630, { currentTarget: inWindow }));

    assert.deepEqual(position(), { left: 890, top: 580 }, 'без этого первое же движение телепортировало бы окно в левый верхний угол');
});

test('nothing moves until a drag actually started — a stray pointermove must not drift the window', () => {
    const position = signal({ left: 10, top: 10 });
    const handlers = createDragHandlers(position);

    handlers['on:pointermove'](pointer(500, 500));

    assert.deepEqual(position(), { left: 10, top: 10 });
});

test('a press on a button inside the handle does NOT start a drag — collapse must not turn into a micro-move', () => {
    const position = signal({ left: 10, top: 10 });
    const handlers = createDragHandlers(position);
    const onButton = { closest: selector => (selector === 'button' ? {} : null) };

    handlers['on:pointerdown'](pointer(0, 0, { target: onButton }));
    handlers['on:pointermove'](pointer(300, 300));

    assert.deepEqual(position(), { left: 10, top: 10 });
});

test('the right mouse button does not drag', () => {
    const position = signal({ left: 10, top: 10 });
    const handlers = createDragHandlers(position);

    handlers['on:pointerdown'](pointer(0, 0, { button: 2 }));
    handlers['on:pointermove'](pointer(300, 300));

    assert.deepEqual(position(), { left: 10, top: 10 });
});

test('the pointer is captured for the drag and released after — without it a fast move loses the window', () => {
    const position = signal({ left: 0, top: 0 });
    const handlers = createDragHandlers(position);
    const captured = [];
    const released = [];
    const handle = { setPointerCapture: id => captured.push(id), releasePointerCapture: id => released.push(id), parentElement: null };

    handlers['on:pointerdown'](pointer(0, 0, { currentTarget: handle }));
    handlers['on:pointerup'](pointer(10, 10, { currentTarget: handle }));

    assert.deepEqual(captured, [1]);
    assert.deepEqual(released, [1]);
});

test('releasing reports the dropped position, so the caller can persist it', () => {
    const position = signal({ left: 0, top: 0 });
    const dropped = [];
    const handlers = createDragHandlers(position, { onDrop: value => dropped.push(value) });

    handlers['on:pointerdown'](pointer(0, 0));
    handlers['on:pointermove'](pointer(40, 25));
    handlers['on:pointerup'](pointer(40, 25));

    assert.deepEqual(dropped, [{ left: 40, top: 25 }]);
});

test('a second drag continues from where the first ended, instead of jumping back', () => {
    const position = signal({ left: 0, top: 0 });
    const handlers = createDragHandlers(position);

    handlers['on:pointerdown'](pointer(0, 0));
    handlers['on:pointermove'](pointer(50, 50));
    handlers['on:pointerup'](pointer(50, 50));
    handlers['on:pointerdown'](pointer(200, 200));
    handlers['on:pointermove'](pointer(210, 190));

    assert.deepEqual(position(), { left: 60, top: 40 });
});

test('clampToViewport keeps a window on screen — one dragged past the edge takes its own drag handle with it', () => {
    const clamped = clampToViewport({ left: -250, top: -124 }, { width: 200, height: 120, viewportWidth: 1000, viewportHeight: 800 });

    assert.deepEqual(clamped, { left: 0, top: 0 });
});

test('clampToViewport stops a window from hiding past the far edge as well', () => {
    const clamped = clampToViewport({ left: 5000, top: 5000 }, { width: 200, height: 120, viewportWidth: 1000, viewportHeight: 800 });

    assert.deepEqual(clamped, { left: 800, top: 680 });
});

test('a window larger than the viewport is pinned at the origin rather than pushed off the top-left', () => {
    const clamped = clampToViewport({ left: 300, top: 300 }, { width: 2000, height: 2000, viewportWidth: 1000, viewportHeight: 800 });

    assert.deepEqual(clamped, { left: 0, top: 0 });
});
