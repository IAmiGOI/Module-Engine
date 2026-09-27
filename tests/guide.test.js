import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createEngine } from '../libraries/shared/engine.js';
import { parseGuideReply, parseInline, plainText } from '../libraries/core/guide-markup.js';
import { parseArticle, selectArticles, buildGuideSystemPrompt } from '../libraries/core/guide-knowledge.js';
import { createGuideCore } from '../cores/guide/index.js';

const read = path => fs.readFileSync(new URL(`../guide/${path}`, import.meta.url), 'utf8');

// --- Разметка ---

test('a reply splits into text and rich blocks; broken JSON or an unknown block stays text', () => {
    const segments = parseGuideReply('Hi!\n```choice\n{"prompt":"Next?","options":["A","B"]}\n```\nAnd\n```action\n{"label":"Enable","action":"modules.enable","params":{"id":"module.tracker"}}\n```\n```card\n{oops}\n```');
    assert.deepEqual(segments.map(segment => segment.type === 'block' ? segment.block.kind : 'text'), ['text', 'choice', 'text', 'action', 'text']);
    assert.deepEqual(segments[1].block.options.map(option => option.label), ['A', 'B']);
    assert.deepEqual(segments[3].block.params, { id: 'module.tracker' });
    assert.match(segments[4].text, /\{oops\}/);
});

test('inline links to blocks, web links and bold are recognised', () => {
    assert.deepEqual(parseInline('Open [Models](stme:card:models), see **this** and [docs](https://x.y/z).'), [
        { type: 'text', text: 'Open ' }, { type: 'anchor', label: 'Models', anchor: 'card:models' }, { type: 'text', text: ', see ' },
        { type: 'bold', text: 'this' }, { type: 'text', text: ' and ' }, { type: 'url', label: 'docs', url: 'https://x.y/z' }, { type: 'text', text: '.' },
    ]);
    assert.equal(plainText('Go [here](stme:card:models).\n```choice\n{"options":["Yes","No"]}\n```'), 'Go here.\n[Yes / No]');
});

// --- Знания ---

test('every shipped article parses with a title and text, and the index lists only existing files', () => {
    const index = JSON.parse(read('knowledge/index.json'));
    for (const file of index.articles) {
        const article = parseArticle(read(`knowledge/${file}`), file);
        assert.ok(article.title && article.text.length > 80, file);
    }
    assert.ok(index.articles.map(file => parseArticle(read(`knowledge/${file}`))).some(article => article.always));
});

test('articles are chosen by the words of the question; always-on ones are always there', () => {
    const articles = JSON.parse(read('knowledge/index.json')).articles.map(file => parseArticle(read(`knowledge/${file}`), file));
    const titles = selectArticles(articles, 'my api key gives 401, which endpoint for nanogpt?').map(article => article.title);
    assert.ok(titles.includes('Model connections'));
    assert.ok(titles.includes('Who you are'));
    assert.ok(!titles.includes('Music'));
});

test('the system prompt carries persona, English-only rule, markup, live state, anchors, actions and knowledge', () => {
    const prompt = buildGuideSystemPrompt({
        persona: { name: 'Nova', personality: 'Dry humour.' }, context: 'Model connections: none configured.',
        anchors: [{ anchor: 'card:models', path: 'Panel › Model connections' }], actions: [{ id: 'models.check', description: 'Check all.' }],
        articles: [parseArticle('---\ntitle: T\n---\nBody text.')],
    });
    for (const expected of ['You are Nova', 'Dry humour.', 'Always answer in English', '```choice', 'none configured', 'card:models — Panel › Model connections', 'models.check: Check all.', '### T']) {
        assert.ok(prompt.includes(expected), expected);
    }
});

// --- Ядро: сценарий без модели, действия, свободный чат ---

function build({ workers = [], generate = () => 'Sure — open [Models](stme:card:models).', probeState = 'up', mainSupported = true } = {}) {
    const engine = createEngine();
    const settings = new Map();
    const calls = { generate: [], reveal: [], enabled: [] };
    let list = [...workers];
    engine.buses.cores.register('storage.settings.get', ({ namespace, key, fallback }) => settings.get(`${namespace}/${key}`) ?? fallback);
    engine.buses.cores.register('storage.settings.set', ({ namespace, key, value }) => { settings.set(`${namespace}/${key}`, value); return true; });
    engine.buses.cores.register('model.workers.get', () => list);
    engine.buses.cores.register('model.workers.set', ({ workers: next }) => { list = next; return true; });
    engine.buses.cores.register('model.workers.status', () => list.map(worker => ({ workerId: worker.id, state: worker.state ?? 'unknown' })));
    engine.buses.cores.register('model.workers.probe', ({ workerId } = {}) => list.filter(worker => !workerId || worker.id === workerId).map(worker => { worker.state = probeState; return { workerId: worker.id, state: probeState, lastError: probeState === 'up' ? null : { message: 'HTTP 502' } }; }));
    engine.buses.cores.register('model.generate', params => { calls.generate.push(params); return generate(params); });
    engine.buses.cores.register('ui.anchors.list', () => [{ anchor: 'card:models', path: 'Panel › Model connections' }]);
    engine.buses.cores.register('ui.reveal', ({ anchor }) => { calls.reveal.push(anchor); return true; });
    engine.buses.services.register('stGeneration.mainConnection', () => ({ api: mainSupported ? 'openai' : 'novel', supported: mainSupported }));
    const modules = { list: () => [{ id: 'module.tracker', title: 'Tracker' }], enabled: () => calls.enabled, enable: async id => { calls.enabled.push(id); }, disable: async () => {} };
    const guide = createGuideCore(engine.registerCaller('core.guide', 'cores', { tier: 'official' }), {
        publish: () => {}, mount: () => ({}), modules, loadText: async path => read(path),
    });
    return { guide, calls, settings, workers: () => list };
}

test('with no model the chat opens with the setup scenario, and "use SillyTavern\'s connection" adds it, checks it and moves to free chat', async () => {
    const { guide, workers } = build();
    await guide.load();
    await guide.open();
    const hello = guide.messages.peek().at(-1);
    assert.equal(hello.node, 'hello');
    assert.match(hello.text, /I'm \*\*Guide\*\*/);

    await guide.chooseOption(hello.id, 0);

    assert.deepEqual(workers().map(worker => worker.format), ['sillytavern']);
    assert.equal(guide.messages.peek().at(-1).node, 'ready');
    assert.equal(guide.mode.peek(), 'chat');
});

test('a failed check leads to the scenario\'s failure branch, not to free chat', async () => {
    const { guide } = build({ probeState: 'down' });
    await guide.load();
    await guide.open();
    await guide.chooseOption(guide.messages.peek().at(-1).id, 0);
    assert.equal(guide.messages.peek().at(-1).node, 'st-failed');
    assert.equal(guide.mode.peek(), 'scenario');
});

test('a free question with a working model goes to the model with the live state and the history, and the reply is kept', async () => {
    const { guide, calls } = build({ workers: [{ id: 'w', state: 'up' }] });
    await guide.load();
    await guide.open();
    await guide.ask('How do I add an API key?');

    const request = calls.generate[0];
    assert.equal(request.messages[0].role, 'system');
    assert.match(request.messages[0].content, /Model connections: w — up/);
    assert.equal(request.messages.at(-1).content, 'How do I add an API key?');
    assert.match(guide.messages.peek().at(-1).text, /stme:card:models/);
});

test('actions run through the whitelist: a module is enabled, an unknown action is refused with a note', async () => {
    const { guide, calls } = build({ workers: [{ id: 'w', state: 'up' }] });
    await guide.load();
    assert.equal((await guide.runAction('modules.enable', { id: 'module.tracker' })).ok, true);
    assert.deepEqual(calls.enabled, ['module.tracker']);
    assert.equal((await guide.runAction('modules.enable', { id: 'module.nope' })).ok, false);
    await guide.runAction('rm.everything', {});
    assert.match(guide.messages.peek().at(-1).text, /Unknown action/);
});

test('the checklist ticks itself from the live state and by the checklist.mark action', async () => {
    const { guide } = build({ workers: [{ id: 'w', state: 'up' }] });
    await guide.load();
    await guide.runAction('checklist.mark', { id: 'tracker' });
    const done = Object.fromEntries((await guide.checklistState()).map(item => [item.id, item.done]));
    assert.deepEqual(done, { model: true, module: false, tracker: true, hello: false });
});

test('the setup scenario only points to nodes that exist', () => {
    const scenario = JSON.parse(read('setup-scenario.json'));
    for (const [id, node] of Object.entries(scenario.nodes)) {
        for (const option of node.options ?? []) for (const target of [option.next, option.onSuccess, option.onFailure].filter(Boolean)) assert.ok(scenario.nodes[target], `${id} → ${target}`);
    }
});
