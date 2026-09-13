import test from 'node:test';
import assert from 'node:assert/strict';
import { domOperations, computeTextNodePaintPlan, registerDomService } from '../services/dom.js';
import { createContractBus } from '../libraries/shared/contract-bus.js';
import { makeFakeDocument, FakeElement, FakeTextNode } from './helpers/fake-document.js';

// --- Unit level: computeTextNodePaintPlan() — pure, no DOM at all ---

test('computeTextNodePaintPlan leaves a text node with NO overlapping run out of the result entirely', () => {
    const plan = computeTextNodePaintPlan([{ index: 0, start: 0, end: 10, text: 'plain text' }], [{ start: 20, end: 25, color: 'red' }]);
    assert.deepEqual(plan, []);
});

test('computeTextNodePaintPlan splits a text node into plain/colored/plain pieces around ONE run in the middle', () => {
    const plan = computeTextNodePaintPlan(
        [{ index: 0, start: 0, end: 11, text: 'Stay close.' }],
        [{ start: 0, end: 4, color: '#ff0000' }],
    );
    assert.deepEqual(plan, [{ index: 0, pieces: [{ text: 'Stay', color: '#ff0000' }, { text: ' close.', color: null }] }]);
});

test('computeTextNodePaintPlan produces TWO separate colored pieces for TWO different runs inside the same text node', () => {
    const plan = computeTextNodePaintPlan(
        [{ index: 0, start: 0, end: 20, text: 'Alex said no, Maria' }],
        [{ start: 0, end: 4, color: 'blue' }, { start: 14, end: 19, color: 'green' }],
    );
    assert.deepEqual(plan[0].pieces, [
        { text: 'Alex', color: 'blue' },
        { text: ' said no, ', color: null },
        { text: 'Maria', color: 'green' },
    ]);
});

test('computeTextNodePaintPlan clamps a run that starts before / ends after this particular text node\'s own range (the run spans MULTIPLE nodes)', () => {
    // Global run [5, 25) against a node covering global offsets [10, 20).
    const plan = computeTextNodePaintPlan([{ index: 0, start: 10, end: 20, text: '0123456789' }], [{ start: 5, end: 25, color: 'red' }]);
    assert.deepEqual(plan, [{ index: 0, pieces: [{ text: '0123456789', color: 'red' }] }]);
});

// --- Integration level: paintTextRuns()/clearPaintedRuns() against a fake but structurally real DOM ---

function buildMessageTextNode(text) {
    const container = new FakeElement('div');
    container.append(new FakeTextNode(text));
    return container;
}

test('paintTextRuns wraps the run in a <span data-stme-paint> carrying the color, and leaves the untouched text as plain text nodes either side', () => {
    const doc = makeFakeDocument();
    const container = buildMessageTextNode('Stay close. Do not talk.');

    domOperations.paintTextRuns(container, [{ start: 0, end: 4, color: '#112233' }], doc);

    assert.equal(container.children.length, 2, 'one colored span + one plain trailing text node');
    const [span, trailing] = container.children;
    assert.equal(span.tagName, 'span');
    assert.equal(span.className, 'stme-speaker-paint');
    assert.equal(span.style.color, '#112233');
    assert.equal(span.children[0].text, 'Stay');
    assert.equal(trailing.text, ' close. Do not talk.');
});

test('paintTextRuns called TWICE in a row (simulating a re-render) never doubles up spans — the second call\'s own clear removes the first paint before repainting', () => {
    const doc = makeFakeDocument();
    const container = buildMessageTextNode('Stay close.');

    domOperations.paintTextRuns(container, [{ start: 0, end: 4, color: 'red' }], doc);
    domOperations.paintTextRuns(container, [{ start: 0, end: 4, color: 'blue' }], doc);

    const spans = container.children.filter(node => node.attributes?.['data-stme-paint']);
    assert.equal(spans.length, 1, 'exactly one paint span must survive a repaint, not two nested/stacked ones');
    assert.equal(spans[0].style.color, 'blue', 'the NEW color must win, not the stale one from the first paint');
});

test('paintTextRuns preserves EXISTING markup: a run split across a <b> boundary becomes two independent colored spans, one per original text node, and the <b> element itself is untouched', () => {
    const doc = makeFakeDocument();
    const container = new FakeElement('div');
    const bold = new FakeElement('b');
    bold.append(new FakeTextNode('Alex'));
    container.append(bold);
    container.append(new FakeTextNode(' said no.'));

    // Concatenated plain text is "Alex said no." — paint the whole run [0, 8) ("Alex sai").
    domOperations.paintTextRuns(container, [{ start: 0, end: 8, color: 'green' }], doc);

    assert.equal(container.children[0], bold, 'the <b> element itself must still be the first child — never replaced');
    assert.equal(bold.children[0].tagName, 'span', 'the text INSIDE <b> got its own colored span');
    assert.equal(bold.children[0].children[0].text, 'Alex');
});

test('clearPaintedRuns removes every painted span and restores its plain text content, leaving the container safe to re-walk for a fresh paint', () => {
    const doc = makeFakeDocument();
    const container = buildMessageTextNode('Stay close.');
    domOperations.paintTextRuns(container, [{ start: 0, end: 4, color: 'red' }], doc);

    domOperations.clearPaintedRuns(container);

    assert.equal(container.children.some(node => node.attributes?.['data-stme-paint']), false);
    const plainText = container.children.map(node => node.text ?? '').join('');
    assert.equal(plainText, 'Stay close.');
});

test('dom.textContent reads the concatenated rendered text of a node, the ONLY property read a Модуль is allowed off a node it was handed', async () => {
    const bus = createContractBus();
    registerDomService(bus, { document: makeFakeDocument() });
    const container = buildMessageTextNode('Hello there.');

    const result = await new Promise(resolve => bus.subscribe('dom.textContent', { params: { node: container } }, resolve));
    assert.equal(result.value, 'Hello there.');
});

test('dom.readCssVariable reads a CSS custom property off documentElement, trimmed', async () => {
    const bus = createContractBus();
    const documentElement = new FakeElement('html');
    const fakeDoc = {
        ...makeFakeDocument(),
        documentElement,
        defaultView: { getComputedStyle: () => ({ getPropertyValue: name => (name === '--SmartThemeQuoteColor' ? '  #3f51b5  ' : '') }) },
    };
    registerDomService(bus, { document: fakeDoc });

    const result = await new Promise(resolve => bus.subscribe('dom.readCssVariable', { params: { name: '--SmartThemeQuoteColor' } }, resolve));
    assert.equal(result.value, '#3f51b5');
});

test('registerDomService() exposes dom.paintTextRuns and dom.clearPaintedRuns as real, Гейт-reachable contracts', async () => {
    const bus = createContractBus();
    registerDomService(bus, { document: makeFakeDocument() });
    const container = buildMessageTextNode('Hi there.');

    const painted = await new Promise(resolve => bus.subscribe('dom.paintTextRuns', { params: { container, runs: [{ start: 0, end: 2, color: 'red' }] } }, resolve));
    assert.equal(painted.ok, true);
    assert.equal(container.children[0].tagName, 'span');

    const cleared = await new Promise(resolve => bus.subscribe('dom.clearPaintedRuns', { params: { container } }, resolve));
    assert.equal(cleared.ok, true);
    assert.equal(container.children.some(node => node.attributes?.['data-stme-paint']), false);
});
