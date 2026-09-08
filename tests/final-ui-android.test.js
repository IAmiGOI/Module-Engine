import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerDomService } from '../services/dom.js';
import { createFinalUiAndroid, isMobileSurface } from '../cores/ui/final-ui-android.js';
import { createFinalUiPc } from '../cores/ui/final-ui-pc.js';
import { makeFakeDocument } from './helpers/fake-document.js';

const DOM_CONTRACTS = ['dom.createElement', 'dom.createTextNode', 'dom.setProp', 'dom.removeProp', 'dom.append', 'dom.remove', 'dom.replaceWith'];

/** Тот же харнесс, что у final-ui-pc.test.js: реальный Гейт + fake-document. */
function setup({ allowedContracts = DOM_CONTRACTS } = {}) {
    const engine = createEngine();
    const domServiceCaller = engine.registerCaller('service.dom', 'services', { tier: 'official' });
    registerDomService(domServiceCaller.own, { document: makeFakeDocument() });

    const uiHost = engine.registerCaller('core.finalUiAndroid', 'cores', { tier: 'community', allowedContracts });
    return { engine, finalUi: createFinalUiAndroid(uiHost) };
}

test('the Android adapter applies the same patch stream through the REAL Гейт-checked path', async () => {
    const { finalUi } = setup();

    finalUi.apply({ type: 'mount', path: [], node: { tag: 'div', props: { class: 'panel' }, children: [] } });
    finalUi.apply({ type: 'insert', path: [{ key: 'a' }], node: { tag: 'span', props: { class: 'item' }, children: [{ text: 'hi' }] } });
    finalUi.apply({ type: 'setProps', path: [{ key: 'a' }], props: { class: 'item first' } });
    await finalUi.settled();

    const root = finalUi.getRoot();
    assert.ok(root, 'root exists');
    // Платформенная пометка добавлена К классу модуля, а не вместо него.
    assert.equal(root.className, 'panel stme-android');
    assert.equal(root.attributes['data-platform'], 'android');
    const child = root.children[0];
    assert.equal(child.className, 'item first stme-android');
    assert.equal(child.attributes['data-platform'], 'android');
});

test('the platform mark survives prop removal (setProps dropping class entirely)', async () => {
    const { finalUi } = setup();

    finalUi.apply({ type: 'mount', path: [], node: { tag: 'div', props: { class: 'x' }, children: [] } });
    await finalUi.settled();
    finalUi.apply({ type: 'setProps', path: [], props: {} }); // class removed
    await finalUi.settled();

    assert.equal(finalUi.getRoot().className, 'stme-android', 'mark re-applied even when the module removed its own class');
});

test('PC and Android cores stay separate instances — no shared node map between platforms', async () => {
    const engine = createEngine();
    const domServiceCaller = engine.registerCaller('service.dom', 'services', { tier: 'official' });
    const document = makeFakeDocument();
    registerDomService(domServiceCaller.own, { document });

    const androidHost = engine.registerCaller('core.finalUi.android', 'cores', { tier: 'community', allowedContracts: DOM_CONTRACTS });
    const pcHost = engine.registerCaller('core.finalUi.pc', 'cores', { tier: 'community', allowedContracts: DOM_CONTRACTS });
    const androidUi = createFinalUiAndroid(androidHost);
    const pcUi = createFinalUiPc(pcHost);

    androidUi.apply({ type: 'mount', path: [], node: { tag: 'div', props: { class: 'a' }, children: [] } });
    pcUi.apply({ type: 'mount', path: [], node: { tag: 'div', props: { class: 'p' }, children: [] } });
    await Promise.all([androidUi.settled(), pcUi.settled()]);

    assert.equal(androidUi.getRoot().className, 'a stme-android');
    assert.equal(pcUi.getRoot().className, 'p', 'PC root carries no platform mark');
    assert.notEqual(androidUi.getRoot(), pcUi.getRoot());
});

test('isMobileSurface() matches Android UA and narrow touch devices, not desktop', () => {
    assert.equal(isMobileSurface({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/126', maxTouchPoints: 5 }), true);
    assert.equal(isMobileSurface({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari', maxTouchPoints: 5 }), true);
    assert.equal(isMobileSurface({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64) Chrome/126', maxTouchPoints: 0 }), false);
    // Тач-ноутбук с большим экраном — не мобильная поверхность.
    assert.equal(isMobileSurface({ userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/126', maxTouchPoints: 5 }), false);
    assert.equal(isMobileSurface(undefined), false);
});
