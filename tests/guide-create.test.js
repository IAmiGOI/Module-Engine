import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createEngine } from '../libraries/shared/engine.js';
import { normalizeTracker, normalizeMacro, normalizeLorebookEntry, describeProposal } from '../libraries/core/guide-create.js';
import { parseCompare, formatWhatsNew } from '../libraries/core/guide-whatsnew.js';
import { parseGuideReply, splitAutoActions, plainText } from '../libraries/core/guide-markup.js';
import { createGuideCore } from '../cores/guide/index.js';

const read = path => fs.readFileSync(new URL(`../guide/${path}`, import.meta.url), 'utf8');

// --- Чистые функции: что реально будет создано ---

test('a tracker proposal becomes a real record: names slugged, fields deduplicated, the poll rule from "when"; nonsense is refused with a reason', () => {
    const made = normalizeTracker({ title: 'Hero Health!', fields: [{ name: 'Health', prompt: 'hurt 0-100', default: 100 }, { name: 'health' }, 'Hunger'], when: 'everyNReplies', every: 3 });
    assert.equal(made.ok, true);
    assert.equal(made.value.id, 'hero_health');
    assert.deepEqual(made.value.fields, [{ name: 'health', prompt: 'hurt 0-100', default: 100 }, { name: 'hunger', prompt: '', default: '' }]);
    assert.deepEqual(made.value.triggers, [{ event: 'generation.completed', every: 3 }]);
    assert.equal(normalizeTracker({ title: 'x' }).ok, false, 'no fields');
    assert.equal(normalizeTracker({ fields: ['a'] }).ok, false, 'no name');
    assert.deepEqual(normalizeTracker({ title: 't', fields: ['a'], when: 'rm -rf' }).value.triggers, [{ event: 'generation.completed' }], 'unknown "when" falls back to every reply');
});

test('macro and lorebook proposals are validated the same way', () => {
    assert.deepEqual(normalizeMacro({ name: 'weather', text: 'It rains.' }).value, { id: 'macro_weather', macroName: 'weather', name: 'weather', kind: 'text', source: 'It rains.', triggers: [] });
    assert.equal(normalizeMacro({ name: '9lives', text: 'x' }).ok, false);
    assert.equal(normalizeMacro({ name: 'empty' }).ok, false);
    assert.equal(normalizeMacro({ name: 'hp', code: 'return 1' }).value.kind, 'code');
    assert.deepEqual(normalizeLorebookEntry({ title: 'Mill', keys: ['mill', 'mill', 'miller'], content: 'An old mill.' }).value, { comment: 'Mill', key: ['mill', 'miller'], content: 'An old mill.', constant: false });
    assert.equal(normalizeLorebookEntry({ content: 'no keys' }).ok, false);
    assert.equal(normalizeLorebookEntry({ content: 'always on', always: true }).ok, true);
});

test('the card shows what will really be written, and refuses what cannot be written', () => {
    const shown = describeProposal('tracker.create', { title: 'Health', fields: [{ name: 'health', prompt: 'how hurt', default: 100 }] });
    assert.equal(shown.title, 'Tracker “health”');
    assert.deepEqual(shown.lines, ['health (starts at 100) — how hurt', 'Updated: after every reply.']);
    assert.equal(describeProposal('tracker.create', {}).ok, false);
    assert.equal(describeProposal('rm.everything', {}).ok, false);
});

// --- Разметка: предложения, кнопки-действия, авто-действия ---

test('a proposal block is recognised only for creating actions; a choice option may carry an action; "auto" is read', () => {
    const [proposal, choice, action, fake] = parseGuideReply('```proposal\n{"action":"macro.create","params":{"name":"a","text":"b"}}\n```\n```choice\n{"options":[{"label":"Check","action":"models.check"},"Later"]}\n```\n```action\n{"label":"x","action":"models.check","auto":true}\n```\n```proposal\n{"action":"models.check"}\n```').map(segment => segment.block ?? segment);
    assert.equal(proposal.kind, 'proposal');
    assert.deepEqual(choice.options.map(option => option.action), ['models.check', undefined]);
    assert.equal(action.auto, true);
    assert.equal(fake.type, 'text', 'a proposal for a non-creating action is left as text');
    assert.match(plainText('```proposal\n{"action":"macro.create","params":{"name":"a","text":"b"}}\n```'), /proposal: macro.create/);
});

test('only safe actions marked auto run at once; the rest of the reply and other blocks stay', () => {
    const reply = 'Checking now.\n```action\n{"label":"Check","action":"models.check","auto":true}\n```\n```action\n{"label":"Enable","action":"modules.enable","params":{"id":"m"},"auto":true}\n```\nDone.';
    const split = splitAutoActions(reply, id => id === 'models.check');
    assert.deepEqual(split.actions, [{ action: 'models.check', params: {} }]);
    assert.ok(!split.text.includes('models.check'));
    assert.ok(split.text.includes('modules.enable'), 'a state-changing action keeps its button even when marked auto');
});

// --- Что нового ---

test('the compare answer becomes a short list: newest first, merges and duplicates dropped', () => {
    const changes = parseCompare({ commits: ['Old thing', 'Merge branch x', 'New thing\n\nbody', 'Old thing'].map(message => ({ commit: { message } })) });
    assert.deepEqual(changes.subjects, ['Old thing', 'New thing']);
    assert.match(formatWhatsNew({ subjects: ['a', 'b'], total: 2 }), /2 changes since you last opened me:\n\n- a\n- b/);
    assert.match(formatWhatsNew({ subjects: Array.from({ length: 12 }, (_, i) => `c${i}`), total: 12 }), /…and 4 more\./);
    assert.equal(formatWhatsNew({ subjects: [], total: 0 }), '');
});

// --- Ядро ---

function build({ commit = 'bbb', stored, compare, workers = [{ id: 'w', state: 'up' }], generate = () => 'ok', bookNames = ['Book'] } = {}) {
    const engine = createEngine();
    const settings = new Map(stored ? [['core.guide/lastCommit', stored]] : []);
    const store = { trackers: [], programs: [], entries: [], compare: [] };
    const bus = engine.buses.cores;
    bus.register('storage.settings.get', ({ namespace, key, fallback }) => settings.get(`${namespace}/${key}`) ?? fallback);
    bus.register('storage.settings.set', ({ namespace, key, value }) => { settings.set(`${namespace}/${key}`, value); return true; });
    bus.register('model.workers.get', () => workers);
    bus.register('model.workers.status', () => workers.map(worker => ({ workerId: worker.id, state: worker.state })));
    bus.register('model.workers.probe', () => workers.map(worker => ({ workerId: worker.id, state: 'up' })));
    bus.register('model.generate', generate);
    bus.register('ui.anchors.list', () => []);
    bus.register('ui.reveal', () => true);
    bus.register('tracking.trackers', () => store.trackers);
    bus.register('tracking.configure', ({ trackers }) => { store.trackers = trackers; return true; });
    bus.register('macros.programs', () => store.programs);
    bus.register('macros.configure', ({ programs }) => { store.programs = programs; return true; });
    bus.register('macros.test', ({ program }) => (program.source.includes('BROKEN') ? { ok: false, error: 'bad syntax' } : { ok: true, value: '1' }));
    bus.register('lorebook.books', () => bookNames);
    bus.register('lorebook.createEntry', ({ patch }) => { store.entries.push(patch); return { ...patch, book: bookNames[0] }; });
    bus.register('selfUpdate.check', () => ({ checked: true, currentCommitHash: commit }));
    bus.register('selfUpdate.repository', () => ({ owner: 'o', repo: 'r' }));
    engine.buses.network.register('http.request', params => { store.compare.push(params.url); return compare ?? { ok: true, status: 200, text: JSON.stringify({ commits: [{ commit: { message: 'Music: model tags' } }, { commit: { message: 'Guide: name Mea' } }] }) }; });
    const modules = { list: () => [], enabled: () => [], enable: async () => {}, disable: async () => {} };
    const guide = createGuideCore(engine.registerCaller('core.guide', 'cores', { tier: 'official', networkAccess: true }), { publish: () => {}, mount: () => ({}), modules, loadText: async path => read(path) });
    return { guide, store, settings };
}

test('applying a tracker proposal creates it beside the existing ones, never replaces one with the same name', async () => {
    const { guide, store } = build();
    await guide.load();
    store.trackers = [{ id: 'keep', kind: 'system' }];
    const result = await guide.runAction('tracker.create', { title: 'Health', fields: [{ name: 'health', prompt: 'hurt', default: 100 }] });
    assert.equal(result.ok, true);
    assert.deepEqual(store.trackers.map(tracker => tracker.id), ['keep', 'health']);
    assert.equal(store.trackers[1].workerId, 'w');
    assert.equal((await guide.runAction('tracker.create', { title: 'Health', fields: ['x'] })).ok, false, 'the same name is refused');
    assert.equal(store.trackers.length, 2);
});

test('a macro program that does not run is refused; a lorebook entry needs a lorebook', async () => {
    const { guide, store } = build();
    await guide.load();
    assert.equal((await guide.runAction('macro.create', { name: 'bad', code: 'BROKEN' })).ok, false);
    assert.equal(store.programs.length, 0);
    assert.equal((await guide.runAction('macro.create', { name: 'weather', text: 'Rain.' })).ok, true);
    assert.equal(store.programs.length, 1);
    assert.equal((await guide.runAction('lorebook.addEntry', { title: 'Mill', keys: ['mill'], content: 'Old mill.' })).ok, true);
    assert.equal(store.entries.length, 1);
    const none = build({ bookNames: [] });
    await none.guide.load();
    assert.equal((await none.guide.runAction('lorebook.addEntry', { title: 'Mill', keys: ['mill'], content: 'Old mill.' })).ok, false);
});

test('a choice option with an action runs it at once — no second button, no model round-trip', async () => {
    let asked = 0;
    const { guide } = build({ generate: () => { asked += 1; return 'x'; } });
    await guide.load();
    await guide.pick({ label: 'Check all connections now', action: 'models.check' });
    assert.equal(asked, 0);
    assert.deepEqual(guide.messages.peek().map(message => message.role), ['user', 'note']);
    assert.match(guide.messages.peek().at(-1).text, /Working: w/);
});

test('a harmless action the model marks "auto" runs by itself and leaves no button; the reply text is kept', async () => {
    let calls = 0;
    const { guide } = build({ generate: () => ((calls += 1) === 1 ? 'Checking now.\n```action\n{"label":"Check","action":"models.check","auto":true}\n```' : 'All good.') });
    await guide.load();
    await guide.ask('check my connections');
    const [, reply, note] = guide.messages.peek();
    assert.equal(reply.text, 'Checking now.');
    assert.match(note.text, /Working: w/);
});

test('"what\'s new": silent on the first run, then a list of the changes once the commit moves — and it is not repeated', async () => {
    const first = build({ commit: 'aaa' });
    await first.guide.load();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(first.guide.messages.peek().length, 0);
    assert.equal(first.settings.get('core.guide/lastCommit'), 'aaa');

    const updated = build({ commit: 'bbb', stored: 'aaa' });
    updated.settings.set('core.guide/chat', { messages: [{ id: '1', role: 'assistant', text: 'Hi' }], mode: 'chat' });
    await updated.guide.load();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(updated.store.compare[0], /compare\/aaa\.\.\.bbb$/);
    assert.match(updated.guide.messages.peek().at(-1).text, /2 changes since you last opened me:\n\n- Guide: name Mea\n- Music: model tags/);
    assert.equal(updated.settings.get('core.guide/lastCommit'), 'bbb');
});

test('a network failure does not eat the message: the commit is not marked as seen', async () => {
    const { guide, settings } = build({ commit: 'bbb', stored: 'aaa', compare: { ok: false, status: 500, text: '' } });
    settings.set('core.guide/chat', { messages: [{ id: '1', role: 'assistant', text: 'Hi' }], mode: 'chat' });
    await guide.load();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(settings.get('core.guide/lastCommit'), 'aaa');
    assert.equal(guide.messages.peek().length, 1);
});
