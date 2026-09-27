import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createEngine } from '../libraries/shared/engine.js';
import { splitThinking, notesBlock, MAX_NOTES_CHARS } from '../libraries/core/guide-thinking.js';
import { normalizePassParams } from '../libraries/core/guide-edit.js';
import { describeProposal } from '../libraries/core/guide-proposals.js';
import { detectFocus } from '../libraries/core/guide-relevance.js';
import { buildGuideSystemPrompt } from '../libraries/core/guide-knowledge.js';
import { createGuideCore, TOKEN_BUDGET, HISTORY_TOKEN_LIMIT, COMPLETION_TOKEN_LIMIT } from '../cores/guide/index.js';

// --- Внутренние рассуждения ---

test('thinking and notes are cut out of what the user sees; notes are reported separately, an empty <notes> means "finished", no tag means "unchanged"', () => {
    const reply = '<think>Need a tracker, then a macro. Check ids.</think>\n<notes>Plan: 1 tracker (done) 2 macro (next)</notes>\nHere is the tracker.\n```proposal\n{"action":"tracker.create","params":{}}\n```';
    const split = splitThinking(reply);
    assert.ok(!split.visible.includes('think') && !split.visible.includes('Plan:'));
    assert.match(split.visible, /^Here is the tracker\./);
    assert.match(split.visible, /```proposal/);
    assert.equal(split.notes, 'Plan: 1 tracker (done) 2 macro (next)');
    assert.equal(splitThinking('Hi.<notes></notes>').notes, '');
    assert.equal(splitThinking('Just an answer.').notes, undefined);
    assert.equal(splitThinking('<think>cut off mid-thought').visible, '', 'an unfinished thought never leaks');
    assert.equal(splitThinking(`<notes>${'x'.repeat(5000)}</notes>ok`).notes.length, MAX_NOTES_CHARS);
    assert.equal(notesBlock('  '), '');
    assert.match(notesBlock('step 2 next'), /## Your working notes from earlier in this task \(private[^\n]*\nstep 2 next/);
    assert.match(buildGuideSystemPrompt({ notes: 'plan A' }), /plan A/);
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

test('her notes are hidden from the chat, kept, and handed back on the next turns until the job is finished, the user closes the talk, or she clears them', async () => {
    const { guide, sent, settings } = build({ replies: ['<think>hard job</think><notes>1. tracker — done\n2. macro — next</notes>First part is ready.', 'Second part is ready.', '<notes></notes>All finished.', 'Sure.'] });
    await guide.load();
    await guide.ask('help me set up a health tracker and a macro for it');
    assert.equal(guide.messages.peek().at(-1).text, 'First part is ready.', 'no think, no notes in the chat');
    assert.match(settings.get('core.guide/chat').notes, /2\. macro — next/, 'saved with the chat');
    await guide.ask('go on');
    assert.match(sent[1].messages[0].content, /## Your working notes[^\n]*\n1\. tracker — done\n2\. macro — next/);
    await guide.ask('and finish it');
    assert.match(sent[2].messages[0].content, /2\. macro — next/, 'still there while the job runs');
    await guide.ask('anything else?');
    assert.ok(!sent[3].messages[0].content.includes('## Your working notes'), 'she cleared them with an empty <notes>');
    assert.equal(sent[0].maxTokens, 5000, 'room for thinking and a long answer');
    assert.deepEqual([TOKEN_BUDGET, HISTORY_TOKEN_LIMIT, COMPLETION_TOKEN_LIMIT], [15000, 10000, 5000], '15k in all: 10k of history, 5k for the answer with its thinking');
});

test('the user closing the talk wipes the notes; clearing the chat wipes them too', async () => {
    const first = build({ replies: ['<notes>plan X</notes>Started.', 'ok'] });
    await first.guide.load();
    await first.guide.ask('start the big job');
    assert.match(first.settings.get('core.guide/chat').notes, /plan X/);
    await first.guide.ask('thanks, that is all');
    assert.ok(!first.sent[1].messages[0].content.includes('plan X'), 'closed by the user');
    const second = build({ replies: ['<notes>plan Y</notes>Started.', 'ok'] });
    await second.guide.load();
    await second.guide.ask('start the big job');
    await second.guide.resetChat();
    assert.equal(second.settings.get('core.guide/chat').notes, '', 'a fresh chat starts without old plans');
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
    assert.equal(streamingText('Here it is.\n```proposal\n{"action":"tracker.create","params":{}}\n```\nDone'), 'Here it is.\n```proposal\n{"action":"tracker.create","params":{}}\n```\nDone');
    assert.equal(streamingText('<notes>plan</notes>Answer<notes>next'), 'Answer');
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
