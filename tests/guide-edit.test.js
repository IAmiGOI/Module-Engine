import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createEngine } from '../libraries/shared/engine.js';
import { signal } from '../cores/ui/reactive.js';
import { normalizeSettingValue, planSettingChanges, describePlan, describeSpecs, numberSetting, booleanSetting } from '../libraries/core/guide-settings.js';
import { normalizeTrackerPatch, applyTrackerPatch, normalizeEntryPatch } from '../libraries/core/guide-edit.js';
import { describeProposal, PROPOSAL_ACTIONS } from '../libraries/core/guide-proposals.js';
import { parseGuideReply } from '../libraries/core/guide-markup.js';
import { createGuideCore } from '../cores/guide/index.js';

// --- Настройки: значение по спецификации ---

const similarity = signal(0.55);
const autoSwitch = signal(true);
const maxNotes = signal(12);
const batch = signal(4);
const specs = () => [
    numberSetting('minSimilarity', 'Min similarity', similarity, { min: 0, max: 1, step: 0.05 }),
    booleanSetting('autoSwitch', 'Auto-switch', autoSwitch),
    numberSetting('maxNotes', 'Maximum notes', maxNotes, { min: 1, max: 200 }),
    { ...numberSetting('cleanupBatch', 'Cleanup batch', batch, { min: 1 }), max: () => maxNotes.peek() },
    { key: 'mode', label: 'Mode', type: 'choice', options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }], get: () => 'a', set: () => {} },
];

test('a setting value is checked against the module\'s own spec: numbers clamp and snap to the step, switches accept words, choices match by value or label', () => {
    const [number, bool, , , choice] = specs();
    assert.equal(normalizeSettingValue(number, 0.42).value, 0.4);
    assert.equal(normalizeSettingValue(number, 7).value, 1, 'clamped to the maximum');
    assert.equal(normalizeSettingValue(number, '-3').value, 0);
    assert.equal(normalizeSettingValue(number, 'lots').ok, false);
    assert.equal(normalizeSettingValue(number, '').ok, false);
    assert.equal(normalizeSettingValue(bool, 'off').value, false);
    assert.equal(normalizeSettingValue(bool, 'maybe').ok, false);
    assert.equal(normalizeSettingValue(choice, 'beta').value, 'b');
    assert.equal(normalizeSettingValue(choice, 'gamma').ok, false);
});

test('a plan checks every key before anything is applied; an unknown key is refused with the list of real ones; bounds may depend on a neighbour', () => {
    const plan = planSettingChanges(specs(), { minSimilarity: 0.4, autoSwitch: false });
    assert.deepEqual(describePlan(plan.changes), ['Min similarity: 0.55 → 0.4', 'Auto-switch: on → off']);
    assert.match(planSettingChanges(specs(), { minSimilarity: 0.4, volume: 3 }).error, /no setting "volume"\. Available: minSimilarity, autoSwitch/);
    assert.equal(planSettingChanges(specs(), { cleanupBatch: 50 }).changes[0].to, 12, 'cleanupBatch cannot exceed maxNotes');
    assert.equal(planSettingChanges(specs(), {}).ok, false);
    assert.match(describeSpecs(specs()), /minSimilarity \(Min similarity\) = 0\.55 \[0–1\]; autoSwitch \(Auto-switch\) = on \[on\/off\]/);
});

// --- Правка: трекер и запись лорбука ---

test('a tracker patch changes only what it names: fields by name (edit or add), removal, schedule, on/off', () => {
    const made = normalizeTrackerPatch({ id: 'Hero Status', fields: [{ name: 'mood', prompt: 'one word' }, { name: 'gold', default: 0 }], removeFields: ['hunger'], every: 3 });
    assert.equal(made.ok, true);
    const before = { id: 'hero_status', kind: 'user', enabled: true, fields: [{ name: 'health', prompt: 'hp', default: 100 }, { name: 'mood', prompt: 'old', default: 'calm' }, { name: 'hunger', prompt: 'h', default: 0 }], triggers: [{ event: 'generation.completed' }] };
    const after = applyTrackerPatch(before, made.value);
    assert.deepEqual(after.fields, [{ name: 'health', prompt: 'hp', default: 100 }, { name: 'mood', prompt: 'one word', default: 'calm' }, { name: 'gold', prompt: '', default: 0 }]);
    assert.deepEqual(after.triggers, [{ event: 'generation.completed', every: 3 }]);
    assert.equal(after.enabled, true);
    assert.equal(normalizeTrackerPatch({ id: 'x' }).ok, false, 'nothing to change');
    assert.equal(normalizeEntryPatch({ uid: 3, title: 'T', always: true }).value.patch.constant, true);
    assert.equal(normalizeEntryPatch({ uid: 'x', title: 'T' }).ok, false);
});

test('the card for a proposal is built for every kind; deletions are marked dangerous; settings show before → after', () => {
    assert.ok(PROPOSAL_ACTIONS.includes('module.setting.set') && PROPOSAL_ACTIONS.includes('tracker.create'));
    assert.equal(describeProposal('tracker.delete', { id: 'hero_status' }).danger, true);
    assert.equal(describeProposal('macro.update', { name: 'weather', text: 'Sunny' }).ok, true);
    assert.equal(describeProposal('tracker.create', { title: 'x', fields: ['a'] }).danger, undefined);
    const shown = describeProposal('module.setting.set', { module: 'module.music', changes: { minSimilarity: 0.4 } }, { settingsOf: () => specs(), titleOf: () => 'Music' });
    assert.deepEqual([shown.title, shown.lines], ['Settings — Music', ['Min similarity: 0.55 → 0.4']]);
    assert.equal(describeProposal('module.setting.set', { module: 'module.off', changes: {} }, { settingsOf: () => null }).ok, false);
    assert.equal(parseGuideReply('```proposal\n{"action":"tracker.delete","params":{"id":"x"}}\n```')[0].block.kind, 'proposal');
});

// --- Ядро ---

function build({ music = true, storage = null } = {}) {
    const engine = createEngine();
    const bus = engine.buses.cores;
    const store = { trackers: [{ id: 'hero', kind: 'user', enabled: true, fields: [{ name: 'health', prompt: 'hp', default: 100 }, { name: 'mood', prompt: 'm', default: '' }], triggers: [] }, { id: 'time', kind: 'system', fields: [{ name: 't' }] }, { id: 'rp', kind: 'user', ownerId: 'module.time', fields: [{ name: 'x' }] }], programs: [{ id: 'macro_weather', macroName: 'weather', kind: 'text', source: 'Rain.' }], entries: [{ uid: 3, book: 'Book', name: 'Mill', keys: ['mill'] }], saved: [], updated: [], removed: [] };
    const generated = [];
    bus.register('storage.settings.get', ({ namespace, key, fallback }) => (storage ? storage.get(`${namespace}/${key}`) ?? fallback : fallback));
    bus.register('storage.settings.set', ({ namespace, key, value }) => { storage?.set(`${namespace}/${key}`, value); return true; });
    bus.register('model.workers.get', () => [{ id: 'w' }]);
    bus.register('model.workers.status', () => [{ workerId: 'w', state: 'up' }]);
    bus.register('ui.anchors.list', () => []);
    bus.register('model.generate', params => { generated.push(params); return 'ok'; });
    bus.register('tracking.trackers', () => store.trackers);
    bus.register('tracking.configure', ({ trackers }) => { store.trackers = trackers; return true; });
    bus.register('macros.programs', () => store.programs);
    bus.register('macros.configure', ({ programs }) => { store.programs = programs; return true; });
    bus.register('macros.test', ({ program }) => (program.source.includes('BROKEN') ? { ok: false, error: 'bad' } : { ok: true }));
    bus.register('lorebook.find', () => store.entries);
    bus.register('lorebook.updateEntry', params => { store.updated.push(params); return { uid: params.uid }; });
    bus.register('lorebook.deleteEntry', params => { store.removed.push(params); return true; });
    const saves = [];
    const modules = {
        list: () => [{ id: 'module.music', title: 'Music' }], enabled: () => (music ? ['module.music'] : []), enable: async () => {}, disable: async () => {},
        guideSettings: id => (music && id === 'module.music' ? { specs: specs(), save: async () => { saves.push('saved'); } } : null),
    };
    const dir = new URL('../guide/', import.meta.url);
    const guide = createGuideCore(engine.registerCaller('core.guide', 'cores', { tier: 'official' }), { publish: () => {}, mount: () => ({}), modules, loadText: async path => fs.readFileSync(new URL(path, dir), 'utf8') });
    return { guide, store, generated, saves };
}

test('changing a tracker touches only the user\'s own; system trackers and other modules\' trackers cannot be changed or deleted', async () => {
    const { guide, store } = build();
    await guide.load();
    assert.equal((await guide.runAction('tracker.update', { id: 'hero', fields: [{ name: 'mood', prompt: 'one word' }], removeFields: [] })).ok, true);
    assert.equal(store.trackers.find(item => item.id === 'hero').fields[1].prompt, 'one word');
    assert.equal((await guide.runAction('tracker.update', { id: 'time', fields: [{ name: 'x', prompt: 'y' }] })).ok, false, 'system');
    assert.equal((await guide.runAction('tracker.delete', { id: 'rp' })).ok, false, 'owned by a module');
    assert.equal((await guide.runAction('tracker.update', { id: 'hero', removeFields: ['health', 'mood'] })).ok, false, 'a tracker keeps at least one field');
    assert.equal((await guide.runAction('tracker.delete', { id: 'hero' })).ok, true);
    assert.deepEqual(store.trackers.map(item => item.id), ['time', 'rp'], 'everything else stays');
});

test('macros and lorebook entries can be changed and deleted; a broken program is refused; unknown names are refused', async () => {
    const { guide, store } = build();
    await guide.load();
    assert.equal((await guide.runAction('macro.update', { name: 'weather', text: 'Sunny.' })).ok, true);
    assert.equal(store.programs[0].source, 'Sunny.');
    assert.equal((await guide.runAction('macro.update', { name: 'weather', code: 'BROKEN' })).ok, false);
    assert.equal((await guide.runAction('macro.update', { name: 'nope', text: 'x' })).ok, false);
    assert.equal((await guide.runAction('macro.delete', { name: 'weather' })).ok, true);
    assert.equal(store.programs.length, 0);
    assert.equal((await guide.runAction('lorebook.updateEntry', { uid: 3, title: 'Old Mill', keys: ['mill', 'wheel'] })).ok, true);
    assert.deepEqual(store.updated[0], { uid: 3, book: undefined, patch: { comment: 'Old Mill', key: ['mill', 'wheel'] } });
    assert.equal((await guide.runAction('lorebook.deleteEntry', { uid: 3, book: 'Book' })).ok, true);
    assert.deepEqual(store.removed[0], { uid: 3, book: 'Book' });
});

test('module settings: only an ENABLED module\'s declared keys, validated, applied live and saved once; nothing is applied when one key is bad', async () => {
    const { guide, saves } = build();
    await guide.load();
    similarity.set(0.55); autoSwitch.set(true);
    const bad = await guide.runAction('module.setting.set', { module: 'module.music', changes: { minSimilarity: 0.3, volume: 9 } });
    assert.equal(bad.ok, false);
    assert.equal(similarity.peek(), 0.55, 'the good key was not applied either');
    const good = await guide.runAction('module.setting.set', { module: 'module.music', changes: { minSimilarity: 0.3, autoSwitch: 'off' } });
    assert.equal(good.ok, true);
    assert.deepEqual([similarity.peek(), autoSwitch.peek(), saves.length], [0.3, false, 1]);
    assert.match(guide.messages.peek().at(-1).text, /Music: Min similarity: 0\.55 → 0\.3; Auto-switch: on → off/);
    const off = build({ music: false });
    await off.guide.load();
    assert.equal((await off.guide.runAction('module.setting.set', { module: 'module.music', changes: { minSimilarity: 0.3 } })).ok, false);
});

const stateFor = async (question, options) => {
    const { guide, generated } = build(options);
    await guide.load();
    await guide.ask(question);
    return generated[0].messages[0].content;
};

test('the prompt is gradual: on a neutral question only counts and module names appear — no ids, no lists, no setting keys', async () => {
    const system = await stateFor('how are you doing today?');
    assert.match(system, /Also on hand \(not listed until the talk is about them\): 1 tracker, 1 macro, 1 lorebook entry\./);
    assert.match(system, /Modules with settings you can change \(their keys show up when you talk about them or they are open\): Music\./);
    for (const hidden of ['hero (fields', '{{weather}}', '#3 “Mill”', 'minSimilarity (Min similarity)']) assert.ok(!system.includes(hidden), hidden);
});

test('the list of a topic appears when the talk is about it, and only that list: trackers, macros, lorebook each by their own words', async () => {
    const trackers = await stateFor('please change my tracker');
    assert.match(trackers, /Your trackers: hero \(fields: health, mood\)/);
    assert.ok(!trackers.includes('{{weather}}') && !trackers.includes('#3 “Mill”'));
    assert.match(trackers, /Also on hand[^\n]*1 macro, 1 lorebook entry/);
    const macros = await stateFor('what does my macro say?');
    assert.match(macros, /Macros: \{\{weather\}\}/);
    assert.ok(!macros.includes('hero (fields'));
    const lore = await stateFor('edit the world info entry about the mill');
    assert.match(lore, /#3 “Mill” \(Book\)/);
    assert.ok(!lore.includes('{{weather}}'));
    assert.ok(!(await stateFor('make a tracker')).includes('time (fields'), 'system trackers are never offered');
});

test('settings keys of a module appear when it is named, or when settings are asked about in general; otherwise only its name', async () => {
    assert.match(await stateFor('make Music calmer'), /Settings you can change in Music \(module\.music\): minSimilarity \(Min similarity\)/);
    assert.match(await stateFor('which settings can you change?'), /minSimilarity \(Min similarity\)/);
    assert.ok(!(await stateFor('tell me a joke')).includes('minSimilarity (Min similarity)'));
});

test('an open block on screen counts as talking about it — but only when it is newly opened: a block left open does not hold the topic forever', async () => {
    const { createGuideContext } = await import('../cores/guide/context.js');
    const { nextFocus, NEUTRAL } = await import('../libraries/core/guide-relevance.js');
    const known = [{ id: 'module.music', title: 'Music' }];
    const context = createGuideContext({
        call: async contract => ({ ok: true, value: ({ 'tracking.trackers': [], 'macros.programs': [], 'lorebook.find': [{ uid: 3, book: 'Book', name: 'Mill' }] })[contract] }),
        modules: { list: () => known, enabled: () => ['module.music'], guideSettings: () => ({ specs: specs() }) },
    });
    const at = (focus, anchors) => nextFocus(focus, { query: 'hello there', anchors, modules: known });
    assert.ok(!(await context.editable({ focus: at(NEUTRAL, []) })).includes('minSimilarity (Min similarity)'));
    const music = at(NEUTRAL, ['module:module.music']);
    assert.match(await context.editable({ focus: music }), /minSimilarity \(Min similarity\)/);
    assert.match(await context.editable({ focus: at(NEUTRAL, ['card:lorebook']) }), /#3 “Mill” \(Book\)/);
    assert.match(await context.editable({ focus: at(music, ['module:module.music']) }), /minSimilarity/, 'still in focus: sticky until finished');
});

// --- Липкий фокус ---

test('sticky focus: a topic stays after its words are gone; only a FACT ends it (done, or a closing phrase); another topic named by phrase replaces it', async () => {
    const { nextFocus, NEUTRAL, isClosing } = await import('../libraries/core/guide-relevance.js');
    const known = [{ id: 'module.music', title: 'Music' }, { id: 'module.scenePainter', title: 'Scene Painter' }];
    const say = (focus, query, anchors = []) => nextFocus(focus, { query, anchors, modules: known });
    let focus = say(NEUTRAL, 'change my tracker please');
    assert.equal(focus.trackers, true);
    focus = say(focus, 'make it a bit shorter');
    assert.equal(focus.trackers, true, 'no topic words, no completion — the focus is held');
    focus = say(focus, 'actually let us look at Scene Painter');
    assert.deepEqual([focus.trackers, focus.modules], [false, ['module.scenePainter']], 'a new topic replaces the old one');
    focus = say(focus, 'thanks, that is all');
    assert.deepEqual([focus.modules, focus.trackers, focus.done], [[], false, false], 'closed by the user');
    focus = say(say(NEUTRAL, 'edit the macro'), 'go on');
    assert.equal(focus.macros, true);
    assert.equal(say({ ...focus, done: true }, 'next question').macros, false, 'an applied change completes the task');
    assert.equal(say({ ...focus, done: true }, 'now the lorebook entry').lorebook, true, 'a new phrase after completion still opens the new topic');
    assert.equal(isClosing('thanks, now change the tracker'.repeat(3)), false, 'a long message is not a closing');
    assert.equal(say(NEUTRAL, 'thanks, now change the tracker').trackers, true, 'a new topic wins over a thank-you');
});

test('sticky focus in a live chat: the list stays through follow-ups with fresh data, ends after an applied change, switches on a new phrase', async () => {
    const { guide, generated, store } = build();
    const settings = new Map();
    void settings;
    await guide.load();
    const system = async question => { await guide.ask(question); return generated.at(-1).messages[0].content; };
    assert.match(await system('please change my tracker'), /Your trackers: hero \(fields: health, mood\)/);
    assert.match(await system('add a hunger field'), /Your trackers: hero/, 'follow-up without the word — still there');
    assert.equal((await guide.runAction('tracker.update', { id: 'hero', fields: [{ name: 'hunger', prompt: 'h' }] })).ok, true);
    const after = await system('anything else you can do?');
    assert.ok(!after.includes('Your trackers: hero'), 'the change was applied — back to the light mode');
    assert.match(after, /Also on hand[^\n]*1 tracker/);
    assert.match(await system('show me the tracker again'), /hero \(fields: health, mood, hunger\)/, 'fresh data after the change');
    const music = await system('now about Music');
    assert.match(music, /minSimilarity \(Min similarity\)/);
    assert.ok(!music.includes('Your trackers: hero'), 'switched by a phrase — the new topic replaces the old');
    assert.match(await system('ok make it calmer'), /minSimilarity \(Min similarity\)/, 'still Music');
    assert.ok(!(await system('thanks!')).includes('minSimilarity (Min similarity)'), 'closed by the user');
    void store;
});

test('the focus lives with the chat: after a page reload the follow-up is still in the same topic', async () => {
    const storage = new Map();
    const first = build({ storage });
    await first.guide.load();
    await first.guide.ask('let us edit my tracker');
    const again = build({ storage });
    await again.guide.load();
    await again.guide.ask('and make it shorter');
    assert.match(again.generated[0].messages[0].content, /Your trackers: hero/);
    const applied = build({ storage });
    await applied.guide.load();
    await applied.guide.runAction('tracker.update', { id: 'hero', enabled: false });
    const later = build({ storage });
    await later.guide.load();
    await later.guide.ask('so, anything new?');
    assert.ok(!later.generated[0].messages[0].content.includes('Your trackers: hero'), 'the completion was remembered too');
});
