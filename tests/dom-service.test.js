import test from 'node:test';
import assert from 'node:assert/strict';
import { registerDomService, domOperations } from '../services/dom.js';
import { createContractBus } from '../libraries/shared/contract-bus.js';
import { makeFakeDocument } from './helpers/fake-document.js';

// --- Unit level: the raw DOM logic, independent of contracts/Шина plumbing ---

test('setProp writes DOM-reflected properties (value/checked/...) directly, everything else as a real attribute', () => {
    const el = makeFakeDocument().createElement('input');

    domOperations.setProp(el, 'value', 'hello');
    domOperations.setProp(el, 'checked', true);
    domOperations.setProp(el, 'data-id', '42');

    assert.equal(el.value, 'hello');
    assert.equal(el.checked, true);
    assert.equal(el.attributes['data-id'], '42');
});

test('setProp performs the real assignment on the FIRST write for a key, even if the live property coincidentally already reads as the target value — found live in the browser: a fresh <option> with no value attribute yet reads .value as "" via its own textContent fallback, exactly matching an intended empty default value, and a naive "skip if el[key] already equals value" check left the attribute never actually set — so once a label got appended, .value silently drifted to the label text', () => {
    let assignCount = 0;
    const el = {};
    Object.defineProperty(el, 'value', {
        get() { return ''; }, // coincidentally already reads as the target, like a fresh <option>
        set() { assignCount += 1; },
    });

    domOperations.setProp(el, 'value', '');

    assert.equal(assignCount, 1, 'the assignment must happen for real on the first write for a key, regardless of what the live property currently reads');
});

test('setProp still skips a REDUNDANT write once WE already wrote this exact value ourselves — the original optimization (typing must not reset the caret to the end on every keystroke) survives the fix above', () => {
    let assignCount = 0;
    let stored = '';
    const el = {};
    Object.defineProperty(el, 'value', { get() { return stored; }, set(v) { stored = v; assignCount += 1; } });

    domOperations.setProp(el, 'value', 'hello');
    domOperations.setProp(el, 'value', 'hello'); // same value, second call

    assert.equal(assignCount, 1, 'only the first write should actually assign; repeating the same value we ourselves already wrote must be a no-op');
});

test('setProp treats "class" as className, and "style" as an object merge', () => {
    const el = makeFakeDocument().createElement('div');

    domOperations.setProp(el, 'class', 'card active');
    domOperations.setProp(el, 'style', { color: 'red' });

    assert.equal(el.className, 'card active');
    assert.equal(el.style.color, 'red');
});

// --- SVG — real createElementNS + attribute-based class (ROADMAP.md 5.47) --

test('createElement() uses createElementNS for SVG tags (circle/polygon/svg/...), and plain createElement for everything else', () => {
    const doc = makeFakeDocument();
    const nsCalls = [];
    const plainCalls = [];
    const originalNS = doc.createElementNS.bind(doc);
    const originalPlain = doc.createElement.bind(doc);
    doc.createElementNS = (ns, tag) => { nsCalls.push(tag); return originalNS(ns, tag); };
    doc.createElement = tag => { plainCalls.push(tag); return originalPlain(tag); };

    const circle = domOperations.createElement(doc, 'circle');
    const div = domOperations.createElement(doc, 'div');

    assert.deepEqual(nsCalls, ['circle']);
    assert.deepEqual(plainCalls, ['div']);
    assert.equal(circle.__isSvg, true);
    assert.equal(div.__isSvg, undefined);
});

test('createElement() treats "image" as an SVG tag too — the map canvas\'s tile layers (ROADMAP.md 5.52) render as <image> INSIDE an <svg>, not a plain HTML <img>; missing this from SVG_TAGS would reproduce the exact zero-render bug ROADMAP.md 5.47 already fixed once, just for a new tag', () => {
    const doc = makeFakeDocument();
    const image = domOperations.createElement(doc, 'image');
    assert.equal(image.__isSvg, true);
});

test('setProp writes "class" on an SVG element through setAttribute, not .className — SVGElement.className is a read-only SVGAnimatedString on the real DOM, so a plain assignment silently does nothing there (the exact bug that made the map canvas render zero visible shapes)', () => {
    const el = makeFakeDocument().createElement('circle');
    el.__isSvg = true;

    domOperations.setProp(el, 'class', 'stme-map-node');

    assert.equal(el.getAttribute('class'), 'stme-map-node');
});

test('setProp with a false/null value removes the attribute rather than setting a stringified "false"', () => {
    const el = makeFakeDocument().createElement('div');
    domOperations.setProp(el, 'data-flag', true);

    domOperations.setProp(el, 'data-flag', false);

    assert.equal('data-flag' in el.attributes, false);
});

test('setProp with an "on:" key wires a real event listener, replacing a previous one for the same type instead of stacking', () => {
    const el = makeFakeDocument().createElement('button');
    const calls = [];

    domOperations.setProp(el, 'on:click', () => calls.push('first'));
    domOperations.setProp(el, 'on:click', () => calls.push('second'));
    el._listeners.get('click')();

    assert.deepEqual(calls, ['second']);
});

test('removeProp on an "on:" key detaches the real listener', () => {
    const el = makeFakeDocument().createElement('button');
    domOperations.setProp(el, 'on:click', () => {});

    domOperations.removeProp(el, 'on:click');

    assert.equal(el._listeners.has('click'), false);
});

// --- Geometry/scroll/resize/innerHTML — added for Chat Viewport's own
// virtualization (visible-range math needs real measured row heights; the
// invisible accessibility/selection mirror needs a way to inject already-
// formatted HTML) ---

test('measureRect() snapshots getBoundingClientRect() into plain numbers, defaulting missing fields to 0', () => {
    const el = { getBoundingClientRect: () => ({ width: 120.5, height: 40, top: 10, left: 0 }) };
    assert.deepEqual(domOperations.measureRect(el), { width: 120.5, height: 40, top: 10, left: 0 });
    assert.deepEqual(domOperations.measureRect({}), { width: 0, height: 0, top: 0, left: 0 });
});

test('readScrollPosition()/writeScrollPosition() read and write scrollTop/scrollLeft directly', () => {
    const el = { scrollTop: 50, scrollLeft: 0 };
    assert.deepEqual(domOperations.readScrollPosition(el), { top: 50, left: 0 });

    domOperations.writeScrollPosition(el, { top: 200 });
    assert.equal(el.scrollTop, 200);
    assert.equal(el.scrollLeft, 0, 'omitting left must not clobber it with NaN/undefined');
});

test('setInnerHtml() assigns innerHTML as-is — the one deliberate place chat-viewport HTML enters the DOM outside h()/diff.js', () => {
    const el = {};
    domOperations.setInnerHtml(el, '<p>hi</p>');
    assert.equal(el.innerHTML, '<p>hi</p>');
});

test('observeResize()/unobserveResize() wire and tear down a real ResizeObserver by the SAME handler reference — same subscribe/unsubscribe discipline as services/st-events.js', () => {
    let observedEl = null;
    let disconnected = false;
    let deliver;
    class FakeResizeObserver {
        constructor(cb) { deliver = cb; }
        observe(el) { observedEl = el; }
        disconnect() { disconnected = true; }
    }
    const el = {};
    const seen = [];
    const handler = box => seen.push(box);

    const subscribed = domOperations.observeResize(el, handler, FakeResizeObserver);
    assert.equal(subscribed, true);
    assert.equal(observedEl, el);

    deliver([{ contentRect: { width: 300, height: 40 } }]);
    assert.deepEqual(seen, [{ width: 300, height: 40 }]);

    const unsubscribed = domOperations.unobserveResize(el, handler);
    assert.equal(unsubscribed, true);
    assert.equal(disconnected, true);
});

test('unobserveResize() on an element/handler pair that was never observed is a harmless no-op', () => {
    assert.equal(domOperations.unobserveResize({}, () => {}), false);
});

// --- Contract level: registerDomService() actually wires all 16 as real,
// callable contracts on a bus ---

test('registerDomService() registers all 16 contracts, each performing the real operation on the real (fake) document/tree', async () => {
    const bus = createContractBus();
    registerDomService(bus, { document: makeFakeDocument() });

    const el = await new Promise(resolve => bus.subscribe('dom.createElement', { params: { tag: 'div' } }, r => resolve(r.value)));
    const text = await new Promise(resolve => bus.subscribe('dom.createTextNode', { params: { text: 'hi' } }, r => resolve(r.value)));
    await new Promise(resolve => bus.subscribe('dom.setProp', { params: { el, key: 'class', value: 'x' } }, resolve));
    await new Promise(resolve => bus.subscribe('dom.append', { params: { parent: el, child: text } }, resolve));

    assert.equal(el.className, 'x');
    assert.deepEqual(el.children, [text]);
});

test('registerDomService()\'s returned unregister function retires all contracts at once', async () => {
    const bus = createContractBus();
    const unregister = registerDomService(bus, { document: makeFakeDocument() });

    unregister();
    const result = await new Promise(resolve => bus.subscribe('dom.createElement', { params: { tag: 'div' } }, resolve));

    assert.equal(result.ok, false);
});
