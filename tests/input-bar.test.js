import test from 'node:test';
import assert from 'node:assert/strict';
import { createInputBarCore } from '../cores/ui/input-bar/index.js';
import { createNativeBridge } from '../cores/ui/input-bar/native-bridge.js';
import { createInputPill } from '../cores/ui/input-bar/pill.js';
import { createLeftDock } from '../cores/ui/input-bar/left-dock.js';

/**
 * Подставной DOM ровно на то, что трогает панель набора: дерево, классы, атрибуты, слушатели с настоящей диспетчеризацией, `click()`,
 * `getElementById`, `getComputedStyle` по инлайн-стилю. Не общий DOM-харнесс — тот же приём, что в tests/launcher-dock.test.js.
 */
class El {
    constructor(tag, doc) {
        this.tag = tag; this.doc = doc; this.children = []; this.parent = null; this.attrs = {}; this.style = {}; this.id = ''; this.className = '';
        this.value = ''; this.listeners = []; this.clicks = 0; this.scrollHeight = 0; this.offsetHeight = 46;
        this.classList = {
            add: name => { if (!this.classList.contains(name)) this.className = `${this.className} ${name}`.trim(); },
            remove: name => { this.className = this.className.split(' ').filter(item => item && item !== name).join(' '); },
            contains: name => this.className.split(' ').includes(name),
        };
    }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    getAttribute(key) { return this.attrs[key] ?? null; }
    append(...nodes) { for (const node of nodes) { node.parent?.children.splice(node.parent.children.indexOf(node), 1); this.children.push(node); node.parent = this; } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    remove() { this.parent?.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    addEventListener(type, fn) { this.listeners.push({ type, fn }); }
    removeEventListener(type, fn) { this.listeners = this.listeners.filter(item => !(item.type === type && item.fn === fn)); }
    dispatchEvent(event) { for (const { type, fn } of [...this.listeners]) if (type === event.type) fn(event); return true; }
    click() { this.clicks += 1; this.dispatchEvent({ type: 'click', target: this, stopPropagation() {}, preventDefault() {} }); }
    focus() { this.doc.focused = this; }
}

function makeDoc() {
    const doc = {
        body: null, documentElement: null, focused: null, byId: new Map(), listeners: [],
        createElement: tag => new El(tag, doc),
        getElementById: id => doc.byId.get(id) ?? null,
        addEventListener: (type, fn) => doc.listeners.push({ type, fn }),
        removeEventListener: (type, fn) => { doc.listeners = doc.listeners.filter(item => !(item.type === type && item.fn === fn)); },
    };
    doc.body = new El('body', doc);
    doc.documentElement = new El('html', doc);
    doc.defaultView = { Event: class { constructor(type, init) { this.type = type; Object.assign(this, init); } }, getComputedStyle: el => ({ display: el.style.display ?? 'flex' }) };
    return doc;
}

/** Родная панель ST в миниатюре: `#leftSendForm` (две кнопки), `#send_textarea`, `#rightSendForm` (`#send_but`, `#mes_stop`). */
function makeNative(doc) {
    const reg = (id, parent) => { const el = doc.createElement('div'); el.id = id; doc.byId.set(id, el); parent?.append(el); return el; };
    const sendForm = reg('send_form', doc.body);
    const left = reg('leftSendForm', sendForm);
    const options = reg('options_button', left);
    const extensions = reg('extensionsMenuButton', left);
    const textarea = reg('send_textarea', sendForm);
    const right = reg('rightSendForm', sendForm);
    const sendBut = reg('send_but', right);
    const stop = reg('mes_stop', right);
    stop.style.display = 'none';
    return { left, options, extensions, textarea, right, sendBut, stop };
}

function makeHost() {
    const handlers = new Map();
    const emitted = [];
    return {
        emitted,
        fire: (name, payload) => handlers.get(name)?.forEach(fn => fn(payload)),
        host: {
            own: { register: () => () => {} },
            events: {
                subscribe: (name, fn) => { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); return () => list.splice(list.indexOf(fn), 1); },
                emit: (name, payload) => { emitted.push([name, payload]); },
            },
            services: { subscribe: (contract, _params, callback) => { callback({ ok: true, value: true }); return () => {}; } },
        },
    };
}

// ── мост ───────────────────────────────────────────────────────────────────────────────────────────────────────────

test('bridge: writing text goes into the native field WITH an input event (so ST sees a draft), and an unchanged value is not written twice', () => {
    const doc = makeDoc(); const native = makeNative(doc);
    const bridge = createNativeBridge({ document: doc });
    let inputs = 0;
    native.textarea.addEventListener('input', () => { inputs += 1; });
    bridge.writeText('hello');
    bridge.writeText('hello');
    assert.equal(native.textarea.value, 'hello');
    assert.equal(inputs, 1);
    assert.equal(bridge.readText(), 'hello');
});

test('bridge: send and stop click the NATIVE buttons; generating follows the native Stop button', () => {
    const doc = makeDoc(); const native = makeNative(doc);
    const bridge = createNativeBridge({ document: doc });
    bridge.send(); bridge.stop();
    assert.equal(native.sendBut.clicks, 1);
    assert.equal(native.stop.clicks, 1);
    assert.equal(bridge.isGenerating(), false);
    native.stop.style.display = 'flex';
    assert.equal(bridge.isGenerating(), true);
});

test('bridge: the generating watcher reports a CHANGE once, not every mutation', () => {
    const doc = makeDoc(); const native = makeNative(doc);
    let trigger = null;
    class FakeObserver { constructor(fn) { trigger = fn; } observe() {} disconnect() {} }
    const bridge = createNativeBridge({ document: doc, MutationObserverCtor: FakeObserver });
    const seen = [];
    bridge.watchGenerating(value => seen.push(value));
    trigger(); trigger();
    native.stop.style.display = 'flex';
    trigger(); trigger();
    native.stop.style.display = 'none';
    trigger();
    assert.deepEqual(seen, [true, false]);
});

test('bridge: it is unavailable without the native field or send button, and the left buttons come back to their form in order', () => {
    const empty = makeDoc();
    assert.equal(createNativeBridge({ document: empty }).available(), false);
    const doc = makeDoc(); const native = makeNative(doc);
    const bridge = createNativeBridge({ document: doc });
    assert.equal(bridge.available(), true);
    const taken = bridge.takeLeftButtons();
    assert.deepEqual(taken.nodes.map(node => node.id), ['options_button', 'extensionsMenuButton']);
    const elsewhere = doc.createElement('div');
    elsewhere.append(...taken.nodes);
    assert.equal(native.left.children.length, 0);
    taken.restore();
    assert.deepEqual(native.left.children.map(node => node.id), ['options_button', 'extensionsMenuButton']);
});

// ── пилюля ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function makePill(overrides = {}) {
    const doc = makeDoc();
    const calls = { input: [], send: 0, stop: 0, regenerate: 0 };
    const pill = createInputPill({
        document: doc, getWindowHeight: () => 800, ResizeObserverCtor: null,
        onInput: value => calls.input.push(value), onSend: () => { calls.send += 1; }, onStop: () => { calls.stop += 1; }, onRegenerate: () => { calls.regenerate += 1; },
        shouldSend: event => event.key === 'Enter' && !event.shiftKey,
        ...overrides,
    });
    return { doc, pill, calls };
}

test('pill: the layout is regenerate circle, field, send circle — and typing resizes the field by its content and reports the text', () => {
    const { pill, calls } = makePill();
    assert.deepEqual(pill.root.children.map(node => node.className.split(' ').slice(0, 2).join(' ')), ['stme-input-circle stme-input-regenerate', 'stme-input-field', 'stme-input-circle stme-input-send']);
    pill.field.value = 'a\nb\nc';
    pill.field.scrollHeight = 100;
    pill.field.dispatchEvent({ type: 'input' });
    assert.equal(pill.field.style.height, '100px', 'grows with the text');
    assert.deepEqual(calls.input, ['a\nb\nc']);
    pill.field.scrollHeight = 900;
    pill.field.dispatchEvent({ type: 'input' });
    assert.equal(pill.field.style.height, '320px', 'capped, then scrolls inside');
    assert.equal(pill.field.style.overflowY, 'auto');
    pill.field.scrollHeight = 10;
    pill.field.dispatchEvent({ type: 'input' });
    assert.equal(pill.field.style.height, '42px', 'never smaller than one line');
});

test('pill: Enter sends (and is swallowed), Shift+Enter is left alone for a new line', () => {
    const { pill, calls } = makePill();
    let prevented = 0;
    pill.field.dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault: () => { prevented += 1; } });
    pill.field.dispatchEvent({ type: 'keydown', key: 'Enter', shiftKey: true, preventDefault: () => { prevented += 1; } });
    assert.equal(calls.send, 1);
    assert.equal(prevented, 1);
});

test('pill: the right circle is Send, becomes Stop while generating (and stops instead of sending), the left circle regenerates', () => {
    const { pill, calls } = makePill();
    const [regenerate, , send] = pill.root.children;
    send.click();
    assert.equal(calls.send, 1);
    pill.setGenerating(true);
    assert.equal(send.getAttribute('title'), 'Stop generating');
    assert.ok(send.classList.contains('stme-input-send-stop'));
    send.click();
    assert.equal(calls.stop, 1);
    assert.equal(calls.send, 1, 'no second send while generating');
    pill.setGenerating(false);
    assert.equal(send.getAttribute('title'), 'Send');
    regenerate.click();
    assert.equal(calls.regenerate, 1);
});

test('pill: the circles do not steal focus from the field (mousedown is cancelled), and the column sets the left edge and width', () => {
    const { pill } = makePill();
    let prevented = 0;
    for (const button of [pill.root.children[0], pill.root.children[2]]) button.dispatchEvent({ type: 'mousedown', preventDefault: () => { prevented += 1; } });
    assert.equal(prevented, 2);
    pill.setColumn({ left: 158, width: 674 });
    assert.equal(pill.root.style.left, '158px');
    assert.equal(pill.root.style.width, '674px');
});

// ── левый док ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('left dock: the two native buttons live inside it, get the dock button class, and go back on dispose', () => {
    const doc = makeDoc(); const native = makeNative(doc);
    const bridge = createNativeBridge({ document: doc });
    const buttons = bridge.takeLeftButtons();
    const dock = createLeftDock({ document: doc, touch: false, buttons });
    dock.mount(doc.body);
    assert.ok(dock.zone.className.includes('stme-left-dock-zone'));
    const slots = dock.zone.children[0].children;
    assert.equal(slots.length, 3, 'close chat + the two native buttons');
    assert.ok(slots[0].className.includes('stme-left-dock-close'), 'Close chat is the leftmost slot');
    assert.deepEqual(slots.slice(1).map(node => node.id), ['options_button', 'extensionsMenuButton']);
    assert.ok(native.options.classList.contains('stme-left-dock-btn'));
    assert.equal(native.left.children.length, 0);
    dock.dispose();
    assert.equal(native.left.children.length, 2);
    assert.equal(native.options.classList.contains('stme-left-dock-btn'), false);
    assert.equal(doc.body.children.includes(dock.zone), false);
});

test('left dock: the Close chat slot calls the callback, and the core wires it to the native menu item', async () => {
    const doc = makeDoc(); makeNative(doc);
    let closed = 0;
    const buttons = createNativeBridge({ document: doc }).takeLeftButtons();
    const dock = createLeftDock({ document: doc, touch: false, buttons, onCloseChat: () => { closed += 1; } });
    dock.zone.children[0].children[0].click();
    assert.equal(closed, 1);
    const { doc: coreDoc, native, core } = makeCore();
    const menuItem = coreDoc.createElement('a'); menuItem.id = 'option_close_chat'; coreDoc.byId.set('option_close_chat', menuItem); native.left.append(menuItem);
    await core.enable();
    coreDoc.body.children.find(node => node.className.includes('stme-left-dock-zone')).children[0].children[0].click();
    assert.equal(menuItem.clicks, 1, 'the native "Close chat" item was clicked');
});

test('left dock: on a touch screen the first tap only opens it, and a tap outside closes it', () => {
    const doc = makeDoc(); makeNative(doc);
    const buttons = createNativeBridge({ document: doc }).takeLeftButtons();
    const dock = createLeftDock({ document: doc, touch: true, buttons });
    dock.mount(doc.body);
    const pill = dock.zone.children[0];
    const captured = pill.listeners.find(item => item.type === 'click').fn;
    let stopped = 0;
    captured({ stopPropagation: () => { stopped += 1; }, preventDefault() {} });
    assert.equal(dock.isOpen(), true);
    assert.equal(stopped, 1, 'the first tap does not reach the button');
    captured({ stopPropagation: () => { stopped += 1; }, preventDefault() {} });
    assert.equal(stopped, 1, 'the second tap goes through');
    doc.listeners.find(item => item.type === 'click').fn({ target: doc.body });
    assert.equal(dock.isOpen(), false);
});

// ── Ядро ───────────────────────────────────────────────────────────────────────────────────────────────────────────

function makeCore(overrides = {}) {
    const doc = makeDoc(); const native = makeNative(doc);
    const { host, emitted, fire } = makeHost();
    const win = { innerWidth: 1000, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
    const core = createInputBarCore(host, { document: doc, win, touch: false, getSendOnEnter: () => 0, ResizeObserverCtor: null, ...overrides });
    return { doc, native, core, emitted, fire, win };
}

test('core: enabling hides the native form via the html class, mounts the pill and the dock, and reports it; disabling puts everything back', async () => {
    const { doc, native, core, emitted } = makeCore();
    assert.deepEqual(await core.enable(), { ok: true });
    assert.ok(doc.documentElement.classList.contains('stme-input-bar-active'));
    assert.equal(doc.body.children.filter(node => node.className.includes('stme-input-bar')).length, 1);
    assert.equal(doc.body.children.filter(node => node.className.includes('stme-left-dock-zone')).length, 1);
    assert.deepEqual(emitted.at(-1), ['ui.inputBar.changed', { active: true, height: 46 }]);
    assert.deepEqual(await core.enable(), { ok: true }, 'a second enable is a no-op');
    assert.equal(doc.body.children.filter(node => node.className.includes('stme-input-bar')).length, 1);
    await core.disable();
    assert.equal(doc.documentElement.classList.contains('stme-input-bar-active'), false);
    assert.equal(doc.body.children.filter(node => node.className.includes('stme-input-bar')).length, 0);
    assert.equal(native.left.children.length, 2);
    assert.deepEqual(emitted.at(-1), ['ui.inputBar.changed', { active: false, height: 0 }]);
});

test('core: without the native input it refuses to enable and touches nothing', async () => {
    const doc = makeDoc();
    const { host } = makeHost();
    const core = createInputBarCore(host, { document: doc, win: { innerWidth: 1000, innerHeight: 800, addEventListener() {}, removeEventListener() {} }, ResizeObserverCtor: null });
    assert.deepEqual(await core.enable(), { ok: false, reason: 'native-input-missing' });
    assert.equal(doc.documentElement.classList.contains('stme-input-bar-active'), false);
});

test('core: typing goes into the native field, Enter clicks the native Send, and what ST writes back (clearing after a send) shows in the pill', async () => {
    const { native, core } = makeCore();
    await core.enable();
    const pill = core.pill();
    pill.field.value = '/echo hi';
    pill.field.scrollHeight = 20;
    pill.field.dispatchEvent({ type: 'input' });
    assert.equal(native.textarea.value, '/echo hi');
    pill.field.dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault() {} });
    assert.equal(native.sendBut.clicks, 1);
    native.textarea.value = '';
    native.textarea.dispatchEvent({ type: 'input' });
    assert.equal(pill.getValue(), '', 'the native field was cleared by ST — the pill follows');
    native.textarea.value = 'restored draft';
    native.textarea.dispatchEvent({ type: 'input' });
    assert.equal(pill.getValue(), 'restored draft');
});

test('core: the column the overlay reported BEFORE the pill existed is applied on enable, and later changes move the pill', async () => {
    const { core, fire } = makeCore();
    fire('ui.chatViewport.columnChanged', { left: 40, width: 600 });
    await core.enable();
    assert.equal(core.pill().root.style.left, '40px');
    assert.equal(core.pill().root.style.width, '600px');
    fire('ui.chatViewport.columnChanged', { left: 100, width: 500 });
    assert.equal(core.pill().root.style.left, '100px');
    assert.equal(core.pill().root.style.width, '500px');
});

test('core: without a reported column the pill is centred with gaps, and the Send-on-Enter setting of ST decides Enter', async () => {
    const { core } = makeCore({ getSendOnEnter: () => -1 });
    await core.enable();
    assert.equal(core.pill().root.style.left, '20px');
    assert.equal(core.pill().root.style.width, '960px');
    const { native, core: core2 } = makeCore({ getSendOnEnter: () => -1 });
    await core2.enable();
    core2.pill().field.dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault() {} });
    assert.equal(native.sendBut.clicks, 0, 'Send on Enter is off in ST — plain Enter is a new line');
});

test('core: the side bar class (native top strip -> vertical bar on the left) is set only on a wide screen without touch, and cleared on disable', async () => {
    const wide = makeCore();
    await wide.core.enable();
    assert.ok(wide.doc.documentElement.classList.contains('stme-side-bar-active'));
    await wide.core.disable();
    assert.equal(wide.doc.documentElement.classList.contains('stme-side-bar-active'), false);
    const touch = makeCore({ touch: true });
    await touch.core.enable();
    assert.ok(touch.doc.documentElement.classList.contains('stme-input-bar-active'));
    assert.equal(touch.doc.documentElement.classList.contains('stme-side-bar-active'), false, 'a phone keeps the native top strip');
    const narrow = makeCore({ win: { innerWidth: 700, innerHeight: 600, addEventListener() {}, removeEventListener() {} } });
    await narrow.core.enable();
    assert.equal(narrow.doc.documentElement.classList.contains('stme-side-bar-active'), false, 'a narrow window keeps the native top strip');
});
