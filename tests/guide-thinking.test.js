import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createEngine } from '../libraries/shared/engine.js';
import { splitThinking, notesBlock, MAX_NOTES_CHARS } from '../libraries/core/guide-thinking.js';
import { normalizePassParams } from '../libraries/core/guide-edit.js';
import { describeProposal } from '../libraries/core/guide-proposals.js';
import { detectFocus } from '../libraries/core/guide-relevance.js';
import { buildGuideSystemPrompt } from '../libraries/core/guide-knowledge.js';
import { createGuideCore } from '../cores/guide/index.js';

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
    assert.ok(buildGuideSystemPrompt({}).includes('Reason first inside <think>'), 'the prompt teaches the habit');
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
    assert.equal(sent[0].maxTokens, 1800, 'room for thinking');
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
