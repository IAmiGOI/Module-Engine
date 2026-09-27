import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createEngine } from '../libraries/shared/engine.js';
import { snapshotOpenBlocks, formatOpenBlocks, readControl } from '../libraries/core/ui-context.js';
import { createAnchorNavigator } from '../cores/ui/anchors.js';
import { parseArticle, selectArticles } from '../libraries/core/guide-knowledge.js';
import { createGuideCore } from '../cores/guide/index.js';

// Рукописное дерево: ровно те свойства, что читает снимок (без DOM).
const text = value => ({ nodeType: 3, textContent: value });
function el(tagName, props = {}, ...children) {
    const nodes = children.map(child => (typeof child === 'string' ? text(child) : child));
    const node = { tagName, className: props.class ?? '', dataset: props.dataset ?? {}, children: nodes.filter(child => child.nodeType !== 3), childNodes: nodes, ...props };
    node.textContent = nodes.map(child => child.textContent).join('');
    node.getAttribute = name => props.attrs?.[name] ?? null;
    return node;
}
const field = (label, control, hint) => el('LABEL', { class: 'stme-field' }, el('SPAN', { class: 'stme-field-label' }, label, hint ? el('SMALL', {}, hint) : ''), control);
const input = (value, extra = {}) => el('INPUT', { type: 'text', value, ...extra });
const block = (anchor, title, open, ...body) => el('DETAILS', { dataset: { stmeAnchor: anchor }, open }, el('SUMMARY', {}, el('DIV', { class: 'stme-card-title' }, el('STRONG', {}, title))), el('DIV', { class: 'stme-card-body' }, ...body));

function panel() {
    return el('DIV', {},
        block('card:modules', 'Modules', true,
            block('module:module.tracker', 'Tracker', true,
                field('Poll when', el('SELECT', { options: [{ textContent: 'Manual only' }, { textContent: 'After every reply' }], selectedIndex: 1 }), 'What triggers an update.'),
                field('Display template', input('❤ {health}')),
                field('API key', input('sk-very-secret')),
                el('LABEL', { class: 'stme-switch' }, el('INPUT', { type: 'checkbox', checked: true }), el('SPAN', { class: 'stme-switch-track' }), el('SPAN', { class: 'stme-switch-label' }, 'Enabled', el('SMALL', {}, 'Turn the tracker off without deleting it.'))),
                el('LABEL', { class: 'stme-slider' }, el('SPAN', { class: 'stme-slider-head' }, el('SPAN', {}, 'Every N replies'), el('OUTPUT', {}, '3')), el('INPUT', { type: 'range', value: '3' })),
                el('BUTTON', { type: 'button' }, 'Save'), el('BUTTON', { type: 'button' }, 'Poll now'), el('BUTTON', { attrs: { title: '' } }, '')),
            block('module:module.music', 'Music', false, field('Min similarity', input('0.3')))),
        block('card:models', 'Model connections', false, field('Name', input('x'))));
}

test('only OPEN blocks are read; each block lists its own fields, switches, sliders and buttons with current values and hints', () => {
    const blocks = snapshotOpenBlocks(panel(), { label: 'Panel' });
    assert.deepEqual(blocks.map(item => item.path), ['Panel › Modules', 'Panel › Modules › Tracker']);
    const tracker = blocks[1];
    assert.equal(tracker.anchor, 'module:module.tracker');
    assert.deepEqual(tracker.fields.map(item => [item.label, item.value]), [['Poll when', 'After every reply'], ['Display template', '❤ {health}'], ['API key', 'set'], ['Enabled', 'on'], ['Every N replies', '3']]);
    assert.equal(tracker.fields[0].hint, 'What triggers an update.');
    assert.equal(tracker.fields[3].hint, 'Turn the tracker off without deleting it.');
    assert.deepEqual(tracker.buttons, ['Save', 'Poll now']);
    assert.equal(blocks[0].fields.length, 0, 'the parent does not swallow its child\'s fields');
});

test('a secret never leaves: password fields and fields named key/token/secret show only set / empty', () => {
    assert.equal(readControl(input('hunter2', { type: 'password' }), 'Anything'), 'set');
    assert.equal(readControl(input('', { type: 'text' }), 'GitHub token'), 'empty');
    assert.equal(readControl(input('abc', { type: 'text' }), 'Dropbox app key'), 'set');
    assert.equal(readControl(input('plain', { type: 'text' }), 'Name'), 'plain');
    const dump = formatOpenBlocks(snapshotOpenBlocks(panel(), { label: 'Panel' }));
    assert.ok(!dump.includes('sk-very-secret'));
    assert.match(dump, /API key: set/);
});

test('the text for the prompt is short, ordered, and says when nothing is open', () => {
    assert.equal(formatOpenBlocks([]), '');
    const dump = formatOpenBlocks(snapshotOpenBlocks(panel(), { label: 'Panel' }));
    assert.match(dump, /- Panel › Modules › Tracker \[module:module\.tracker\]\n {2}· Poll when: After every reply — What triggers an update\./);
    assert.match(dump, /buttons: Save, Poll now/);
    assert.ok(!dump.includes('Min similarity'), 'a collapsed block is not read');
    const many = Array.from({ length: 30 }, (_, index) => ({ anchor: `a${index}`, path: `P ${index}`, fields: Array.from({ length: 24 }, (__, n) => ({ label: `field ${n}`, value: 'x'.repeat(80), hint: '' })), buttons: [] }));
    assert.ok(formatOpenBlocks(many).length < 2700);
});

test('ui.context reports the open blocks of every screen and the text for the prompt; a screen that is not mounted is skipped', () => {
    const engine = createEngine();
    const navigator = createAnchorNavigator(engine.registerCaller('core.ui.anchors', 'cores', { tier: 'official' }), { roots: [{ root: panel, open: () => {}, label: 'Panel' }, { root: () => null, open: () => {}, label: 'Settings' }] });
    const context = navigator.context();
    assert.deepEqual(context.blocks.map(item => item.anchor), ['card:modules', 'module:module.tracker']);
    assert.match(context.text, /Poll when: After every reply/);
    assert.ok(!context.text.includes('sk-very-secret'));
});

// --- Глоссарий полей и подбор статей по открытому блоку ---

const article = (id, anchors, always = false) => parseArticle(`---\ntitle: ${id}\nanchors: ${anchors}\nalways: ${always}\n---\n${id} body text about things.`, id);

test('the articles of the blocks that are open right now come right after the always-on ones (at most two)', () => {
    const all = [article('core', '', true), article('tracker', 'module:module.tracker'), article('music', 'module:module.music'), article('summary', 'card:summary'), article('extra', 'module:module.tracker')];
    const titles = selectArticles(all, 'hello', { openAnchors: ['module:module.tracker', 'card:summary'] }).map(item => item.title);
    assert.deepEqual(titles, ['core', 'tracker', 'summary'], 'two at most: the third open-block article (extra) waits');
    assert.deepEqual(selectArticles(all, 'hello').map(item => item.title), ['core'], 'nothing open, nothing asked — only the always-on ones');
});

test('every module has an article bound to its own block and carrying a field glossary', () => {
    const dir = new URL('../guide/knowledge/', import.meta.url);
    const articles = JSON.parse(fs.readFileSync(new URL('index.json', dir), 'utf8')).articles.map(file => parseArticle(fs.readFileSync(new URL(file, dir), 'utf8'), file));
    const modules = ['tracker', 'time', 'postprocess', 'music', 'scenePainter', 'speakerColors', 'map', 'notebook', 'secrets'];
    for (const id of modules) {
        const found = articles.find(item => item.anchors.includes(`module:module.${id}`));
        assert.ok(found, `no article for module.${id}`);
        assert.match(found.text, /## Fields on screen/, `${found.title} has no field glossary`);
    }
});

// --- Гид видит экран ---

test('the guide puts what is open on screen into the prompt and pulls the article of that block', async () => {
    const engine = createEngine();
    const bus = engine.buses.cores;
    const calls = [];
    bus.register('storage.settings.get', ({ fallback }) => fallback);
    bus.register('storage.settings.set', () => true);
    bus.register('model.workers.get', () => [{ id: 'w' }]);
    bus.register('model.workers.status', () => [{ workerId: 'w', state: 'up' }]);
    bus.register('ui.anchors.list', () => []);
    bus.register('ui.context', () => ({ text: 'Blocks the user has open right now:\n- Panel › Modules › Tracker [module:module.tracker]\n  · Poll when: After every reply', blocks: [{ anchor: 'module:module.tracker', path: 'Panel › Modules › Tracker' }] }));
    bus.register('model.generate', params => { calls.push(params); return 'ok'; });
    const guideDir = new URL('../guide/', import.meta.url);
    const guide = createGuideCore(engine.registerCaller('core.guide', 'cores', { tier: 'official' }), { publish: () => {}, mount: () => ({}), modules: { list: () => [], enabled: () => [] }, loadText: async path => fs.readFileSync(new URL(path, guideDir), 'utf8') });
    await guide.load();
    await guide.ask('what is this?');
    const system = calls[0].messages[0].content;
    assert.match(system, /Poll when: After every reply/);
    assert.match(system, /## Fields on screen/);
    assert.match(system, /Hold the generation until this tracker answers/);
});

test('a block that is "open" but not on screen (its panel is closed) is not reported as open — otherwise the guide would not open the panel and would talk about fields nobody can see', () => {
    const hidden = panel();
    const trackerBlock = hidden.children[0].children[1].children[0];   // Modules → body → Tracker
    trackerBlock.getClientRects = () => [];
    const shown = snapshotOpenBlocks(hidden, { label: 'Panel' });
    assert.ok(!shown.some(block => block.anchor === 'module:module.tracker'));
    const visible = panel();
    visible.children[0].children[1].children[0].getClientRects = () => [{}];
    assert.ok(snapshotOpenBlocks(visible, { label: 'Panel' }).some(block => block.anchor === 'module:module.tracker'));
    const closedPanel = panel();
    closedPanel.children[0].getClientRects = () => [];   // the whole Modules card is hidden with its panel
    assert.deepEqual(snapshotOpenBlocks(closedPanel, { label: 'Panel' }), []);
});
