import test from 'node:test';
import assert from 'node:assert/strict';
import { signal } from '../cores/ui/reactive.js';
import { TOOLS_RIGHT_SPACE } from '../libraries/shared/message-tools-model.js';
import { INPUT_PANEL_GAP, SIDE_BAR_INSET, SIDE_TOP_INSET, LEFT_DOCK_REACH, minSideMargin } from '../libraries/shared/chat-viewport-overlay-math.js';
import { createChatViewportOverlay } from '../cores/ui/chat-viewport-overlay/overlay.js';

/** A tiny fake page: every dom.* call is recorded, elements are plain objects, chatViewport is a recorder. */
function makeHarness({ touchPill = false, withPill = false, formTop = { value: 520 }, attachResult = true, sideMargin = 24, failWhen = () => false, scroll = { top: 754 } } = {}) {
    const calls = [];
    const resizeHandlers = [];
    const emitted = [];
    const hovers = [];
    const rafQueue = [];
    const subscriptions = new Map();
    const unsubscribed = [];
    const windowListeners = new Set();
    const viewportCalls = [];
    let detached = 0;

    const respond = (contract, params) => {
        calls.push({ contract, params });
        switch (contract) {
            case 'stChat.container': return { ok: true, value: { id: 'chat' } };
            case 'dom.body': return { ok: true, value: { id: 'body' } };
            case 'dom.createElement': return { ok: true, value: { tag: params.tag, scrollTop: 0 } };
            // The chat starts at y=40, 600px tall; the input form sits right under it (y=640), so geometry sync finds nothing to change.
            case 'dom.measureRect': return { ok: true, value: { top: params.el?.id === 'form' ? formTop.value : 40, left: 0, width: 800, height: 600 } };
            case 'dom.clientSize': return { ok: true, value: { width: 1000, height: 600 } };
            case 'dom.readCssVariable': return { ok: true, value: params.name === 'font-family' ? 'Foo, serif' : '#abcdef' };
            case 'dom.querySelector':
                if (params.selector.includes('stme-side-bar-active')) return { ok: true, value: withPill && !touchPill ? { id: 'holder' } : null };
                return { ok: true, value: params.selector === '.stme-input-bar' && !withPill ? null : { id: 'form' } };
            case 'dom.parentElement': return { ok: true, value: { id: 'sheld' } };
            case 'dom.scrollPosition': return { ok: true, value: scroll };
            case 'dom.observeResize': resizeHandlers.push(params.handler); return { ok: true, value: true };
            default: return { ok: true, value: undefined };
        }
    };
    const callService = async (contract, params) => respond(contract, params);
    const callServiceOrThrow = async (contract, params) => {
        if (failWhen(contract, params)) throw new Error(`${contract} refused`);
        const result = respond(contract, params);
        return result.value;
    };
    const host = {
        events: {
            subscribe: (name, handler) => { subscriptions.set(name, handler); return () => { unsubscribed.push(name); subscriptions.delete(name); }; },
            emit: (name, payload) => { emitted.push([name, payload]); },
        },
    };
    const chatViewport = {
        attach: async args => { chatViewport.attachArgs = args; return attachResult; },
        detach: async () => { detached += 1; },
        totalHeight: () => 1234,
        renderedScrollTop: () => 0,
        canvasPad: () => 100,
        setViewport: args => viewportCalls.push(args),
        hoverAt: point => { hovers.push(point); },
        hoverLeave: () => { hovers.push('leave'); },
    };
    const win = {
        addEventListener: (type, handler) => windowListeners.add(`${type}`),
        removeEventListener: type => windowListeners.delete(`${type}`),
        requestAnimationFrame: callback => { rafQueue.push(callback); return rafQueue.length; },
    };
    const margin = signal(sideMargin);
    const overlay = createChatViewportOverlay({ host, chatViewport, callService, callServiceOrThrow, sideMargin: margin, onMarginCommit: () => {}, win });
    const names = contract => calls.filter(call => call.contract === contract);
    return { rafQueue, hovers, emitted, resizeHandlers, formTop, overlay, calls, names, subscriptions, unsubscribed, windowListeners, chatViewport, viewportCalls, margin, detachedCount: () => detached };
}

test('enable() builds the overlay, sizes the canvas by the side margin, and reports ok', async () => {
    const h = makeHarness();
    const result = await h.overlay.enable();
    assert.deepEqual(result, { ok: true });
    assert.equal(h.overlay.isActive(), true);
    assert.equal(h.chatViewport.attachArgs.width, 1000 - 24 * 2);
    assert.equal(h.chatViewport.attachArgs.height, 600 - 40 - 80, 'the visible area is the window minus the top bar and the input panel');
    assert.match(h.chatViewport.attachArgs.css, /color: #abcdef;/);
    assert.match(h.chatViewport.attachArgs.css, /font-family: Foo, serif;/);
    assert.deepEqual([...h.subscriptions.keys()].sort(), ['ui.chatViewport.render.completed', 'ui.chatViewport.scrollRequest', 'ui.inputBar.changed']);
    assert.equal(h.names('dom.suppressStyleRules').length, 1);
    assert.equal(h.names('dom.overrideRootStyles').length, 1);
});

test('an oversized side margin is clamped so the canvas never gets narrower than half the page', async () => {
    const h = makeHarness({ sideMargin: 9999 });
    await h.overlay.enable();
    assert.equal(h.chatViewport.attachArgs.width, 500);
});

test('the overlay covers the whole window: it sits inside #sheld, is padded by the top bar and the input panel, and its sticky layer sticks to the content edge (right below the top bar)', async () => {
    const h = makeHarness();
    await h.overlay.enable();
    const wrapperStyle = h.names('dom.setProp').find(call => call.params.key === 'style' && call.params.value.position === 'fixed')?.params.value;
    assert.equal(wrapperStyle.top, '0px');
    assert.equal(wrapperStyle.bottom, '0px');
    assert.equal(wrapperStyle.paddingTop, '40px');
    assert.equal(wrapperStyle.zIndex, -1, 'under the input panel (in flow inside #sheld), above the transparent #sheld background');
    const sticky = h.names('dom.setProp').find(call => call.params.key === 'style' && call.params.value.position === 'sticky')?.params.value;
    assert.equal(sticky.top, '0px', 'sticky offsets count from the padding edge, so no extra top here');
    assert.ok(h.names('dom.append').some(call => call.params.parent?.id === 'sheld'), 'appended to #sheld, not to body');
    assert.equal(h.names('dom.setProp').some(call => call.params.value?.paddingBottom === '80px'), true, 'bottom padding = window bottom minus the input panel top');
});

test('when the input panel grows, the bottom padding and the visible area follow it, and a chat pinned to the bottom stays pinned', async () => {
    const formTop = { value: 520 };
    const h = makeHarness({ formTop, scroll: { top: 754 } });
    await h.overlay.enable();
    await new Promise(resolve => setTimeout(resolve, 5)); // the first sync started by enable() is fire-and-forget
    h.calls.length = 0;
    h.viewportCalls.length = 0;
    formTop.value = 420; // the textarea grew by 100px
    await h.resizeHandlers.at(-1)();
    await new Promise(resolve => setTimeout(resolve, 5));
    const padding = h.names('dom.setProp').find(call => call.params.value?.paddingBottom)?.params.value;
    assert.equal(padding.paddingBottom, '180px');
    const sticky = h.names('dom.setProp').find(call => call.params.value?.marginBottom)?.params.value;
    assert.equal(sticky.height, '380px');
    assert.equal(h.viewportCalls.at(-1).viewportHeight, 380);
    assert.equal(h.names('dom.setScrollPosition')[0].params.top, 754 + 100, 'pinned to the bottom: the content moves up together with the panel');
});

test('with our own input pill the last message keeps a gap above it (the native panel has none)', async () => {
    const formTop = { value: 520 };
    const h = makeHarness({ withPill: true, formTop, scroll: { top: 754 } });
    await h.overlay.enable();
    await new Promise(resolve => setTimeout(resolve, 5));
    const padding = h.names('dom.setProp').filter(call => call.params.value?.paddingBottom).at(-1).params.value.paddingBottom;
    assert.equal(padding, `${600 - 520 + INPUT_PANEL_GAP}px`, 'window bottom minus the pill top, plus the gap');
    const sticky = h.names('dom.setProp').filter(call => call.params.value?.marginBottom).at(-1).params.value;
    assert.equal(sticky.height, `${600 - (40 + SIDE_TOP_INSET) - (600 - 520 + INPUT_PANEL_GAP)}px`, 'the visible area shrinks by the gap and by the small top inset (no top bar any more)');
    const wrapperStyle = h.names('dom.setProp').find(call => call.params.key === 'style' && call.params.value.position === 'fixed')?.params.value;
    assert.equal(wrapperStyle.left, `${SIDE_BAR_INSET}px`, 'the overlay starts to the right of the side bar');
    assert.equal(wrapperStyle.width, `${1000 - SIDE_BAR_INSET}px`);
    assert.equal(wrapperStyle.paddingTop, `${40 + SIDE_TOP_INSET}px`);
});

test('the message column is reported in WINDOW coordinates — shifted right by the side bar — so the input pill stands exactly under it', async () => {
    const h = makeHarness({ withPill: true });
    await h.overlay.enable();
    const column = h.emitted.filter(([name]) => name === 'ui.chatViewport.columnChanged').at(-1)[1];
    const margin = minSideMargin(SIDE_BAR_INSET);
    assert.equal(column.left, margin + SIDE_BAR_INSET, 'the margin is raised to the left dock reach, so the column never runs under the open dock; plus the side bar inset');
    assert.equal(column.left >= LEFT_DOCK_REACH, true);
    assert.equal(column.width, 1000 - 2 * margin - TOOLS_RIGHT_SPACE, 'the fake reports the wrapper client width as 1000 — the width is the wrapper width minus both margins and the room kept for the message tools panel');
});

test('on a phone (own pill but the native top strip stays) the overlay keeps the full width and the old top offset', async () => {
    const h = makeHarness({ withPill: true, touchPill: true });
    await h.overlay.enable();
    const wrapperStyle = h.names('dom.setProp').find(call => call.params.key === 'style' && call.params.value.position === 'fixed')?.params.value;
    assert.equal(wrapperStyle.left, '0px');
    assert.equal(wrapperStyle.width, '1000px');
    assert.equal(wrapperStyle.paddingTop, '40px', 'no extra top inset: the native top strip is still there');
});

test('hovering the chat reports the cursor in the coordinates of the core frame (column-relative x, frame-relative y with the live scroll delta), once per frame, and touch is ignored', async () => {
    const h = makeHarness({ withPill: true });
    await h.overlay.enable();
    const wrapper = h.calls.find(call => call.contract === 'dom.createElement' && call.params.tag === 'div');
    void wrapper;
    const move = h.calls.filter(call => call.contract === 'dom.setProp' && call.params.key === 'on:pointermove').at(-1).params.value;
    const leave = h.calls.filter(call => call.contract === 'dom.setProp' && call.params.key === 'on:pointerleave').at(-1).params.value;
    h.rafQueue.length = 0;
    move({ clientX: 500, clientY: 300 });
    move({ clientX: 510, clientY: 310 });
    assert.equal(h.rafQueue.length, 1, 'coalesced into one call per frame');
    h.rafQueue.shift()();
    // x: окно 510 − (оверлей начинается на боковой панели 52 + боковой отступ, поднятый до досягаемости левого дока); y: окно 310 − (панель 40 + отступ сверху 8) + сдвиг прокрутки 0.
    assert.deepEqual(h.hovers, [{ x: 510 - SIDE_BAR_INSET - minSideMargin(SIDE_BAR_INSET), y: 310 - 48 }]);
    move({ pointerType: 'touch', clientX: 1, clientY: 1 });
    assert.equal(h.rafQueue.length, 0, 'touch has no hover');
    leave();
    assert.equal(h.hovers.at(-1), 'leave');
});

test('disable() undoes everything enable() did — subscriptions, window listener, canvas, ST style overrides', async () => {
    const h = makeHarness();
    await h.overlay.enable();
    assert.ok(h.windowListeners.has('resize'));
    await h.overlay.disable();
    assert.equal(h.overlay.isActive(), false);
    assert.equal(h.detachedCount(), 1);
    assert.equal(h.subscriptions.size, 0);
    assert.equal(h.windowListeners.has('resize'), false);
    assert.equal(h.names('dom.remove').length, 1);
    assert.equal(h.names('dom.restoreStyleRules').length, 1);
    assert.equal(h.names('dom.restoreRootStyles').length, 1);
    await h.overlay.disable(); // a second call is a no-op, not a second teardown
    assert.equal(h.detachedCount(), 1);
});

test('a browser without WebGL leaves the native chat alone — overlay removed, no ST style rules touched, nothing left subscribed', async () => {
    const h = makeHarness({ attachResult: false });
    const result = await h.overlay.enable();
    assert.deepEqual(result, { ok: false, reason: 'webgl-unavailable' });
    assert.equal(h.overlay.isActive(), false);
    assert.equal(h.names('dom.remove').length, 1);
    assert.equal(h.names('dom.suppressStyleRules').length, 0);
    assert.equal(h.subscriptions.size, 0);
    assert.equal(h.detachedCount(), 0);
});

test('a failure BEFORE attach removes the half-built overlay from the page instead of leaving it there', async () => {
    const h = makeHarness({ failWhen: contract => contract === 'dom.readCssVariable' });
    await assert.rejects(() => h.overlay.enable(), /dom\.readCssVariable refused/);
    assert.equal(h.overlay.isActive(), false);
    assert.equal(h.names('dom.remove').length, 1);
    assert.equal(h.detachedCount(), 0);
});

test('a failure AFTER attach detaches the viewport core and removes the overlay too', async () => {
    const h = makeHarness({ failWhen: (contract, params) => contract === 'dom.setProp' && params.key === 'on:scroll' });
    await assert.rejects(() => h.overlay.enable(), /refused/);
    assert.equal(h.overlay.isActive(), false);
    assert.equal(h.detachedCount(), 1);
    assert.equal(h.names('dom.remove').length, 1);
});

test('when the chat GROWS while the user is pinned to the bottom, the wrapper follows it down', async () => {
    const h = makeHarness({ scroll: { top: 754 } }); // 754 + 480 (visible area) == the initial 1234 total height
    await h.overlay.enable();
    await new Promise(resolve => setTimeout(resolve, 0)); // let the fire-and-forget first geometry sync finish
    h.calls.length = 0;
    await h.subscriptions.get('ui.chatViewport.render.completed')({ totalHeight: 1500 });
    const scrolled = h.names('dom.setScrollPosition');
    assert.equal(scrolled.length, 1);
    assert.equal(scrolled[0].params.top, 1500 - 480);
    assert.deepEqual(h.names('dom.setProp').find(call => call.params.key === 'style' && call.params.value.height === '1500px')?.params.value, { height: '1500px' });
});

test('a render that did not grow the chat never yanks the scroll position back (the slow-scroll-up jitter)', async () => {
    const h = makeHarness({ scroll: { top: 754 } });
    await h.overlay.enable();
    await new Promise(resolve => setTimeout(resolve, 0)); // let the fire-and-forget first geometry sync finish
    h.calls.length = 0;
    await h.subscriptions.get('ui.chatViewport.render.completed')({ totalHeight: 1234 });
    assert.equal(h.names('dom.setScrollPosition').length, 0);
});

test('a user toggle (expanding a reasoning block) does not auto-scroll even though the chat grew', async () => {
    const h = makeHarness({ scroll: { top: 754 } });
    await h.overlay.enable();
    await new Promise(resolve => setTimeout(resolve, 0)); // let the fire-and-forget first geometry sync finish
    h.calls.length = 0;
    await h.subscriptions.get('ui.chatViewport.render.completed')({ totalHeight: 1500, userToggle: true });
    assert.equal(h.names('dom.setScrollPosition').length, 0);
});

test('the core asking to scroll to an absolute position is forwarded to the wrapper', async () => {
    const h = makeHarness();
    await h.overlay.enable();
    await new Promise(resolve => setTimeout(resolve, 0)); // let the fire-and-forget first geometry sync finish
    h.calls.length = 0;
    await h.subscriptions.get('ui.chatViewport.scrollRequest')({ scrollTop: 321 });
    assert.equal(h.names('dom.setScrollPosition')[0].params.top, 321);
});
