import test from 'node:test';
import assert from 'node:assert/strict';
import { SEND_ON_ENTER, shouldSendOnKey, computeFieldHeight, maxFieldHeight, sendButtonMode, computeBarColumn } from '../libraries/shared/input-bar-model.js';

test('Enter sends on desktop by default, never on a touch screen in AUTO mode, and Shift+Enter is always a new line', () => {
    assert.equal(shouldSendOnKey({ key: 'Enter' }), true);
    assert.equal(shouldSendOnKey({ key: 'Enter', touch: true }), false);
    assert.equal(shouldSendOnKey({ key: 'Enter', shiftKey: true }), false);
    assert.equal(shouldSendOnKey({ key: 'a' }), false);
});

test('the ST setting decides: DISABLED never sends on plain Enter, ENABLED always does (even on touch); Ctrl/Cmd+Enter always sends', () => {
    assert.equal(shouldSendOnKey({ key: 'Enter', sendOnEnter: SEND_ON_ENTER.DISABLED }), false);
    assert.equal(shouldSendOnKey({ key: 'Enter', sendOnEnter: SEND_ON_ENTER.ENABLED, touch: true }), true);
    assert.equal(shouldSendOnKey({ key: 'Enter', sendOnEnter: SEND_ON_ENTER.DISABLED, ctrlKey: true }), true);
    assert.equal(shouldSendOnKey({ key: 'Enter', sendOnEnter: SEND_ON_ENTER.DISABLED, metaKey: true }), true);
});

test('Enter during IME composition belongs to the IME and never sends', () => {
    assert.equal(shouldSendOnKey({ key: 'Enter', isComposing: true }), false);
    assert.equal(shouldSendOnKey({ key: 'Enter', isComposing: true, ctrlKey: true }), false);
});

test('the field is at least one line and grows with the text up to the ceiling, then scrolls', () => {
    assert.deepEqual(computeFieldHeight({ scrollHeight: 20, minHeight: 42, maxHeight: 200 }), { height: 42, scrolls: false });
    assert.deepEqual(computeFieldHeight({ scrollHeight: 120, minHeight: 42, maxHeight: 200 }), { height: 120, scrolls: false });
    assert.deepEqual(computeFieldHeight({ scrollHeight: 500, minHeight: 42, maxHeight: 200 }), { height: 200, scrolls: true });
    assert.deepEqual(computeFieldHeight({ scrollHeight: NaN, minHeight: 42, maxHeight: 200 }), { height: 42, scrolls: false });
});

test('the ceiling is a fraction of the window, clamped between a floor and a hard limit', () => {
    assert.equal(maxFieldHeight(800), 320);
    assert.equal(maxFieldHeight(500), 200);
    assert.equal(maxFieldHeight(100), 88);
    assert.equal(maxFieldHeight(0), 88);
});

test('the round button on the right is Stop while generating and Send otherwise', () => {
    assert.equal(sendButtonMode({ generating: true }), 'stop');
    assert.equal(sendButtonMode({ generating: false }), 'send');
});

test('the bar follows the message column when the overlay reports one, and otherwise centres with side gaps', () => {
    assert.deepEqual(computeBarColumn({ column: { left: 24.4, width: 951.6 }, windowWidth: 1000 }), { left: 24, width: 952 });
    assert.deepEqual(computeBarColumn({ column: null, windowWidth: 1000 }), { left: 20, width: 960 });
    assert.deepEqual(computeBarColumn({ column: null, windowWidth: 400 }), { left: 12, width: 376 });
    assert.deepEqual(computeBarColumn({ column: { left: 0, width: 0 }, windowWidth: 300 }), { left: 12, width: 276 });
});
