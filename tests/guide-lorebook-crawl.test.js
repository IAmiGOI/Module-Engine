import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { createGuideCore } from '../cores/guide/index.js';
import { registerStWebSearchService } from '../services/st-web-search.js';
import { renderBookPage, entryHeading, countByBook, describeOutline, OUTLINE_SHOWN } from '../libraries/core/lorebook-page.js';

const entry = (uid, comment, key, content, extra = {}) => ({ uid, comment, key, keysecondary: [], content, constant: false, disable: false, ...extra });

test('a book becomes a page where every entry is a section with its number, title and keys; the page keeps numbers in order and marks always-on and disabled entries', () => {
    const text = renderBookPage('Ranoa', [entry(2, 'Academy', ['academy', 'school'], 'The Ranoa Magic Academy.', { constant: true }), entry(1, 'Old Mill', ['mill'], 'An abandoned mill.', { keysecondary: ['river'], disable: true })]);
    assert.ok(text.indexOf('## #1 Old Mill') < text.indexOf('## #2 Academy'), 'ordered by uid');
    assert.match(text, /## #1 Old Mill \[mill \| also: river\] \[off\]\nAn abandoned mill\./);
    assert.match(text, /## #2 Academy \[academy, school\] \[always on\]\nThe Ranoa Magic Academy\./);
    assert.equal(renderBookPage('Empty', []), 'Lorebook “Empty” has no entries.');
    assert.equal(entryHeading({ uid: 5, comment: '', key: ['wolf'] }), '## #5 wolf [wolf]', 'no title: the first key stands in');
});

test('the list of a huge book shows only the first entries and says how to find the rest; books are counted per name', () => {
    const outline = Array.from({ length: OUTLINE_SHOWN + 25 }, (_, index) => ({ number: index + 1, title: `#${index} Entry ${index}`, chars: 100 }));
    const text = describeOutline(outline);
    assert.equal(text.split('\n').length, OUTLINE_SHOWN + 1);
    assert.match(text, /and 25 more entries: find them with web\.find/);
    assert.deepEqual(countByBook([{ book: 'A' }, { book: 'B' }, { book: 'A' }]), [{ book: 'A', count: 2 }, { book: 'B', count: 1 }]);
});

function build({ books, active = Object.keys(books), generate, writes = [] }) {
    const engine = createEngine();
    const settings = new Map();
    const calls = [];
    const bus = engine.buses.cores;
    bus.register('storage.settings.get', ({ namespace, key, fallback }) => settings.get(`${namespace}/${key}`) ?? fallback);
    bus.register('storage.settings.set', ({ namespace, key, value }) => { settings.set(`${namespace}/${key}`, value); return true; });
    bus.register('model.workers.get', () => [{ id: 'w', state: 'up' }]);
    bus.register('model.workers.status', () => [{ workerId: 'w', state: 'up' }]);
    bus.register('model.workers.probe', () => [{ workerId: 'w', state: 'up' }]);
    bus.register('model.generate', params => { calls.push(params); return generate(calls.length, params); });
    bus.register('ui.anchors.list', () => []);
    bus.register('tracking.trackers', () => []);
    bus.register('macros.programs', () => []);
    bus.register('lorebook.find', () => []);
    bus.register('lorebook.scan', () => ({}));
    bus.register('lorebook.entries', () => active.flatMap(name => Object.values(books[name].entries).map(item => ({ ...item, book: name }))));
    bus.register('lorebook.books', () => active);
    bus.register('lorebook.createEntry', params => { writes.push(['entry', params.book ?? active[0], params.patch.comment]); return { uid: writes.length, book: params.book ?? active[0] }; });
    bus.register('characterCard.update', params => { writes.push(['attach', params.avatar, params.fields.world]); return { name: 'Mira', changed: ['world'] }; });
    bus.register('lorebook.createBook', ({ name }) => { if (books[name]) throw new Error(`A lorebook named “${name}” already exists.`); writes.push(['book', name]); books[name] = { entries: {} }; return { name }; });
    bus.register('lorebook.read', ({ name }) => { if (!books[name]) throw new Error(`There is no lorebook named “${name}”.`); return Object.values(books[name].entries).map(item => ({ ...item, book: name })); });
    bus.register('lorebook.names', () => Object.keys(books));
    registerStWebSearchService(engine.buses.services, { getContext: () => ({}), fetch: async () => { throw new Error('no network in this test'); } });
    const modules = { list: () => [{ id: 'm', title: 'M' }], enabled: () => [], enable: async () => {}, disable: async () => {} };
    const guide = createGuideCore(engine.registerCaller('core.guide', 'cores', { tier: 'official', networkAccess: true }), { publish: () => {}, mount: () => ({}), modules, loadText: async () => '' });
    return { guide, calls };
}

const bigBook = () => ({ entries: Object.fromEntries(Array.from({ length: 60 }, (_, index) => [index, entry(index, `Place ${index}`, [`place${index}`], `Notes about place ${index}. ${'The long history of this town. '.repeat(8)}${index === 41 ? 'The silver mill grinds only at night.' : ''}`)])) });
const action = (name, params) => '```action\n' + JSON.stringify({ action: name, params }) + '\n```';
const textOf = call => call.messages.map(message => message.content).join('\n');

test('she opens a big lorebook without loading it into the chat: the list is short, then a find by words lands on the right entry, and a read by number gives its text with the #uid to edit it by', async () => {
    const replies = [action('lorebook.open', { book: 'Town' }), action('web.find', { id: 'p1', query: 'silver mill' }), action('web.page', { id: 'p1', section: 'Place 41' }), 'Found it.<done/>'];
    const { guide, calls } = build({ books: { Town: bigBook() }, generate: count => replies[count - 1] });
    await guide.load();
    await guide.ask('What does the Town book say about the mill?');
    assert.match(textOf(calls[1]), /Book p1 — “Town” \(60 entries/, 'opened as a page');
    assert.match(textOf(calls[1]), /and 20 more entries: find them with web\.find/, 'only the first 40 are listed');
    assert.ok(!textOf(calls[1]).includes('Notes about place 55'), 'the body of the book is not in the chat');
    assert.match(textOf(calls[2]), /silver mill grinds only at night/, 'the find shows the place');
    assert.match(textOf(calls[3]), /## #41 Place 41/, 'the section by number is the entry with its uid');
    assert.equal(guide.messages.peek().at(-1).text, 'Found it.');
});

test('without a name the active books are listed (several) or the only one is opened; an unknown name lists the books that exist', async () => {
    const two = build({ books: { A: { entries: { 0: entry(0, 'One', ['one'], 'Text.') } }, B: { entries: { 0: entry(0, 'Two', ['two'], 'Text.') } } }, generate: count => (count === 1 ? action('lorebook.open', {}) : 'Which one?<done/>') });
    await two.guide.load();
    await two.guide.ask('Show my lorebooks.');
    assert.match(textOf(two.calls[1]), /Active books: “A” \(1 entries\); “B” \(1 entries\)/);
    const single = build({ books: { Only: { entries: { 0: entry(0, 'One', ['one'], 'Short text.') } } }, generate: count => (count === 1 ? action('lorebook.open', {}) : 'Read.<done/>') });
    await single.guide.load();
    await single.guide.ask('Open the lorebook.');
    assert.match(textOf(single.calls[1]), /Book p1 — “Only” \(\d+ characters, whole\)[^]*## #0 One \[one\]\nShort text\./, 'a short book comes whole');
    const unknown = build({ books: { Town: bigBook() }, generate: count => (count === 1 ? action('lorebook.open', { book: 'Nope' }) : 'Sorry.<done/>') });
    await unknown.guide.load();
    await unknown.guide.ask('Open Nope.');
    assert.match(textOf(unknown.calls[1]), /There is no lorebook named “Nope”\. Books that exist: Town\./);
});

const proposal = (name, params) => '```proposal\n' + JSON.stringify({ action: name, params }) + '\n```';

test('she makes a new lorebook, attaches it to a character and fills it with several entries at once, with no button; an entry without text is reported and the rest are written', async () => {
    const writes = [];
    const replies = [
        proposal('lorebook.createBook', { name: 'Mushoku Tensei', avatar: 'Mira.png' }),
        proposal('lorebook.addEntries', { book: 'Mushoku Tensei', entries: [{ title: 'Ranoa Academy', keys: ['academy', 'Ranoa'], content: 'The magic academy of the Ranoa Kingdom.' }, { title: 'Broken', keys: ['x'] }, { title: 'Orsted', keys: ['Orsted'], content: 'The Dragon God.' }] }),
        'The book is ready.<done/>',
    ];
    const { guide, calls } = build({ books: {}, active: [], writes, generate: count => replies[count - 1] });
    await guide.load();
    await guide.ask('Make a lorebook for the Mushoku Tensei world.');
    assert.deepEqual(writes.map(item => item.join(':')), ['book:Mushoku Tensei', 'attach:Mira.png:Mushoku Tensei', 'entry:Mushoku Tensei:Ranoa Academy', 'entry:Mushoku Tensei:Orsted']);
    assert.match(textOf(calls[2]), /2 of 3 entries written[^]*Not written: “Broken”: The entry has no text\./);
    assert.ok(!guide.messages.peek().some(message => /```proposal/.test(message.text ?? '')), 'no proposal card is left in the chat');
    assert.equal(calls.length, 3, 'each step gave her the next turn');
});

test('adding one entry to a named book goes straight in (no active book needed), and a name that is taken is refused with the reason', async () => {
    const writes = [];
    const one = build({ books: { Town: bigBook() }, active: [], writes, generate: count => (count === 1 ? proposal('lorebook.addEntry', { book: 'Town', title: 'Mill', keys: ['mill'], content: 'It grinds at night.' }) : 'Added.<done/>') });
    await one.guide.load();
    await one.guide.ask('Add the mill to Town.');
    assert.deepEqual(writes, [['entry', 'Town', 'Mill']]);
    const taken = build({ books: { Town: bigBook() }, writes: [], generate: count => (count === 1 ? proposal('lorebook.createBook', { name: 'Town' }) : 'Taken.<done/>') });
    await taken.guide.load();
    await taken.guide.ask('Make a book called Town.');
    assert.match(textOf(taken.calls[1]), /A lorebook named “Town” already exists\./);
});

test('an action that needs no confirmation (create a lorebook, add entries, a card change) runs at once even when the model sends it as an ```action block instead of a ```proposal: no button is left in the chat', async () => {
    const writes = [];
    const replies = [action('lorebook.createBook', { name: 'Mushoku Tensei', avatar: 'Mira.png' }), action('lorebook.addEntries', { book: 'Mushoku Tensei', entries: [{ title: 'Orsted', keys: ['Orsted'], content: 'The Dragon God.' }] }), 'Done.<done/>'];
    const { guide, calls } = build({ books: {}, active: [], writes, generate: count => replies[count - 1] });
    await guide.load();
    await guide.ask('Make the lorebook.');
    assert.deepEqual(writes.map(item => item.join(':')), ['book:Mushoku Tensei', 'attach:Mira.png:Mushoku Tensei', 'entry:Mushoku Tensei:Orsted']);
    assert.ok(!guide.messages.peek().some(message => /```action/.test(message.text ?? '')), 'no action block (button) is left in the chat');
    assert.equal(calls.length, 3);
});

test('when a person presses a button and the action fails, the error is shown in the chat (it is hidden only inside her own turn, where she fixes it herself)', async () => {
    const { guide } = build({ books: { Town: bigBook() }, generate: () => 'ok<done/>' });
    await guide.load();
    const result = await guide.runAction('lorebook.createBook', { name: 'Town' });
    assert.equal(result.ok, false);
    const note = guide.messages.peek().find(message => message.role === 'note' && /already exists/.test(message.text));
    assert.ok(note, 'the note exists');
    assert.notEqual(note.hidden, true, 'and it is visible');
});
