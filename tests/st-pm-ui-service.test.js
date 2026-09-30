import test from 'node:test';
import assert from 'node:assert/strict';
import { registerStPmUiService } from '../services/st-pm-ui.js';
import { createContractBus } from '../libraries/shared/contract-bus.js';
import { makeFakeDocument, FakeElement } from './helpers/fake-document.js';

/**
 * Фейковый документ с разметкой ST 1.18: иконка «AI Response Configuration» и панель, которую она открывает.
 * `addEventListener`/`_dispatch` на самом ДОКУМЕНТЕ (не элементе) — минимально то, что нужно проверить перехват
 * в фазе погружения; настоящей capture/bubble-модели у фейка нет, тест зовёт зарегистрированный обработчик напрямую.
 */
function makeStDocument({ withButton = true } = {}) {
    const doc = makeFakeDocument();
    doc.head = new FakeElement('head');
    if (withButton) {
        const button = new FakeElement('div');
        button.id = 'ai-config-button';
        const toggle = new FakeElement('div');
        toggle.className = 'drawer-toggle';
        button.append(toggle);
        doc.body.append(button);
    }
    const find = (node, id) => {
        if (node.id === id) return node;
        for (const child of node.children ?? []) { const hit = find(child, id); if (hit) return hit; }
        return null;
    };
    doc.getElementById = id => find(doc.head, id) ?? find(doc.body, id);
    doc._listeners = {};
    doc.addEventListener = (type, fn) => { (doc._listeners[type] ??= []).push(fn); };
    doc.removeEventListener = (type, fn) => { doc._listeners[type] = (doc._listeners[type] ?? []).filter(entry => entry !== fn); };
    doc._dispatch = (type, event) => { for (const fn of doc._listeners[type] ?? []) fn(event); };
    // Настоящий `Element.closest()`: сам узел или ближайший предок с этим id.
    FakeElement.prototype.closest = function closest(selector) {
        const id = selector.replace('#', '');
        for (let node = this; node; node = node.parent) if (node.id === id) return node;
        return null;
    };
    return doc;
}

function clickEvent(target) {
    const event = { target, defaultPrevented: false, immediateStopped: false };
    event.preventDefault = () => { event.defaultPrevented = true; };
    event.stopImmediatePropagation = () => { event.immediateStopped = true; };
    return event;
}

test('clicking SillyTavern\'s own "AI Response Configuration" icon calls our handler and stops the click before it reaches ST\'s own', () => {
    const doc = makeStDocument();
    const service = registerStPmUiService(createContractBus(), { document: doc });
    let opened = 0;

    assert.deepEqual(service.install({ onOpen: () => { opened += 1; } }), { found: true });
    assert.equal((doc._listeners.click ?? []).length, 1, 'one capture-phase listener on the document');

    const toggle = doc.getElementById('ai-config-button').children[0];
    const event = clickEvent(toggle);
    doc._dispatch('click', event);

    assert.equal(opened, 1);
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.immediateStopped, true, 'stopImmediatePropagation — ST\'s own bubble-phase handler on the same icon must never run');
});

test('a click elsewhere on the page is left alone', () => {
    const doc = makeStDocument();
    const service = registerStPmUiService(createContractBus(), { document: doc });
    let opened = 0;
    service.install({ onOpen: () => { opened += 1; } });

    doc._dispatch('click', clickEvent(new FakeElement('div')));

    assert.equal(opened, 0);
});

test('SillyTavern\'s own "AI Response Configuration" panel is hidden as soon as install() runs, permanently — no coexistence in any state', () => {
    const doc = makeStDocument();
    const service = registerStPmUiService(createContractBus(), { document: doc });
    service.install({ onOpen: () => {} });
    assert.match(doc.getElementById('stme-pm-suppress').textContent, /#left-nav-panel \{ display: none/);
    service.uninstall();
    assert.equal(doc.getElementById('stme-pm-suppress'), null);
});

test('without the "AI Response Configuration" icon in this SillyTavern version, install() answers found: false — nothing to intercept, PM disables itself', () => {
    const service = registerStPmUiService(createContractBus(), { document: makeStDocument({ withButton: false }) });
    assert.deepEqual(service.install({ onOpen: () => {} }), { found: false });
});
