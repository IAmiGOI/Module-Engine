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
    return { guide, calls, bus };
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
    assert.ok(lastTurns(calls).some(turn => turn.startsWith('[ENGINE RESULT') && turn.includes('Search results for “Faputa tails”') && turn.includes('Result 6')), 'the model sees the whole result');
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
    assert.ok(lastTurns(calls).some(turn => turn.startsWith('[ENGINE RESULT') && turn.includes('Search results for')));
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

test('a search she writes without the "auto" flag still runs by itself — no button asks the user for a permission that the request already gave', async () => {
    const forgotten = SEARCH_ACTION.replace(',"auto":true', '');
    const { guide, calls } = build({ generate: count => (count === 1 ? `Let me read her page.\n${forgotten}` : 'Five tails.') });
    await guide.load();
    await guide.ask('Make a character card for Faputa.');
    assert.equal(calls.length, 2, 'the search ran and she answered with it');
    assert.ok(!guide.messages.peek().some(message => /```action/.test(message.text ?? '')), 'no leftover button');
});

test('while she works on a character card the history may reach 50 thousand tokens; past that the oldest turns are folded into a summary by one model call, the fresh window stays word for word, and the summary is sent with every later request', async () => {
    const { guide, calls } = build({ generate: (_, params) => (String(params.prompt ?? '').startsWith('You keep the memory') ? 'SUMMARY: Faputa, five tails, user wants a terse voice.' : 'Understood.') });
    await guide.load();
    const big = 'word '.repeat(9000); // ≈ 11 000 tokens
    guide.messages.set(Array.from({ length: 7 }, (_, index) => ({ id: `m${index}`, at: index, role: index % 2 ? 'assistant' : 'user', text: `${index}: ${big}` })));
    await guide.ask('Continue the character card for Faputa.');
    const folding = calls.find(call => String(call.prompt).startsWith('You keep the memory'));
    assert.ok(folding, 'the fold was asked for');
    const answerCall = calls.at(-1);
    assert.ok(answerCall.messages[0].content.includes('SUMMARY: Faputa, five tails'), 'the summary is in the system prompt');
    const sent = answerCall.messages.slice(1).map(message => message.content).join(' ');
    assert.ok(!sent.includes('0: word'), 'the folded oldest turn is no longer sent word for word');
    assert.ok(sent.includes('6: word'), 'the newest turns stay');
    const calls0 = calls.length;
    await guide.ask('And one more thing.');
    assert.equal(calls.slice(calls0).filter(call => String(call.prompt).startsWith('You keep the memory')).length, 0, 'under the limit nothing is folded again');
    assert.ok(calls.at(-1).messages[0].content.includes('SUMMARY: Faputa'), 'the summary stays');
});

test('outside card work the history keeps the old 10 thousand token cut and nothing is folded', async () => {
    const { guide, calls } = build({ generate: () => 'Sure.' });
    await guide.load();
    const big = 'word '.repeat(9000);
    guide.messages.set(Array.from({ length: 7 }, (_, index) => ({ id: `m${index}`, at: index, role: index % 2 ? 'assistant' : 'user', text: `${index}: ${big}` })));
    await guide.ask('What does the summary module do?');
    assert.ok(!calls.some(call => String(call.prompt).startsWith('You keep the memory')));
});

const FAKE_REPLY = 'Let me read her Appearance section first.<continue(result: web.page result for p1, section 1 (Appearance):\n"Emilia has long silver hair…"\n(text continues.)\nNow I have enough canon material.';

test('when she writes tool results herself, the invention is thrown away with everything after it, never shown, and she is told to send the real action instead', async () => {
    const { guide, calls } = build({ generate: count => (count === 1 ? FAKE_REPLY : 'Sending the real action.') });
    await guide.load();
    await guide.ask('Make a card for Emilia.');
    const texts = guide.messages.peek().map(message => message.text);
    assert.ok(texts.includes('Let me read her Appearance section first.'), 'only what came before the invention is shown');
    assert.ok(!texts.some(text => /silver hair|text continues|<continue/.test(text ?? '')), 'nothing invented reaches the chat');
    assert.equal(calls.length, 2, 'she got a turn to correct herself');
    assert.match(lastTurns(calls).at(-1), /looked like a tool result — it was thrown away/);
});

test('an invented result next to a real action does not stop the real action: it runs, and she reads its real result', async () => {
    const reply = `Reading it.\n${'```action\n{"label":"Read","action":"web.search","params":{"query":"Emilia"}}\n```'}\n[ENGINE RESULT — made up]\nFake page text.`;
    const { guide, calls } = build({ generate: count => (count === 1 ? reply : 'Done reading.') });
    await guide.load();
    await guide.ask('Look up Emilia.');
    assert.equal(calls.length, 2);
    const turns = lastTurns(calls);
    assert.ok(turns.some(turn => turn.startsWith('[ENGINE RESULT') && turn.includes('Search results for “Emilia”')), 'the real result is in the history');
    assert.ok(!turns.some(turn => turn.includes('Fake page text')), 'the invention is not');
});

test('results sit in her history as engine frames from the user side, not as her own words, so she has nothing of hers to imitate', async () => {
    const { guide, calls } = build({ generate: () => 'Found it.' });
    await guide.load();
    await guide.runAction('web.search', { query: 'Faputa tails' });
    await settle();
    const resultTurn = calls.at(-1).messages.slice(1).find(message => message.content.startsWith('[ENGINE RESULT'));
    assert.equal(resultTurn.role, 'user');
    assert.match(resultTurn.content, /you never write these\]\nSearch results for/);
    assert.match(calls.at(-1).messages[0].content, /You never write tool results/);
});

const CREATE_PROPOSAL = '```proposal\n{"action":"character.create","params":{"name":"Emilia","description":"A half-elf."}}\n```';

function buildCards({ generate, create }) {
    const made = build({ generate });
    made.bus.register('characterCard.create', params => create(params));
    made.bus.register('characterCard.update', params => ({ name: 'Emilia', changed: Object.keys(params.fields) }));
    return made;
}

test('a card change she proposes is applied at once with no card and no button, and she goes on by herself with the next step', async () => {
    const created = [];
    const { guide, calls } = buildCards({ generate: count => (count === 1 ? `Writing the description.\n${CREATE_PROPOSAL}` : 'Done. Next: the first message.'), create: params => { created.push(params.fields.name); return { name: 'Emilia', avatar: 'Emilia.png' }; } });
    await guide.load();
    await guide.ask('Make a card for Emilia.');
    assert.deepEqual(created, ['Emilia'], 'created without anyone pressing Apply');
    const texts = guide.messages.peek();
    assert.ok(!texts.some(message => /```proposal/.test(message.text ?? '')), 'no proposal card is left in the chat');
    assert.ok(texts.some(message => message.role === 'note' && /Character “Emilia” is created/.test(message.text)), 'the chat gets a one-line note');
    assert.equal(calls.length, 2, 'she got her turn right after the change');
    assert.match(lastTurns(calls).at(-1), /The card change was applied[^]*do not ask whether to apply/);
    assert.equal(texts.at(-1).text, 'Done. Next: the first message.');
});

test('a change that cannot be applied gives her a turn too, with the reason, so she fixes it instead of stalling; and a proposal for something else is still a card to approve', async () => {
    const { guide, calls } = buildCards({ generate: count => (count === 1 ? CREATE_PROPOSAL : 'Fixed.'), create: () => { throw new Error('The name is taken.'); } });
    await guide.load();
    await guide.ask('Make a card for Emilia.');
    assert.equal(calls.length, 2);
    assert.ok(lastTurns(calls).some(turn => turn.includes('The name is taken.')), 'she sees the reason');
    assert.match(lastTurns(calls).at(-1), /could not be applied/);
    const other = buildCards({ generate: () => 'Here you go.\n```proposal\n{"action":"tracker.create","params":{"title":"Health","fields":[{"name":"health","prompt":"hp","default":1}]}}\n```', create: () => ({}) });
    await other.guide.load();
    await other.guide.ask('Make a health tracker.');
    assert.ok(other.guide.messages.peek().some(message => /```proposal/.test(message.text ?? '')), 'other proposals still wait for the user');
    assert.equal(other.calls.length, 1);
});

test('creating a card ignores "label" and "avatar" that models copy over from the update action, instead of failing with "Unknown character field"', async () => {
    const seen = [];
    const { guide } = buildCards({ generate: () => 'ok', create: params => { seen.push(params.fields); return { name: 'Emilia', avatar: 'Emilia.png' }; } });
    await guide.load();
    const result = await guide.runAction('character.create', { name: 'Emilia', first_mes: 'Hi.', label: 'First message', avatar: 'x.png' });
    assert.equal(result.ok, true);
    assert.deepEqual(seen, [{ name: 'Emilia', first_mes: 'Hi.' }]);
});
