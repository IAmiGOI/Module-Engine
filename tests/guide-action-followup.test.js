import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { createGuideCore } from '../cores/guide/index.js';

const SEARCH_ACTION = '```action\n{"label":"Search","action":"web.search","params":{"query":"Faputa tails"},"auto":true}\n```';

function build({ generate }) {
    const engine = createEngine();
    const settings = new Map();
    const calls = [];
    const bus = engine.buses.cores;
    bus.register('storage.settings.get', ({ namespace, key, fallback }) => settings.get(`${namespace}/${key}`) ?? fallback);
    bus.register('storage.settings.set', ({ namespace, key, value }) => { settings.set(`${namespace}/${key}`, value); return true; });
    bus.register('model.workers.get', () => [{ id: 'w', state: 'up' }]);
    bus.register('model.workers.status', () => [{ workerId: 'w', state: 'up' }]);
    bus.register('model.workers.probe', () => [{ workerId: 'w', state: 'up' }]);
    bus.register('model.generate', params => { calls.push(params); return generate(calls.length, params); });
    bus.register('ui.anchors.list', () => []);
    bus.register('tracking.trackers', () => []);
    bus.register('macros.programs', () => []);
    bus.register('lorebook.find', () => []);
    engine.buses.services.register('stWebSearch.search', ({ query }) => ({ source: 'web', results: Array.from({ length: 6 }, (_, index) => ({ title: `Result ${index + 1} about ${query}`, url: `https://x.org/${index}`, snippet: 'A long snippet of the page. '.repeat(10) })) }));
    const modules = { list: () => [{ id: 'm', title: 'M' }], enabled: () => [], enable: async () => {}, disable: async () => {} };
    const guide = createGuideCore(engine.registerCaller('core.guide', 'cores', { tier: 'official', networkAccess: true }), { publish: () => {}, mount: () => ({}), modules, loadText: async () => '' });
    return { guide, calls };
}

const lastTurns = calls => calls.at(-1).messages.slice(1).map(message => message.content);
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

test('a button that needs her answer (search, page, check) gives her another turn by herself: the chat gets a short note, and she reads the full result', async () => {
    const { guide, calls } = build({ generate: () => 'Found it: five tails.' });
    await guide.load();
    const result = await guide.runAction('web.search', { query: 'Faputa tails' });
    assert.equal(result.ok, true);
    await settle();
    const note = guide.messages.peek().find(message => message.role === 'note');
    assert.equal(note.text, 'Searched the web for “Faputa tails”: 6 results.');
    assert.ok(note.detail.includes('Result 6 about Faputa tails'), 'the long listing is kept for the model');
    assert.ok(!note.text.includes('Result 1'), 'the long listing is NOT in the chat line');
    assert.equal(calls.length, 1, 'one automatic turn');
    assert.ok(lastTurns(calls).some(turn => turn.startsWith('(result: Search results for “Faputa tails”') && turn.includes('Result 6')), 'the model sees the whole result');
    assert.match(lastTurns(calls).at(-1), /^\(automatic — the user did not type this\) The result of the action you ran is in the last note/);
    assert.equal(guide.messages.peek().at(-1).text, 'Found it: five tails.');
    const before = calls.length;
    await guide.runAction('models.check');
    await settle();
    assert.equal(calls.length, before + 1, 'a model check gets her reply too');
    await guide.runAction('modules.enable', { id: 'm' });
    await settle();
    assert.equal(calls.length, before + 1, 'an action whose result needs no reading does not');
});

test('a search she runs by herself inside her reply is read in the same go: the user asks once, she searches, then answers with the result', async () => {
    const { guide, calls } = build({ generate: count => (count === 1 ? `Let me look that up.\n${SEARCH_ACTION}` : 'She has five tails.') });
    await guide.load();
    await guide.ask('How many tails does Faputa have?');
    assert.equal(calls.length, 2, 'the search result got its own turn without the user typing');
    assert.ok(lastTurns(calls).some(turn => turn.startsWith('(result: Search results for')));
    const texts = guide.messages.peek().map(message => `${message.role}: ${message.text}`);
    assert.deepEqual(texts, [
        'user: How many tails does Faputa have?',
        'assistant: Let me look that up.',
        'note: Searched the web for “Faputa tails”: 6 results.',
        'assistant: She has five tails.',
    ]);
});

test('a model that keeps searching is stopped after four automatic rounds for one request, and a new request from the user starts the count again', async () => {
    const { guide, calls } = build({ generate: () => `Searching again.\n${SEARCH_ACTION}` });
    await guide.load();
    await guide.ask('Tell me everything about Faputa.');
    assert.equal(calls.length, 5, 'the user turn plus four automatic ones, then she stops');
    await guide.ask('And again?');
    assert.equal(calls.length, 10, 'the count started over with the new request');
});
