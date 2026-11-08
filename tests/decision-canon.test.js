import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanon } from '../cores/decision/canon.js';
import { canonKey, normalizeCanons } from '../libraries/core/decision-canon.js';
import { BANK_BUILDER_VERSION } from '../libraries/core/decision-banks.js';

const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

const greatState = () => ({
    aria: {
        name: 'Aria', aliases: [], importance: 'main',
        material: { 1: ['A scout in grey.'], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] },
        spiritual: { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] },
        decree: { 1: ['Keeps the camp safe.'], 2: [], 3: ['Long goal: hold the pass.', 'Today: learn who came.'], 4: [], 5: [] },
        knowledge: { items: [] }, history: [], pending: [],
    },
});

const creationState = () => ({
    sections: [{ key: 'geography', no: 1, title: 'Geography', guaranteed: true, text: 'The pass and the camp.', at: '' }],
    scales: [{ id: 'scale:mana', name: 'Mana', principle: 'Will made real.', payment: 'focus', rules: [], discoveries: [{ at: 'Day 2', rule: 'Shape', text: 'Iron became a blade.', seq: 1 }] }],
    extra: [], history: [], snapshots: { at: '', seq: 1 },
});

function world({ books = ['World'], cards = [{ name: 'Aria' }], stored = null, answer = null } = {}) {
    const settings = new Map();
    if (stored) settings.set('canons', clone(stored));
    const applied = { banks: null, great: null, ready: 0, creation: null, sorted: 0 };
    const asked = [];
    let creation = creationState();
    const call = async (contract, params = {}) => {
        if (contract === 'storage.settings.get') return settings.has(params.key) ? clone(settings.get(params.key)) : params.fallback ?? null;
        if (contract === 'storage.settings.set') { settings.set(params.key, clone(params.value)); return true; }
        if (contract === 'lorebook.entries') return books.map((book, uid) => ({ book, uid, content: 'world' }));
        if (contract === 'stCharacter.chatCharacters') return cards;
        return null;
    };
    const canon = createCanon({
        call,
        store: {},
        banks: {
            records: () => [{
                sourceKey: 'card:Aria', sourceKind: 'card', name: 'Aria', sourceHash: 'h1',
                text: '***Aria***\nA scout in grey.', sizeBand: 'key', aliases: ['Ari'], canonicalName: 'Aria',
                importance: 'main', status: 'ready', builderVersion: BANK_BUILDER_VERSION, timelineHash: '',
            }],
            great: {
                sync: async () => greatState(),
                load: async () => greatState(),
                replace: async state => { applied.great = state; return state; },
            },
            applySet: async set => { applied.banks = set; return Object.keys(set.banks).length; },
            markSorted: async () => { applied.sorted += 1; return true; },
        },
        creation: {
            load: async () => creation,
            state: () => creation,
            save: async state => { creation = state; applied.creation = state; return state; },
        },
        preparation: { markReady: async () => { applied.ready += 1; return { step: 'ready' }; } },
        askUser: async question => { asked.push(question); return answer ? answer(question) : { skipped: true }; },
        publishEvent: () => {},
        now: () => 2000,
    });
    return { canon, settings, applied, asked, creation: () => creation };
}

test('the Canon key is the set of books and cards, order and case do not matter', () => {
    assert.equal(canonKey({ books: ['B', 'A'], cards: ['Rem', 'Emilia'] }), canonKey({ books: ['A', 'B'], cards: ['emilia', 'rem'] }));
    assert.match(canonKey({ books: ['World'], cards: ['Aria'] }), /^books:World::cards:aria$/);
    assert.equal(canonKey({}), '');
});

test('Save as Canon keeps Creation, the Great Bank and the bank records under the set key', async () => {
    const { canon, settings } = world();
    const saved = await canon.save({ name: 'First world' });
    assert.equal(saved.ok, true);
    const key = canonKey({ books: ['World'], cards: ['Aria'] });
    const all = settings.get('canons');
    const list = normalizeCanons(all[key]);
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'First world');
    assert.equal(list[0].creation.sections[0].text, 'The pass and the camp.');
    assert.equal(list[0].creation.scales[0].discoveries[0].text, 'Iron became a blade.', 'Scales keep their discoveries');
    assert.equal(list[0].great.aria.decree[3].length, 2);
    assert.equal(list[0].banks['card:Aria'].text, '***Aria***\nA scout in grey.', 'the original card.md is kept');
    assert.equal(list[0].banks['card:Aria'].importance, 'main');
});

test('a Canon is a version, not a mutable record: a second save adds a new version', async () => {
    const { canon, settings } = world();
    await canon.save({ name: 'First world' });
    await canon.save({ name: 'First world again' });
    const key = canonKey({ books: ['World'], cards: ['Aria'] });
    const names = normalizeCanons(settings.get('canons')[key]).map(item => item.name);
    assert.deepEqual(names, ['First world again', 'First world']);
});

test('applying a Canon copies Creation, banks and the Great Bank, and marks preparation ready with no God or Director', async () => {
    const source = world();
    await source.canon.save({ name: 'Reusable' });
    const stored = source.settings.get('canons');

    const target = world({ stored });
    const [canon] = await target.canon.list();
    const applied = await target.canon.apply({ id: canon.id });
    assert.equal(applied.ok, true);
    assert.equal(target.applied.creation.sections[0].text, 'The pass and the camp.');
    assert.equal(target.applied.banks.banks['card:Aria'].importance, 'main');
    assert.equal(target.applied.great.aria.importance, 'main');
    assert.equal(target.applied.sorted, 1, 'the cold start is marked done, so the banks are not sorted or built again');
    assert.equal(target.applied.ready, 1, 'preparation becomes ready at once');
});

test('a new chat with the same set is offered the Canon and takes it; a different set is not asked', async () => {
    const source = world();
    await source.canon.save({ name: 'Reusable' });
    const stored = source.settings.get('canons');

    const same = world({ stored, answer: question => ({ answer: question.options[0], skipped: false }) });
    assert.equal(await same.canon.offer(), 1);
    assert.equal(same.asked.length, 1);
    assert.match(same.asked[0].question, /Canon already exists/);
    assert.match(same.asked[0].options[0], /Canon “Reusable”/);
    assert.equal(same.applied.ready, 1);

    const other = world({ stored, cards: [{ name: 'Rem' }], answer: question => ({ answer: question.options[0], skipped: false }) });
    assert.equal(await other.canon.offer(), 0);
    assert.equal(other.asked.length, 0, 'a different set of cards is a different key');
});

test('declining the Canon leaves preparation to the normal path', async () => {
    const source = world();
    await source.canon.save({ name: 'Reusable' });
    const stored = source.settings.get('canons');
    const target = world({ stored, answer: question => ({ answer: question.options.at(-1), skipped: false }) });
    assert.equal(await target.canon.offer(), 0);
    assert.equal(target.applied.ready, 0);
    assert.equal(target.applied.banks, null);
});
