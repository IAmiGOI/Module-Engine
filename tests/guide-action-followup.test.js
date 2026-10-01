import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { createGuideCore } from '../cores/guide/index.js';

const SEARCH_ACTION = '```action\n{"label":"Search","action":"web.search","params":{"query":"Faputa tails"},"auto":true}\n```';

function build({ generate, noDone = false }) {
    const engine = createEngine();
    const settings = new Map();
    const calls = [];
    const bus = engine.buses.cores;
    bus.register('storage.settings.get', ({ namespace, key, fallback }) => settings.get(`${namespace}/${key}`) ?? fallback);
    bus.register('storage.settings.set', ({ namespace, key, value }) => { settings.set(`${namespace}/${key}`, value); return true; });
    bus.register('model.workers.get', () => [{ id: 'w', state: 'up' }]);
    bus.register('model.workers.status', () => [{ workerId: 'w', state: 'up' }]);
    bus.register('model.workers.probe', () => [{ workerId: 'w', state: 'up' }]);
    // A final answer ends with <done/> (the end-of-turn rule); tests of the "forgot it" nudge pass `keepDone: true` replies through unchanged by writing <done/> themselves or by opting out here.
    bus.register('model.generate', params => {
        calls.push(params);
        const reply = generate(calls.length, params);
        return typeof reply === 'string' && !noDone && !reply.includes('```') && !/<done/.test(reply) ? `${reply}<done/>` : reply;
    });
    bus.register('ui.anchors.list', () => []);
    bus.register('tracking.trackers', () => []);
    bus.register('macros.programs', () => []);
    bus.register('lorebook.find', () => []);
    engine.buses.services.register('stWebSearch.search', ({ query }) => ({ source: 'web', results: Array.from({ length: 6 }, (_, index) => ({ title: `Result ${index + 1} about ${query}`, url: `https://x.org/${index}`, snippet: 'A long snippet of the page. '.repeat(10) })) }));
    const modules = { list: () => [{ id: 'm', title: 'M' }], enabled: () => [], enable: async () => {}, disable: async () => {} };
    const guide = createGuideCore(engine.registerCaller('core.guide', 'cores', { tier: 'official', networkAccess: true }), { publish: () => {}, mount: () => ({}), modules, loadText: async () => '' });
    return { guide, calls, bus, engine };
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

test('a long research chain is not cut: every successful step gives her the next turn, with no limit, until she stops asking for actions; a new request from the user starts clean', async () => {
    const { guide, calls } = build({ generate: count => (count <= 7 ? `Searching again.\n${SEARCH_ACTION}` : 'That is everything about Faputa.') });
    await guide.load();
    await guide.ask('Tell me everything about Faputa.');
    assert.equal(calls.length, 8, 'seven searches in a row, each read by her, then the answer');
    assert.equal(guide.messages.peek().at(-1).text, 'That is everything about Faputa.');
    assert.ok(!guide.messages.peek().some(message => /paused|stuck/.test(message.text ?? '')), 'nothing cut it short');
});

test('only a chain that makes NO progress is stopped: three nudges in a row without one successful step end with a plain note, and a successful step starts the count over', async () => {
    const { guide, calls } = build({ noDone: true, generate: () => 'Let me look at that for you now.' });
    await guide.load();
    await guide.ask('Go on.');
    assert.equal(calls.length, 4, 'the user turn plus three nudges, then she stops');
    assert.match(guide.messages.peek().at(-1).text, /I keep getting stuck without making progress/);
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
    const failNote = guide.messages.peek().find(message => message.role === 'note' && /name is taken/.test(message.text));
    assert.equal(failNote?.hidden, true, 'the failure she fixes herself is kept for her but hidden from the user');
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

const READ_ACTION = '```action\n{"label":"Read","action":"web.search","params":{"query":"Emilia"}}\n```';

test('the same sentence and the same action repeated in one reply are shown once and run once; the pieces between removed blocks are not glued into one line', async () => {
    const stuck = `Let me read her main wiki page.${READ_ACTION}Let me pull up her main wiki page and her appearance page.${READ_ACTION}Let me pull up her main wiki page and her appearance page.${READ_ACTION}`;
    const { guide, calls } = build({ generate: count => (count === 1 ? stuck : 'Read it.') });
    await guide.load();
    await guide.ask('Make a card.');
    const shown = guide.messages.peek().filter(message => message.role === 'assistant')[0].text;
    assert.equal(shown, 'Let me read her main wiki page.\nLet me pull up her main wiki page and her appearance page.');
    assert.equal(guide.messages.peek().filter(message => message.role === 'note').length, 1, 'one search, not three');
    assert.equal(calls.length, 2);
});

test('a reply that only promises to look something up gets a nudge to send the action, instead of stopping until the user writes "so?"; questions, finished answers and replies with blocks do not', async () => {
    const { guide, calls } = build({ noDone: true, generate: count => (count === 1 ? 'Patience, I am reading. Let me grab her personality and quotes sections.' : (count === 2 ? `Here you go.${READ_ACTION}` : 'Done.')) });
    await guide.load();
    await guide.ask('Go on.');
    assert.equal(calls.length >= 2, true, 'she was asked to follow through');
    assert.match(lastTurns(calls).at(-1) ?? '', /^$|Send the action block now|The result of the action/);
    assert.ok(calls[1].messages.at(-1).content.includes('Send the action block now'), 'the nudge was the automatic turn');
    for (const quiet of ['Let me know which version you want.', 'Should I read her wiki page first?', 'Done: the card is written.']) {
        const world = build({ generate: () => quiet });
        await world.guide.load();
        await world.guide.ask('Go on.');
        assert.equal(world.calls.length, 1, quiet);
    }
});

test('while her plan is open, a reply that ends with no action and no question is a stop halfway: she is sent on to the next step; a question, a finished plan or a block waiting for the user is not', async () => {
    const planned = text => `<plan>1. read the page 2. write the card</plan>${text}`;
    const { guide, calls } = build({ noDone: true, generate: count => (count === 1 ? planned('The page is long, I have the idea of her now.') : (count === 2 ? `Reading.${READ_ACTION}` : '<plan></plan>Done.')) });
    await guide.load();
    await guide.ask('Make a card for Emilia.');
    assert.ok(calls[1].messages.at(-1).content.includes('Your plan still has open steps'), 'sent on by the plan');
    const asking = build({ generate: () => planned('Which arc should she be from?') });
    await asking.guide.load();
    await asking.guide.ask('Make a card.');
    assert.equal(asking.calls.length, 1, 'a question to the user is a real stop');
    const noPlan = build({ generate: () => 'Here is what I think about her.' });
    await noPlan.guide.load();
    await noPlan.guide.ask('Tell me about her.');
    assert.equal(noPlan.calls.length, 1, 'no plan, nothing to continue');
    const careful = build({ noDone: true, generate: () => planned('Two things I need from you: 1. which arc? 2. where does she start (the default is the academy).<done/>') });
    await careful.guide.load();
    await careful.guide.ask('Make a card.');
    assert.equal(careful.calls.length, 1, 'questions that end with <done/> wait for the user even with the plan open and no question mark at the end');
    const finished = build({ noDone: true, generate: count => (count === 1 ? planned('Reading.') : '<plan></plan>The card is finished.') });
    await finished.guide.load();
    await finished.guide.ask('Make a card.');
    assert.equal(finished.calls.length, 2, 'one nudge, and after she clears the plan she is left alone');
});

test('a link to a web page after stme: is no anchor: it is shown as plain words, and a reply that "looks" at a link that opens nothing is told how to read a web page instead of looping', async () => {
    const dead = 'Let me open the wiki page.[Read main wiki page](stme:https://mushoku.fandom.com/wiki/Shizuka)<continue/>';
    const { guide, calls } = build({ generate: count => (count === 1 ? dead : (count === 2 ? `Reading.${READ_ACTION}` : 'Done.')) });
    await guide.load();
    await guide.ask('Look her up.');
    assert.ok(calls[1].messages.at(-1).content.includes('does not open anything'), 'told that this is not how a web page is read');
    assert.ok(guide.messages.peek().some(message => message.role === 'note' && /Searched/.test(message.text ?? '')), 'and the real action ran');
});

test('a GLM-style tool call in her reply runs as a real action and leaves no markup in the chat, and she reads the result', async () => {
    const reply = 'Let me look her up.<tool_call>web.search\n<arg_key>query</arg_key>\n<arg_value>Emilia Re:Zero</arg_value>\n</tool_call>$0$';
    const { guide, calls } = build({ generate: count => (count === 1 ? reply : 'Found her.') });
    await guide.load();
    await guide.ask('Look up Emilia.');
    const texts = guide.messages.peek().map(message => message.text ?? '');
    assert.ok(texts.includes('Let me look her up.'));
    assert.ok(!texts.some(text => /tool_call|arg_key|arg_value|\$\d\$/.test(text)), 'no foreign markup in the chat');
    assert.ok(texts.some(text => text.startsWith('Searched the web for “Emilia Re:Zero”')), 'the real search ran');
    assert.equal(calls.length, 2);
});

test('a safe action that fails gives her a turn with the reason and the right way to send it, instead of leaving her stalled', async () => {
    const { guide, calls } = build({ generate: count => (count === 1 ? 'Looking.\n```action\n{"label":"x","action":"web.character","params":{}}\n```' : 'Sending it again.') });
    await guide.load();
    await guide.ask('Make a card.');
    assert.equal(calls.length, 2);
    assert.ok(calls[1].messages.some(message => message.content.includes('Send it as {"name": "Emilia"')), 'the usage is in the result she reads');
    assert.ok(calls[1].messages.at(-1).content.includes('The action you sent failed'));
});

test('the Stop button cuts the answer that is being written, keeps what had arrived, and ends the whole chain of automatic turns', async () => {
    const world = build({ generate: count => (count === 1 ? new Promise((_, reject) => { world.reject = reject; }) : 'Here is the card.') });
    const cancelled = [];
    world.bus.register('model.generate.cancel', params => { cancelled.push(params.requestId); world.reject(new Error('The request was stopped.')); return true; });
    await world.guide.load();
    assert.equal(world.guide.stop(), false, 'nothing to stop while idle');
    const asking = world.guide.ask('Make a card.');
    await new Promise(resolve => setTimeout(resolve, 20));
    world.engine.events.emit('model.generate.chunk', { requestId: cancelled[0] ?? world.calls[0].requestId, delta: 'x', text: 'Let me start with her appearance' });
    assert.equal(world.guide.stop(), true);
    await asking;
    assert.equal(cancelled.length, 1);
    const texts = world.guide.messages.peek();
    assert.equal(texts.at(-2).text, 'Let me start with her appearance', 'the part that had arrived is kept');
    assert.equal(texts.at(-1).text, 'Stopped.');
    assert.equal(world.guide.streamDraft.peek(), null);
    assert.equal(world.calls.length, 1, 'no automatic turn follows a stop');
});

test('a model that starts repeating itself is cut off at once (one copy of the phrase stays) and is then asked again for the action block only, so the chain goes on instead of dying', async () => {
    const phrase = 'Let me pull up the Personality, Background, and Quotes sections from the main wiki page.';
    const world = build({ generate: count => (count === 1 ? new Promise((_, reject) => { world.reject = reject; }) : 'Here is the card.') });
    const cancelled = [];
    world.bus.register('model.generate.cancel', params => { cancelled.push(params.requestId); world.reject(new Error('The request was stopped.')); return true; });
    await world.guide.load();
    const asking = world.guide.ask('Go on.');
    await new Promise(resolve => setTimeout(resolve, 20));
    const requestId = world.calls[0].requestId;
    let text = 'Good, I have the infobox. ';
    for (let index = 0; index < 8 && !cancelled.length; index += 1) {
        text += phrase;
        world.engine.events.emit('model.generate.chunk', { requestId, delta: phrase, text });
        await new Promise(resolve => setTimeout(resolve, 70));
    }
    await asking;
    assert.equal(cancelled.length, 1, 'cancelled while it was still looping');
    const shown = world.guide.messages.peek();
    assert.ok((shown.find(message => message.role === 'assistant' && message.text.startsWith('Good'))?.text.match(/Quotes sections/g) ?? []).length <= 2, 'about one copy is kept');
    assert.equal(world.calls.length, 2, 'asked again');
    assert.match(JSON.stringify(world.calls[1].messages ?? world.calls[1]), /stuck repeating one sentence/);
    assert.equal(shown.at(-1).text, 'Here is the card.');
});

test('the debug log of the guide shows, for every turn, what the model said, what the engine did with it and why the chain went on or ended, with the raw provider answer attached', async () => {
    const world = build({ generate: count => (count === 1 ? `Let me read it.\n${READ_ACTION}` : 'All done.') });
    await world.guide.load();
    world.engine.events.subscribe('model.generate.finished', () => {});
    await world.guide.ask('Look up Emilia.');
    const requestId = world.calls[0].requestId;
    world.engine.events.emit('model.generate.raw', { requestId, status: 200, format: 'openai', body: 'data: {"choices":[{"delta":{"content":"Let me read it."},"finish_reason":"stop"}]}\n\ndata: [DONE]', content: 'Let me read it.' });
    const log = JSON.parse(world.guide.debugText());
    assert.equal(log.turns.length, 2);
    const [first, second] = log.turns;
    assert.deepEqual([first.kind, first.because, first.actions.map(item => item.action), first.results, first.next], ['user', 'user message', ['web.search'], [{ action: 'web.search', ok: true }], 'follow-up: action-result']);
    assert.equal(first.reply.startsWith('Let me read it.'), true);
    assert.equal(first.raw.finishReasons[0], 'stop', 'the raw answer is attached to its turn');
    assert.deepEqual([second.kind, second.because, second.next], ['automatic', 'action-result', 'ended: the reply is final (no action, no nudge needed)']);
    assert.equal(log.meta.focus, 'general');
});

test('a promise with any verb ("Let me hit the wiki for the real details") is caught, while "let me know" and a finished answer are not', async () => {
    const { isUnkeptPromise } = await import('../libraries/core/guide-markup.js');
    assert.equal(isUnkeptPromise('AniList gives me the basics but not much depth. Let me hit the Mushoku Tensei wiki for the real details — appearance, personality, speech, her whole deal.'), true);
    assert.equal(isUnkeptPromise("I'll visit the wiki next."), true);
    assert.equal(isUnkeptPromise('Done. Let me know if you want changes.'), false);
    assert.equal(isUnkeptPromise('The card is ready.'), false);
    assert.equal(isUnkeptPromise('Should I let me search the wiki?'), false);
});

test('a working chain goes on by itself until she says <done/>: a silent stop after a result gets one nudge (with the rule as the LAST message), the tag is hidden, and a question to the user or <done/> ends it at once', async () => {
    const silent = build({ noDone: true, generate: count => (count === 1 ? `Reading.\n${READ_ACTION}` : (count === 2 ? 'AniList gives me the basics. Let me hit the wiki for the details.' : (count === 3 ? `Now the wiki.\n${READ_ACTION}` : 'The card is ready.<done/>'))) });
    await silent.guide.load();
    await silent.guide.ask('Make a card.');
    assert.equal(silent.calls.length, 4, 'action, silent stop, nudge → action, final');
    assert.match(lastTurns(silent.calls.slice(0, 3)).at(-1), /<done\/>/, 'the end-of-turn rule is the last message of the automatic turn');
    assert.equal(silent.guide.messages.peek().at(-1).text, 'The card is ready.', 'the tag is not shown');
    const forgetful = build({ noDone: true, generate: count => (count === 1 ? `Reading.\n${READ_ACTION}` : 'Here is what I found.') });
    await forgetful.guide.load();
    await forgetful.guide.ask('Look it up.');
    assert.equal(forgetful.calls.length, 3, 'one nudge only, then the chain ends without a scolding note');
    assert.ok(!forgetful.guide.messages.peek().some(message => message.role === 'note' && /stuck/.test(message.text)));
    const asking = build({ noDone: true, generate: count => (count === 1 ? `Reading.\n${READ_ACTION}` : 'Which Nanahoshi do you mean?') });
    await asking.guide.load();
    await asking.guide.ask('Look it up.');
    assert.equal(asking.calls.length, 2, 'a question waits for the user');
});

test('the negation rule never refuses the work: the card is saved at once, the places that read as standing negations go first into her plan ("fix before the next stage"), and the line leaves the plan when a small update has fixed them', async () => {
    const sent = [];
    const bad = '```proposal\n{"action":"character.create","params":{"name":"Emilia","description":"She does not step back. She does not step forward."}}\n```';
    const fix = '```proposal\n{"action":"character.update","params":{"avatar":"Emilia.png","description":"She holds her ground."}}\n```';
    const { guide, calls } = buildCards({
        generate: count => (count === 1 ? bad : (count === 2 ? fix : 'Card is ready.')),
        create: params => { sent.push(params.negationsOk); return { name: 'Emilia', avatar: 'Emilia.png' }; },
    });
    await guide.load();
    await guide.ask('Make a card for Emilia.');
    assert.deepEqual(sent, [true], 'written at the first send, no refusal');
    const planOf = call => JSON.stringify(call.messages.filter(message => message.role === 'system').slice(1));
    assert.match(planOf(calls[1]), /\[fix\] Before the next stage[^]*two negations in a row/, 'the debt is the first line of her plan on the next turn');
    assert.ok(!/\[fix\]/.test(planOf(calls[2])), 'a small update fixed it, the line is gone');
    assert.ok(guide.messages.peek().some(message => message.role === 'note' && /is created[^]*standing negations/.test(message.text)));
    assert.equal(calls.length, 3);
});

test('she can read the full card of any character on demand with character.read, and the card text goes to her, not to the chat', async () => {
    const READ = '```action\n{"action":"character.read","params":{"avatar":"Mira.png"}}\n```';
    const { guide, calls, bus } = buildCards({ generate: count => (count === 1 ? READ : 'Compared.'), create: () => ({}) });
    bus.register('characterCard.get', params => ({ avatar: params.avatar, fields: { name: 'Mira', description: 'Mira answers in one sentence.', alternate_greetings: [], tags: [], depth_prompt: { depth: 4, role: 'system', prompt: '' } } }));
    await guide.load();
    await guide.ask('Copy the style of Mira.');
    assert.equal(calls.length, 2);
    assert.ok(lastTurns(calls).some(turn => turn.includes('Mira answers in one sentence.')), 'she reads the card text');
    assert.ok(!guide.messages.peek().some(message => message.role === 'assistant' && /Mira answers in one sentence/.test(message.text)));
});
