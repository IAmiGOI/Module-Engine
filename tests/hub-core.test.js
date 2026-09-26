import test from 'node:test';
import assert from 'node:assert/strict';
import { createHubCore } from '../cores/ui/hub/index.js';

/** Минимальный фейк DOM: узлы с детьми, классами, стилем, слушателями и querySelector(All) по классу/атрибуту. */
function el(tag = 'div', attrs = {}) {
    const listeners = {};
    const node = {
        tag, children: [], style: {}, dataset: {}, attrs: { ...attrs }, hidden: false, textContent: '', clientWidth: 0, isConnected: false, scrollTop: 0, open: false,
        classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); }, contains(c) { return this.set.has(c); } },
        set className(value) { this.classList.set = new Set(String(value).split(' ').filter(Boolean)); },
        get className() { return [...this.classList.set].join(' '); },
        append(...kids) { for (const kid of kids) { node.children.push(kid); kid.parent = node; kid.isConnected = true; } },
        prepend(kid) { node.children.unshift(kid); kid.parent = node; kid.isConnected = true; },
        insertBefore(kid, ref) { const i = node.children.indexOf(ref); node.children.splice(i < 0 ? node.children.length : i, 0, kid); kid.parent = node; kid.isConnected = true; },
        replaceChildren() { node.children = []; },
        remove() { if (node.parent) node.parent.children = node.parent.children.filter(k => k !== node); node.isConnected = false; },
        setAttribute(name, value) { node.attrs[name] = value; },
        addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
        removeEventListener() {},
        click() { for (const fn of listeners.click ?? []) fn({}); },
        querySelector(selector) { return node.querySelectorAll(selector)[0] ?? null; },
        querySelectorAll(selector) {
            const [head, ...rest] = selector.split(' ');   // «A B» — потомок B внутри каждого A
            const out = [];
            const walk = n => { for (const kid of n.children) { if (matches(kid, head)) out.push(kid); walk(kid); } };
            walk(node);
            return rest.length ? out.flatMap(found => found.querySelectorAll(rest.join(' '))) : out;
        },
        set innerHTML(value) { node.inner = value; },
        contains: other => node === other || node.children.some(kid => kid.contains?.(other)),
    };
    return node;
}
const matches = (node, selector) => (selector.startsWith('.') ? node.classList.contains(selector.slice(1)) : node.tag === selector);

/** Карточка панели: `.stme-card` с заголовком `.stme-card-title strong`. */
function card(title) {
    const c = el('details');
    c.classList.add('stme-card');
    const head = el('div'); head.classList.add('stme-card-title');
    const strong = el('strong'); strong.textContent = title;
    head.append(strong); c.append(head);
    return c;
}

function harness({ webgl = false, workers = [{ id: 'local' }], modules = null } = {}) {
    const doc = { createElement: tag => el(tag), body: el('body'), documentElement: el('html') };
    const win = { getComputedStyle: () => ({ color: 'rgb(1,2,3)', fontFamily: 'x' }), addEventListener() {}, removeEventListener() {} };
    const services = new Map();
    const subscribed = new Map();
    const host = {
        services: { subscribe: (contract, { params }, cb) => { cb({ ok: webgl && contract !== 'htmlRasterizer.rasterize' ? true : (contract === 'htmlRasterizer.rasterize' ? true : false), value: contract === 'htmlRasterizer.rasterize' ? { image: {}, width: 1, height: 1 } : webgl }); return () => {}; } },
        own: { subscribe: (contract, { params }, cb) => { cb({ ok: true, value: contract === 'model.workers.get' ? workers : null }); return () => {}; } },
        events: { subscribe: (event, cb) => { subscribed.set(event, cb); return () => subscribed.delete(event); } },
    };
    const hub = createHubCore(host, { document: doc, win, ResizeObserverCtor: null, modules });
    const container = el('div');
    const panelRoot = el('div'); panelRoot.classList.add('stme-panel');
    const cards = ['Model connections', 'Macros', 'Modules'].map(card);
    panelRoot.append(...cards);
    container.append(panelRoot);
    return { hub, container, panelRoot, cards, subscribed, doc };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

test('mounting puts the overview before the panel tree and hides the tree; the overview is the default view', async () => {
    const h = harness();
    const handle = h.hub.mount({ container: h.container, panelRoot: h.panelRoot, group: 'work' });
    await tick();
    assert.equal(h.container.children[0].classList.contains('stme-hub'), true, 'the hub sits before the forms');
    assert.equal(h.panelRoot.style.display, 'none');
    assert.equal(handle.view(), null);
});

test('opening a tile shows ONLY its card (expanded), flattens the columns and shows the Back bar; Back restores the overview and all cards', async () => {
    const h = harness();
    const handle = h.hub.mount({ container: h.container, panelRoot: h.panelRoot, group: 'work' });
    const hubRoot = h.container.children[0];
    assert.equal(handle.open('models'), true);
    assert.equal(handle.view(), 'models');
    assert.deepEqual(h.cards.map(c => c.style.display), ['', 'none', 'none']);
    assert.equal(h.cards[0].open, true);
    assert.equal(h.panelRoot.style.display, '');
    assert.equal(h.panelRoot.classList.contains('stme-hub-single'), true);
    const bar = hubRoot.querySelector('.stme-hub-bar');
    assert.equal(bar.hidden, false);
    assert.equal(hubRoot.querySelector('.stme-hub-overview').hidden, true);
    assert.equal(h.container.scrollTop, 0, 'the form opens from the top');
    hubRoot.querySelector('.stme-hub-back').click();
    assert.equal(handle.view(), null);
    assert.deepEqual(h.cards.map(c => c.style.display), ['', '', '']);
    assert.equal(h.panelRoot.style.display, 'none');
    assert.equal(bar.hidden, true);
});

test('openCard finds the tile by the card title (used by the checklist step); a card of another group or an unknown one is refused and changes nothing', async () => {
    const h = harness();
    const work = h.hub.mount({ container: h.container, panelRoot: h.panelRoot, group: 'work' });
    assert.equal(work.groupHas('Modules'), true);
    assert.equal(work.groupHas('Updates'), false, 'Updates lives on the settings screen');
    assert.equal(work.openCard('Modules'), true);
    assert.equal(work.view(), 'modules');
    assert.equal(work.openCard('Updates'), false);
    assert.equal(work.open('ghost'), false);
    assert.equal(work.view(), null, 'an unknown tile falls back to the overview');
});

test('without WebGL the tiles still show their text as plain DOM (the panel is never "off"), with the live status from the engine', async () => {
    const h = harness({ webgl: false, workers: [{ id: 'local' }, { id: 'router' }], modules: { list: () => [{ id: 'a', title: 'Tracker' }, { id: 'b', title: 'Music' }], enabled: () => ['a'] } });
    h.hub.mount({ container: h.container, panelRoot: h.panelRoot, group: 'work' });
    await tick(); await tick();
    const hubRoot = h.container.children[0];
    const overview = hubRoot.querySelector('.stme-hub-overview');
    overview.clientWidth = 900;
    h.hub.refresh();
    await tick(); await tick();
    const tiles = hubRoot.querySelectorAll('.stme-hub-tile');
    assert.equal(tiles.length, 5, 'one tile per card of the work group');
    const models = tiles.find(tile => tile.dataset.tile === 'models');
    assert.equal(models.dataset.status, 'ok');
    assert.equal(models.querySelector('.stme-hub-text').children[1].textContent, '2 connections');
    const modules = tiles.find(tile => tile.dataset.tile === 'modules');
    assert.deepEqual(modules.querySelector('.stme-hub-text').children.map(c => c.textContent), ['Modules', '1 of 2 enabled', 'Tracker']);
});

test('a change of the model workers refreshes the statuses; disposing removes the hub and restores the panel tree', async () => {
    const h = harness();
    const handle = h.hub.mount({ container: h.container, panelRoot: h.panelRoot, group: 'work' });
    assert.equal(h.subscribed.has('model.workers.changed'), true, 'the hub listens for worker changes');
    handle.dispose();
    assert.equal(h.container.children.some(kid => kid.classList.contains('stme-hub')), false);
    assert.equal(h.panelRoot.style.display, '');
});
