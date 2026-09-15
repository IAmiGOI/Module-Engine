import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { createChatViewportCore } from '../cores/ui/chat-viewport.js';

/**
 * Scenario level (TESTING.md "Уровень 2") — real engine, real Гейт, only the
 * four Сервисы this Ядро touches are faked (`stChat`, `dom`, `htmlRasterizer`,
 * `webglChat`) — none of them can run for real in Node (real ST context,
 * real browser DOM, real WebGL). The fake `dom.measureRect` looks up a
 * height by the exact HTML string the fake `dom.setInnerHtml` most recently
 * wrote into that element — the same "real layout would answer this, our
 * fake stands in for the browser" boundary TESTING.md draws for Services.
 */

function buildEngine({ messages = [], heightByHtml = new Map(), glAvailable = true, chromeHeight = 0 } = {}) {
    const engine = createEngine();
    const calls = {
        deleteMessage: [], swipe: [], regenerate: [], setText: [],
        uploadTexture: [], releaseTexture: [], drawFrame: [], rasterize: [],
        setInnerHtml: [], domRemove: [], classChanges: [], resize: [], append: [],
    };

    let elCounter = 0;
    const makeEl = tag => ({ __id: (elCounter += 1), tag, html: '', props: {} });

    engine.buses.services.register('dom.createElement', ({ tag }) => makeEl(tag));
    engine.buses.services.register('dom.setProp', ({ el, key, value }) => {
        el.props[key] = value;
        if (key === 'class') calls.classChanges.push(value);
        return true;
    });
    engine.buses.services.register('dom.removeProp', ({ el, key }) => {
        delete el.props[key];
        if (key === 'class') calls.classChanges.push(null);
        return true;
    });
    engine.buses.services.register('dom.append', ({ parent, child }) => { calls.append.push({ parent: parent?.__id ?? parent, child: child?.__id ?? child }); return true; });
    engine.buses.services.register('dom.remove', ({ node }) => { calls.domRemove.push(node.__id); return true; });
    engine.buses.services.register('dom.setInnerHtml', ({ el, html }) => { el.html = html; calls.setInnerHtml.push(html); return true; });
    engine.buses.services.register('dom.measureRect', ({ el }) => ({
        width: 300,
        height: el.__chromeRoot ? chromeHeight : (heightByHtml.get(el.html) ?? 96),
        top: 0, left: 0,
    }));

    engine.buses.services.register('stChat.messages', () => messages);
    engine.buses.services.register('stChat.formatMessage', ({ mesid }) => `<p>${messages.find(m => m.mesid === mesid)?.text}</p>`);
    engine.buses.services.register('stChat.container', () => makeEl('div'));
    engine.buses.services.register('stChat.deleteMessage', p => { calls.deleteMessage.push(p); return true; });
    engine.buses.services.register('stChat.swipe', p => { calls.swipe.push(p); return true; });
    engine.buses.services.register('stChat.regenerate', () => { calls.regenerate.push(true); return true; });
    engine.buses.services.register('stChat.setText', p => { calls.setText.push(p); return true; });

    engine.buses.services.register('htmlRasterizer.rasterize', ({ html, width, height, scale }) => {
        calls.rasterize.push({ html, width, height, scale });
        return { image: { __fakeImage: true }, width: Math.round(width * (scale || 1)), height: Math.round(height * (scale || 1)) };
    });

    engine.buses.services.register('webglChat.attach', () => glAvailable);
    engine.buses.services.register('webglChat.resize', ({ width, height }) => { calls.resize?.push({ width, height }); return true; });
    engine.buses.services.register('webglChat.detach', () => true);
    engine.buses.services.register('webglChat.uploadTexture', ({ textureId }) => { calls.uploadTexture.push(textureId); return true; });
    engine.buses.services.register('webglChat.releaseTexture', ({ textureId }) => { calls.releaseTexture.push(textureId); return true; });
    engine.buses.services.register('webglChat.drawFrame', ({ quads }) => { calls.drawFrame.push(quads); return true; });

    return { engine, calls };
}

function buildCore(engineBundle, coreOptions) {
    const host = engineBundle.engine.registerCaller('core.chatViewport', 'cores', { tier: 'official' });
    return createChatViewportCore(host, coreOptions);
}

const CANVAS = { __canvas: true, props: {} };
const MIRROR_CONTAINER = { __mirrorContainer: true, props: {}, children: [] };
const CHROME_CONTAINER = { __id: 'chrome-container', props: {} };

/**
 * `createFinalUi` — тот же приём, что `tests/message-footer-core.test.js`:
 * настоящий diff.js реально диффит дерево (значит MessageHeader/
 * MessageActionsRow/ReasoningBlock реально исполняются), но `apply` —
 * no-op, так что реальные `dom.*` вызовы, которые обычно делает
 * `cores/ui/final-ui-pc.js`, здесь не происходят — проверяется размещение
 * (mount/append/remove), а не диффинг, который уже покрыт diff.test.js.
 */
function fakeCreateFinalUi() {
    let counter = 0;
    return () => {
        const root = { __id: `chrome-root-${counter += 1}`, __chromeRoot: true, props: {} };
        return { apply: () => {}, getRoot: () => root, settled: () => Promise.resolve() };
    };
}

function msg(mesid, text) {
    return { mesid, text, isUser: false, isSystem: false, name: 'Alice' };
}

test('attach() returns false and touches nothing else when the platform has no WebGL', async () => {
    const bundle = buildEngine({ messages: [msg('0', 'hi')], glAvailable: false });
    const core = buildCore(bundle);

    const ok = await core.attach({ canvas: CANVAS, mirrorContainer: MIRROR_CONTAINER, width: 300, height: 200 });

    assert.equal(ok, false);
    assert.equal(bundle.calls.rasterize.length, 0);
    assert.equal(bundle.calls.classChanges.length, 0, 'native chat must not be suppressed if the WebGL fallback failed');
});

test('attach() with WebGL available suppresses the native chat and renders the initial visible messages', async () => {
    const heightByHtml = new Map([['<p>a</p>', 100], ['<p>b</p>', 100]]);
    const bundle = buildEngine({ messages: [msg('0', 'a'), msg('1', 'b')], heightByHtml });
    const core = buildCore(bundle, { rowHeight: 100, overscan: 0 });

    const ok = await core.attach({ canvas: CANVAS, mirrorContainer: MIRROR_CONTAINER, width: 300, height: 200 });

    assert.equal(ok, true);
    assert.equal(bundle.calls.classChanges[0], 'stme-chat-viewport-suppress-native', 'the FIRST class write must be suppressing the native container, before any mirror is created');
    assert.equal(bundle.calls.rasterize.length, 2, 'both 100px-tall rows fit inside a 200px viewport');
    assert.deepEqual(bundle.calls.uploadTexture.sort(), ['0', '1']);
    const lastFrame = bundle.calls.drawFrame.at(-1);
    assert.equal(lastFrame.length, 2);
    assert.deepEqual(lastFrame[0], { textureId: '0', x: 0, y: 0, width: 300, height: 100 });
    assert.deepEqual(lastFrame[1], { textureId: '1', x: 0, y: 100, width: 300, height: 100 });
});

test('a devicePixelRatio > 1 rasterizes at the SCALED (physical) resolution and draws quads in physical pixels, while measurement/layout stay in logical pixels — this is the fix for blurry/pixelated text on any non-1x display', async () => {
    const heightByHtml = new Map([['<p>a</p>', 100]]);
    const bundle = buildEngine({ messages: [msg('0', 'a')], heightByHtml });
    const core = buildCore(bundle, { rowHeight: 100, overscan: 0, getDevicePixelRatio: () => 2 });

    await core.attach({ canvas: CANVAS, mirrorContainer: MIRROR_CONTAINER, width: 300, height: 200 });

    // webglChat.attach() itself takes physical dims — asserted via the fake's
    // glAvailable path returning true regardless of args, so check the
    // rasterize/quad math instead, where the scale actually has to show up.
    assert.equal(bundle.calls.rasterize[0].width, 300, 'rasterization width stays LOGICAL — text wrapping must match the logical-pixel mirror measurement');
    assert.equal(bundle.calls.rasterize[0].scale, 2);
    const quad = bundle.calls.drawFrame.at(-1)[0];
    assert.equal(quad.width, 600, 'the QUAD (physical pixels) is scaled by devicePixelRatio, unlike the rasterization request width');
    assert.equal(quad.height, 200);
});

test('resizing the viewport calls webglChat.resize with PHYSICAL (devicePixelRatio-scaled) dimensions, but only when width/height actually changed — not on every scroll', async () => {
    const heightByHtml = new Map([['<p>a</p>', 100]]);
    const bundle = buildEngine({ messages: [msg('0', 'a')], heightByHtml });
    const core = buildCore(bundle, { rowHeight: 100, overscan: 0, getDevicePixelRatio: () => 2 });
    await core.attach({ canvas: CANVAS, mirrorContainer: MIRROR_CONTAINER, width: 300, height: 200 });
    bundle.calls.resize.length = 0;

    await core.setViewport({ scrollTop: 50 });
    assert.equal(bundle.calls.resize.length, 0, 'a pure scroll must not trigger a WebGL resize');

    await core.setViewport({ viewportWidth: 400, viewportHeight: 250 });
    assert.deepEqual(bundle.calls.resize.at(-1), { width: 800, height: 500 });
});

test('a second render() with UNCHANGED message text does not re-rasterize or re-upload — only the diff matters, not that render ran again', async () => {
    const heightByHtml = new Map([['<p>a</p>', 100]]);
    const bundle = buildEngine({ messages: [msg('0', 'a')], heightByHtml });
    const core = buildCore(bundle, { rowHeight: 100, overscan: 0 });
    await core.attach({ canvas: CANVAS, mirrorContainer: MIRROR_CONTAINER, width: 300, height: 200 });
    assert.equal(bundle.calls.rasterize.length, 1);

    await core.render();

    assert.equal(bundle.calls.rasterize.length, 1, 'unchanged content must not trigger a second rasterize/upload pass');
});

test('editing a visible message (text actually changes) DOES re-rasterize it on the next render', async () => {
    const heightByHtml = new Map([['<p>a</p>', 100], ['<p>a-edited</p>', 100]]);
    const messages = [msg('0', 'a')];
    const bundle = buildEngine({ messages, heightByHtml });
    const core = buildCore(bundle, { rowHeight: 100, overscan: 0 });
    await core.attach({ canvas: CANVAS, mirrorContainer: MIRROR_CONTAINER, width: 300, height: 200 });

    messages[0].text = 'a-edited';
    await core.render();

    assert.equal(bundle.calls.rasterize.length, 2);
    assert.deepEqual(bundle.calls.uploadTexture, ['0', '0']);
});

test('virtualization: only messages inside the visible+overscan window are rasterized, not the whole chat', async () => {
    const heightByHtml = new Map(Array.from({ length: 10 }, (_, i) => [`<p>msg${i}</p>`, 100]));
    const messages = Array.from({ length: 10 }, (_, i) => msg(String(i), `msg${i}`));
    const bundle = buildEngine({ messages, heightByHtml });
    // viewport 250px tall, 100px rows: visible rows 0,1,2 (partial); overscan 0.
    const core = buildCore(bundle, { rowHeight: 100, overscan: 0 });

    await core.attach({ canvas: CANVAS, mirrorContainer: MIRROR_CONTAINER, width: 300, height: 250 });

    assert.equal(bundle.calls.rasterize.length, 3, 'a 250px viewport with 100px rows should only need rows 0-2, not all 10');
});

test('scrolling evicts a message that left the window: its texture is released and its mirror removed', async () => {
    const heightByHtml = new Map(Array.from({ length: 5 }, (_, i) => [`<p>msg${i}</p>`, 100]));
    const messages = Array.from({ length: 5 }, (_, i) => msg(String(i), `msg${i}`));
    const bundle = buildEngine({ messages, heightByHtml });
    const core = buildCore(bundle, { rowHeight: 100, overscan: 0 });
    // height:60 (not 100) deliberately avoids landing exactly on a row boundary — see chat-viewport-math.test.js's own note on this ambiguity.
    await core.attach({ canvas: CANVAS, mirrorContainer: MIRROR_CONTAINER, width: 300, height: 60 }); // only row 0 fits
    assert.deepEqual(bundle.calls.uploadTexture, ['0']);

    await core.setViewport({ scrollTop: 400 }); // now only row 4 should be visible

    assert.ok(bundle.calls.releaseTexture.includes('0'), 'row 0 left the window and must be released');
    assert.equal(bundle.calls.domRemove.length, 1, 'its mirror element must be removed from the DOM too');
});

test('deleteMessage()/swipe()/regenerate()/editMessage() dispatch to the matching stChat.* contract and trigger a re-render', async () => {
    const heightByHtml = new Map([['<p>a</p>', 100]]);
    const bundle = buildEngine({ messages: [msg('0', 'a')], heightByHtml });
    const core = buildCore(bundle, { rowHeight: 100, overscan: 0 });
    await core.attach({ canvas: CANVAS, mirrorContainer: MIRROR_CONTAINER, width: 300, height: 200 });

    await core.deleteMessage({ mesid: '0' });
    await core.swipe({ mesid: '0', direction: 'left' });
    await core.regenerate();
    await core.editMessage({ mesid: '0', text: 'new text' });

    assert.deepEqual(bundle.calls.deleteMessage, [{ mesid: '0' }]);
    assert.deepEqual(bundle.calls.swipe, [{ mesid: '0', direction: 'left' }]);
    assert.equal(bundle.calls.regenerate.length, 1);
    assert.deepEqual(bundle.calls.setText, [{ mesid: '0', text: 'new text' }]);
});

test('setEnabled(false) removes the suppression class, releases every texture/mirror, and stops rendering until re-enabled', async () => {
    const heightByHtml = new Map([['<p>a</p>', 100]]);
    const bundle = buildEngine({ messages: [msg('0', 'a')], heightByHtml });
    const core = buildCore(bundle, { rowHeight: 100, overscan: 0 });
    await core.attach({ canvas: CANVAS, mirrorContainer: MIRROR_CONTAINER, width: 300, height: 200 });
    const rasterizeCountAfterAttach = bundle.calls.rasterize.length;

    await core.setEnabled({ enabled: false });

    assert.equal(bundle.calls.classChanges.at(-1), null, 'the suppression class must be removed, restoring the native chat');
    assert.ok(bundle.calls.releaseTexture.includes('0'));

    const renderedWhileDisabled = await core.render();
    assert.equal(renderedWhileDisabled, false);
    assert.equal(bundle.calls.rasterize.length, rasterizeCountAfterAttach, 'no new rasterization work while disabled');
});

test('detach() unsubscribes every ST event — a redraw event firing afterward must not trigger another render', async () => {
    const heightByHtml = new Map([['<p>a</p>', 100]]);
    const bundle = buildEngine({ messages: [msg('0', 'a')], heightByHtml });
    const core = buildCore(bundle, { rowHeight: 100, overscan: 0 });
    await core.attach({ canvas: CANVAS, mirrorContainer: MIRROR_CONTAINER, width: 300, height: 200 });

    await core.detach();
    const drawFrameCountAfterDetach = bundle.calls.drawFrame.length;
    bundle.engine.events.emit('st.messageEdited', {});
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(bundle.calls.drawFrame.length, drawFrameCountAfterDetach, 'a detached core must not still be listening for ST redraw events');
});

// --- Chrome widgets (Avatar/MessageHeader/MessageActionsRow/ReasoningBlock) mounted over the canvas ---

test('without createFinalUi, the core never touches chrome mounting at all — the WebGL body still renders on its own (backward compatible with every test above)', async () => {
    const heightByHtml = new Map([['<p>a</p>', 100]]);
    const bundle = buildEngine({ messages: [msg('0', 'a')], heightByHtml });
    const core = buildCore(bundle, { rowHeight: 100, overscan: 0 }); // no createFinalUi

    await core.attach({ canvas: CANVAS, mirrorContainer: MIRROR_CONTAINER, chromeContainer: CHROME_CONTAINER, width: 300, height: 200 });

    assert.equal(bundle.calls.append.filter(a => a.parent === 'chrome-container').length, 0);
});

test('a visible message gets its chrome mounted and appended to the chromeContainer', async () => {
    const heightByHtml = new Map([['<p>a</p>', 100], ['<p>b</p>', 100]]);
    const bundle = buildEngine({ messages: [msg('0', 'a'), msg('1', 'b')], heightByHtml });
    const core = buildCore(bundle, { rowHeight: 100, overscan: 0, createFinalUi: fakeCreateFinalUi() });

    await core.attach({ canvas: CANVAS, mirrorContainer: MIRROR_CONTAINER, chromeContainer: CHROME_CONTAINER, width: 300, height: 200 });

    const appendedToChrome = bundle.calls.append.filter(a => a.parent === 'chrome-container');
    assert.equal(appendedToChrome.length, 2, 'both visible messages (0 and 1) get their own chrome row appended once');
});

test('re-rendering with the SAME visible messages does not re-append chrome (mounted once, updated via signals afterward)', async () => {
    const heightByHtml = new Map([['<p>a</p>', 100]]);
    const bundle = buildEngine({ messages: [msg('0', 'a')], heightByHtml });
    const core = buildCore(bundle, { rowHeight: 100, overscan: 0, createFinalUi: fakeCreateFinalUi() });
    await core.attach({ canvas: CANVAS, mirrorContainer: MIRROR_CONTAINER, chromeContainer: CHROME_CONTAINER, width: 300, height: 200 });
    const countAfterAttach = bundle.calls.append.filter(a => a.parent === 'chrome-container').length;

    await core.render();

    assert.equal(bundle.calls.append.filter(a => a.parent === 'chrome-container').length, countAfterAttach, 'no second append for a message that was already mounted');
});

test('scrolling a message out of the window removes its chrome row from the DOM too, not just its texture', async () => {
    const heightByHtml = new Map(Array.from({ length: 5 }, (_, i) => [`<p>msg${i}</p>`, 100]));
    const messages = Array.from({ length: 5 }, (_, i) => msg(String(i), `msg${i}`));
    const bundle = buildEngine({ messages, heightByHtml });
    const core = buildCore(bundle, { rowHeight: 100, overscan: 0, createFinalUi: fakeCreateFinalUi() });
    await core.attach({ canvas: CANVAS, mirrorContainer: MIRROR_CONTAINER, chromeContainer: CHROME_CONTAINER, width: 300, height: 60 });
    const chromeRootsAppended = bundle.calls.append.filter(a => a.parent === 'chrome-container').map(a => a.child);
    assert.equal(chromeRootsAppended.length, 1);

    await core.setViewport({ scrollTop: 400 });

    assert.ok(bundle.calls.domRemove.includes(chromeRootsAppended[0]), 'the evicted row\'s chrome root must be removed from the document');
});

test('the WebGL body quad is offset DOWN by the real measured chrome height — chrome sits ABOVE the body, not on top of it (caught live in the harness before this fix: header text overlapped the message body)', async () => {
    const heightByHtml = new Map([['<p>a</p>', 100]]);
    const bundle = buildEngine({ messages: [msg('0', 'a')], heightByHtml, chromeHeight: 40 });
    const core = buildCore(bundle, { rowHeight: 100, overscan: 0, createFinalUi: fakeCreateFinalUi() });

    await core.attach({ canvas: CANVAS, mirrorContainer: MIRROR_CONTAINER, chromeContainer: CHROME_CONTAINER, width: 300, height: 200 });

    const quad = bundle.calls.drawFrame.at(-1)[0];
    assert.equal(quad.y, 40, 'the body must start 40px (the chrome height) below the row top, not at y:0');
    assert.equal(quad.height, 100, 'the BODY texture itself is still exactly its own measured height, unaffected by the chrome above it');
});

test('total row height (used for virtualization) is body height PLUS chrome height, not just the body — otherwise the next row would start too early and overlap this one\'s chrome', async () => {
    const heightByHtml = new Map([['<p>a</p>', 100], ['<p>b</p>', 100]]);
    const bundle = buildEngine({ messages: [msg('0', 'a'), msg('1', 'b')], heightByHtml, chromeHeight: 40 });
    const core = buildCore(bundle, { rowHeight: 100, overscan: 0, createFinalUi: fakeCreateFinalUi() });

    await core.attach({ canvas: CANVAS, mirrorContainer: MIRROR_CONTAINER, chromeContainer: CHROME_CONTAINER, width: 300, height: 400 });

    const [firstQuad, secondQuad] = bundle.calls.drawFrame.at(-1);
    assert.equal(firstQuad.y, 40);
    assert.equal(secondQuad.y, 140 + 40, 'row 1 starts after row 0\'s FULL height (100 body + 40 chrome = 140), then its own 40px chrome');
});

test('detach() removes every remaining chrome row, not just the texture/mirror state', async () => {
    const heightByHtml = new Map([['<p>a</p>', 100], ['<p>b</p>', 100]]);
    const bundle = buildEngine({ messages: [msg('0', 'a'), msg('1', 'b')], heightByHtml });
    const core = buildCore(bundle, { rowHeight: 100, overscan: 0, createFinalUi: fakeCreateFinalUi() });
    await core.attach({ canvas: CANVAS, mirrorContainer: MIRROR_CONTAINER, chromeContainer: CHROME_CONTAINER, width: 300, height: 200 });
    const chromeRoots = bundle.calls.append.filter(a => a.parent === 'chrome-container').map(a => a.child);

    await core.detach();

    for (const root of chromeRoots) assert.ok(bundle.calls.domRemove.includes(root));
});
