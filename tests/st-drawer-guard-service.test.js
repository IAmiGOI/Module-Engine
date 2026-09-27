import test from 'node:test';
import assert from 'node:assert/strict';
import { registerStDrawerGuard } from '../services/st-drawer-guard.js';
import { createContractBus } from '../libraries/shared/contract-bus.js';
import { createDrawerGuardCore } from '../cores/drawer-guard/index.js';
import { createEngine } from '../libraries/shared/engine.js';

/** A fake `document`: `addEventListener`/`removeEventListener` capture the mousedown/touchstart handlers ST itself listens for — see the doc-comment on `registerStDrawerGuard` for why `click` is the wrong event. `querySelectorAll('.openDrawer')` returns fake drawer elements with a real-shaped classList/dataset. */
function fakeDrawer(open = true) {
    const classes = new Set(open ? ['openDrawer'] : []);
    return {
        classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
        dataset: {},
    };
}

function fakeDocument(drawers) {
    const handlers = new Map(); // type -> handler
    return {
        addEventListener: (type, fn) => handlers.set(type, fn),
        removeEventListener: (type, fn) => { if (handlers.get(type) === fn) handlers.delete(type); },
        querySelectorAll: () => drawers,
        press(target) { handlers.get('mousedown')?.({ target }); },
        isListening: () => handlers.has('mousedown') && handlers.has('touchstart'),
    };
}

const insideOurUi = { closest: () => true };
const outsideOurUi = { closest: () => false };

const install = bus => new Promise(resolve => bus.subscribe('stDrawerGuard.install', {}, resolve));

test('a click inside the engine\'s own UI pins every currently open ST drawer, so ST\'s own autoclose (which skips .pinnedOpen) leaves it open', async () => {
    const drawer = fakeDrawer();
    const doc = fakeDocument([drawer]);
    const bus = createContractBus();
    registerStDrawerGuard(bus, { documentRef: () => doc });
    await install(bus);

    doc.press(insideOurUi);
    assert.equal(drawer.classList.contains('pinnedOpen'), true);
});

test('a click anywhere else unpins a drawer WE pinned — a genuine outside click still closes it exactly like stock ST', async () => {
    const drawer = fakeDrawer();
    const doc = fakeDocument([drawer]);
    const bus = createContractBus();
    registerStDrawerGuard(bus, { documentRef: () => doc });
    await install(bus);

    doc.press(insideOurUi);
    assert.equal(drawer.classList.contains('pinnedOpen'), true);
    doc.press(outsideOurUi);
    assert.equal(drawer.classList.contains('pinnedOpen'), false, 'unpinned — ST\'s own handler is free to close it now');
});

test('a drawer already .pinnedOpen by something else (not us) is left alone on an outside click — we only ever remove OUR OWN pin', async () => {
    const drawer = fakeDrawer();
    drawer.classList.add('pinnedOpen'); // pinned by someone/something else, never touched by us
    const doc = fakeDocument([drawer]);
    const bus = createContractBus();
    registerStDrawerGuard(bus, { documentRef: () => doc });
    await install(bus);

    doc.press(outsideOurUi);
    assert.equal(drawer.classList.contains('pinnedOpen'), true, 'not ours to remove');
});

test('install()/uninstall() attach and detach exactly one capture-phase click listener; a second install() is a no-op, not a second listener', async () => {
    const doc = fakeDocument([]);
    const bus = createContractBus();
    registerStDrawerGuard(bus, { documentRef: () => doc });

    assert.equal(doc.isListening(), false);
    const first = await install(bus);
    assert.equal(first.value, true);
    assert.equal(doc.isListening(), true);
    await install(bus); // second call: no crash, still one listener
    assert.equal(doc.isListening(), true);
    const off = await new Promise(resolve => bus.subscribe('stDrawerGuard.uninstall', {}, resolve));
    assert.equal(off.value, true);
    assert.equal(doc.isListening(), false);
});

// --- Ядро: решает КОГДА, не трогает КАК ---

test('createDrawerGuardCore().install() calls the service through host.services, and is idempotent (a second call does not re-install)', async () => {
    const engine = createEngine();
    let installCalls = 0;
    engine.buses.services.register('stDrawerGuard.install', () => { installCalls += 1; return true; });
    const core = createDrawerGuardCore(engine.registerCaller('core.drawerGuard', 'cores', { tier: 'official' }));

    assert.equal(await core.install(), true);
    assert.equal(await core.install(), true, 'already installed — the core itself short-circuits, no second request');
    assert.equal(installCalls, 1);
});
