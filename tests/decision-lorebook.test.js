import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { request } from '../libraries/shared/request.js';
import { createPipelineCore } from '../cores/pipeline/index.js';
import { createDecisionCore } from '../cores/decision/index.js';
import { buildLorebookContext, buildWriterLorebook, withoutCharacterEntries, LOREBOOK_SMALL_TOKENS } from '../libraries/core/decision-lorebook.js';
import { searchEntries } from '../libraries/core/lorebook-sources.js';
import { characterLorebookEntries } from '../libraries/core/decision-banks.js';

const long = text => `${text} ${'detail '.repeat(2000)}`;
const entries = [
    { uid: 1, book: 'World', comment: 'Old Mill', key: ['mill', 'miller'], content: 'The mill stands by the river. The miller knows every road.', constant: false, disable: false },
    { uid: 2, book: 'World', comment: 'The River', key: ['river'], content: 'The river is deep and cold all year.', constant: true, disable: false },
    { uid: 3, book: 'World', comment: 'Hidden', key: ['none'], content: 'This deleted entry must not appear.', disable: true },
];

test('a small book travels whole into the stable director context; disabled entries do not', () => {
    const built = buildLorebookContext(entries);
    assert.equal(built.large, false);
    assert.match(built.text, /^THE LOREBOOK/);
    assert.match(built.text, /Old Mill/);
    assert.match(built.text, /The miller knows every road/);
    assert.match(built.text, /The River/);
    assert.doesNotMatch(built.text, /deleted entry/);
    assert.equal(built.entries, 2);
});

test('a large book sends only always-on entries and points the director at the search tool', () => {
    const large = [
        { uid: 1, book: 'World', comment: 'Ordinary', key: ['x'], content: long('Ordinary fact.'), constant: false },
        { uid: 2, book: 'World', comment: 'Always', key: ['y'], content: long('Always true.'), constant: true },
    ];
    const built = buildLorebookContext(large, { smallTokens: LOREBOOK_SMALL_TOKENS });
    assert.equal(built.large, true);
    assert.match(built.text, /only always-on entries/);
    assert.match(built.text, /Always true/);
    assert.doesNotMatch(built.text, /Ordinary fact/);
    assert.equal(built.constants, 1);
});

test('search ranks the name and keys above a bare content hit, skips disabled entries, and honours the limit', () => {
    const found = searchEntries(entries, 'mill');
    assert.ok(found.length >= 1);
    assert.equal(found[0].name, 'Old Mill');
    assert.match(found[0].snippet, /miller/);
    assert.deepEqual(searchEntries(entries, 'deleted'), []);
    assert.deepEqual(searchEntries(entries, ''), []);
    assert.equal(searchEntries([...entries, ...entries.map((entry, index) => ({ ...entry, uid: 10 + index, comment: `Mill ${index}` }))], 'mill', { limit: 2 }).length, 2);
});

function build({ bookEntries = entries, worker = 'director' } = {}) {
    const engine = createEngine();
    const settings = new Map();
    const memory = new Map();
    const calls = [];
    const searches = [];
    const key = (namespace, name) => `${namespace}:${name}`;
    const bus = engine.buses.cores;
    bus.register('storage.settings.get', ({ namespace, key: name, fallback }) => settings.has(key(namespace, name)) ? structuredClone(settings.get(key(namespace, name))) : fallback);
    bus.register('storage.settings.set', ({ namespace, key: name, value }) => { settings.set(key(namespace, name), structuredClone(value)); return true; });
    bus.register('storage.chatMemory.get', ({ namespace, key: name, fallback }) => memory.has(key(namespace, name)) ? structuredClone(memory.get(key(namespace, name))) : fallback);
    bus.register('storage.chatMemory.set', ({ namespace, key: name, value }) => { memory.set(key(namespace, name), structuredClone(value)); return true; });
    bus.register('model.workers.get', () => [{ id: 'director', format: 'openai', model: 'director/model' }]);
    bus.register('summary.list', () => []);
    bus.register('chatHistory.messages', () => [{ mesid: '1', text: 'last' }]);
    bus.register('chatHistory.annotations', () => ({}));
    bus.register('lorebook.books', () => ['World']);
    bus.register('lorebook.entries', () => bookEntries);
    bus.register('lorebook.search', ({ query, limit }) => { searches.push({ query, limit }); return searchEntries(bookEntries, query, { limit }); });
    bus.register('lorebook.get', ({ uid }) => bookEntries.find(entry => entry.uid === uid) ?? null);
    bus.register('ui.notify', () => true);
    bus.register('ui.reveal', () => true);
    bus.register('model.generate', async params => {
        if (String(params.messages?.[0]?.content ?? '').startsWith("You are preparing the Director's character data banks")) {
            const marked = characterLorebookEntries(bookEntries).map(entry => ({ uid: entry.uid, name: entry.comment, importance: 'minor' }));
            return { text: '', toolCalls: [{ id: 'mark', name: 'mark_lorebook_characters', arguments: { comment: 'These entries describe single characters.', characters: marked } }] };
        }
        calls.push(params);
        return {
            text: '',
            toolCalls: [
                { id: 'plan', name: 'set_plan', arguments: { comment: 'The turn needs a direction.', direction: 'Cross the river.' } },
                { id: 'lore', name: 'lorebook', arguments: { comment: 'The mill may matter for the route.', op: 'search', query: 'mill' } },
                { id: 'turn', name: 'submit_turn', arguments: { comment: 'The turn is decided.', scene: { minutes: 1 }, resolution: 'They cross the river.', userResult: 'The user waited.', characters: [] } },
            ],
        };
    });
    const pipelineCore = createPipelineCore(engine.registerCaller('core.pipeline', 'cores', { tier: 'official' }), {
        resolveAs: engine.resolveAs, publish: (event, payload) => engine.events.emit(event, payload),
    });
    pipelineCore.define({ id: 'generation.beforeSend', mode: 'collect' });
    pipelineCore.define({ id: 'generation.payload', mode: 'fold' });
    const core = createDecisionCore(engine.registerCaller('core.decision', 'cores', { tier: 'official' }), { retryDelayMs: 0 });
    return (async () => {
        await core.load();
        await core.configure({ decider: { workerId: worker } });
        return { engine, pipelineCore, core, calls, searches };
    })();
}

test('the director sees the book and can search it; the writer body gets the book as is', async () => {
    const { pipelineCore, core, calls, searches } = await build();
    const chat = [{ mes: 'Where is the mill?', is_user: true }];
    const before = await pipelineCore.run({ pipelineId: 'generation.beforeSend', input: { runId: 'run_1', chat, type: 'normal' } });
    assert.equal(before.ok, true);
    const directorText = JSON.stringify(calls[0].messages);
    assert.match(directorText, /THE LOREBOOK/);
    assert.match(directorText, /Old Mill/);
    assert.ok(calls[0].tools.some(tool => tool.name === 'lorebook'), 'the director gets the search tool');
    assert.deepEqual(searches, [{ query: 'mill', limit: undefined }]);
    const trace = core.log()[0].toolCalls.find(entry => entry.name === 'lorebook');
    assert.equal(trace.result.ok, true);
    assert.equal(trace.result.results[0].name, 'Old Mill');

    const sent = await pipelineCore.run({ pipelineId: 'generation.payload', input: { messages: [{ role: 'system', content: 'ST' }] } });
    const writerText = JSON.stringify(sent.value.messages);
    assert.match(writerText, /THE LOREBOOK/);
    assert.match(writerText, /Old Mill/);
    assert.match(writerText, /PUSH — what happens this turn:/);
});

test('a large book reaches the director only by its always-on entries, and the search tool finds the rest', async () => {
    const large = [
        { uid: 1, book: 'World', comment: 'Ordinary Mill', key: ['mill'], content: long('Ordinary fact.'), constant: false },
        { uid: 2, book: 'World', comment: 'Always', key: ['truth'], content: long('Always true.'), constant: true },
    ];
    const { pipelineCore, calls, searches } = await build({ bookEntries: large });
    const before = await pipelineCore.run({ pipelineId: 'generation.beforeSend', input: { runId: 'run_1', chat: [{ mes: 'hi', is_user: true }], type: 'normal' } });
    assert.equal(before.ok, true);
    const firstToolCall = calls[0].messages.findIndex(message => Array.isArray(message.tool_calls) && message.tool_calls.length);
    const text = JSON.stringify(calls[0].messages.slice(0, firstToolCall));
    assert.match(text, /THE LOREBOOK \(large/);
    assert.match(text, /Always true/);
    assert.doesNotMatch(text, /Ordinary fact/);
    assert.deepEqual(searches, [{ query: 'mill', limit: undefined }]);
});

const withCharacters = [
    { uid: 1, book: 'World', comment: '-- LOCATIONS --', content: '' },
    { uid: 2, book: 'World', comment: 'Old Mill', key: ['mill'], content: 'The mill stands by the river.' },
    { uid: 3, book: 'World', comment: '-- CHARACTERS --', content: '' },
    { uid: 4, book: 'World', comment: 'Lena', key: ['lena'], content: 'Lena runs the ferry and trusts nobody.' },
    { uid: 5, book: 'World', comment: '-- PAST EVENTS --', content: '' },
    { uid: 6, book: 'World', comment: 'The Flood', key: ['flood'], content: 'The flood took the old bridge.' },
];

test('character entries of the lorebook become data banks, so neither the director nor the writer gets them twice', () => {
    assert.deepEqual(withoutCharacterEntries(withCharacters).map(entry => entry.comment), ['-- LOCATIONS --', 'Old Mill', '-- CHARACTERS --', '-- PAST EVENTS --', 'The Flood']);
    const director = buildLorebookContext(withCharacters).text;
    const writer = buildWriterLorebook(withCharacters).text;
    for (const text of [director, writer]) {
        assert.match(text, /Old Mill/);
        assert.match(text, /The Flood/);
        assert.doesNotMatch(text, /trusts nobody/);
    }
});

test('a large book reaches the writer by its always-on entries and the entries whose keys appear in the scene', () => {
    const large = [
        { uid: 1, book: 'World', comment: 'Ordinary', key: ['granary'], content: long('Ordinary fact.') },
        { uid: 2, book: 'World', comment: 'Always', key: ['x'], content: 'Always-on fact.', constant: true },
        { uid: 3, book: 'World', comment: 'Mentioned', key: ['Lighthouse'], content: long('The lighthouse fact.') },
    ];
    const built = buildWriterLorebook(large, { scanText: 'They walk to the lighthouse at dusk.' });
    assert.equal(built.large, true);
    assert.match(built.text, /Always-on fact/);
    assert.match(built.text, /The lighthouse fact/);
    assert.doesNotMatch(built.text, /Ordinary fact/);
    assert.doesNotMatch(built.text, /search/i, 'the writer has no tools, so the text never points at one');
});

test('the director\'s marking decides which entries are excluded from the lorebook text, not the section headings', () => {
    const entries = [
        { book: 'Story', uid: 1, comment: '-- VILLAINS --', content: '' },
        { book: 'Story', uid: 2, comment: 'Rem (Still comatose lmao)', content: 'A demon maid.' },
        { book: 'Story', uid: 3, comment: 'The family', content: 'A whole family.' },
    ];
    const marks = { Story: { sourceHash: 'x', marks: [{ uid: 2, name: 'Rem', importance: 'key' }] } };
    assert.deepEqual(withoutCharacterEntries(entries, marks).map(entry => entry.comment), ['-- VILLAINS --', 'The family']);
});
