import test from 'node:test';
import assert from 'node:assert/strict';
import { computeStageRect, useFlowLayout, HOME_BOTTOM_MARGIN } from '../cores/ui/home/geometry.js';

const docWith = ({ side = false, stripBottom = 0 } = {}) => ({
    documentElement: { classList: { contains: name => side && name === 'stme-side-bar-active' } },
    getElementById: id => (id === 'top-settings-holder' ? { getBoundingClientRect: () => ({ bottom: stripBottom }) } : null),
});

test('desktop with the side bar: the stage is the window minus the side bar on the left and a small top inset', () => {
    const rect = computeStageRect({ doc: docWith({ side: true }), win: { innerWidth: 1280, innerHeight: 720 } });
    assert.deepEqual([rect.left, rect.top, rect.width, rect.height], [52, 8, 1228, 720 - 8 - HOME_BOTTOM_MARGIN]);
});

test('phone: the stage starts UNDER the native icon strip of ST (it used to cover the first blocks) and spans the full width', () => {
    const rect = computeStageRect({ doc: docWith({ stripBottom: 88 }), win: { innerWidth: 406, innerHeight: 802 } });
    assert.deepEqual([rect.left, rect.top, rect.width], [0, 94, 406]);
    assert.equal(rect.height, 802 - 94 - HOME_BOTTOM_MARGIN);
    const noStrip = computeStageRect({ doc: docWith(), win: { innerWidth: 406, innerHeight: 802 } });
    assert.equal(noStrip.top, 0, 'no strip measured — no inset');
});

test('the desk flows (and scrolls) on touch and in a narrow window, and lays out on a stage on a wide non-touch window', () => {
    assert.equal(useFlowLayout({ touch: true, width: 1400 }), true);
    assert.equal(useFlowLayout({ touch: false, width: 400 }), true);
    assert.equal(useFlowLayout({ touch: false, width: 699 }), true);
    assert.equal(useFlowLayout({ touch: false, width: 700 }), false);
});
