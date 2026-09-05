import test from 'node:test';
import assert from 'node:assert/strict';
import { createUiModulesCore } from '../cores/ui/ui-modules.js';
import { h } from '../cores/ui/tree.js';
import { createEngine } from '../libraries/shared/engine.js';
import { registerDomService } from '../services/dom.js';
import { createFinalUiPc } from '../cores/ui/final-ui-pc.js';
import { makeFakeDocument } from './helpers/fake-document.js';

function makeStubFinalUi() {
    const patches = [];
    return { apply: patch => patches.push(patch), settled: () => Promise.resolve(), patches };
}

test('enable() mounts a fresh Final UI for that module id, and isEnabled() reflects it', () => {
    const uiModules = createUiModulesCore(makeStubFinalUi);

    const finalUi = uiModules.enable('tracker', h('div', {}, 'tracker settings'));

    assert.equal(uiModules.getFinalUi('tracker'), finalUi);
    assert.equal(uiModules.isEnabled('tracker'), true);
    assert.equal(finalUi.patches[0].type, 'mount');
});

test('disable() tears down just that module, leaving other enabled modules mounted', () => {
    const uiModules = createUiModulesCore(makeStubFinalUi);
    uiModules.enable('tracker', h('div', {}));
    uiModules.enable('macros', h('div', {}));

    uiModules.disable('tracker');

    assert.equal(uiModules.isEnabled('tracker'), false);
    assert.equal(uiModules.isEnabled('macros'), true);
});

test('disableAll() tears down every enabled module', () => {
    const uiModules = createUiModulesCore(makeStubFinalUi);
    uiModules.enable('tracker', h('div', {}));
    uiModules.enable('macros', h('div', {}));

    uiModules.disableAll();

    assert.equal(uiModules.isEnabled('tracker'), false);
    assert.equal(uiModules.isEnabled('macros'), false);
});

test('enabledModuleIds() lists exactly the currently-enabled module ids — genuinely unbounded, not a fixed set', () => {
    const uiModules = createUiModulesCore(makeStubFinalUi);
    uiModules.enable('tracker', h('div', {}));
    uiModules.enable('macros', h('div', {}));
    uiModules.enable('dice', h('div', {}));

    assert.deepEqual(uiModules.enabledModuleIds().sort(), ['dice', 'macros', 'tracker']);

    uiModules.disable('macros');
    assert.deepEqual(uiModules.enabledModuleIds().sort(), ['dice', 'tracker']);
});

test('re-enabling an already-enabled module replaces its tree, disposing the old one first', () => {
    const uiModules = createUiModulesCore(makeStubFinalUi);
    const first = uiModules.enable('tracker', h('div', {}, 'v1'));

    uiModules.enable('tracker', h('div', {}, 'v2'));

    assert.notEqual(uiModules.getFinalUi('tracker'), first);
});

// --- End to end: two enabled modules, each through its own real
// Гейт-checked Final UI PC, mount into two independent real trees.

test('end to end: two enabled modules mount into two fully independent real trees, through real Гейт-checked DOM', async () => {
    const engine = createEngine();
    const domCaller = engine.registerCaller('service.dom', 'services', { tier: 'official' });
    registerDomService(domCaller.own, { document: makeFakeDocument() });

    let counter = 0;
    const createFinalUi = () => createFinalUiPc(engine.registerCaller(`core.finalUiPc.${++counter}`, 'cores', { tier: 'official' }));
    const uiModules = createUiModulesCore(createFinalUi);

    const trackerUi = uiModules.enable('tracker', h('div', { class: 'tracker-card' }));
    const macrosUi = uiModules.enable('macros', h('div', { class: 'macros-card' }));
    await uiModules.settled('tracker');
    await uiModules.settled('macros');

    assert.equal(trackerUi.getRoot().className, 'tracker-card');
    assert.equal(macrosUi.getRoot().className, 'macros-card');
    assert.notEqual(trackerUi.getRoot(), macrosUi.getRoot());
});
