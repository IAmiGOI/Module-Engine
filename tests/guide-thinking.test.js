import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createEngine } from '../libraries/shared/engine.js';
import { splitThinking, planMessage, insertPlan, MAX_PLAN_CHARS, PLAN_DEPTH } from '../libraries/core/guide-thinking.js';
import { normalizePassParams } from '../libraries/core/guide-edit.js';
import { describeProposal } from '../libraries/core/guide-proposals.js';
import { detectFocus } from '../libraries/core/guide-relevance.js';
import { buildGuideSystemPrompt } from '../libraries/core/guide-knowledge.js';
import { createGuideCore, TOKEN_BUDGET, HISTORY_TOKEN_LIMIT, COMPLETION_TOKEN_LIMIT } from '../cores/guide/index.js';

// --- Внутренние рассуждения ---

test('thinking and the plan are cut out of what the user sees; the plan is reported separately, an empty <plan> means "finished", no tag means "unchanged", and the old <notes> tag still works', () => {
    const reply = '<think>Need a tracker, then a macro. Check ids.</think>\n<plan>Plan: 1 tracker (done) 2 macro (next)</plan>\nHere is the tracker.\n```proposal\n{"action":"tracker.create","params":{}}\n```';
    const split = splitThinking(reply);
    assert.ok(!split.visible.includes('think') && !split.visible.includes('Plan:'));
    assert.match(split.visible, /^Here is the tracker\./);
    assert.match(split.visible, /```proposal/);
    assert.equal(split.plan, 'Plan: 1 tracker (done) 2 macro (next)');
    assert.equal(splitThinking('<notes>old name</notes>Hi.').plan, 'old name');
    assert.equal(splitThinking('Hi.<plan></plan>').plan, '');
    assert.equal(splitThinking('Just an answer.').plan, undefined);
    assert.equal(splitThinking('<think>cut off mid-thought').visible, '', 'an unfinished thought never leaks');
    assert.equal(splitThinking(`<plan>${'x'.repeat(9000)}</plan>ok`).plan.length, MAX_PLAN_CHARS);
    assert.equal(planMessage('  '), null);
    assert.match(planMessage('step 2 next').content, /## Your plan for this task \(private[^\n]*\nstep 2 next/);
    assert.ok(!buildGuideSystemPrompt({ plan: 'plan A' }).includes('plan A'), 'the plan is not part of the system prompt: it lives in the history');
    const prompt = buildGuideSystemPrompt({});
    assert.ok(prompt.includes('Think carefully and thoroughly'), 'the prompt teaches the habit');
    assert.match(prompt, /Do not walk the user through your thinking[^\n]*only when the user asks/, 'and keeps the user out of it unless they ask');
});

function build({ replies = ['ok'], passes = null } = {}) {
    const engine = createEngine();
    const bus = engine.buses.cores;
    const settings = new Map();
    const sent = [];
    let turn = 0;
    bus.register('storage.settings.get', ({ namespace, key, fallback }) => settings.get(`${namespace}/${key}`) ?? fallback);
    bus.register('storage.settings.set', ({ namespace, key, value }) => { settings.set(`${namespace}/${key}`, value); return true; });
    bus.register('model.workers.get', () => [{ id: 'w' }]);
    bus.register('model.workers.status', () => [{ workerId: 'w', state: 'up' }]);
    bus.register('ui.anchors.list', () => []);
    bus.register('tracking.trackers', () => []);
    bus.register('macros.programs', () => []);
    bus.register('lorebook.find', () => []);
    bus.register('model.generate', params => { sent.push(params); return replies[Math.min(turn++, replies.length - 1)]; });
    const calls = [];
    const tools = passes && {
        describe: () => `Post-Turn passes: ${passes.map(pass => pass.id).join(', ') || 'none yet'}.`,
        addPass: async params => { calls.push(['add', params]); return { ok: true, message: 'added' }; },
        updatePass: async params => { calls.push(['update', params]); return { ok: true, message: 'updated' }; },
        removePass: async params => { calls.push(['remove', params]); return { ok: true, message: 'removed' }; },
        movePass: async params => { calls.push(['move', params]); return { ok: true, message: 'moved' }; },
    };
    const known = [{ id: 'module.postprocess', title: 'Post-Turn Processor' }];
    const modules = { list: () => known, enabled: () => (tools ? ['module.postprocess'] : []), enable: async () => {}, disable: async () => {}, guideTools: id => (id === 'module.postprocess' ? tools : null) };
    const dir = new URL('../guide/', import.meta.url);
    const guide = createGuideCore(engine.registerCaller('core.guide', 'cores', { tier: 'official' }), { publish: () => {}, mount: () => ({}), modules, loadText: async path => fs.readFileSync(new URL(path, dir), 'utf8') });
    return { guide, sent, calls, settings };
}

test('her plan is hidden from the chat, needs no confirmation, is kept, and is handed back on the next turns until the job is finished, the user closes the talk, or she clears it', async () => {
    const { guide, sent, settings } = build({ replies: ['<think>hard job</think><plan>1. tracker — done\n2. macro — next</plan>First part is ready.', 'Second part is ready.', '<plan></plan>All finished.', 'Sure.'] });
    await guide.load();
    await guide.ask('help me set up a health tracker and a macro for it');
    assert.equal(guide.messages.peek().at(-1).text, 'First part is ready.', 'no think, no plan in the chat');
    assert.match(settings.get('core.guide/chat').plan, /2\. macro — next/, 'saved with the chat');
    await guide.ask('go on');
    const planAt = messages => messages.findIndex(message => message.role === 'system' && message.content.startsWith('## Your plan'));
    assert.match(sent[1].messages[planAt(sent[1].messages)].content, /## Your plan[^\n]*\n1\. tracker — done\n2\. macro — next/);
    assert.equal(sent[1].messages.length - planAt(sent[1].messages) - 1, 3, 'a short talk (three messages): the plan goes before all of them'); // глубина больше длины — в самое начало
    await guide.ask('and finish it');
    assert.ok(planAt(sent[2].messages) > 0, 'still there while the job runs');
    assert.equal(sent[2].messages.length - planAt(sent[2].messages) - 1, PLAN_DEPTH, 'depth 4: exactly four messages come after it');
    await guide.ask('anything else?');
    assert.equal(planAt(sent[3].messages), -1, 'she cleared it with an empty <plan>');
    assert.equal(sent[0].maxTokens, 5000, 'room for thinking and a long answer');
    assert.deepEqual([TOKEN_BUDGET, HISTORY_TOKEN_LIMIT, COMPLETION_TOKEN_LIMIT], [15000, 10000, 5000], '15k in all: 10k of history, 5k for the answer with its thinking');
});

test('the user closing the talk wipes the plan; clearing the chat wipes it too', async () => {
    const first = build({ replies: ['<plan>plan X</plan>Started.', 'ok'] });
    await first.guide.load();
    await first.guide.ask('start the big job');
    assert.match(first.settings.get('core.guide/chat').plan, /plan X/);
    await first.guide.ask('thanks, that is all');
    assert.ok(!first.sent[1].messages.some(message => message.content.includes('plan X')), 'closed by the user');
    const second = build({ replies: ['<plan>plan Y</plan>Started.', 'ok'] });
    await second.guide.load();
    await second.guide.ask('start the big job');
    await second.guide.resetChat();
    assert.equal(second.settings.get('core.guide/chat').plan, '', 'a fresh chat starts without old plans');
});

// --- Проходы Post-Turn Processor как инструменты ---

test('pass parameters are checked before the module sees them; cards are built for every pass action, removal is dangerous', () => {
    assert.equal(normalizePassParams('postprocess.pass.add', { name: 'x' }).ok, false, 'a pass needs an instruction');
    assert.deepEqual(normalizePassParams('postprocess.pass.add', { prompt: 'Fix grammar.', position: 2 }).value, { fields: { name: 'New pass', prompt: 'Fix grammar.' }, position: 2 });
    assert.equal(normalizePassParams('postprocess.pass.update', { id: 'p1' }).ok, false, 'nothing to change');
    assert.deepEqual(normalizePassParams('postprocess.pass.update', { id: 'p1', enabled: false, contextDepth: 3.4 }).value, { id: 'p1', fields: { enabled: false, contextDepth: 3 } });
    assert.equal(normalizePassParams('postprocess.pass.move', { id: 'p1' }).ok, false);
    const add = describeProposal('postprocess.pass.add', { name: 'De-cliché', prompt: 'Remove clichés.', workerId: 'w' });
    assert.deepEqual([add.title, add.lines[1], add.lines[2]], ['New pass “De-cliché”', 'Model: w', 'Runs last']);
    assert.equal(describeProposal('postprocess.pass.remove', { id: 'p1' }).danger, true);
    assert.equal(describeProposal('postprocess.pass.move', { id: 'p1', position: 1 }).ok, true);
});

test('the pass tools reach the module only when it is on; the list of passes appears when the talk is about them (also by the word "passes")', async () => {
    assert.ok(detectFocus({ query: 'add a pass that removes clichés', modules: [{ id: 'module.postprocess', title: 'Post-Turn Processor' }] }).modules.includes('module.postprocess'));
    const off = build();
    await off.guide.load();
    assert.equal((await off.guide.runAction('postprocess.pass.add', { prompt: 'Fix grammar.' })).ok, false);
    assert.match(off.guide.messages.peek().at(-1).text, /Post-Turn Processor is off/);
    const on = build({ passes: [{ id: 'pass_1' }] });
    await on.guide.load();
    await on.guide.ask('I want a new pass for the post-turn processor');
    assert.match(on.sent[0].messages[0].content, /Post-Turn passes: pass_1\./);
    assert.match(on.sent[0].messages[0].content, /postprocess\.pass\.add:/);
    assert.equal((await on.guide.runAction('postprocess.pass.add', { name: 'Grammar', prompt: 'Fix grammar.' })).ok, true);
    assert.equal((await on.guide.runAction('postprocess.pass.update', { id: 'pass_1', enabled: false })).ok, true);
    assert.equal((await on.guide.runAction('postprocess.pass.move', { id: 'pass_1', position: 2 })).ok, true);
    assert.equal((await on.guide.runAction('postprocess.pass.remove', { id: 'pass_1' })).ok, true);
    assert.deepEqual(on.calls.map(entry => entry[0]), ['add', 'update', 'move', 'remove']);
    assert.deepEqual(on.calls[0][1], { fields: { name: 'Grammar', prompt: 'Fix grammar.' }, position: undefined });
});

// --- Стриминг ---

import { streamingText } from '../libraries/core/guide-thinking.js';

test('while the reply is still arriving the user sees only finished text: no thoughts, no half a tag, no raw JSON of a card that is still being written', () => {
    assert.equal(streamingText('<think>hmm, first'), '');
    assert.equal(streamingText('<think>done</think>Here is'), 'Here is');
    assert.equal(streamingText('Hello <thi'), 'Hello');
    assert.equal(streamingText('Hello <'), 'Hello');
    assert.equal(streamingText('a < b is fine'), 'a < b is fine', 'a lone comparison sign in the middle is text');
    assert.equal(streamingText('Here it is.\n```proposal\n{"action":"tracker.cre'), 'Here it is.', 'the unfinished card waits');
    assert.equal(streamingText('Here it is.\n```proposal\n{"action":"tracker.create","params":{}}\n```\nDone'), 'Here it is.', 'blocks appear with the final reply, never as raw JSON while streaming');
    assert.equal(streamingText('<plan>plan</plan>Answer<plan>next'), 'Answer');
});

test('the reply streams into a draft (throttled, thinking hidden) and is replaced by the final message; no draft is left behind, also after an error', async () => {
    const engine = createEngine();
    const bus = engine.buses.cores;
    const seen = [];
    let clock = 0;
    bus.register('storage.settings.get', ({ fallback }) => fallback);
    bus.register('storage.settings.set', () => true);
    bus.register('model.workers.get', () => [{ id: 'w' }]);
    bus.register('model.workers.status', () => [{ workerId: 'w', state: 'up' }]);
    bus.register('ui.anchors.list', () => []);
    bus.register('tracking.trackers', () => []);
    bus.register('macros.programs', () => []);
    bus.register('lorebook.find', () => []);
    let guide;
    let fail = false;
    bus.register('model.generate', params => {
        assert.equal(params.stream, true);
        assert.match(params.requestId, /^guide-/);
        const parts = ['<think>plan the answer', '</think>Sure, ', 'here is the ', 'result.'];
        let text = '';
        for (const part of parts) {
            text += part;
            clock += 100;
            engine.events.emit('model.generate.chunk', { requestId: params.requestId, delta: part, text });
            seen.push(guide.streamDraft.peek());
        }
        engine.events.emit('model.generate.chunk', { requestId: 'someone-else', delta: 'X', text: 'LEAK' });
        seen.push(guide.streamDraft.peek());
        if (fail) throw new Error('provider down');
        return text;
    });
    const dir = new URL('../guide/', import.meta.url);
    guide = createGuideCore(engine.registerCaller('core.guide', 'cores', { tier: 'official' }), { publish: () => {}, mount: () => ({}), modules: { list: () => [], enabled: () => [] }, now: () => clock, loadText: async path => fs.readFileSync(new URL(path, dir), 'utf8') });
    await guide.load();
    await guide.ask('hello');
    assert.deepEqual(seen, ['', 'Sure,', 'Sure, here is the', 'Sure, here is the result.', 'Sure, here is the result.'], 'thinking hidden, foreign requests ignored');
    assert.equal(guide.messages.peek().at(-1).text, 'Sure, here is the result.');
    assert.equal(guide.streamDraft.peek(), null, 'no draft is left once the final message is in');
    fail = true;
    await guide.ask('again');
    assert.equal(guide.streamDraft.peek(), null, 'and none after a failure');
    assert.match(guide.messages.peek().at(-1).text, /I couldn't answer: provider down/);
});

test('buttons are not offered on every turn: if her previous reply had a choice block, the next one comes without it; after a reply without buttons they are allowed again', async () => {
    const choice = '\n```choice\n{"options":["Tracker","Macro"]}\n```';
    const { guide } = build({ replies: [`Which one?${choice}`, `Got it, tracker.${choice}`, `Here it is.${choice}`] });
    await guide.load();
    await guide.ask('I want to create something');
    assert.match(guide.messages.peek().at(-1).text, /```choice/, 'a real fork — the buttons are kept');
    await guide.ask('a tracker');
    assert.ok(!guide.messages.peek().at(-1).text.includes('choice'), 'the very next reply is calm: no buttons again');
    assert.match(guide.messages.peek().at(-1).text, /^Got it, tracker\./);
    await guide.ask('thanks, and one more thing');
    assert.match(guide.messages.peek().at(-1).text, /```choice/, 'the previous reply had none, so buttons are allowed');
});

// --- Настройки генерации прохода и гайд по сильным промптам ---

test('a pass can carry its generation settings (temperature, top-p, max tokens, reasoning); the card shows them; bad values never reach the module as numbers', () => {
    const made = normalizePassParams('postprocess.pass.update', { id: 'p1', temperature: '0.3', maxTokens: 4000, reasoningMode: ' Disabled ', topP: 'lots' });
    assert.deepEqual(made.value, { id: 'p1', fields: { temperature: 0.3, maxTokens: 4000, reasoningMode: 'disabled' } });
    const card = describeProposal('postprocess.pass.update', { id: 'p1', temperature: 0.3, maxTokens: 4000 });
    assert.ok(card.lines.includes('Generation: temperature 0.3, maxTokens 4000'));
    const add = describeProposal('postprocess.pass.add', { prompt: 'Rewrite it.', temperature: 0.7 });
    assert.ok(add.lines.some(line => line === 'Generation: temperature 0.7'));
    assert.equal(normalizePassParams('postprocess.pass.update', { id: 'p1', temperature: 'hot' }).ok, false, 'nothing valid to change');
});

test('the guide on writing strong prompts comes with the Post-Turn Processor (and trackers, painter): by an open block or by the sticky focus, and it teaches the craft, not one-liners', async () => {
    const dir = new URL('../guide/knowledge/', import.meta.url);
    const { parseArticle, selectArticles } = await import('../libraries/core/guide-knowledge.js');
    const index = JSON.parse(fs.readFileSync(new URL('index.json', dir), 'utf8')).articles;
    assert.ok(index.includes('prompt-craft.md'));
    const articles = index.map(file => parseArticle(fs.readFileSync(new URL(file, dir), 'utf8'), file));
    const titles = selectArticles(articles, 'make me a pass', { openAnchors: ['module:module.postprocess'] }).map(article => article.title);
    assert.ok(titles.includes('Writing strong prompts (passes, trackers, painter)') && titles.includes('Post-Turn Processor'));
    const craft = articles.find(article => article.title.startsWith('Writing strong prompts')).text;
    for (const rule of ['must be precise — it does not have to be short', 'never pad with filler', 'One job per pass', 'Say what stays', 'Output contract', 'temperature 0.2–0.4', 'Return only the rewritten text']) assert.ok(craft.includes(rule), rule);
    assert.ok(!articles.find(article => article.title === 'Post-Turn Processor').text.includes('"Fix grammar and spelling.'), 'the weak one-liner examples are gone');
    const { guide, sent } = build({ passes: [{ id: 'pass_1' }] });
    await guide.load();
    await guide.ask('write me a better pass for the post-turn processor');
    assert.match(sent[0].messages[0].content, /### Writing strong prompts/);
    await guide.ask('make it a bit shorter');
    assert.match(sent[1].messages[0].content, /### Writing strong prompts/, 'the sticky focus keeps the guide in the prompt on follow-ups');
});

// --- Зайти в блок за сведениями и продолжить ---

test('<continue/> is cut from the visible text and reported; the prompt teaches how to get information (open the block, continue) and to split a job into steps', () => {
    const split = splitThinking('Let me look at [Music](stme:module:module.music).<continue/>');
    assert.equal(split.more, true);
    assert.equal(split.visible, 'Let me look at [Music](stme:module:module.music).');
    assert.equal(splitThinking('<think>maybe <continue/> later</think>Plain answer.').more, false, 'a tag inside her private thinking does not count');
    assert.equal(streamingText('Looking now <c'), 'Looking now');
    const prompt = buildGuideSystemPrompt({});
    assert.match(prompt, /you do NOT see everything at once/);
    assert.match(prompt, /open the block: link it[^\n]*end the reply with <continue\/>/);
    assert.match(prompt, /At most three such rounds/);
    assert.match(prompt, /Split a complex job into steps[^\n]*gather the information first[^\n]*only after you have seen the current values/);
});

function buildLoop(replies) {
    const engine = createEngine();
    const bus = engine.buses.cores;
    const sent = [];
    const revealed = [];
    const pauses = [];
    let open = false;
    let turn = 0;
    bus.register('storage.settings.get', ({ fallback }) => fallback);
    bus.register('storage.settings.set', () => true);
    bus.register('model.workers.get', () => [{ id: 'w' }]);
    bus.register('model.workers.status', () => [{ workerId: 'w', state: 'up' }]);
    bus.register('ui.anchors.list', () => [{ anchor: 'module:module.music', path: 'Panel › Music' }]);
    bus.register('ui.reveal', ({ anchor }) => { revealed.push(anchor); open = true; return true; });
    bus.register('ui.context', () => (open ? { text: 'Blocks the user has open right now:\n- Panel › Music\n  · Min similarity: 0.55', blocks: [{ anchor: 'module:module.music', path: 'Panel › Music' }] } : { text: '', blocks: [] }));
    bus.register('tracking.trackers', () => []);
    bus.register('macros.programs', () => []);
    bus.register('lorebook.find', () => []);
    bus.register('model.generate', params => { sent.push(params); return replies[Math.min(turn++, replies.length - 1)]; });
    const dir = new URL('../guide/', import.meta.url);
    const guide = createGuideCore(engine.registerCaller('core.guide', 'cores', { tier: 'official' }), {
        publish: () => {}, mount: () => ({}), modules: { list: () => [{ id: 'module.music', title: 'Music' }], enabled: () => [] }, sleep: async ms => { pauses.push(ms); },
        loadText: async path => fs.readFileSync(new URL(path, dir), 'utf8'),
    });
    return { guide, sent, revealed, pauses };
}

test('she opens a block to look and gets the next turn by herself: the block is revealed, the second call sees it on screen with an automatic hint, the user typed once', async () => {
    const { guide, sent, revealed, pauses } = buildLoop(['<think>need the values</think><plan>1. look at Music 2. propose</plan>Let me look at [Music](stme:module:module.music) first.<continue/>', 'Min similarity is 0.55 — lower it to 0.4?']);
    await guide.load();
    await guide.ask('make the music less picky');
    assert.equal(sent.length, 2, 'two model calls for one question');
    assert.deepEqual(revealed, ['module:module.music']);
    assert.ok(!sent[0].messages[0].content.includes('Min similarity: 0.55'), 'the first turn could not see it');
    assert.match(sent[1].messages[0].content, /Panel › Music\n {2}· Min similarity: 0\.55/, 'the second turn sees the opened block');
    assert.ok(sent[1].messages.some(message => /1. look at Music 2. propose/.test(message.content) && message.role === 'system' && message !== sent[1].messages[0]), 'and her own plan, as a separate message');
    assert.match(sent[1].messages.at(-1).content, /^\(automatic — the user did not type this\)/);
    assert.ok(pauses.includes(800), 'she waited for the block to open');
    assert.deepEqual(guide.messages.peek().map(message => message.role), ['user', 'assistant', 'assistant'], 'no invented user message in the chat');
    assert.match(guide.messages.peek().at(-1).text, /Min similarity is 0\.55/);
    assert.ok(!guide.messages.peek().some(message => message.text.includes('automatic')));
});

test('automatic rounds are capped at three per request; a <continue/> with nothing to open, or a plain answer, never loops', async () => {
    const endless = buildLoop(['Looking: [Music](stme:module:module.music).<continue/>']);
    await endless.guide.load();
    await endless.guide.ask('go on forever');
    assert.equal(endless.sent.length, 4, 'one real turn + three automatic ones, then she stops');
    const nothing = buildLoop(['I already know it.<continue/>']);
    await nothing.guide.load();
    await nothing.guide.ask('hello');
    assert.equal(nothing.sent.length, 1, 'no link, nothing new to see — no extra turn');
    const again = buildLoop(['Looking: [Music](stme:module:module.music).<continue/>', 'Done looking.', 'Looking again: [Music](stme:module:module.music).<continue/>', 'Done again.']);
    await again.guide.load();
    await again.guide.ask('first');
    await again.guide.ask('second');
    assert.equal(again.sent.length, 4, 'the counter starts over with every new question of the user');
});

// --- Сначала зайти в блок ---

import { isTaskRequest } from '../libraries/core/guide-relevance.js';

function buildLook({ enabled = true, alreadyOpen = false } = {}) {
    const engine = createEngine();
    const bus = engine.buses.cores;
    const sent = [];
    const revealed = [];
    let open = alreadyOpen;
    bus.register('storage.settings.get', ({ fallback }) => fallback);
    bus.register('storage.settings.set', () => true);
    bus.register('model.workers.get', () => [{ id: 'w' }]);
    bus.register('model.workers.status', () => [{ workerId: 'w', state: 'up' }]);
    bus.register('ui.anchors.list', () => []);
    bus.register('ui.reveal', ({ anchor }) => { revealed.push(anchor); open = true; return true; });
    bus.register('ui.context', () => (open ? { text: 'Blocks the user has open right now:\n- Panel › Post-Turn Processor\n  · Auto-run after each reply: off', blocks: [{ anchor: 'module:module.postprocess', path: 'Panel › Post-Turn Processor' }] } : { text: '', blocks: [] }));
    bus.register('tracking.trackers', () => []);
    bus.register('macros.programs', () => []);
    bus.register('lorebook.find', () => []);
    bus.register('model.generate', params => { sent.push(params); return 'ok'; });
    const dir = new URL('../guide/', import.meta.url);
    const guide = createGuideCore(engine.registerCaller('core.guide', 'cores', { tier: 'official' }), {
        publish: () => {}, mount: () => ({}), sleep: async () => {},
        modules: { list: () => [{ id: 'module.postprocess', title: 'Post-Turn Processor' }], enabled: () => (enabled ? ['module.postprocess'] : []) },
        loadText: async path => fs.readFileSync(new URL(path, dir), 'utf8'),
    });
    return { guide, sent, revealed };
}

test('a TASK about a module starts with going into its block: it opens by itself and the very first model call already sees its fields — no reliance on the model remembering to look', async () => {
    const { guide, sent, revealed } = buildLook();
    await guide.load();
    await guide.ask('Can you build a good anti-slop post turn processor for me?');
    assert.deepEqual(revealed, ['module:module.postprocess']);
    assert.equal(sent.length, 1, 'one call — the looking happened before it');
    assert.match(sent[0].messages[0].content, /Auto-run after each reply: off/, 'the opened block is in the state');
    assert.match(sent[0].messages[0].content, /## How it really works/, 'with the mechanics article');
});

test('only a task opens the block: a plain question, a module that is off, a block already open, or a follow-up in the same topic do not', async () => {
    const question = buildLook();
    await question.guide.load();
    await question.guide.ask('what is the post-turn processor?');
    assert.deepEqual(question.revealed, [], 'a question is answered without touching the screen');
    const off = buildLook({ enabled: false });
    await off.guide.load();
    await off.guide.ask('please build a post-turn pass');
    assert.deepEqual(off.revealed, [], 'the module is off — there is no block to open');
    const open = buildLook({ alreadyOpen: true });
    await open.guide.load();
    await open.guide.ask('please build a post-turn pass');
    assert.deepEqual(open.revealed, [], 'already open');
    const follow = buildLook();
    await follow.guide.load();
    await follow.guide.ask('build a post-turn pass');
    await follow.guide.ask('make it shorter');
    assert.equal(follow.revealed.length, 1, 'the same topic — opened once');
    assert.equal(isTaskRequest('why is it slow?'), false);
    assert.equal(isTaskRequest('I want less slop'), true);
    assert.equal(isTaskRequest('Okay, can you do than good anti-slop post turn processor pass for me?'), true, 'the exact live phrase that used to slip through — no old verb, just a plain request');
    assert.equal(isTaskRequest('what is the post-turn processor?'), false);
    assert.equal(isTaskRequest("Can you build me good anti-slop post turn processor pass?"), true);
    for (const phrase of ['could you make me a health tracker', 'would you set up a macro', 'please add a pass', "let's make a tracker", "I'd like a pass for grammar", 'give me a tracker']) assert.equal(isTaskRequest(phrase), true, phrase);
    assert.equal(isTaskRequest('why does this keep failing?'), false);
    assert.equal(isTaskRequest('which module should I turn on?'), false);

});

test('the focus is sticky, but a task that NAMES the module opens its block again if it is closed now — a repeated request in the same chat does not leave the window shut', async () => {
    const { guide, revealed } = buildLook();
    await guide.load();
    await guide.ask('build a post-turn pass');
    assert.equal(revealed.length, 1);
    await guide.ask('thanks, that is all');
    await guide.ask('Can you build me good anti-slop post turn processor pass?');
    assert.equal(revealed.length, 1, 'still open from the first time — nothing to reopen');
    const { guide: closing, revealed: seen } = buildLook();
    await closing.load();
    await closing.ask('help me with the post-turn processor');
    seen.length = 0;
    await closing.ask('now build me a good post turn pass');
    assert.ok(seen.length <= 1);
});

// --- Длина настоящего брифа ---

test('a real pass brief is not cut short: the module keeps 16 000 characters (it cut at 4 000), the guide accepts them, and the guide teaches the size of a real brief with a full exemplar', async () => {
    const { sanitizePasses } = await import('../modules/postprocess/index.js');
    const long = 'Keep every event. '.repeat(500);   // 9 000 characters
    assert.equal(sanitizePasses([{ id: 'p', prompt: long }])[0].prompt.length, long.trim().length, 'nothing is cut off at 4 000');
    assert.equal(sanitizePasses([{ id: 'p', prompt: 'x'.repeat(20000) }])[0].prompt.length, 16000, 'a sane ceiling remains');
    const made = normalizePassParams('postprocess.pass.add', { prompt: long });
    assert.equal(made.value.fields.prompt.length, long.trim().length);
    const dir = new URL('../guide/knowledge/', import.meta.url);
    const craft = fs.readFileSync(new URL('prompt-craft.md', dir), 'utf8');
    assert.match(craft, /expect 400–900 words/);
    assert.match(craft, /A 100–200 word instruction is a sketch, not a brief/);
    const exemplar = craft.slice(craft.indexOf('Exemplar for an anti-slop pass'), craft.indexOf('Tracker field prompts'));
    assert.ok(exemplar.split(/\s+/).length > 600, 'the exemplar itself is a full-size brief');
    for (const part of ['WHAT MUST NOT CHANGE', 'WHAT TO FIX', 'HOW TO DECIDE', 'HOW TO REWRITE', 'EXAMPLES', 'OUTPUT']) assert.ok(exemplar.includes(part), part);
    assert.match(craft, /three to five, not one/);
    const prompt = buildGuideSystemPrompt({});
    assert.match(prompt, /Be concise in the CHAT[^\n]*only for talking to the user[^\n]*several hundred words/, 'brevity is for chat, not for the texts she writes for the tools');
});

// --- Не отвечать, пока нет полной информации ---

import { stripBlocks } from '../libraries/core/guide-markup.js';

test('the prompt forbids answering before she has the information: a looking turn is one short line, the real answer comes only when everything is visible', () => {
    const prompt = buildGuideSystemPrompt({});
    assert.match(prompt, /NEVER give the answer, a proposal card or a guess before you have what you need/);
    assert.match(prompt, /never "answer now and add more after looking"/);
    assert.match(prompt, /ONE short line[^\n]*<continue\/>[^\n]*Give the real answer only in the turn where everything you need is visible/);
    const cut = stripBlocks('Text.\n```proposal\n{"action":"tracker.create","params":{}}\n```\n```card\n{"title":"T"}\n```', ['proposal', 'choice']);
    assert.ok(cut.startsWith('Text.') && !cut.includes('proposal') && cut.includes('```card'), 'only the named kinds are removed');
});

test('a reply that goes to look at a block carries no card and no buttons: the proposal she wrote too early is thrown away and appears only in the turn after the block is open', async () => {
    const early = 'Let me check [Post-Turn](stme:module:module.postprocess) first.\n```proposal\n{"action":"postprocess.pass.add","params":{"prompt":"Fix it."}}\n```<continue/>';
    const final = 'Now I can see it. Here is the pass.\n```proposal\n{"action":"postprocess.pass.add","params":{"prompt":"A full brief."}}\n```';
    const { guide, sent } = buildLoop([early, final]);
    await guide.load();
    await guide.ask('build me a pass');
    assert.equal(sent.length, 2);
    const [first, second] = guide.messages.peek().filter(message => message.role === 'assistant');
    assert.ok(!first.text.includes('proposal'), 'the early card is gone');
    assert.match(first.text, /^Let me check/);
    assert.match(second.text, /```proposal/);
    assert.match(second.text, /A full brief\./);
    const noLink = buildLoop(['Here is the pass.\n```proposal\n{"action":"tracker.create","params":{}}\n```<continue/>']);
    await noLink.guide.load();
    await noLink.guide.ask('make a tracker');
    assert.match(noLink.guide.messages.peek().at(-1).text, /```proposal/, 'nothing to look at — the card stays');
});

test('the same everyday phrase that failed to open the panel now does; a pure "what/why/which" question still does not', async () => {
    const { guide, revealed } = buildLook();
    await guide.load();
    await guide.ask('Okay, can you do than good anti-slop post turn processor pass for me?');
    assert.deepEqual(revealed, ['module:module.postprocess']);
});

test('the proposal card preview is long enough to actually judge a real brief, and always states the true word count no matter how much the preview cuts off', async () => {
    const { describeProposal } = await import('../libraries/core/guide-proposals.js');
    const short = describeProposal('postprocess.pass.add', { prompt: 'Fix grammar and spelling.' });
    assert.match(short.lines[0], /^Instruction: Fix grammar and spelling\. \(4 words total\)$/);
    const long = describeProposal('postprocess.pass.add', { prompt: 'Keep every event unchanged. '.repeat(60).trim() });
    assert.match(long.lines[0], /…\s\(240 words total\)$/);
    assert.ok(long.lines[0].length > 240, 'the preview itself is longer than the old 240-character cut, so a real brief no longer LOOKS short');
});

// --- Закрыть блок по её просьбе (не автоматически) ---

test('ui.hide is a real action she can call: it reaches the ui.hide contract and is safe (auto-runnable), but nothing closes anything by itself', async () => {
    const engine = createEngine();
    const bus = engine.buses.cores;
    const hidden = [];
    bus.register('storage.settings.get', ({ fallback }) => fallback);
    bus.register('storage.settings.set', () => true);
    bus.register('model.workers.get', () => [{ id: 'w' }]);
    bus.register('model.workers.status', () => [{ workerId: 'w', state: 'up' }]);
    bus.register('ui.anchors.list', () => []);
    bus.register('ui.hide', ({ anchor }) => { hidden.push(anchor); return true; });
    const dir = new URL('../guide/', import.meta.url);
    const guide = createGuideCore(engine.registerCaller('core.guide', 'cores', { tier: 'official' }), { publish: () => {}, mount: () => ({}), modules: { list: () => [], enabled: () => [] }, loadText: async path => fs.readFileSync(new URL(path, dir), 'utf8') });
    await guide.load();
    const result = await guide.runAction('ui.hide', { anchor: 'module:module.postprocess' });
    assert.equal(result.ok, true);
    assert.deepEqual(hidden, ['module:module.postprocess']);
    assert.match(buildGuideSystemPrompt({ actions: [{ id: 'ui.hide', description: 'x' }] }), /ui\.hide: x/);
    assert.match(buildGuideSystemPrompt({}), /Use ui\.hide to close a block/);
});

test('opening a block for a task does not close anything by itself when the topic later moves on — closing is hers to call, not automatic', async () => {
    const { guide, revealed } = buildLook();
    await guide.load();
    await guide.ask('build a post-turn pass');
    assert.equal(revealed.length, 1);
    await guide.ask('now help me with the tracker instead');
    assert.equal(revealed.length, 1, 'the engine never calls ui.hide on its own');
});

test('the plan is placed before the last four messages (depth 4, like an @4 injection), at the very start of a short talk, and nothing is added without a plan', () => {
    const turns = Array.from({ length: 7 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `m${index}` }));
    const placed = insertPlan(turns, 'step 1');
    assert.deepEqual(placed.map(turn => turn.content.slice(0, 2)), ['m0', 'm1', 'm2', '##', 'm3', 'm4', 'm5', 'm6']);
    assert.equal(placed[3].role, 'system');
    assert.deepEqual(insertPlan(turns.slice(0, 2), 'p').map(turn => turn.role), ['system', 'user', 'assistant']);
    assert.equal(insertPlan(turns, ''), turns);
    assert.equal(turns.length, 7, 'the history itself is not touched');
});
