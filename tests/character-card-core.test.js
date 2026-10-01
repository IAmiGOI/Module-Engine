import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { request } from '../libraries/shared/request.js';
import { createCharacterCardsCore } from '../cores/character-cards/index.js';

// Повторяет слияние ST 1.18 (`deepMerge`): объекты сливаются по ключам, всё остальное, включая массивы, заменяется целиком.
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function deepMerge(target, source) {
    const output = { ...target };
    for (const key of Object.keys(source)) output[key] = isObject(source[key]) && isObject(target?.[key]) ? deepMerge(target[key], source[key]) : structuredClone(source[key]);
    return output;
}

function buildWorld({ failMerge = false } = {}) {
    const engine = createEngine();
    const cards = new Map([
        ['Aria.png', { name: 'Aria', description: 'old', tags: ['a'], data: { name: 'Aria', description: 'old', tags: ['a'], alternate_greetings: ['x', 'y'], extensions: { chub: { id: 7 }, talkativeness: 0.5 }, character_book: { name: 'B', extensions: {}, entries: [{ id: 0, keys: ['k'], content: 'kept', extensions: { depth: 4 } }] } } }],
        ['Bram.png', { name: 'Bram', description: 'b', data: { name: 'Bram' } }],
        ['Bram Two.png', { name: 'Bram', description: 'b2', data: { name: 'Bram' } }],
    ]);
    const versions = [];
    const log = { created: [], merges: [], refreshed: 0 };
    const services = engine.buses.services;
    services.register('stCharacterCard.list', () => [...cards].map(([avatar, card]) => ({ avatar, name: card.name, tags: card.tags ?? [] })));
    services.register('stCharacterCard.load', ({ avatar }) => structuredClone(cards.get(avatar)));
    services.register('stCharacterCard.create', ({ form }) => {
        log.created.push(form);
        const avatar = `${form.ch_name}.png`;
        cards.set(avatar, { name: form.ch_name, description: form.description ?? '', data: { name: form.ch_name, extensions: { talkativeness: Number(form.talkativeness ?? 0.5) } } });
        return { avatar };
    });
    services.register('stCharacterCard.merge', ({ avatar, body }) => {
        if (failMerge) throw new Error('SillyTavern refused the card: data.tags');
        log.merges.push({ avatar, body });
        cards.set(avatar, deepMerge(cards.get(avatar), body));
        return true;
    });
    services.register('characterCardVersions.list', ({ avatar }) => versions.filter(record => record.avatar === avatar).sort((a, b) => b.at - a.at).map(({ card, ...summary }) => summary));
    services.register('characterCardVersions.get', ({ key }) => versions.find(record => record.key === key) ?? null);
    services.register('characterCardVersions.put', ({ record }) => { versions.push({ ...record, key: `${record.avatar}:${record.at}` }); return true; });
    let clock = 1000;
    const events = [];
    const core = createCharacterCardsCore(engine.registerCaller('core.characterCard', 'cores', { tier: 'official' }), { publish: (event, payload) => events.push([event, payload]), now: () => (clock += 1000) });
    const call = (contract, params) => request(engine.buses.cores, contract, { params });
    return { core, call, cards, versions, log, events };
}

test('creating a card refuses a name that is already taken instead of replacing that character', async () => {
    const { call, log } = buildWorld();
    const refused = await call('characterCard.create', { fields: { name: 'aria', description: 'x' } });
    assert.equal(refused.ok, false);
    assert.match(refused.error.message, /already exists \(Aria\.png\)/);
    assert.equal(log.created.length, 0);
});

test('creating a card sends only the name in the form and writes every field by one merge, so newlines, an exact zero talkativeness and the lorebook come out as given', async () => {
    const { call, cards, log, events } = buildWorld();
    const created = await call('characterCard.create', { fields: { name: 'Cleo', description: 'line one\nline two', talkativeness: 0, character_book: { name: 'Book', entries: [{ name: 'Mill', keys: ['mill'], content: 'An old mill.' }] } } });
    assert.equal(created.ok, true);
    assert.deepEqual(created.value, { avatar: 'Cleo.png', name: 'Cleo' });
    assert.deepEqual(log.created[0], { ch_name: 'Cleo' });
    assert.equal(log.merges.length, 1);
    const saved = cards.get('Cleo.png');
    assert.equal(saved.data.description, 'line one\nline two');
    assert.equal(saved.description, 'line one\nline two');
    assert.equal(saved.data.extensions.talkativeness, 0);
    assert.equal(saved.data.character_book.entries[0].content, 'An old mill.');
    assert.equal(saved.data.character_book.entries[0].id, 0);
    assert.deepEqual(events.at(-1), ['characterCard.changed', { avatar: 'Cleo.png', action: 'create' }]);
});

test('an edit saves the previous version BEFORE writing, changes only the named fields, and replaces a list as a whole', async () => {
    const { call, cards, versions, log } = buildWorld();
    const updated = await call('characterCard.update', { avatar: 'Aria.png', fields: { description: 'new', alternate_greetings: ['only'] } });
    assert.equal(updated.ok, true);
    assert.deepEqual(updated.value.changed, ['description', 'alternate_greetings']);
    assert.equal(versions.length, 1);
    assert.equal(versions[0].card.description, 'old', 'the snapshot holds the card as it was before the edit');
    assert.match(versions[0].label, /Before changing description, alternate_greetings/);
    const saved = cards.get('Aria.png');
    assert.equal(saved.data.description, 'new');
    assert.equal(saved.description, 'new', 'the flat V1 field is updated too');
    assert.deepEqual(saved.data.alternate_greetings, ['only']);
    assert.deepEqual(saved.data.extensions.chub, { id: 7 }, 'a foreign extension is not touched');
    assert.equal(saved.data.character_book.entries[0].content, 'kept', 'an unnamed lorebook stays');
    assert.equal(log.merges.length, 1);
});

test('if ST refuses the write, the error is returned as a refusal and the snapshot is already there to restore from', async () => {
    const { call, versions, cards } = buildWorld({ failMerge: true });
    const failed = await call('characterCard.update', { avatar: 'Aria.png', fields: { tags: ['z'] } });
    assert.equal(failed.ok, false);
    assert.match(failed.error.message, /SillyTavern refused the card/);
    assert.equal(versions.length, 1);
    assert.equal(cards.get('Aria.png').description, 'old');
});

test('a lorebook edit changes one entry by id without losing the ST-only settings of it and adds a new one', async () => {
    const { call, cards } = buildWorld();
    const updated = await call('characterCard.update', { avatar: 'Aria.png', fields: { character_book: { entries: [{ id: 0, content: 'changed' }, { name: 'New', keys: ['n'], content: 'fresh' }] } } });
    assert.equal(updated.ok, true);
    const entries = cards.get('Aria.png').data.character_book.entries;
    assert.deepEqual(entries.map(entry => [entry.id, entry.content]), [[0, 'changed'], [1, 'fresh']]);
    assert.deepEqual(entries[0].extensions, { depth: 4 });
});

test('restoring puts the snapshot back, saves the state it replaced first, and refuses a version of another character', async () => {
    const { call, cards, versions } = buildWorld();
    await call('characterCard.update', { avatar: 'Aria.png', fields: { description: 'new' } });
    const [first] = versions;
    const listed = await call('characterCard.versions', { avatar: 'Aria.png' });
    assert.equal(listed.value[0].key, first.key);
    assert.equal('card' in listed.value[0], false, 'the list does not carry the heavy card body');
    const restored = await call('characterCard.restore', { avatar: 'Aria.png', key: first.key });
    assert.equal(restored.ok, true);
    assert.equal(cards.get('Aria.png').data.description, 'old');
    assert.equal(versions.length, 2, 'the restore itself can be undone');
    assert.equal(versions[1].card.description, 'new');
    assert.match(versions[1].label, /Before restoring/);
    const foreign = await call('characterCard.restore', { avatar: 'Bram.png', key: first.key });
    assert.equal(foreign.ok, false);
    assert.equal(cards.get('Bram.png').description, 'b');
});

test('a character is found by avatar file or by a name that is unique; a name two characters share is refused, not guessed', async () => {
    const { call } = buildWorld();
    assert.equal((await call('characterCard.get', { name: 'aria' })).value.avatar, 'Aria.png');
    assert.equal((await call('characterCard.get', { avatar: 'Bram Two.png' })).value.fields.description, 'b2');
    const shared = await call('characterCard.get', { name: 'Bram' });
    assert.equal(shared.ok, false);
    assert.match(shared.error.message, /several characters are called "Bram"/);
    assert.equal((await call('characterCard.get', { name: 'Nobody' })).ok, false);
});

test('renaming into a name another character already has is refused', async () => {
    const { call } = buildWorld();
    const clash = await call('characterCard.update', { avatar: 'Aria.png', fields: { name: 'Bram' } });
    assert.equal(clash.ok, false);
    assert.match(clash.error.message, /another character is already called "Bram"/);
});

test('a card whose lorebook is refused is not created at all, so no empty card with only a name is left in SillyTavern', async () => {
    const { call, log, cards } = buildWorld();
    const refused = await call('characterCard.create', { fields: { name: 'Dara', character_book: { entries: [{ content: 'no keys here' }] } } });
    assert.equal(refused.ok, false);
    assert.equal(log.created.length, 0);
    assert.equal(cards.has('Dara.png'), false);
});
