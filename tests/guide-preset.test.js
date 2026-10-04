import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createEngine } from '../libraries/shared/engine.js';
import { describeProposal, PROPOSAL_ACTIONS } from '../libraries/core/guide-proposals.js';
import { stToPreset } from '../libraries/core/pm-st-import.js';
import { normalizePresetOps, applyPresetOps, buildPresetView, computePresetProblems, buildPresetFixLine, createStarterPreset, describeCondition, normalizePresetParams } from '../libraries/core/guide-preset.js';
import { detectFocus, sanitizeFocus, countsLine, NEUTRAL } from '../libraries/core/guide-relevance.js';
import { createGuideCore } from '../cores/guide/index.js';

const readArticle = path => fs.readFileSync(new URL(`../guide/${path}`, import.meta.url), 'utf8');
const polished = () => stToPreset(JSON.parse(fs.readFileSync(new URL('./fixtures/pm-amigo-polished.st.json', import.meta.url), 'utf8')), { name: 'Polished' });
const apply = (preset, ops) => { const made = normalizePresetOps(ops); assert.ok(made.ok, made.error); return applyPresetOps(preset, made.value); };
const blockText = (preset, name) => preset.blocks.find(block => block.name === name)?.content;

function buildGuide({ generate = () => 'ok', enabledModules = [] } = {}) {
    const engine = createEngine();
    const settings = new Map();
    const store = new Map();
    const versions = [];
    const calls = [];
    const bus = engine.buses.cores;
    const seed = (id, name, preset) => store.set(id, { id, name, sourceName: null, updatedAt: 1, size: JSON.stringify(preset).length, preset });
    seed('pm_a', 'Polished', polished());
    seed('pm_b', 'Scratch', createStarterPreset('Scratch'));
    let pmSettings = { enabled: true, activePresetId: 'pm_a', overrides: { enabled: false } };
    bus.register('storage.settings.get', ({ namespace, key, fallback }) => settings.get(`${namespace}/${key}`) ?? fallback);
    bus.register('storage.settings.set', ({ namespace, key, value }) => { settings.set(`${namespace}/${key}`, value); return true; });
    bus.register('model.workers.get', () => [{ id: 'w', state: 'up' }]);
    bus.register('model.workers.status', () => [{ workerId: 'w', state: 'up' }]);
    bus.register('model.generate', generate);
    bus.register('ui.anchors.list', () => []);
    bus.register('tracking.trackers', () => []);
    bus.register('macros.programs', () => []);
    bus.register('lorebook.find', () => []);
    bus.register('characterCard.list', () => []);
    bus.register('promptManager.settings', () => pmSettings);
    bus.register('promptManager.presets', () => [...store.values()].map(({ preset, ...rest }) => rest));
    bus.register('promptManager.preset', ({ id }) => store.get(id) ?? null);
    bus.register('promptManager.savePreset', ({ record, label }) => {
        const id = record.id ?? `pm_${store.size + 1}`;
        const full = { ...record, id, updatedAt: 2, size: JSON.stringify(record.preset).length };
        store.set(id, full); versions.push({ key: `${id}:${versions.length}`, presetId: id, at: 5000, label }); calls.push(['save', { id, label }]);
        return full;
    });
    bus.register('promptManager.versions', ({ presetId }) => versions.filter(item => item.presetId === presetId));
    bus.register('promptManager.rollback', params => { calls.push(['rollback', params]); return store.get(params.presetId); });
    bus.register('promptManager.duplicatePreset', ({ id, name }) => { const copy = { ...store.get(id), id: 'pm_copy', name: name ?? 'copy' }; store.set('pm_copy', copy); return copy; });
    bus.register('promptManager.setOverride', params => { calls.push(['override', params]); pmSettings = { ...pmSettings, overrides: { ...pmSettings.overrides, [params.scope]: { [params.key]: params.params } } }; return pmSettings; });
    bus.register('promptManager.preview', () => ({ messages: [], report: [{ name: 'Maybe', included: false, reason: 'condition' }], tokens: { total: 1234, byBlock: [['ROLE', 46], ['Anti Bias', 460]] }, dropped: [{ block: 'history', tokens: 90, reason: 'over budget' }], budget: 35000, macros: { usedRandom: true, unresolved: ['foo'] } }));
    bus.register('promptManager.stability', () => ({ volatile: ['time'], recoverableTokens: 800, advice: [{ block: 'inject:time', movesAbove: 'x' }], verdict: 'the start of the request changed', cachedTokens: null }));
    const modules = { list: () => [], enabled: () => enabledModules, enable: async () => {}, disable: async () => {} };
    const guide = createGuideCore(engine.registerCaller('core.guide', 'cores', { tier: 'official', networkAccess: true }), { publish: () => {}, mount: () => ({}), modules, loadText: async path => readArticle(path) });
    return { guide, calls, store };
}

test('preset proposals are recognised as proposal blocks and the card shows what will be written', () => {
    assert.ok(['preset.create', 'preset.update', 'preset.restore', 'preset.duplicate', 'preset.override'].every(action => PROPOSAL_ACTIONS.includes(action)));
    assert.equal(describeProposal('preset.update', {}).ok, false, 'an update needs its preset');
    assert.equal(describeProposal('preset.update', { id: 'p' }).ok, false, 'an update with nothing in it');
    const shown = describeProposal('preset.update', { id: 'p', params: { temperature: 0.7 }, ops: [{ op: 'setEnabled', node: 'ROLE', enabled: false }] });
    assert.equal(shown.ok, true);
    assert.match(shown.lines[0], /temperature 0\.7/);
    assert.equal(describeProposal('preset.update', { id: 'p', params: { creativity: 1 } }).ok, false, 'an unknown generation setting is named in the refusal');
    assert.equal(describeProposal('preset.restore', { id: 'p', key: 'k' }).danger, true);
    assert.equal(describeProposal('preset.create', {}).ok, false);
});

test('changes are checked as a whole before anything is applied: shape, names, limits', () => {
    assert.equal(normalizePresetOps([]).ok, false);
    assert.equal(normalizePresetOps([{ op: 'jump' }]).ok, false);
    assert.match(normalizePresetOps([{ op: 'editBlock', block: 'ROLE' }]).error, /nothing to change/);
    assert.match(normalizePresetOps([{ op: 'addBlock', name: 'X', into: 'a', before: 'b' }]).error, /only one of/);
    assert.match(normalizePresetOps([{ op: 'addBlock', name: 'X', role: 'robot' }]).error, /"role"/);
    assert.match(normalizePresetOps([{ op: 'setCondition', node: 'ROLE', condition: { type: 'all', items: 'x' } }]).error, /"condition"/);
    assert.match(normalizePresetOps([{ op: 'addRule', name: 'r', find: { kind: 'regex', pattern: '(' } }]).error, /not a valid regex/);
    assert.equal(normalizePresetOps(Array.from({ length: 41 }, () => ({ op: 'removeBlock', block: 'x' }))).ok, false);
    assert.equal(normalizePresetParams({ temperature: 0.8 }).ok, true);
    assert.equal(normalizePresetParams({ temperature: 'hot' }).ok, true, 'text is a legal value for some settings');
    assert.equal(normalizePresetParams({ nonsense: 1 }).ok, false);
});

test('blocks are added, edited and moved by name; the original preset is never touched', () => {
    const preset = polished();
    const before = JSON.stringify(preset);
    const done = apply(preset, [
        { op: 'addBlock', name: 'Memory Note', content: 'Check what was written down.', into: 'logic' },
        { op: 'editBlock', block: 'Present Tense', content: 'Write in the present tense.' },
        { op: 'moveNode', node: 'logic', before: 'narration' },
        { op: 'setEnabled', node: 'FOV', enabled: false },
    ]);
    assert.equal(done.ok, true, done.error);
    assert.equal(JSON.stringify(preset), before);
    assert.equal(blockText(done.preset, 'Present Tense'), 'Write in the present tense.');
    const logic = done.preset.tree.find(node => node.name === 'logic');
    assert.equal(blockText(done.preset, 'Memory Note'), 'Check what was written down.');
    assert.equal(logic.children.length, 4);
    assert.equal(done.preset.tree.find(node => node.name === 'narration').children.find(node => node.block && done.preset.blocks.find(b => b.id === node.block).name === 'FOV').enabled, false);
    assert.equal(done.changedBlocks.size, 2);
});

test('a failing change writes nothing and names the problem: unknown node, taken name, ambiguous name, marker, card prompts', () => {
    const preset = polished();
    assert.match(apply(preset, [{ op: 'editBlock', block: 'No Such' }].map(op => ({ ...op, content: 'x' }))).error, /There is no block called “No Such”/);
    assert.match(apply(preset, [{ op: 'addBlock', name: 'ROLE', content: 'x' }]).error, /already exists/);
    assert.match(apply(preset, [{ op: 'removeBlock', block: 'Chat History' }]).error, /marker/);
    assert.match(apply(preset, [{ op: 'removeBlock', block: 'Main Prompt' }]).error, /character card's own prompts/);
    assert.match(apply(preset, [{ op: 'moveNode', node: 'logic', into: 'logic' }]).error, /itself/);
    assert.match(apply(preset, [{ op: 'addBlock', name: 'Y', content: 'x', into: 'ROLE' }]).error, /not a group/);
    const twin = structuredClone(preset);
    twin.blocks.push({ id: 'dup', name: 'ROLE', role: 'system', content: 'second' });
    twin.tree.push({ type: 'item', block: 'dup', enabled: true });
    assert.match(apply(twin, [{ op: 'setEnabled', node: 'ROLE', enabled: false }]).error, /names 2 blocks/);
});

test('groups wrap their content in tags, conditions are stored as given and read back in plain words, text rules and Guided CoT steps are kept', () => {
    const done = apply(createStarterPreset('S'), [
        { op: 'addGroup', name: 'rules', before: 'Chat History' },
        { op: 'addBlock', name: 'Pace', content: 'One step per reply.', into: 'rules' },
        { op: 'setCondition', node: 'Pace', condition: { type: 'all', items: [{ type: 'keyword', words: ['fight'], scan: 2 }, { type: 'not', item: { type: 'chance', percent: 10 } }] } },
        { op: 'addRule', name: 'no think', find: { kind: 'between', from: '<think>', to: '</think>' } },
        { op: 'setCot', enabled: true, mode: 'always' },
        { op: 'addCotStep', name: 'Plan', content: 'List what happens next.' },
    ]);
    assert.equal(done.ok, true, done.error);
    const group = done.preset.tree.find(node => node.name === 'rules');
    assert.equal(done.preset.blocks.find(block => block.id === group.wrap.open).content, '<rules>');
    assert.equal(done.preset.tree.indexOf(group) < done.preset.tree.findIndex(node => node.block === 'chatHistory'), true);
    assert.equal(describeCondition(group.children[0].condition), '(the last 2 messages by anyone mention "fight" AND NOT 10% chance)');
    assert.equal(done.preset.rules.length, 1);
    assert.equal(done.preset.cot.enabled, true);
    assert.equal(done.preset.cot.steps.length, 1);
    const removed = apply(done.preset, [{ op: 'removeNode', node: 'rules' }]);
    assert.equal(removed.ok, true);
    assert.equal(removed.preset.tree.some(node => node.name === 'rules'), false);
    assert.equal(removed.preset.tree.some(node => node.block === done.preset.blocks.find(block => block.name === 'Pace').id), true, 'the items of a removed group stay in its place');
});

test('a module row is placed by depth or next to a named node', () => {
    const preset = createStarterPreset('S');
    preset.tree.push({ type: 'inject', contribution: 'time', name: 'RP Time', enabled: true, defaultPlacement: 'before-history', atHistoryStart: true });
    const deep = apply(preset, [{ op: 'placeModule', contribution: 'time', depth: 0 }]);
    const row = deep.preset.tree.find(node => node.type === 'inject');
    assert.deepEqual(row.placement, { mode: 'depth', depth: 0, order: 100 });
    assert.equal(row.atHistoryStart, undefined);
    assert.match(apply(preset, [{ op: 'placeModule', contribution: 'weather', depth: 0 }]).error, /no module row/);
});

test('the form check finds what the owner asked about: typos in touched blocks, a step reference that does not exist, tags that do not pair, a per-turn row that breaks the cache', () => {
    const preset = polished();
    const touchedAll = new Set(preset.blocks.map(block => block.id));
    const found = computePresetProblems(preset, { changed: touchedAll });
    const text = found.map(item => `${item.where}: ${item.problem}`).join('\n');
    assert.match(text, /ROLE: typo “discription”/);
    assert.match(text, /CoT Checklist: refers to Step 3\.4, but step 3 has no item 4/);
    assert.ok(!/Step 0/.test(text), 'step 0 exists');
    assert.equal(computePresetProblems(preset, { changed: new Set() }).some(item => /typo/.test(item.problem)), false, 'text that was not touched is not "corrected"');
    const broken = structuredClone(preset);
    broken.blocks.find(block => block.name === '</logic>').content = '</logik>';
    assert.ok(computePresetProblems(broken).some(item => /wrapper tags do not match/.test(item.problem)));
    const volatile = createStarterPreset('V');
    volatile.tree.push({ type: 'inject', contribution: 'time', name: 'RP Time', enabled: true, atHistoryStart: true });
    assert.ok(computePresetProblems(volatile).some(item => /restarts before the whole history/.test(item.problem)));
    volatile.tree[volatile.tree.length - 1].placement = { mode: 'depth', depth: 0, order: 100 };
    assert.equal(computePresetProblems(volatile).length, 0);
    assert.match(buildPresetFixLine(found), /^\[fix\] The engine found these in the preset/);
    assert.equal(buildPresetFixLine([]), '');
});

test('text that calls a module is flagged only while that module is off, and only when a list of modules is known', () => {
    const preset = polished();
    const all = new Set(preset.blocks.map(block => block.id));
    const off = computePresetProblems(preset, { changed: all, enabledModules: [] }).map(item => item.problem).join('\n');
    assert.match(off, /mentions Notebook, but the Notebook module is off/);
    assert.match(off, /mentions RP Time, but the RP Time module is off/);
    const on = computePresetProblems(preset, { changed: all, enabledModules: ['module.notebook', 'module.secrets', 'module.time'] }).map(item => item.problem).join('\n');
    assert.ok(!/module is off/.test(on));
    assert.ok(!computePresetProblems(preset, { changed: all }).some(item => /module is off/.test(item.problem)));
});

test('the view shows the order with names and ids, full texts, switches and conditions, and marks a text it cannot show whole', () => {
    const done = apply(polished(), [{ op: 'setEnabled', node: 'FOV', enabled: false }, { op: 'setCondition', node: 'Fluid Motion', condition: { type: 'everyN', n: 3 } }]);
    const view = buildPresetView({ id: 'pm_a', name: 'Polished', size: 30000, preset: done.preset }, { isActive: true });
    assert.match(view, /Prompt Manager preset “Polished” — id pm_a \(the ACTIVE preset/);
    assert.match(view, /GROUP “need guidelines” <need guidelines>…<\/need guidelines>/);
    assert.match(view, /\[ \] BLOCK “FOV”/);
    assert.match(view, /BLOCK “Fluid Motion” .* — only when every 3th message/);
    assert.match(view, /MARKER “Chat History”/);
    assert.match(view, /GROUP “char instructions” .* inside the chat, depth 8, order 101/);
    assert.match(view, /### Anti Bias\ntext \(\d+ chars\):\n/);
    const long = structuredClone(done.preset);
    long.blocks.find(block => block.name === 'ROLE').content = 'x'.repeat(15000);
    assert.match(buildPresetView({ id: 'p', name: 'L', preset: long }), /text \(TRUNCATED — you see 12000 of 15000 chars; do NOT replace this text as a whole\)/);
});

test('applying a proposal goes through the promptManager contracts, saves a version, and leaves findings in the plan', async () => {
    const { guide, calls, store } = buildGuide();
    await guide.load();
    const updated = await guide.runAction('preset.update', { id: 'pm_a', label: 'tense', ops: [{ op: 'editBlock', block: 'Present Tense', content: 'Write in the present tense, as {{user}} observes from inside.' }] });
    assert.equal(updated.ok, true, updated.message);
    assert.match(updated.message, /updated: changed content of “Present Tense”\. The previous version is saved\. It is the active preset/);
    assert.deepEqual(calls[0], ['save', { id: 'pm_a', label: 'tense' }]);
    assert.match(updated.planFix ?? '', /^$/, 'a clean block raises nothing');
    const typo = await guide.runAction('preset.update', { id: 'pm_a', ops: [{ op: 'editBlock', block: 'ROLE', content: 'Discription: you are the narrator.' }] });
    assert.equal(typo.ok, true);
    assert.match(typo.planFix, /^\[fix\] .*ROLE: typo “discription”/);
    assert.match(store.get('pm_a').preset.blocks.find(block => block.name === 'ROLE').content, /^Discription/, 'findings never block a write');
    const fixed = await guide.runAction('preset.update', { id: 'pm_a', ops: [{ op: 'editBlock', block: 'ROLE', content: 'Description: you are the narrator.' }] });
    assert.equal(fixed.planFix, '', 'a fixed block leaves the plan');
    assert.equal((await guide.runAction('preset.update', { id: 'pm_a', ops: [{ op: 'editBlock', block: 'Nope', content: 'x' }] })).ok, false);
    assert.equal((await guide.runAction('preset.update', { id: 'pm_a' })).ok, false, 'nothing to change');
    assert.equal((await guide.runAction('preset.update', { name: 'Missing', params: { temperature: 0.5 } })).ok, false);
    const byName = await guide.runAction('preset.update', { name: 'scratch', params: { temperature: 0.6 } });
    assert.equal(byName.ok, true);
    assert.equal(store.get('pm_b').preset.params.temperature, 0.6);
    assert.ok(!/active preset/.test(byName.message), 'the other preset is not the active one');
});

test('creating: a taken name is refused, a copy keeps the source, a starter has the markers, and the new preset is never made active', async () => {
    const { guide, store } = buildGuide();
    await guide.load();
    assert.equal((await guide.runAction('preset.create', { name: 'polished' })).ok, false);
    const fresh = await guide.runAction('preset.create', { name: 'Fresh', ops: [{ op: 'addBlock', name: 'Frame', content: 'You narrate the scene.', before: 'Chat History' }], params: { temperature: 0.9 } });
    assert.equal(fresh.ok, true, fresh.message);
    const made = [...store.values()].find(record => record.name === 'Fresh');
    assert.equal(made.preset.params.temperature, 0.9);
    assert.ok(made.preset.tree.some(node => node.block === 'chatHistory'));
    assert.equal(made.preset.tree[made.preset.tree.length - 2].block !== undefined, true);
    const copy = await guide.runAction('preset.create', { name: 'Polished 2', from: 'pm_a', ops: [{ op: 'setEnabled', node: 'logic', enabled: false }] });
    assert.equal(copy.ok, true, copy.message);
    assert.equal([...store.values()].find(record => record.name === 'Polished 2').preset.blocks.length, store.get('pm_a').preset.blocks.length);
    assert.equal(store.get('pm_a').preset.tree.find(node => node.name === 'logic').enabled, true, 'the source is untouched');
});

test('restore, duplicate and override go through their contracts; an override warns while overrides are off', async () => {
    const { guide, calls } = buildGuide();
    await guide.load();
    assert.equal((await guide.runAction('preset.restore', { id: 'pm_a', key: 'pm_a:0' })).ok, true);
    assert.deepEqual(calls.at(-1), ['rollback', { presetId: 'pm_a', key: 'pm_a:0' }]);
    assert.equal((await guide.runAction('preset.restore', { id: 'pm_a' })).ok, false, 'a restore needs a version key');
    assert.equal((await guide.runAction('preset.duplicate', { id: 'pm_a', name: 'Try' })).ok, true);
    const set = await guide.runAction('preset.override', { scope: 'chat', key: 'abc', params: { temperature: 0.5 } });
    assert.equal(set.ok, true);
    assert.match(set.message, /switched off in the Prompt Manager Settings tab/);
    assert.equal((await guide.runAction('preset.override', { scope: 'planet', key: 'x', params: {} })).ok, false);
    assert.equal((await guide.runAction('preset.override', { scope: 'chat', key: 'abc', params: { nonsense: 1 } })).ok, false);
});

test('reading and previewing hand the model the whole thing: the full preset, tokens per block, what was left out, cache advice', async () => {
    const { guide } = buildGuide();
    await guide.load();
    const read = await guide.runAction('preset.read', {});
    assert.equal(read.ok, true);
    assert.match(read.detail, /\(the ACTIVE preset/);
    const named = await guide.runAction('preset.read', { name: 'Scratch' });
    assert.match(named.detail, /preset “Scratch”/);
    assert.equal((await guide.runAction('preset.read', { id: 'zzz' })).ok, false);
    const preview = await guide.runAction('preset.preview', {});
    assert.equal(preview.ok, true);
    assert.match(preview.detail, /Request preview: 1234 tokens of a budget of 35000\.\nTokens by block:\n {2}ROLE: 46\n {2}Anti Bias: 460/);
    assert.match(preview.detail, /Not sent:\n {2}Maybe — condition/);
    assert.match(preview.detail, /Dropped by trimming: history \(90 tokens, over budget\)/);
    assert.match(preview.detail, /Random macros are used/);
    assert.match(preview.detail, /Unknown macros left as text: foo/);
    assert.match(preview.detail, /800 stable tokens stand after the first of them \(inject:time\)/);
});

test('when the talk is about presets the model sees the list, the active preset in full and its saved versions; otherwise presets are only counted', async () => {
    let system = '';
    const { guide } = buildGuide({ generate: params => { system = params.systemPrompt; return 'ok'; } });
    await guide.load();
    await guide.ask('Please rewrite the Anti Bias block of my preset');
    assert.match(system, /Prompt Manager presets \(id — name\): pm_a \(“Polished”, ACTIVE\); pm_b \(“Scratch”\)/);
    assert.match(system, /Prompt Manager preset “Polished” — id pm_a \(the ACTIVE preset/);
    assert.match(system, /No saved versions of pm_a yet\./);
    const other = buildGuide({ generate: params => { system = params.systemPrompt; return 'ok'; } });
    await other.guide.load();
    await other.guide.ask('how do I connect a model?');
    assert.match(system, /Also on hand \(not listed until the talk is about them\): 2 Prompt Manager presets\./);
    assert.ok(!system.includes('Anti Bias'));
});

test('the preset topic is a sticky focus like characters', () => {
    assert.equal(detectFocus({ query: 'add a block to my preset' }).presets, true);
    assert.equal(detectFocus({ query: 'turn on guided cot' }).presets, true);
    assert.equal(detectFocus({ query: 'hello' }), null);
    assert.equal(sanitizeFocus({ presets: true }).presets, true);
    assert.equal(sanitizeFocus({ presets: 'yes' }).presets, false);
    assert.equal(countsLine({ presets: 1 }, NEUTRAL), 'Also on hand (not listed until the talk is about them): 1 Prompt Manager preset.');
});

test('the preset articles work as one topic: while the talk is about presets ALL of them reach the model, otherwise none', async () => {
    const titles = ['Prompt Manager presets: how to work', 'Prompt Manager presets: writing blocks', 'Prompt Manager presets: order, placement and cache', 'Prompt Manager presets: modules, macros and the character card', 'Prompt Manager presets: testing and reinforcing', 'Prompt Manager'];
    let system = '';
    const { guide } = buildGuide({ generate: params => { system = params.systemPrompt; return 'ok'; } });
    await guide.load();
    await guide.ask('I want a new block in my preset');
    for (const title of titles) assert.ok(system.includes(`### ${title}`), `missing article: ${title}`);
    const other = buildGuide({ generate: params => { system = params.systemPrompt; return 'ok'; } });
    await other.guide.load();
    await other.guide.ask('how do I connect a model?');
    for (const title of titles.slice(0, 5)) assert.ok(!system.includes(`### ${title}`), `should not be there: ${title}`);
});

test('the articles hold ideas, not a template: they forbid copying and ship none of the owner\'s block text', () => {
    const articles = ['preset-workflow', 'preset-blocks', 'preset-order-cache', 'preset-modules-card', 'preset-testing'].map(name => readArticle(`knowledge/${name}.md`)).join('\n');
    assert.match(articles, /never reproduce the owner's blocks, headings, wording or group layout/);
    assert.match(articles, /do not copy the layout or the wording of any other preset, including the owner's/);
    const owner = polished().blocks.filter(block => (block.content ?? '').length > 120).flatMap(block => block.content.split('\n').filter(line => line.trim().length > 40));
    for (const line of owner) assert.ok(!articles.includes(line.trim()), `the owner's line is copied into an article: ${line.slice(0, 60)}`);
});

test('the cache law is checked: anything that can differ between requests before the chat history is flagged; the Summaries row is the one thing that must stand before it', () => {
    const base = () => createStarterPreset('C');
    const historyAt = preset => preset.tree.findIndex(node => node.block === 'chatHistory');
    const problems = preset => computePresetProblems(preset).map(item => `${item.where}: ${item.problem}`);

    const calm = base();
    calm.tree.splice(historyAt(calm), 0, { type: 'inject', contribution: 'summary', name: 'Summaries', enabled: true, atHistoryStart: true });
    assert.deepEqual(problems(calm), [], 'summaries before the history are right');

    const late = base();
    late.tree.push({ type: 'inject', contribution: 'summary', name: 'Summaries', enabled: true });
    assert.match(problems(late).join('\n'), /Summaries.*summaries belong BEFORE the chat history .*but this row stands after it/);

    const deepSummary = base();
    deepSummary.tree.push({ type: 'inject', contribution: 'summary', name: 'Summaries', enabled: true, placement: { mode: 'depth', depth: 0, order: 100 } });
    assert.match(problems(deepSummary).join('\n'), /summaries replace the start of the chat and belong BEFORE the chat history, not inside the chat/);

    for (const contribution of ['memory-graph', 'memory-graph-plot', 'notebook', 'secrets', 'time']) {
        const preset = base();
        preset.tree.splice(historyAt(preset), 0, { type: 'inject', contribution, name: contribution, enabled: true, atHistoryStart: true });
        assert.match(problems(preset).join('\n'), /restarts before the whole history/, `${contribution} before the history breaks the cache`);
        preset.tree.find(node => node.contribution === contribution).placement = { mode: 'depth', depth: 0, order: 100 };
        assert.deepEqual(problems(preset), [], `${contribution} at depth 0 is fine`);
    }

    const conditional = apply(base(), [{ op: 'addGroup', name: 'maybe', before: 'Chat History' }, { op: 'addBlock', name: 'Fight', content: 'Combat rules.', into: 'maybe' }, { op: 'setCondition', node: 'maybe', condition: { type: 'keyword', words: ['fight'] } }]);
    assert.match(problems(conditional.preset).join('\n'), /group “maybe”.*has a condition but stands before the chat history/);
    const after = apply(base(), [{ op: 'addGroup', name: 'maybe' }, { op: 'setCondition', node: 'maybe', condition: { type: 'keyword', words: ['fight'] } }]);
    assert.deepEqual(problems(after.preset), [], 'the same group after the history keeps the cache');

    const dice = apply(base(), [{ op: 'addBlock', name: 'Mood', content: 'Today the mood is {{random::calm::tense}}.', before: 'Chat History' }]);
    assert.match(problems(dice.preset).join('\n'), /block “Mood”.*random macro before the chat history/);
    const diceDeep = apply(base(), [{ op: 'addBlock', name: 'Mood', content: 'Today the mood is {{random::calm::tense}}.', position: 'depth', depth: 1 }]);
    assert.deepEqual(problems(diceDeep.preset), [], 'a block inside the chat does not sit before the history');
    const off = structuredClone(dice.preset);
    off.tree.find(node => off.blocks.find(block => block.id === node.block)?.name === 'Mood').enabled = false;
    assert.deepEqual(problems(off), [], 'a switched-off block costs nothing');
});

test('the cache law is written into the articles and into the update action, with the Summaries exception', () => {
    const order = readArticle('knowledge/preset-order-cache.md');
    assert.match(order, /## THE CACHE LAW \(highest priority/);
    assert.match(order, /The reuse stops at the FIRST character that differs/);
    assert.match(order, /\*\*The only exception is the Summaries row: it MUST stand before the chat history\*\*/);
    assert.match(readArticle('knowledge/preset-workflow.md'), /## The cache law comes first/);
    assert.match(readArticle('knowledge/preset-blocks.md'), /## A block's text decides where it can stand/);
    return buildGuide().guide.load().then(() => {
        const text = fs.readFileSync(new URL('../cores/guide/preset-actions.js', import.meta.url), 'utf8');
        assert.equal((text.match(/CACHE LAW \(it comes before everything else/g) ?? []).length, 2, 'both create and update carry it');
        assert.match(text, /the ONLY exception is the Summaries row/);
    });
});

test('the context budget idea is taught: a 35 000 token sweet spot, a 50 000 to 60 000 ceiling counted over the whole request, and it is in the update action', () => {
    const order = readArticle('knowledge/preset-order-cache.md');
    assert.match(order, /## Context budget: the sweet spot and the ceiling/);
    assert.match(order, /Sweet spot: about 35 000 tokens/);
    assert.match(order, /about 50 000 to 60 000 tokens IN TOTAL/);
    assert.match(readArticle('knowledge/preset-blocks.md'), /about 35 000 tokens and the ceiling without losses about 50 000 to 60 000/);
    assert.match(readArticle('knowledge/preset-workflow.md'), /the sweet spot is about 35 000 tokens in total/);
    const actions = fs.readFileSync(new URL('../cores/guide/preset-actions.js', import.meta.url), 'utf8');
    assert.equal((actions.match(/CONTEXT BUDGET: the sweet spot/g) ?? []).length, 2);
});
