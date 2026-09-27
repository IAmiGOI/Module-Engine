import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createEngine } from '../libraries/shared/engine.js';
import { extractAnchors } from '../libraries/core/guide-markup.js';
import { createGuideCore } from '../cores/guide/index.js';

test('every interface link of a reply is found, in order and without repeats: text links, card anchors, step anchors — web links are not interface blocks', () => {
    const reply = 'Open [Models](stme:card:models) and [Models again](stme:card:models), docs: [x](https://example.com).\n```card\n{"title":"T","text":"t","anchor":"card:modules"}\n```\n```steps\n{"items":[{"text":"a","anchor":"card:summary"},{"text":"b"},{"text":"c","anchor":"card:models"}]}\n```';
    assert.deepEqual(extractAnchors(reply), ['card:models', 'card:modules', 'card:summary']);
    assert.deepEqual(extractAnchors('No links here.'), []);
});

function build(reply) {
    const engine = createEngine();
    const bus = engine.buses.cores;
    const revealed = [];
    const pauses = [];
    bus.register('storage.settings.get', ({ fallback }) => fallback);
    bus.register('storage.settings.set', () => true);
    bus.register('model.workers.get', () => [{ id: 'w' }]);
    bus.register('model.workers.status', () => [{ workerId: 'w', state: 'up' }]);
    bus.register('ui.anchors.list', () => []);
    bus.register('ui.reveal', ({ anchor }) => { revealed.push(anchor); return true; });
    bus.register('model.generate', () => reply);
    const dir = new URL('../guide/', import.meta.url);
    const guide = createGuideCore(engine.registerCaller('core.guide', 'cores', { tier: 'official' }), {
        publish: () => {}, mount: () => ({}), modules: { list: () => [], enabled: () => [] }, sleep: async ms => { pauses.push(ms); },
        loadText: async path => fs.readFileSync(new URL(path, dir), 'utf8'),
    });
    return { guide, revealed, pauses };
}

test('the blocks she links open by themselves, one after another with a pause, and no more than a few per reply', async () => {
    const { guide, revealed, pauses } = build('Let me show you: [a](stme:card:models), [b](stme:card:modules), [c](stme:card:summary), [d](stme:card:lorebook), [e](stme:card:macros).');
    await guide.load();
    await guide.ask('where do I start?');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(revealed, ['card:models', 'card:modules', 'card:summary', 'card:lorebook']);
    assert.equal(pauses.length, 3, 'a pause between blocks, none before the first');
    assert.match(guide.messages.peek().at(-1).text, /\[a\]\(stme:card:models\)/, 'the links stay in the reply as chips');
});

test('a reply without links opens nothing', async () => {
    const { guide, revealed } = build('Just words.');
    await guide.load();
    await guide.ask('hi');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(revealed, []);
});
