import test from 'node:test';
import assert from 'node:assert/strict';
import { createEdgeDrag } from '../libraries/shared/edge-drag.js';

/**
 * Набор для [edge-drag.js](../libraries/shared/edge-drag.js) — перетаскивание
 * пилюли-дока вдоль края экрана (просьба пользователя 2026-09: «навести — она
 * развернётся, перетащить — свернётся на новом месте, место сохраняется»).
 *
 * Библиотека чистая (только числа + переданный storage), поэтому тестируется
 * без браузера — тем же способом, что draggable.test.js: фейковые события
 * с координатами, фейковый storage, фейковый «элемент» в виде сеттеров.
 *
 * Дисциплина непустоты (проектное правило): набор проверялся на отказ
 * временным выведением порога DRAG_THRESHOLD_PX → 0 — пороговые тесты
 * ('a 1px nudge is NOT a drag' и соседний) падали, после восстановления
 * проходили.
 */

/** Фейковые координатные события + фейковый элемент с pointer capture. */
function harness({ viewportHeight = 1000, height = 260, bottom = 140 } = {}) {
    const state = {
        bottom, // текущий отступ снизу — как style.bottom у зоны
        stored: null, // что записали в storage
        capture: null,
    };
    const drag = createEdgeDrag({
        storage: {
            getItem: () => state.stored,
            setItem: value => { state.stored = value; },
        },
        getViewportHeight: () => viewportHeight,
        getHeight: () => height,
        getBottom: () => state.bottom,
        setBottom: px => { state.bottom = px; },
    });
    const element = {
        setPointerCapture: id => { state.capture = id; },
        releasePointerCapture: () => { state.capture = null; },
    };
    let id = 0;
    const fire = (type, { clientY, pointerType = 'mouse', button = 0 } = {}) => {
        const event = {
            pointerId: ++id, clientY, pointerType, button,
            currentTarget: element,
            target: null,
        };
        drag[`on:${type}`](event);
        return event;
    };
    return { drag, state, fire };
}

test('dragging along the edge moves bottom and stores the resting place', () => {
    const { state, fire } = harness({ bottom: 140 });
    fire('pointerdown', { clientY: 500 });
    fire('pointermove', { clientY: 400 }); // вверх на 100 → bottom 240
    fire('pointerup', { clientY: 400 });
    assert.equal(state.bottom, 240, 'upward drag increases bottom by the distance');
    assert.equal(state.stored, '240', 'the resting place is persisted');
});

test('the resting place is restored on mount and clamped into the viewport', () => {
    const small = harness({ viewportHeight: 500, height: 260, bottom: 140 });
    small.state.stored = '900'; // оставлено «у края» огромного экрана
    small.drag.restore();
    assert.equal(small.state.bottom, 240, 'clamped to viewportHeight - height');
    // Битая запись не роняет инициализацию и ничего не двигает.
    const broken = harness();
    broken.state.stored = 'banana';
    broken.drag.restore();
    assert.equal(broken.state.bottom, 140, 'garbage storage leaves the CSS place alone');
});

test('a 1px nudge is NOT a drag — no storage write, click stays a click', () => {
    const { drag, state, fire } = harness();
    fire('pointerdown', { clientY: 500 });
    fire('pointermove', { clientY: 499 }); // 1px — дрожь руки, порог 4px
    fire('pointerup', { clientY: 499 });
    assert.equal(state.bottom, 140, 'position untouched');
    assert.equal(state.stored, null, 'nothing persisted');
    assert.equal(drag.suppressClick, false, 'click must survive');
});

test('after a REAL drag the following click is suppressed', () => {
    const { drag, fire } = harness();
    fire('pointerdown', { clientY: 500 });
    fire('pointermove', { clientY: 300 });
    fire('pointerup', { clientY: 300 });
    assert.equal(drag.suppressClick, true, 'click gassed after a drag');
});

test('drag clamps at both ends of the edge', () => {
    const { state, fire } = harness({ viewportHeight: 1000, height: 260, bottom: 20 });
    fire('pointerdown', { clientY: 500 });
    // Оба движения считаются ОТ ТОЧКИ ЗАХВАТА (startBottom - dy), не друг от
    // друга — как и в живом pointermove-потоке между двумя иными точками.
    fire('pointermove', { clientY: 900 }); // вниз на 400, а места только 20
    assert.equal(state.bottom, 0, 'cannot be dragged below the bottom edge');
    fire('pointermove', { clientY: -600 }); // вверх на 1100, а потолок 1000-260=740
    assert.equal(state.bottom, 740, 'cannot be dragged past the top edge');
});

test('touch pointers are ignored — the tap contract owns that surface', () => {
    const { state, fire } = harness();
    fire('pointerdown', { clientY: 500, pointerType: 'touch' });
    fire('pointermove', { clientY: 300 });
    fire('pointerup', { clientY: 300 });
    assert.equal(state.bottom, 140, 'position untouched');
    assert.equal(state.stored, null, 'nothing persisted');
});
