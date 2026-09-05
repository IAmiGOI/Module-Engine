import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { request } from '../libraries/shared/request.js';
import { h } from '../cores/ui/tree.js';
import { createMessageFooterCore, SLOTS } from '../cores/ui/message-footer.js';

/**
 * Крошечная подделка DOM — ровно те методы, которыми пользуется Ядро. Смысл не
 * в том, чтобы «сэмулировать браузер», а в том, чтобы проверяемым стало
 * ГЛАВНОЕ обещание: подвал возвращается на место после чужой перерисовки.
 */
function fakeNode(className = '') {
    const node = {
        className,
        dataset: {},
        children: [],
        append(child) { child.parent = node; node.children.push(child); },
        remove() {
            const index = node.parent?.children.indexOf(node) ?? -1;
            if (index >= 0) node.parent.children.splice(index, 1);
            node.parent = null;
        },
        contains(other) {
            if (other === node) return true;
            return node.children.some(child => child.contains?.(other));
        },
        querySelector(selector) {
            const slot = /\[data-slot="(\w+)"\]/.exec(selector)?.[1];
            const wanted = /\.([\w-]+)/.exec(selector)?.[1];
            return node.children.find(child => (slot ? child.dataset?.slot === slot : child.className === wanted)) ?? null;
        },
    };
    return node;
}

function buildEngine() {
    const engine = createEngine();
    const messageBlock = fakeNode('mes_block');
    const roots = [];

    const stHost = engine.registerCaller('service.stChat', 'services', { tier: 'official' });
    stHost.own.register('stChat.renderedIds', () => ['0', '1']);
    stHost.own.register('stChat.messageElement', () => messageBlock);
    stHost.own.register('stChat.container', () => null);
    // Узлы создаёт Сервис DOM — Ядро само их не делает и делать не должно.
    const domHost = engine.registerCaller('service.dom', 'services', { tier: 'official' });
    domHost.own.register('dom.createElement', () => fakeNode());

    let observerCallback = null;
    const core = createMessageFooterCore(engine.registerCaller('core.ui.messageFooter', 'cores', { tier: 'official' }), {
        // Каждый слот получает свою «финальную отрисовку»: настоящий Final UI
        // здесь не нужен, проверяется размещение, а не диффинг.
        createFinalUi: () => {
            const root = fakeNode('widget');
            roots.push(root);
            return { apply: () => {}, getRoot: () => root, settled: () => Promise.resolve() };
        },
        observe: (container, onChanged) => { observerCallback = onChanged; return () => { observerCallback = null; }; },
    });

    return { engine, core, messageBlock, roots, fireObserver: () => observerCallback?.() };
}

const footerOf = block => block.children.find(child => child.className === 'stme-message-footer');

test('the footer offers exactly three slots — no more, no fewer', () => {
    assert.deepEqual(SLOTS, ['left', 'center', 'right']);
});

test('a claimed slot really gets its widget placed under the message', async () => {
    const { core, messageBlock, roots } = buildEngine();
    core.claim({ slot: 'center', ownerId: 'module.time', node: h('div', {}, 'time') });

    await core.render();

    const cell = footerOf(messageBlock).children.find(child => child.dataset.slot === 'center');
    assert.ok(cell, 'слот появился');
    assert.ok(cell.contains(roots[0]), 'и в нём дерево виджета');
});

test('three independent widgets live side by side, each with its own tree', async () => {
    const { core, messageBlock, roots } = buildEngine();
    core.claim({ slot: 'left', ownerId: 'a', node: h('div', {}, 'A') });
    core.claim({ slot: 'center', ownerId: 'b', node: h('div', {}, 'B') });
    core.claim({ slot: 'right', ownerId: 'c', node: h('div', {}, 'C') });

    await core.render();

    const footer = footerOf(messageBlock);
    assert.deepEqual(footer.children.map(child => child.dataset.slot), ['left', 'center', 'right']);
    assert.equal(new Set(roots).size, 3, 'у каждого виджета СВОЁ дерево — падение одного не трогает соседей');
});

test('a slot someone else already took is refused instead of silently stolen', async () => {
    const { core } = buildEngine();
    core.claim({ slot: 'left', ownerId: 'first', node: h('div', {}, 'x') });

    assert.throws(() => core.claim({ slot: 'left', ownerId: 'second', node: h('div', {}, 'y') }), /already taken by "first"/);
});

test('the same owner may re-claim its own slot — that is a redraw, not a conflict', () => {
    const { core } = buildEngine();
    core.claim({ slot: 'left', ownerId: 'same', node: h('div', {}, 'x') });

    assert.doesNotThrow(() => core.claim({ slot: 'left', ownerId: 'same', node: h('div', {}, 'y') }));
});

test('an unknown slot name is refused — "bottom" would silently render nowhere', () => {
    const { core } = buildEngine();

    assert.throws(() => core.claim({ slot: 'bottom', ownerId: 'a', node: h('div', {}) }), /unknown slot "bottom"/);
});

// --- Главное обещание: переживать чужую перерисовку -------------------------

test('a reroll that wipes the message DOM does NOT lose the footer — the ST event puts it back', async () => {
    const { engine, core, messageBlock } = buildEngine();
    core.claim({ slot: 'center', ownerId: 'module.time', node: h('div', {}, 'time') });
    await core.start(); // подписки на события ST заводит именно start()

    // Ровно то, что делает перерисовка сообщения: всё содержимое заменено.
    messageBlock.children.length = 0;
    engine.events.emit('st.messageSwiped');
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.ok(footerOf(messageBlock), 'подвал вернулся сам');
});

test('an edit of the original message puts the footer back too', async () => {
    const { engine, core, messageBlock } = buildEngine();
    core.claim({ slot: 'left', ownerId: 'a', node: h('div', {}, 'x') });
    await core.start();

    messageBlock.children.length = 0;
    engine.events.emit('st.messageEdited');
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.ok(footerOf(messageBlock));
});

test('a redraw NOBODY announced is still caught — that is what the observer is for', async () => {
    const { core, messageBlock, fireObserver } = buildEngine();
    core.claim({ slot: 'left', ownerId: 'a', node: h('div', {}, 'x') });
    await core.start();

    // `updateMessageBlock()` из чужого кода не эмитит ни одного события ST —
    // именно на этот случай и стоит наблюдатель.
    messageBlock.children.length = 0;
    fireObserver();
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.ok(footerOf(messageBlock));
});

test('attach() is idempotent — calling it again does not stack a second footer', async () => {
    const { core, messageBlock } = buildEngine();
    core.claim({ slot: 'left', ownerId: 'a', node: h('div', {}, 'x') });
    await core.render();

    await core.attach();
    await core.attach();

    assert.equal(messageBlock.children.filter(child => child.className === 'stme-message-footer').length, 1);
});

test('releasing a slot takes its widget out of the DOM, not just out of the registry', async () => {
    const { core, messageBlock, roots } = buildEngine();
    core.claim({ slot: 'left', ownerId: 'a', node: h('div', {}, 'x') });
    await core.render();

    core.release('left');

    assert.equal(roots[0].parent, null, 'узел снят со страницы');
    assert.deepEqual(core.slots().find(entry => entry.slot === 'left').ownerId, null);
});

test('a Module can claim a slot over the bus, and one without the right cannot', async () => {
    const { engine, core } = buildEngine();
    const allowed = engine.registerCaller('module.ok', 'modules', { tier: 'community', allowedContracts: ['ui.messageFooter.claim'] });
    const denied = engine.registerCaller('module.no', 'modules', { tier: 'community', allowedContracts: [] });

    const ok = await request(allowed.cores, 'ui.messageFooter.claim', { params: { slot: 'right', ownerId: 'module.ok', node: h('div', {}) } });
    const no = await request(denied.cores, 'ui.messageFooter.claim', { params: { slot: 'left', ownerId: 'module.no', node: h('div', {}) } });

    assert.equal(ok.ok, true);
    assert.equal(no.ok, false);
    assert.deepEqual(core.slots().filter(entry => entry.ownerId).map(entry => entry.ownerId), ['module.ok']);
});

test('the Ядро has NO way to write into a message — the model can never see the footer', () => {
    const { core } = buildEngine();

    const surface = Object.keys(core);
    assert.deepEqual(surface.filter(name => /message|mes|prompt|text/i.test(name)), [], 'ни одного метода, которым можно дописать сообщение');
});

test('a slot claimed AFTER the engine started still shows up — modules are enabled later, not at boot', async () => {
    const { core, messageBlock } = buildEngine();
    await core.start();

    core.claim({ slot: 'left', ownerId: 'module.time', node: h('div', {}, 'time') });
    await new Promise(resolve => setTimeout(resolve, 0));

    const footer = footerOf(messageBlock);
    assert.ok(footer, 'подвал появился');
    assert.ok(footer.children.some(child => child.dataset.slot === 'left'), 'и в нём слот включённого позже Модуля');
});

test('a slot claimed after the footer is ALREADY placed still gets its cell — the early return must not skip the slots', async () => {
    const { core, messageBlock } = buildEngine();
    core.claim({ slot: 'center', ownerId: 'first', node: h('div', {}, 'A') });
    await core.start();
    assert.deepEqual(footerOf(messageBlock).children.map(child => child.dataset.slot), ['center']);

    core.claim({ slot: 'left', ownerId: 'later', node: h('div', {}, 'B') });
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.deepEqual(footerOf(messageBlock).children.map(child => child.dataset.slot).sort(), ['center', 'left']);
});
