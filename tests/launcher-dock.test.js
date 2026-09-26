import test from 'node:test';
import assert from 'node:assert/strict';
import { createLauncherDockCore } from '../cores/ui/launcher-dock.js';
import { createEdgeDrag } from '../libraries/shared/edge-drag.js';
import {
    DOCK_BUTTONS, buttonClassOf, shouldCollapseOnOutsideTap, shouldInterceptTap, shouldRestoreSavedPosition,
} from '../libraries/shared/dock-model.js';

// ── Чистая модель ──────────────────────────────────────────────────────────────────────────────────────────────────

test('the dock has five buttons in a fixed order, and the class of each matches what styles/ styles', () => {
    assert.deepEqual(DOCK_BUTTONS.map(button => button.id), ['main', 'graph', 'music', 'image', 'settings']);
    assert.equal(buttonClassOf('main'), 'stme-launcher-dock-btn');
    assert.equal(buttonClassOf('settings'), 'stme-launcher-dock-btn stme-launcher-dock-btn-settings');
    assert.equal(DOCK_BUTTONS.find(button => button.id === 'image').translate, false, 'the picture button has no translation key');
});

test('touch rules: the first tap only opens the pill, an outside tap closes it, and a saved position is never applied on a phone', () => {
    assert.equal(shouldInterceptTap({ touch: true, open: false }), true);
    assert.equal(shouldInterceptTap({ touch: true, open: true }), false);
    assert.equal(shouldInterceptTap({ touch: false, open: false }), false, 'a mouse has :hover, no two-step needed');
    assert.equal(shouldCollapseOnOutsideTap({ touch: true, open: true, inside: false }), true);
    assert.equal(shouldCollapseOnOutsideTap({ touch: true, open: true, inside: true }), false);
    assert.equal(shouldCollapseOnOutsideTap({ touch: true, open: false, inside: false }), false);
    assert.equal(shouldRestoreSavedPosition({ touch: false }), true);
    assert.equal(shouldRestoreSavedPosition({ touch: true }), false);
});

// ── Подставной DOM: настоящее дерево и настоящий порядок событий (capture → цель → bubble → document) ───────────────

class FakeNode {
    constructor(tag, doc) {
        this.tag = tag; this.doc = doc; this.children = []; this.parent = null; this.attrs = {}; this.style = {}; this.id = ''; this.className = '';
        this.listeners = []; this.offsetHeight = 240;
        this.classList = {
            add: name => { if (!this.classList.contains(name)) this.className = `${this.className} ${name}`.trim(); },
            remove: name => { this.className = this.className.split(' ').filter(item => item && item !== name).join(' '); },
            contains: name => this.className.split(' ').includes(name),
        };
    }
    setAttribute(key, value) { this.attrs[key] = value; }
    append(child) { child.parent = this; this.children.push(child); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this); this.parent = null; }
    addEventListener(type, fn, capture = false) { this.listeners.push({ type, fn, capture: capture === true }); }
    contains(node) { for (let current = node; current; current = current.parent) if (current === this) return true; return false; }
    getBoundingClientRect() { return { bottom: 700 }; }
}

function createFakeDom() {
    const doc = new FakeNode('#document', null);
    doc.body = new FakeNode('body', doc);
    doc.body.parent = doc;
    doc.createElement = tag => new FakeNode(tag, doc);
    doc.getElementById = id => {
        const walk = node => (node.id === id ? node : node.children.map(walk).find(Boolean));
        return walk(doc.body) ?? null;
    };
    /** Событие идёт как в браузере: capture сверху вниз, цель, bubble снизу вверх до document; stopPropagation останавливает остальное. */
    doc.dispatch = (target, type, extra = {}) => {
        const event = { type, target, defaultPrevented: false, stopped: false, ...extra, stopPropagation() { this.stopped = true; }, preventDefault() { this.defaultPrevented = true; } };
        const path = [];
        for (let node = target; node; node = node.parent) path.unshift(node);
        const run = (node, capture) => { for (const listener of [...node.listeners]) if (listener.type === type && (capture === null || listener.capture === capture)) listener.fn(event); };
        for (const node of path.slice(0, -1)) { run(node, true); if (event.stopped) return event; }
        run(target, null); if (event.stopped) return event;
        for (const node of path.slice(0, -1).reverse()) { run(node, false); if (event.stopped) return event; }
        return event;
    };
    return doc;
}

function build({ touch = false, savedY = null, viewportHeight = 800, actions = {}, mountActivityLight, activityState = { peek: () => 'idle' }, createEdgeDragImpl = createEdgeDrag } = {}) {
    const doc = createFakeDom();
    const calls = [];
    const track = name => () => calls.push(name);
    const dock = createLauncherDockCore({}, {
        document: doc, touch,
        storage: { getItem: () => savedY, setItem: () => {} },
        actions: { main: track('main'), graph: track('graph'), music: track('music'), image: track('image'), settings: track('settings'), ...actions },
        activityState, mountActivityLight, createEdgeDrag: createEdgeDragImpl, getViewportHeight: () => viewportHeight,
    });
    const zone = dock.mount();
    const buttons = zone.children[0].children;
    return { doc, dock, zone, pill: zone.children[0], buttons, calls, button: id => buttons[DOCK_BUTTONS.findIndex(spec => spec.id === id)] };
}

test('the dock is built as zone → pill → five buttons with icons, titles and translation keys, and is placed in the page once', () => {
    const { doc, zone, pill, buttons, dock } = build();
    assert.equal(zone.id, 'stmeBetaLauncherDock');
    assert.equal(zone.className, 'stme-launcher-dock-zone');
    assert.equal(pill.className, 'stme-launcher-dock');
    assert.deepEqual(buttons.map(button => button.children[0].className), ['fa-solid fa-flask fa-fw', 'fa-solid fa-diagram-project fa-fw', 'fa-solid fa-music fa-fw', 'fa-solid fa-image fa-fw', 'fa-solid fa-gear fa-fw']);
    assert.equal(buttons[4].attrs['data-i18n'], '[title]Open engine settings');
    assert.equal('data-i18n' in buttons[3].attrs, false);
    assert.equal(doc.body.children.length, 1);
    assert.equal(dock.mount(), null, 'a second mount does nothing');
    assert.equal(doc.body.children.length, 1);
});

test('on a desktop every button runs its own action with one click, and a button without an action does nothing', () => {
    const { doc, button, calls } = build({ actions: { image: undefined } });
    for (const id of ['main', 'graph', 'music', 'settings']) doc.dispatch(button(id), 'click');
    doc.dispatch(button('image'), 'click');
    assert.deepEqual(calls, ['main', 'graph', 'music', 'settings']);
});

test('on a phone the first tap on a button only opens the pill, the second tap runs the action, a tap outside closes it again', () => {
    const { doc, button, calls, zone, dock } = build({ touch: true });
    assert.equal(zone.classList.contains('stme-launcher-dock-touch'), true);
    doc.dispatch(button('settings'), 'click');
    assert.deepEqual(calls, [], 'the first tap did not run the action');
    assert.equal(dock.isOpen(), true);
    doc.dispatch(button('settings'), 'click');
    assert.deepEqual(calls, ['settings']);
    doc.dispatch(doc.body, 'click');
    assert.equal(dock.isOpen(), false, 'an outside tap collapses it');
    doc.dispatch(button('graph'), 'click');
    assert.deepEqual(calls, ['settings'], 'closed again: the tap opens, it does not act');
});

test('a saved dock position is restored (and clamped to the screen) on a desktop', () => {
    const { zone } = build({ savedY: '900', viewportHeight: 800 });
    assert.equal(zone.style.bottom, '560px', '800 - 240, never above the top of the screen');
});

test('a saved dock position is IGNORED on a phone — a stale value from another mode used to carry the dock off the top of the screen', () => {
    const { zone } = build({ touch: true, savedY: '900', viewportHeight: 800 });
    assert.equal(zone.style.bottom, undefined, 'the CSS position (above the input bar) stays in charge');
});

test('the activity light is mounted on the zone with the activity state, and skipped when there is no state or no factory', () => {
    const mounted = [];
    const state = () => 'idle';
    const { zone } = build({ activityState: state, mountActivityLight: (target, given) => mounted.push([target, given]) });
    assert.deepEqual(mounted, [[zone, state]]);
    const none = [];
    build({ activityState: null, mountActivityLight: (...args) => none.push(args) });
    build({ mountActivityLight: undefined });
    assert.deepEqual(none, []);
});

test('a click sent by the browser right after a drag is swallowed before any button sees it', () => {
    const { doc, button, calls } = build({ createEdgeDragImpl: () => ({ restore() {}, suppressClick: true, 'on:pointerdown': () => {}, 'on:pointermove': () => {}, 'on:pointerup': () => {}, 'on:pointercancel': () => {} }) });
    const event = doc.dispatch(button('main'), 'click');
    assert.deepEqual(calls, []);
    assert.equal(event.defaultPrevented, true);
});

test('dragging with the mouse moves the zone along the edge through the real edge-drag library', () => {
    const { doc, zone } = build();
    doc.dispatch(zone.children[0], 'pointerdown', { pointerType: 'mouse', button: 0, clientY: 500, currentTarget: zone, target: zone.children[0] });
    doc.dispatch(zone.children[0], 'pointermove', { clientY: 400, pointerType: 'mouse' });
    assert.ok(zone.style.bottom, 'the zone has a new bottom offset');
});

test('disposing removes the dock from the page', () => {
    const { doc, dock } = build();
    dock.dispose();
    assert.equal(doc.body.children.length, 0);
    assert.equal(dock.zone(), null);
});
