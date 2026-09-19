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
    let chromeHeightNow = chromeHeight;   // тест может изменить: имитация переноса имени на вторую строку
    const engine = createEngine();
    const calls = {
        deleteMessage: [], swipe: [], regenerate: [], setText: [],
        uploadTexture: [], releaseTexture: [], drawFrame: [], rasterize: [],
        setInnerHtml: [], domRemove: [], classChanges: [], resize: [], append: [],
        stEventsSubscribe: [], stEventsUnsubscribe: [],
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
    // Один общий "родитель канваса" — тот же узел, что `ensureGlyphBg()` в
    // `cores/ui/chat-viewport.js` вешает через `dom.parentElement` на
    // `canvas`, и куда добавляет фоны глифов.
    const canvasParent = { __id: 'canvas-parent', props: {} };
    engine.buses.services.register('dom.parentElement', () => canvasParent);
    engine.buses.services.register('dom.setInnerHtml', ({ el, html }) => { el.html = html; calls.setInnerHtml.push(html); return true; });
    // Не настоящий поиск по поддереву (эти фейковые узлы не хранят реальных
    // детей) — просто "да, такая заглушка внутри этой строки есть", той же
    // достаточной глубины фейка, что и остальной этот файл. Оба класса,
    // которые реально ищет `ensureRowChrome()` в `cores/ui/chat-viewport.js`.
    engine.buses.services.register('dom.querySelector', ({ el, selector }) => (
        (selector === '.stme-toolcall-body' || selector === '.stme-chat-viewport-footer-slot')
            ? { __id: `${selector}-${el.__id}`, props: {} }
            : null
    ));
    // `endsWith`, не `.get(el.html)` exact — НАЙДЕНО ЖИВЬЁМ: `syncMesid()`
    // препендит невидимую float-заглушку под ОСТАТОК аватарки (см.
    // `avatarSpacerHtml()` в chat-viewport.js) перед реальным HTML, когда
    // хром короче аватарки — `el.html` для таких сообщений уже не РАВЕН
    // ключу из `heightByHtml`, а ЗАКАНЧИВАЕТСЯ им. Фейк ищет по СОВПАДЕНИЮ
    // ХВОСТА, а не восстанавливает точную разметку заглушки.
    function lookupHeight(html) {
        for (const [key, value] of heightByHtml) if (html.endsWith(key)) return value;
        return undefined;
    }
    engine.buses.services.register('dom.measureRect', ({ el }) => ({
        width: 300,
        height: el.__chromeRoot ? chromeHeightNow : (lookupHeight(el.html) ?? 96),
        top: 0, left: 0,
    }));

    engine.buses.services.register('stChat.messages', () => messages);
    engine.buses.services.register('stChat.formatMessage', ({ mesid }) => `<p>${messages.find(m => m.mesid === mesid)?.text}</p>`);
    engine.buses.services.register('stChat.container', () => makeEl('div'));
    engine.buses.services.register('stChat.deleteMessage', p => { calls.deleteMessage.push(p); return true; });
    engine.buses.services.register('stChat.swipe', p => { calls.swipe.push(p); return true; });
    engine.buses.services.register('stChat.regenerate', () => { calls.regenerate.push(true); return true; });
    engine.buses.services.register('stChat.setText', p => { calls.setText.push(p); return true; });
    // Прямая (в обход `host.events`) подписка на `STREAM_TOKEN_RECEIVED` —
    // см. `STREAM_TOKEN_ST_EVENT` в `cores/ui/chat-viewport.js`. Тест
    // держит зарегистрированные обработчики сам, чтобы иметь возможность
    // вызвать их напрямую (имитируя реальный ST-эмит) без настоящего
    // `stEvents`-сервиса.
    const stEventHandlers = new Map(); // event -> Set(handler)
    engine.buses.services.register('stEvents.subscribe', ({ event, handler }) => {
        calls.stEventsSubscribe.push({ event });
        if (!stEventHandlers.has(event)) stEventHandlers.set(event, new Set());
        stEventHandlers.get(event).add(handler);
        return true;
    });
    engine.buses.services.register('stEvents.unsubscribe', ({ event, handler }) => {
        calls.stEventsUnsubscribe.push({ event });
        stEventHandlers.get(event)?.delete(handler);
        return true;
    });
    function fireStEvent(event) {
        for (const handler of stEventHandlers.get(event) ?? []) handler();
    }

    engine.buses.services.register('htmlRasterizer.rasterize', ({ html, width, height, scale }) => {
        calls.rasterize.push({ html, width, height, scale });
        return { image: { __fakeImage: true }, width: Math.round(width * (scale || 1)), height: Math.round(height * (scale || 1)) };
    });

    engine.buses.services.register('webglChat.attach', () => glAvailable);
    engine.buses.services.register('webglChat.resize', ({ width, height }) => { calls.resize?.push({ width, height }); return true; });
    engine.buses.services.register('webglChat.detach', () => true);
    engine.buses.services.register('webglChat.uploadTexture', ({ canvas, textureId }) => { calls.uploadTexture.push(textureId); (calls.uploadOn ??= []).push({ textureId, canvas }); return true; });
    engine.buses.services.register('webglChat.releaseTexture', ({ textureId }) => { calls.releaseTexture.push(textureId); return true; });
    engine.buses.services.register('webglChat.drawFrame', ({ canvas, quads }) => { calls.drawFrame.push(quads); (calls.drawOn ??= []).push({ canvas, quads }); return true; });

    // `ui.messageFooter.*` — на шине 'cores', НЕ 'services' (см. doc-comment
    // `coreOrNull()` в `cores/ui/chat-viewport.js` — этот же разнобой шин
    // был реальным багом: `serviceOrNull` молча не находил контракт,
    // зарегистрированный `message-footer.js` на 'cores'). Фейк здесь только
    // отслеживает САМ факт вызова/аргументы — полная симуляция DOM-дерева
    // ради поиска `.stme-chat-viewport-footer-slot` через `dom.querySelector`
    // (который этот файл тоже не подделывает вовсе — см. `ToolCall`'s
    // `.stme-toolcall-body`, тот же непроверенный на этом уровне путь) сюда
    // не входит: она уже проверена живьём в реальном ST.
    const messageFooterCalls = { setHostResolver: [], clearHostResolver: 0, attach: 0 };
    engine.buses.cores.register('ui.messageFooter.setHostResolver', ({ resolver }) => {
        messageFooterCalls.setHostResolver.push(resolver);
        return true;
    });
    engine.buses.cores.register('ui.messageFooter.clearHostResolver', () => {
        messageFooterCalls.clearHostResolver += 1;
        return true;
    });
    engine.buses.cores.register('ui.messageFooter.attach', () => {
        messageFooterCalls.attach += 1;
        return true;
    });

    // Наблюдатели за размером хрома: тест сам «срабатывает» ими, как это сделал бы ResizeObserver браузера.
    const observers = [];
    engine.buses.services.register('dom.observeResize', ({ el, handler }) => { observers.push({ el, handler, active: true }); return true; });
    engine.buses.services.register('dom.unobserveResize', ({ el, handler }) => { for (const item of observers) if (item.el === el && item.handler === handler) item.active = false; return true; });
    return { engine, calls, fireStEvent, messageFooterCalls, messages, observers, setChromeHeight: value => { chromeHeightNow = value; } };
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
    // Сообщения пользователя: подряд идущие от одного пользователя склеиваются в один глиф (ИИ подряд — только продолжение хода, см. computeGlyphs()).
    return { mesid, text, isUser: true, isSystem: false, name: 'Alice' };
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
    // `x: 10, width: 280` — `TEXT_PADDING` (10px each side, owner: "Глиф
    // все-еще слишком близко к левой и правой границе текста") shrinks the
    // body's drawn/rasterized width relative to the raw 300px viewport.
    assert.deepEqual(lastFrame[0], { textureId: '0', x: 10, y: 0, width: 280, height: 100 });
    assert.deepEqual(lastFrame[1], { textureId: '1', x: 10, y: 100, width: 280, height: 100 });
});

test('a devicePixelRatio > 1 rasterizes at the SCALED (physical) resolution and draws quads in physical pixels, while measurement/layout stay in logical pixels — this is the fix for blurry/pixelated text on any non-1x display', async () => {
    const heightByHtml = new Map([['<p>a</p>', 100]]);
    const bundle = buildEngine({ messages: [msg('0', 'a')], heightByHtml });
    const core = buildCore(bundle, { rowHeight: 100, overscan: 0, getDevicePixelRatio: () => 2 });

    await core.attach({ canvas: CANVAS, mirrorContainer: MIRROR_CONTAINER, width: 300, height: 200 });

    // webglChat.attach() itself takes physical dims — asserted via the fake's
    // glAvailable path returning true regardless of args, so check the
    // rasterize/quad math instead, where the scale actually has to show up.
    // 300 - TEXT_PADDING*2 (10px each side) = 280 — rasterization width stays
    // LOGICAL (content width, not the raw viewport) — text wrapping must
    // match the logical-pixel mirror measurement (also at content width).
    assert.equal(bundle.calls.rasterize[0].width, 280, 'rasterization width stays LOGICAL — text wrapping must match the logical-pixel mirror measurement');
    assert.equal(bundle.calls.rasterize[0].scale, 2);
    const quad = bundle.calls.drawFrame.at(-1)[0];
    assert.equal(quad.width, 560, 'the QUAD (physical pixels) is scaled by devicePixelRatio, unlike the rasterization request width');
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
    const core = buildCore(bundle, { prerenderFactor: 1, rowHeight: 100, overscan: 0 });

    await core.attach({ canvas: CANVAS, mirrorContainer: MIRROR_CONTAINER, width: 300, height: 250 });

    assert.equal(bundle.calls.rasterize.length, 3, 'a 250px viewport with 100px rows should only need rows 0-2, not all 10');
});

test('scrolling evicts a message that left the window: its texture is released and its mirror removed', async () => {
    const heightByHtml = new Map(Array.from({ length: 5 }, (_, i) => [`<p>msg${i}</p>`, 100]));
    const messages = Array.from({ length: 5 }, (_, i) => msg(String(i), `msg${i}`));
    const bundle = buildEngine({ messages, heightByHtml });
    const core = buildCore(bundle, { prerenderFactor: 1, rowHeight: 100, overscan: 0 });
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

function messages0Text(bundle, text) { bundle.messages[0].text = text; }

test('attach() subscribes to STREAM_TOKEN_RECEIVED DIRECTLY via stEvents (bypassing host.events) — found live: the shared event bus never bridges this event at all (DEFAULT_EXCLUDED_ST in cores/events/index.js), so streaming text/reasoning/ToolCalls never redrew Chat Viewport until this direct subscription existed', async () => {
    const heightByHtml = new Map([['<p>a</p>', 100]]);
    const bundle = buildEngine({ messages: [msg('0', 'a')], heightByHtml });
    const core = buildCore(bundle, { rowHeight: 100, overscan: 0 });
    await core.attach({ canvas: CANVAS, mirrorContainer: MIRROR_CONTAINER, width: 300, height: 200 });

    assert.ok(bundle.calls.stEventsSubscribe.some(c => c.event === 'STREAM_TOKEN_RECEIVED'), 'attach() must subscribe directly to the raw ST stream event');

    const drawFrameCountBefore = bundle.calls.drawFrame.length;
    messages0Text(bundle, 'a2'); // стрим что-то дописал — иначе кадр без изменений не перерисовывается (и это правильно)
    bundle.fireStEvent('STREAM_TOKEN_RECEIVED');
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.ok(bundle.calls.drawFrame.length > drawFrameCountBefore, 'firing the raw ST stream event must trigger a re-render');
});

test('detach() unsubscribes STREAM_TOKEN_RECEIVED too — with the SAME handler reference stEvents.subscribe() was given, or ST\'s real .off() could never find it to remove', async () => {
    const heightByHtml = new Map([['<p>a</p>', 100]]);
    const bundle = buildEngine({ messages: [msg('0', 'a')], heightByHtml });
    const core = buildCore(bundle, { rowHeight: 100, overscan: 0 });
    await core.attach({ canvas: CANVAS, mirrorContainer: MIRROR_CONTAINER, width: 300, height: 200 });

    await core.detach();

    assert.ok(bundle.calls.stEventsUnsubscribe.some(c => c.event === 'STREAM_TOKEN_RECEIVED'));
    const drawFrameCountAfterDetach = bundle.calls.drawFrame.length;
    bundle.fireStEvent('STREAM_TOKEN_RECEIVED');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(bundle.calls.drawFrame.length, drawFrameCountAfterDetach, 'a detached core must not still redraw on the raw stream event either');
});

test('totalHeight() reflects the sum of ALL messages\' heights, not just the visible ones — the real UI needs this to size a native scrollbar', async () => {
    const heightByHtml = new Map(Array.from({ length: 5 }, (_, i) => [`<p>msg${i}</p>`, 100]));
    const messages = Array.from({ length: 5 }, (_, i) => msg(String(i), `msg${i}`));
    const bundle = buildEngine({ messages, heightByHtml });
    const core = buildCore(bundle, { rowHeight: 100, overscan: 0 });

    await core.attach({ canvas: CANVAS, mirrorContainer: MIRROR_CONTAINER, width: 300, height: 60 }); // only 1 row visible

    assert.equal(core.totalHeight(), 500, 'total must count all 5 rows (100px each), even though only 1 is currently rendered');
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
    const core = buildCore(bundle, { prerenderFactor: 1, rowHeight: 100, overscan: 0, createFinalUi: fakeCreateFinalUi() });
    await core.attach({ canvas: CANVAS, mirrorContainer: MIRROR_CONTAINER, chromeContainer: CHROME_CONTAINER, width: 300, height: 60 });
    const chromeRootsAppended = bundle.calls.append.filter(a => a.parent === 'chrome-container').map(a => a.child);
    assert.equal(chromeRootsAppended.length, 1);

    await core.setViewport({ scrollTop: 400 });

    assert.ok(bundle.calls.domRemove.includes(chromeRootsAppended[0]), 'the evicted row\'s chrome root must be removed from the document');
});

// --- message-footer.js integration (owner: "RP Time и прочие штуки не
// отображаются корректно" — Модули со слотами подвала иначе крепятся в
// НАСТОЯЩИЙ `.mes`, скрытый вместе со всем `#chat`) ---

test('attach() registers a hostResolver on the CORES bus, not services — message-footer.js\'s own contracts live there', async () => {
    const heightByHtml = new Map([['<p>a</p>', 100]]);
    const bundle = buildEngine({ messages: [msg('0', 'a')], heightByHtml });
    const core = buildCore(bundle, { rowHeight: 100, overscan: 0, createFinalUi: fakeCreateFinalUi() });

    await core.attach({ canvas: CANVAS, mirrorContainer: MIRROR_CONTAINER, chromeContainer: CHROME_CONTAINER, width: 300, height: 200 });

    assert.equal(bundle.messageFooterCalls.setHostResolver.length, 1);
    assert.equal(typeof bundle.messageFooterCalls.setHostResolver[0], 'function', 'a real resolver function, not a placeholder value');
});

test('detach() clears the hostResolver — a disabled Chat Viewport must not keep message-footer.js pointing at DOM nodes it is about to remove', async () => {
    const heightByHtml = new Map([['<p>a</p>', 100]]);
    const bundle = buildEngine({ messages: [msg('0', 'a')], heightByHtml });
    const core = buildCore(bundle, { rowHeight: 100, overscan: 0, createFinalUi: fakeCreateFinalUi() });
    await core.attach({ canvas: CANVAS, mirrorContainer: MIRROR_CONTAINER, chromeContainer: CHROME_CONTAINER, width: 300, height: 200 });

    await core.detach();

    assert.equal(bundle.messageFooterCalls.clearHostResolver, 1);
});

test('a newly mounted row pulls message-footer.js in immediately — RP Time claiming its slot after the engine started must not wait for the next unrelated ST event to appear', async () => {
    const heightByHtml = new Map([['<p>a</p>', 100]]);
    const bundle = buildEngine({ messages: [msg('0', 'a')], heightByHtml });
    const core = buildCore(bundle, { rowHeight: 100, overscan: 0, createFinalUi: fakeCreateFinalUi() });

    await core.attach({ canvas: CANVAS, mirrorContainer: MIRROR_CONTAINER, chromeContainer: CHROME_CONTAINER, width: 300, height: 200 });
    await new Promise(resolve => setTimeout(resolve, 0)); // the pull-in call is fired without awaiting it

    assert.ok(bundle.messageFooterCalls.attach >= 1, 'ui.messageFooter.attach() got called for the row that just appeared');
});

// --- Глифы (owner: "Глиф - одна цепочка сообщений от одного пользователя
// подряд... Глифы должны иметь отдельный бэкграунд") ---

function msgAs(mesid, text, name) {
    return { mesid, text, isUser: true, isSystem: false, name };
}

test('a run of consecutive same-name messages gets ONE glyph background, not one per message', async () => {
    const heightByHtml = new Map([['<p>a</p>', 100], ['<p>b</p>', 100], ['<p>c</p>', 100]]);
    const messages = [msgAs('0', 'a', 'Lena'), msgAs('1', 'b', 'Lena'), msgAs('2', 'c', 'Sasha')];
    const bundle = buildEngine({ messages, heightByHtml });
    const core = buildCore(bundle, { rowHeight: 100, overscan: 0, createFinalUi: fakeCreateFinalUi() });

    await core.attach({ canvas: CANVAS, mirrorContainer: MIRROR_CONTAINER, chromeContainer: CHROME_CONTAINER, width: 300, height: 400 });

    const glyphBgAppends = bundle.calls.append.filter(a => a.parent === 'canvas-parent');
    assert.equal(glyphBgAppends.length, 2, 'two glyphs total: [Lena,Lena] and [Sasha] — one background element each');
});

test('scrolling a glyph fully out of the window removes its background too', async () => {
    const heightByHtml = new Map(Array.from({ length: 5 }, (_, i) => [`<p>msg${i}</p>`, 100]));
    const messages = Array.from({ length: 5 }, (_, i) => msgAs(String(i), `msg${i}`, `Speaker${i}`));
    const bundle = buildEngine({ messages, heightByHtml });
    const core = buildCore(bundle, { rowHeight: 100, overscan: 0, createFinalUi: fakeCreateFinalUi() });
    await core.attach({ canvas: CANVAS, mirrorContainer: MIRROR_CONTAINER, chromeContainer: CHROME_CONTAINER, width: 300, height: 60 });
    const firstGlyphBg = bundle.calls.append.find(a => a.parent === 'canvas-parent').child;

    await core.setViewport({ scrollTop: 400 });

    assert.ok(bundle.calls.domRemove.includes(firstGlyphBg), 'the evicted glyph\'s background must be removed from the document too');
});

test('a ToolCall message (isToolCall:true) never gets rasterized/uploaded/quaded on the canvas — its own <details> lives in real chrome DOM instead, owner: "ToolCall не открывается" (a rasterized <details> is just a picture, clicking it does nothing)', async () => {
    const heightByHtml = new Map([['<p>a</p>', 100], ['<p>b</p>', 100]]);
    const messages = [
        msgAs('0', 'a', 'Lena'),
        { ...msgAs('1', 'Tool calls: Notebook (1)', 'SillyTavern System'), isToolCall: true },
        msgAs('2', 'b', 'Lena'),
    ];
    const bundle = buildEngine({ messages, heightByHtml });
    const core = buildCore(bundle, { rowHeight: 100, overscan: 0, createFinalUi: fakeCreateFinalUi() });

    await core.attach({ canvas: CANVAS, mirrorContainer: MIRROR_CONTAINER, chromeContainer: CHROME_CONTAINER, width: 300, height: 400 });

    assert.ok(!bundle.calls.rasterize.some(r => r.html.includes('Tool calls')), 'the ToolCall message body must never reach htmlRasterizer.rasterize');
    assert.ok(!bundle.calls.uploadTexture.includes('1'), 'no texture is ever uploaded for the ToolCall mesid');
    const lastFrame = bundle.calls.drawFrame.at(-1);
    assert.ok(!lastFrame.some(q => q.textureId === '1'), 'no quad is drawn for the ToolCall mesid — its content lives in real DOM, not the canvas');
});

test('a chat change removes the chrome of EVERY row, including ToolCall rows that never had a mirror — otherwise their "Tool calls" labels stayed on screen in the next chat (owner: only after "create new chat")', async () => {
    const heightByHtml = new Map([['<p>a</p>', 100]]);
    const messages = [
        msgAs('0', 'a', 'Lena'),
        { ...msgAs('1', 'Tool calls: Notebook (1)', 'SillyTavern System'), isToolCall: true },
    ];
    const bundle = buildEngine({ messages, heightByHtml });
    const core = buildCore(bundle, { rowHeight: 100, overscan: 0, createFinalUi: fakeCreateFinalUi() });
    await core.attach({ canvas: CANVAS, mirrorContainer: MIRROR_CONTAINER, chromeContainer: CHROME_CONTAINER, width: 300, height: 400 });
    const chromeRoots = bundle.calls.append.filter(a => a.parent === 'chrome-container').map(a => a.child);
    assert.equal(chromeRoots.length, 2, 'both the text row and the ToolCall row mount chrome');

    bundle.engine.events.emit('st.chatChanged', {});
    await new Promise(resolve => setTimeout(resolve, 20));

    for (const root of chromeRoots) assert.ok(bundle.calls.domRemove.includes(root), 'every chrome root, ToolCall row included, must be removed on chat change');
});

test('the WebGL body quad is offset DOWN by the real measured chrome height — chrome sits ABOVE the body, not on top of it (caught live in the harness before this fix: header text overlapped the message body)', async () => {
    const heightByHtml = new Map([['<p>a</p>', 100]]);
    const bundle = buildEngine({ messages: [msg('0', 'a')], heightByHtml, chromeHeight: 40 });
    const core = buildCore(bundle, { rowHeight: 100, overscan: 0, createFinalUi: fakeCreateFinalUi() });

    await core.attach({ canvas: CANVAS, mirrorContainer: MIRROR_CONTAINER, chromeContainer: CHROME_CONTAINER, width: 300, height: 200 });

    const quad = bundle.calls.drawFrame.at(-1)[0];
    assert.equal(quad.y, 52, 'the body must start 52px (40 measured content + 2x6 row padding) below the row top, not at y:0');
    assert.equal(quad.height, 100, 'the BODY texture itself is still exactly its own measured height, unaffected by the chrome above it');
});

test('total row height (used for virtualization) is body height PLUS chrome height, not just the body — otherwise the next row would start too early and overlap this one\'s chrome', async () => {
    const heightByHtml = new Map([['<p>a</p>', 100], ['<p>b</p>', 100]]);
    const bundle = buildEngine({ messages: [msg('0', 'a'), msg('1', 'b')], heightByHtml, chromeHeight: 40 });
    const core = buildCore(bundle, { rowHeight: 100, overscan: 0, createFinalUi: fakeCreateFinalUi() });

    await core.attach({ canvas: CANVAS, mirrorContainer: MIRROR_CONTAINER, chromeContainer: CHROME_CONTAINER, width: 300, height: 400 });

    const [firstQuad, secondQuad] = bundle.calls.drawFrame.at(-1);
    assert.equal(firstQuad.y, 52);
    assert.equal(secondQuad.y, 152 + 52, 'row 1 starts after row 0\'s FULL height (100 body + 52 chrome = 152), then its own 52px chrome');
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

test('with a separate last-message canvas, ONLY the last message body is uploaded to and drawn on it — streaming redraws that small canvas, never the main one', async () => {
    const heightByHtml = new Map([['<p>a</p>', 100], ['<p>b</p>', 100]]);
    const bundle = buildEngine({ messages: [msg('0', 'a'), msg('1', 'b')], heightByHtml });
    const core = buildCore(bundle, { rowHeight: 100, overscan: 0 });
    const LAST_CANVAS = { __id: 'last-canvas', props: {} };
    await core.attach({ canvas: CANVAS, lastCanvas: LAST_CANVAS, mirrorContainer: MIRROR_CONTAINER, width: 300, height: 400 });

    const uploadFor = id => bundle.calls.uploadOn.find(u => u.textureId === id)?.canvas;
    assert.equal(uploadFor('0'), CANVAS, 'an earlier message lives on the main canvas');
    assert.equal(uploadFor('1'), LAST_CANVAS, 'the last message lives on its own canvas');
    const mainQuads = bundle.calls.drawOn.filter(d => d.canvas === CANVAS).at(-1).quads;
    assert.ok(!mainQuads.some(q => q.textureId === '1'), 'the main canvas never draws the last message');
    const lastQuads = bundle.calls.drawOn.filter(d => d.canvas === LAST_CANVAS).at(-1).quads;
    assert.deepEqual(lastQuads.map(q => q.textureId), ['1']);
});

test('when the header (chrome) becomes TALLER after the first measurement — the name wraps onto a second line on a narrow phone screen — the body moves down instead of overlapping it (phone screenshots)', async () => {
    const heightByHtml = new Map([['<p>a</p>', 100]]);
    const bundle = buildEngine({ messages: [msg('0', 'a')], heightByHtml, chromeHeight: 40 });
    const core = buildCore(bundle, { rowHeight: 100, overscan: 0, createFinalUi: fakeCreateFinalUi() });
    await core.attach({ canvas: CANVAS, mirrorContainer: MIRROR_CONTAINER, chromeContainer: CHROME_CONTAINER, width: 300, height: 200 });
    assert.equal(bundle.calls.drawFrame.at(-1)[0].y, 52, 'first layout: one-line header');
    assert.ok(bundle.observers.some(item => item.active), 'the core watches the real height of the header');

    bundle.setChromeHeight(80);   // the name wrapped: the header is now two lines high
    for (const item of bundle.observers.filter(entry => entry.active)) await item.handler({ width: 300, height: 80 });
    await new Promise(resolve => setTimeout(resolve, 120));

    assert.equal(bundle.calls.drawFrame.at(-1)[0].y, 92, 'the body starts below the taller header: 80 measured + 12 padding');
});

test('a header whose height did not really change does not cause another layout pass, however often the observer fires', async () => {
    const heightByHtml = new Map([['<p>a</p>', 100]]);
    const bundle = buildEngine({ messages: [msg('0', 'a')], heightByHtml, chromeHeight: 40 });
    const core = buildCore(bundle, { rowHeight: 100, overscan: 0, createFinalUi: fakeCreateFinalUi() });
    await core.attach({ canvas: CANVAS, mirrorContainer: MIRROR_CONTAINER, chromeContainer: CHROME_CONTAINER, width: 300, height: 200 });
    const framesBefore = bundle.calls.drawFrame.length;
    for (let round = 0; round < 3; round += 1) for (const item of bundle.observers.filter(entry => entry.active)) await item.handler({ width: 300, height: 40 });
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(bundle.calls.drawFrame.length, framesBefore, 'no extra frames');
});

test('several header changes in a burst are laid out ONCE, and watching stops when the row is forgotten (chat changed)', async () => {
    const heightByHtml = new Map([['<p>a</p>', 100], ['<p>b</p>', 100]]);
    const bundle = buildEngine({ messages: [msg('0', 'a'), msg('1', 'b')], heightByHtml, chromeHeight: 40 });
    const core = buildCore(bundle, { rowHeight: 100, overscan: 0, createFinalUi: fakeCreateFinalUi() });
    await core.attach({ canvas: CANVAS, mirrorContainer: MIRROR_CONTAINER, chromeContainer: CHROME_CONTAINER, width: 300, height: 400 });
    const framesBefore = bundle.calls.drawFrame.length;
    bundle.setChromeHeight(64);
    await Promise.all(bundle.observers.filter(entry => entry.active).map(item => item.handler({ width: 300, height: 64 })));
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(bundle.calls.drawFrame.length - framesBefore, 1, 'both rows changed, one pass');
    assert.equal(bundle.calls.drawFrame.at(-1)[0].y, 76);

    bundle.messages.splice(0);   // the new chat is empty: every old row is forgotten
    bundle.engine.events.emit('st.chatChanged', {});
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(bundle.observers.some(item => item.active), false, 'no observer outlives its row');
});
