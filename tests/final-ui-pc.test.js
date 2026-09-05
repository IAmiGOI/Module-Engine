import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerDomService } from '../services/dom.js';
import { createFinalUiPc } from '../cores/ui/final-ui-pc.js';
import { signal } from '../cores/ui/reactive.js';
import { h } from '../cores/ui/tree.js';
import { render } from '../cores/ui/diff.js';
import { makeFakeDocument } from './helpers/fake-document.js';

const DOM_CONTRACTS = ['dom.createElement', 'dom.createTextNode', 'dom.setProp', 'dom.removeProp', 'dom.append', 'dom.remove', 'dom.replaceWith'];

/** Wires a real engine: a "service.dom" caller providing the real (fake-document-backed) dom.* contracts, and a "core.finalUiPc" caller with the given rights, reaching them through a real Гейт. */
function setup({ allowedContracts = DOM_CONTRACTS } = {}) {
    const engine = createEngine();
    const domServiceCaller = engine.registerCaller('service.dom', 'services', { tier: 'official' });
    registerDomService(domServiceCaller.own, { document: makeFakeDocument() });

    const uiHost = engine.registerCaller('core.finalUiPc', 'cores', { tier: 'community', allowedContracts });
    return { engine, finalUi: createFinalUiPc(uiHost) };
}

test('applying a full sequence (mount, insert, setProps, reorder, remove) through the REAL Гейт-checked path produces the correct real tree', async () => {
    const { finalUi } = setup();

    finalUi.apply({ type: 'mount', path: [], node: { tag: 'ul', props: {}, children: [] } });
    finalUi.apply({ type: 'insert', path: [{ key: 'a' }], node: { tag: 'li', props: {}, children: [] } });
    finalUi.apply({ type: 'insert', path: [{ key: 'b' }], node: { tag: 'li', props: {}, children: [] } });
    finalUi.apply({ type: 'setProps', path: [{ key: 'a' }], props: { class: 'first' } });
    finalUi.apply({ type: 'reorder', path: [], order: ['b', 'a'] });
    await finalUi.settled();

    assert.equal(finalUi.getRoot().tagName, 'ul');
    assert.deepEqual(finalUi.getRoot().children.map(c => c === finalUi.getNode([{ key: 'a' }]) ? 'a' : 'b'), ['b', 'a']);
    assert.equal(finalUi.getNode([{ key: 'a' }]).className, 'first');

    finalUi.apply({ type: 'remove', path: [{ key: 'b' }] });
    await finalUi.settled();
    assert.equal(finalUi.getRoot().children.length, 1);
});

test('a Ядро WITHOUT rights to the dom.* contracts is refused by the real Гейт — the fake document is never touched at all', async () => {
    const { finalUi } = setup({ allowedContracts: [] }); // no DOM rights granted at all

    await assert.rejects(
        () => { finalUi.apply({ type: 'mount', path: [], node: { tag: 'div', props: {}, children: [] } }); return finalUi.settled(); },
        /refused/,
    );
    assert.equal(finalUi.getRoot(), null);
});

test('partial rights are enforced per-contract, not all-or-nothing — missing JUST "dom.setProp" still blocks that specific step', async () => {
    const { finalUi } = setup({ allowedContracts: DOM_CONTRACTS.filter(c => c !== 'dom.setProp') });

    await assert.rejects(
        () => { finalUi.apply({ type: 'mount', path: [], node: { tag: 'div', props: { title: 'x' }, children: [] } }); return finalUi.settled(); },
        /dom\.setProp.*refused/,
    );
});

// --- End to end: render() (diff.js) -> createFinalUiPc() -> REAL Гейт ->
// real (fake-document) DOM. The full loop, properly gated this time.

test('end to end: a signal-driven re-render really updates the real (fake-document) tree, through the real Гейт', async () => {
    const { finalUi } = setup();
    const title = signal('first');
    const items = signal([h('li', { key: 'x' }, 'X')]);

    const dispose = render(h('div', { title }, h('ul', {}, items)), patch => finalUi.apply(patch));
    await finalUi.settled();

    assert.equal(finalUi.getRoot().attributes.title, 'first');
    const ul = finalUi.getRoot().children[0];
    assert.equal(ul.children[0].children[0].text, 'X');

    title.set('second');
    items.set([h('li', { key: 'y' }, 'Y'), h('li', { key: 'x' }, 'X')]);
    await finalUi.settled();

    assert.equal(finalUi.getRoot().attributes.title, 'second');
    assert.equal(ul.children.length, 2);
    assert.equal(ul.children[0].children[0].text, 'Y');
    assert.equal(ul.children[1].children[0].text, 'X');

    dispose();
});
