import test from 'node:test';
import assert from 'node:assert/strict';
import { createUiEngineCore } from '../cores/ui/ui-engine.js';
import { h } from '../cores/ui/tree.js';
import { signal } from '../cores/ui/reactive.js';
import { createEngine } from '../libraries/shared/engine.js';
import { registerDomService } from '../services/dom.js';
import { createFinalUiPc } from '../cores/ui/final-ui-pc.js';
import { makeFakeDocument } from './helpers/fake-document.js';

function makeStubFinalUi() {
    const patches = [];
    return { apply: patch => patches.push(patch), settled: () => Promise.resolve(), patches };
}

test('mount() renders into a fresh Final UI for that slot, tracked by getFinalUi()', () => {
    const uiEngine = createUiEngineCore(makeStubFinalUi);

    const finalUi = uiEngine.mount('settings', h('div', {}, 'hi'));

    assert.equal(uiEngine.getFinalUi('settings'), finalUi);
    assert.equal(finalUi.patches[0].type, 'mount');
    assert.equal(uiEngine.isMounted('settings'), true);
});

test('mounting the SAME slot again disposes the old tree first — no leaked reactivity', () => {
    const uiEngine = createUiEngineCore(makeStubFinalUi);
    const title = signal('old');
    const firstFinalUi = uiEngine.mount('settings', h('div', { title }));
    uiEngine.mount('settings', h('div', {}, 'new'));
    firstFinalUi.patches.length = 0;

    title.set('changed');

    assert.equal(firstFinalUi.patches.length, 0, 'the disposed first tree\'s own effect must never fire again');
});

test('two DIFFERENT slots mounted at the same time are fully independent — separate Final UI instances', () => {
    const uiEngine = createUiEngineCore(makeStubFinalUi);

    const settingsUi = uiEngine.mount('settings', h('div', {}, 'settings'));
    const browserUi = uiEngine.mount('moduleBrowser', h('div', {}, 'browser'));

    assert.notEqual(settingsUi, browserUi);
    assert.equal(uiEngine.isMounted('settings'), true);
    assert.equal(uiEngine.isMounted('moduleBrowser'), true);
});

test('unmount() tears down just that one slot, leaving the others mounted', () => {
    const uiEngine = createUiEngineCore(makeStubFinalUi);
    uiEngine.mount('settings', h('div', {}));
    uiEngine.mount('moduleBrowser', h('div', {}));

    uiEngine.unmount('settings');

    assert.equal(uiEngine.isMounted('settings'), false);
    assert.equal(uiEngine.isMounted('moduleBrowser'), true);
});

test('unmountAll() tears down every mounted slot', () => {
    const uiEngine = createUiEngineCore(makeStubFinalUi);
    uiEngine.mount('settings', h('div', {}));
    uiEngine.mount('moduleBrowser', h('div', {}));

    uiEngine.unmountAll();

    assert.equal(uiEngine.isMounted('settings'), false);
    assert.equal(uiEngine.isMounted('moduleBrowser'), false);
});

test('unmounting a never-mounted slot is a harmless no-op', () => {
    const uiEngine = createUiEngineCore(makeStubFinalUi);
    assert.doesNotThrow(() => uiEngine.unmount('nothing-here'));
});

// --- End to end: real engine + real Гейт + real (fake-document) DOM — two
// slots really don't collide in a REAL Final UI PC, not just a stub.

test('end to end: two slots, each through its own real Гейт-checked Final UI PC, mount into two independent real trees', async () => {
    const engine = createEngine();
    const domCaller = engine.registerCaller('service.dom', 'services', { tier: 'official' });
    registerDomService(domCaller.own, { document: makeFakeDocument() });

    let counter = 0;
    const createFinalUi = () => createFinalUiPc(engine.registerCaller(`core.finalUiPc.${++counter}`, 'cores', { tier: 'official' }));
    const uiEngine = createUiEngineCore(createFinalUi);

    const settingsUi = uiEngine.mount('settings', h('div', { class: 'settings-root' }));
    const browserUi = uiEngine.mount('moduleBrowser', h('div', { class: 'browser-root' }));
    await uiEngine.settled('settings');
    await uiEngine.settled('moduleBrowser');

    assert.equal(settingsUi.getRoot().className, 'settings-root');
    assert.equal(browserUi.getRoot().className, 'browser-root');
    assert.notEqual(settingsUi.getRoot(), browserUi.getRoot());
});
