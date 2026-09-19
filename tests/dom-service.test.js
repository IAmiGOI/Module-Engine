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

test('setProp with an "on:X:capture" key attaches in the CAPTURE phase (the 3rd addEventListener arg is true) — found live: a delegated "on:toggle" listener on an ANCESTOR never fired on a real user click, because native <details> "toggle" events do not bubble in this browser; capture-phase delegation catches the event on the way down regardless of bubbling', () => {
    const calls = [];
    const el = {
        addEventListener(type, fn, capture) { calls.push({ op: 'add', type, capture }); },
        removeEventListener(type, fn, capture) { calls.push({ op: 'remove', type, capture }); },
    };

    domOperations.setProp(el, 'on:toggle:capture', () => {});

    assert.deepEqual(calls, [{ op: 'add', type: 'toggle', capture: true }]);
});

test('setProp with "on:X:capture" keeps its OWN bookkeeping key separate from a plain "on:X" — replacing one must not accidentally remove the other, since a real element could have both a bubble and a capture listener for the same event type', () => {
    const calls = [];
    const el = {
        addEventListener(type, fn, capture) { calls.push({ op: 'add', capture: !!capture }); },
        removeEventListener() { calls.push({ op: 'remove' }); },
    };

    domOperations.setProp(el, 'on:toggle', () => {});
    domOperations.setProp(el, 'on:toggle:capture', () => {});

    assert.deepEqual(calls, [{ op: 'add', capture: false }, { op: 'add', capture: true }], 'both listeners attach — the second write must not be seen as "replacing" the first');
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

test('measureClientSize() reads clientWidth/clientHeight — the CONTENT box, excluding the element\'s own scrollbar (unlike measureRect\'s outer border-box)', () => {
    const el = { clientWidth: 1090, clientHeight: 800 };
    assert.deepEqual(domOperations.measureClientSize(el), { width: 1090, height: 800 });
    assert.deepEqual(domOperations.measureClientSize({}), { width: 0, height: 0 });
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

// --- Contract level: registerDomService() actually wires all 18 as real,
// callable contracts on a bus ---

test('registerDomService() registers all its contracts, each performing the real operation on the real (fake) document/tree', async () => {
    const bus = createContractBus();
    const doc = makeFakeDocument();
    registerDomService(bus, { document: doc });

    const el = await new Promise(resolve => bus.subscribe('dom.createElement', { params: { tag: 'div' } }, r => resolve(r.value)));
    const text = await new Promise(resolve => bus.subscribe('dom.createTextNode', { params: { text: 'hi' } }, r => resolve(r.value)));
    await new Promise(resolve => bus.subscribe('dom.setProp', { params: { el, key: 'class', value: 'x' } }, resolve));
    await new Promise(resolve => bus.subscribe('dom.append', { params: { parent: el, child: text } }, resolve));

    assert.equal(el.className, 'x');
    assert.deepEqual(el.children, [text]);
});

test('dom.body returns the real document.body — the one anchor OUTSIDE #chat, so an overlay appended there survives #chat being display:none\'d (display:none is inherited by descendants, so an overlay INSIDE #chat would vanish too)', async () => {
    const bus = createContractBus();
    const doc = makeFakeDocument();
    registerDomService(bus, { document: doc });

    const body = await new Promise(resolve => bus.subscribe('dom.body', {}, r => resolve(r.value)));

    assert.equal(body, doc.body);
});

test('dom.parentElement returns the element\'s real parent — needed because getBoundingClientRect() of a display:none element (like a suppressed #chat) is permanently 0x0, so resizing must measure a stable ANCESTOR instead of the hidden element itself', async () => {
    const bus = createContractBus();
    const doc = makeFakeDocument();
    registerDomService(bus, { document: doc });
    const parent = doc.createElement('div');
    const child = doc.createElement('div');
    parent.append(child);

    const result = await new Promise(resolve => bus.subscribe('dom.parentElement', { params: { el: child } }, resolve));

    assert.equal(result.value, parent);
});

test('dom.parentElement returns null for an element with no parent, rather than throwing', async () => {
    const bus = createContractBus();
    registerDomService(bus, { document: makeFakeDocument() });
    const orphan = makeFakeDocument().createElement('div');

    const result = await new Promise(resolve => bus.subscribe('dom.parentElement', { params: { el: orphan } }, resolve));

    assert.equal(result.value, null);
});

test('registerDomService()\'s returned unregister function retires all contracts at once', async () => {
    const bus = createContractBus();
    const unregister = registerDomService(bus, { document: makeFakeDocument() });

    unregister();
    const result = await new Promise(resolve => bus.subscribe('dom.createElement', { params: { tag: 'div' } }, resolve));

    assert.equal(result.ok, false);
});

test('suppressStyleRules()/restoreStyleRules() remove matching :has([style*=]) rules and put them back at their old positions', async () => {
    const { registerDomService } = await import('../services/dom.js');
    const rules = [
        { selectorText: '.a', cssText: '.a { color: red; }' },
        { selectorText: '#x:has([data-a][style*="display: none"])', cssText: '#x:has([data-a][style*="display: none"]) { opacity: 0.5; }' },
        { selectorText: '.b', cssText: '.b { color: blue; }' },
    ];
    const sheet = { href: 'toggle-dependent.css', get cssRules() { return rules; }, deleteRule(i) { rules.splice(i, 1); }, insertRule(text, i) { rules.splice(i, 0, { selectorText: text.split(' {')[0], cssText: text }); } };
    const bus = { handlers: new Map(), register(name, fn) { this.handlers.set(name, fn); return () => {}; } };
    registerDomService(bus, { document: { styleSheets: [sheet] } });

    const removed = bus.handlers.get('dom.suppressStyleRules')({ key: 't', selectorPattern: String.raw`:has\([^)]*\[style\*=` });
    assert.equal(removed, 1);
    assert.deepEqual(rules.map(r => r.selectorText), ['.a', '.b']);
    bus.handlers.get('dom.restoreStyleRules')({ key: 't' });
    assert.deepEqual(rules.map(r => r.selectorText), ['.a', '#x:has([data-a][style*="display: none"])', '.b']);
});

test('overrideRootStyles()/restoreRootStyles() set important overrides on <html> and put the previous values back', async () => {
    const { registerDomService } = await import('../services/dom.js');
    const props = new Map([['transform', ['translateZ(0)', '']]]);
    const style = {
        getPropertyValue: n => props.get(n)?.[0] ?? '',
        getPropertyPriority: n => props.get(n)?.[1] ?? '',
        setProperty: (n, v, p = '') => props.set(n, [v, p]),
        removeProperty: n => props.delete(n),
    };
    const bus = { handlers: new Map(), register(name, fn) { this.handlers.set(name, fn); return () => {}; } };
    registerDomService(bus, { document: { styleSheets: [], documentElement: { style } } });

    assert.equal(bus.handlers.get('dom.overrideRootStyles')({ key: 'k', styles: { transform: 'none', perspective: 'none' } }), true);
    assert.deepEqual(props.get('transform'), ['none', 'important']);
    assert.deepEqual(props.get('perspective'), ['none', 'important']);
    bus.handlers.get('dom.restoreRootStyles')({ key: 'k' });
    assert.deepEqual(props.get('transform'), ['translateZ(0)', '']);
    assert.equal(props.has('perspective'), false);
});
