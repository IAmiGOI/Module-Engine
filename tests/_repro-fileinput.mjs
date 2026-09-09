
import { createEngine } from '../libraries/shared/engine.js';
import { registerDomService } from '../services/dom.js';
import { createFinalUiPc } from '../cores/ui/final-ui-pc.js';
import { h } from '../cores/ui/tree.js';
import { render } from '../cores/ui/diff.js';
import { makeFakeDocument } from '../tests/helpers/fake-document.js';

const engine = createEngine();
const domCaller = engine.registerCaller('service.dom', 'services', { tier: 'official' });
registerDomService(domCaller.own, { document: makeFakeDocument() });
const uiHost = engine.registerCaller('core.test', 'cores', { tier: 'official' });
const ui = createFinalUiPc(uiHost);

const fileInput = h('input', { type: 'file', accept: 'application/json,.json', class: 'stme-preset-file', 'on:change': () => {} });
const tree = h('div', { class: 'row' }, fileInput);
const patches = [];
render(tree, p => patches.push(p));
for (const p of patches) ui.apply(p);
await ui.settled();
const root = ui.getRoot();
const input = root.children[0];
console.log('tag:', input.tagName, '| attrs:', JSON.stringify(input.attributes), '| class:', JSON.stringify(input.className));
