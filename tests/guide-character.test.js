import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createEngine } from '../libraries/shared/engine.js';
import { describeProposal, PROPOSAL_ACTIONS } from '../libraries/core/guide-proposals.js';
import { parseGuideReply } from '../libraries/core/guide-markup.js';
import { buildCharacterView } from '../libraries/core/guide-character.js';
import { detectFocus, sanitizeFocus, countsLine, NEUTRAL } from '../libraries/core/guide-relevance.js';
import { createGuideCore } from '../cores/guide/index.js';

const readArticle = path => fs.readFileSync(new URL(`../guide/${path}`, import.meta.url), 'utf8');

const ARIA_FIELDS = {
    name: 'Aria', description: 'Aria is a scout.', personality: '', scenario: '', first_mes: '"Who goes there?"', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: 'Keep it short.',
    alternate_greetings: [], tags: ['scout'], creator: '', character_version: '', talkativeness: 0.5, fav: false, world: '', depth_prompt: { prompt: '', depth: 4, role: 'system' },
    character_book: { name: 'Book', entries: [{ id: 0, name: 'Mill', keys: ['mill'], content: 'An old mill.' }] }, extensions: {},
};

function buildGuide({ generate = () => 'ok', characters = [{ avatar: 'Aria.png', name: 'Aria', tags: [] }, { avatar: 'Bram.png', name: 'Bram', tags: [] }], openAvatar = null } = {}) {
    const engine = createEngine();
    const settings = new Map();
    const calls = [];
    const bus = engine.buses.cores;
    bus.register('storage.settings.get', ({ namespace, key, fallback }) => settings.get(`${namespace}/${key}`) ?? fallback);
    bus.register('storage.settings.set', ({ namespace, key, value }) => { settings.set(`${namespace}/${key}`, value); return true; });
    bus.register('model.workers.get', () => [{ id: 'w', state: 'up' }]);
    bus.register('model.workers.status', () => [{ workerId: 'w', state: 'up' }]);
    bus.register('model.generate', generate);
    bus.register('ui.anchors.list', () => []);
    bus.register('tracking.trackers', () => []);
    bus.register('macros.programs', () => []);
    bus.register('lorebook.find', () => []);
    bus.register('characterCard.list', () => characters);
    bus.register('characterCard.get', ({ avatar }) => ({ avatar, fields: { ...ARIA_FIELDS, name: characters.find(item => item.avatar === avatar)?.name ?? 'X' } }));
    bus.register('characterCard.versions', () => [{ key: 'Aria.png:5000', avatar: 'Aria.png', at: 5000, label: 'Before changing description' }]);
    bus.register('characterCard.create', params => { calls.push(['create', params]); return { avatar: `${params.fields.name}.png`, name: params.fields.name }; });
    bus.register('characterCard.update', params => { calls.push(['update', params]); return { avatar: params.avatar, name: 'Aria', changed: Object.keys(params.fields) }; });
    bus.register('characterCard.restore', params => { calls.push(['restore', params]); return { avatar: params.avatar, changed: ['description'] }; });
    engine.buses.services.register('stCharacter.current', () => (openAvatar ? { avatar: openAvatar, name: 'Aria' } : null));
    const modules = { list: () => [], enabled: () => [], enable: async () => {}, disable: async () => {} };
    const guide = createGuideCore(engine.registerCaller('core.guide', 'cores', { tier: 'official', networkAccess: true }), { publish: () => {}, mount: () => ({}), modules, loadText: async path => readArticle(path) });
    return { guide, calls };
}

test('character proposals are recognised as proposal blocks, and each card shows what will really be written', () => {
    assert.ok(['character.create', 'character.update', 'character.restore'].every(action => PROPOSAL_ACTIONS.includes(action)));
    const [block] = parseGuideReply('```proposal\n{"action":"character.create","params":{"name":"Cleo"}}\n```').map(segment => segment.block ?? segment);
    assert.equal(block.kind, 'proposal');
    const shown = describeProposal('character.create', { name: 'Cleo', description: 'D'.repeat(400), tags: ['a'], character_book: { entries: [{ name: 'Mill', keys: ['mill'], content: 'An old mill.' }] } });
    assert.equal(shown.title, 'New character “Cleo”');
    assert.equal(shown.lines[0], 'Name: Cleo');
    assert.match(shown.lines[1], /^Description \(400 chars, ~100 tokens\):\n/);
    assert.ok(shown.lines[1].endsWith('…'), 'a long text is shown as a preview with its size');
    assert.ok(shown.lines.includes('Tags: a'));
    assert.ok(shown.lines.some(line => /Card lorebook: 1 new entry/.test(line)));
});

test('the card of an edit names the character by its avatar file, treats "name" as the new name, and warns when entries are removed', () => {
    const shown = describeProposal('character.update', { avatar: 'Aria.png', first_mes: 'Hi.' });
    assert.equal(shown.title, 'Change character “Aria”');
    assert.equal(shown.danger, false);
    assert.equal(describeProposal('character.update', { name: 'Only a name' }).ok, false, 'without the avatar file nothing is addressed');
    assert.equal(describeProposal('character.update', { avatar: 'Aria.png', character_book: { removeEntries: [1] } }).danger, true);
    assert.equal(describeProposal('character.update', { avatar: 'Aria.png' }).ok, false, 'an edit that changes nothing is refused');
    assert.equal(describeProposal('character.restore', { avatar: 'Aria.png' }).ok, false, 'a restore needs the version key');
    assert.equal(describeProposal('character.restore', { avatar: 'Aria.png', key: 'k' }).danger, true);
});

test('applying a proposal goes through the characterCard contracts: create by fields, update with the avatar split off, restore by key', async () => {
    const { guide, calls } = buildGuide();
    await guide.load();
    assert.equal((await guide.runAction('character.create', { name: 'Cleo', description: 'd' })).ok, true);
    assert.equal((await guide.runAction('character.update', { avatar: 'Aria.png', label: 'tone', first_mes: 'Hi.' })).ok, true);
    assert.equal((await guide.runAction('character.restore', { avatar: 'Aria.png', key: 'Aria.png:5000' })).ok, true);
    assert.deepEqual(calls[0], ['create', { fields: { name: 'Cleo', description: 'd' } }]);
    assert.deepEqual(calls[1], ['update', { avatar: 'Aria.png', label: 'tone', fields: { first_mes: 'Hi.' } }]);
    assert.deepEqual(calls[2], ['restore', { avatar: 'Aria.png', key: 'Aria.png:5000' }]);
    assert.equal((await guide.runAction('character.update', { first_mes: 'no target' })).ok, false);
});

test('when the talk is about characters the model sees the list and the full card of the open character and of one named in the talk, with its saved versions', async () => {
    let system = '';
    const { guide } = buildGuide({ openAvatar: 'Aria.png', generate: params => { system = params.systemPrompt; return 'ok'; } });
    await guide.load();
    await guide.ask('Please rewrite the first message of Bram, the character card is too long');
    assert.match(system, /Character cards \(avatar file — name\): Aria\.png \(“Aria”\); Bram\.png \(“Bram”\)/);
    assert.match(system, /\[The character open in SillyTavern right now\]\nCharacter “Aria” — file Aria\.png/);
    assert.match(system, /Character “Bram” — file Bram\.png/);
    assert.match(system, /post_history_instructions:\nKeep it short\./);
    assert.match(system, /Saved versions of Aria\.png \(newest first; key — when — note\): Aria\.png:5000 — 1970-01-01 00:00 — Before changing description/);
    assert.match(system, /character_book “Book” — 1 entries \(id, name, keys, always-on, text\):\n {2}#0 “Mill” \[mill\]/);
});

test('when the talk is about something else, cards are only counted, not sent', async () => {
    let system = '';
    const { guide } = buildGuide({ openAvatar: 'Aria.png', generate: params => { system = params.systemPrompt; return 'ok'; } });
    await guide.load();
    await guide.ask('how do I connect a model?');
    assert.match(system, /Also on hand \(not listed until the talk is about them\): 2 character cards\./);
    assert.ok(!system.includes('Aria is a scout.'));
});

test('a long field the model cannot see whole is marked as truncated, so it is never rewritten as a whole', () => {
    const view = buildCharacterView({ avatar: 'Big.png', fields: { ...ARIA_FIELDS, description: 'x'.repeat(15000) } });
    assert.match(view, /description \(TRUNCATED — you see 12000 of 15000 chars; do NOT replace this field as a whole/);
    assert.ok(!view.includes('x'.repeat(12001)));
});

test('the character topic is a sticky focus like trackers: named by the talk, kept in storage, counted when out of focus', () => {
    assert.equal(detectFocus({ query: 'edit the greeting of my character' }).characters, true);
    assert.equal(detectFocus({ query: 'hello' }), null);
    assert.equal(sanitizeFocus({ characters: true }).characters, true);
    assert.equal(sanitizeFocus({ characters: 'yes' }).characters, false);
    assert.equal(countsLine({ characters: 1 }, NEUTRAL), 'Also on hand (not listed until the talk is about them): 1 character card.');
});

test('the character articles work as one topic: while the talk is about characters ALL of them reach the model, otherwise none of them does', async () => {
    const titles = ['Creating and editing character cards', 'Character cards: the skeleton and the named rules', 'Character cards: example dialogues and greetings', 'How the owner\'s preset reads a card', 'Character cards: testing and reinforcing'];
    let system = '';
    const { guide } = buildGuide({ generate: params => { system = params.systemPrompt; return 'ok'; } });
    await guide.load();
    await guide.ask('I want a new character card for a caravan guide');
    for (const title of titles) assert.ok(system.includes(`### ${title}`), `missing article: ${title}`);
    assert.ok(system.includes('## Explicit Naming') && system.includes('## Card Interview') && system.includes('## Reactive Reinforcement'));
    const other = buildGuide({ generate: params => { system = params.systemPrompt; return 'ok'; } });
    await other.guide.load();
    await other.guide.ask('how do I connect a model?');
    for (const title of titles) assert.ok(!system.includes(`### ${title}`), `should not be there: ${title}`);
});

test('every character article names its topic, and every field the Core accepts is explained in the workflow article', () => {
    const articles = ['character-cards.md', 'character-rules.md', 'character-examples.md', 'character-preset-fit.md', 'character-testing.md'].map(file => readArticle(`knowledge/${file}`));
    for (const text of articles) assert.match(text, /^topic: characters$/m);
    const workflow = articles[0];
    for (const field of ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'post_history_instructions', 'system_prompt', 'alternate_greetings', 'tags', 'creator', 'character_version', 'creator_notes', 'talkativeness', 'fav', 'depth_prompt', 'world', 'character_book', 'extensions']) {
        assert.ok(workflow.includes(`\`${field}\``), `the workflow article does not explain ${field}`);
    }
});
