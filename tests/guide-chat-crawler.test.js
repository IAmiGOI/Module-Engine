import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createEngine } from '../libraries/shared/engine.js';
import { createGuideCore } from '../cores/guide/index.js';
import { registerStWebSearchService } from '../services/st-web-search.js';
import { registerStChatArchiveService } from '../services/st-chat-archive.js';
import { normalizeSavedChat, messageHeading, renderChatPage, parseMessageSpans, locateMessage, sliceMessages, describeChatOpening, CHAT_READ_MAX_CHARS } from '../libraries/core/chat-page.js';
import { chunkPage, MAX_CHUNKS, CHAT_MAX_CHUNKS } from '../libraries/core/web-semantic.js';
import { computeOutline } from '../libraries/core/web-pages.js';

const readArticle = path => fs.readFileSync(new URL(`../guide/${path}`, import.meta.url), 'utf8');
const message = (mesid, name, text, extra = {}) => ({ mesid: String(mesid), isUser: false, isSystem: false, name, text, sendDate: null, ...extra });
const longChat = () => Array.from({ length: 120 }, (_, index) => (index % 2
    ? message(index, 'Sanya', index === 41 ? 'I swear I will bring the silver key back before the full moon.' : `I look around the hall, turn ${index}.`, { isUser: true, sendDate: 'October 3, 2026 11:05pm' })
    : message(index, 'Aria', index === 44 ? 'She nods slowly. "Then the key stays yours until the moon rises."' : `Aria answers about the hall, turn ${index}. ${'The torches burn low. '.repeat(6)}`, { sendDate: 'October 3, 2026 11:06pm' })));

test('a saved chat file loses its header line and keeps ST message numbers; a line that looks like a heading cannot split a message', () => {
    const raw = [{ user_name: 'Sanya', character_name: 'Aria', chat_metadata: {} }, { name: 'Aria', is_user: false, mes: 'Hello.', send_date: 'now' }, { name: 'Sanya', is_user: true, mes: '## not a heading\nHi.' }, { name: 'System', is_system: true, mes: 'folded' }];
    const messages = normalizeSavedChat(raw);
    assert.deepEqual(messages.map(item => [item.mesid, item.name, item.isUser, item.isSystem]), [['0', 'Aria', false, false], ['1', 'Sanya', true, false], ['2', 'System', false, true]]);
    const page = renderChatPage({ title: 'Aria — chat', messages });
    const spans = parseMessageSpans(page);
    assert.equal(spans.length, 3, 'three messages, the escaped "## " did not make a fourth');
    assert.equal(computeOutline(page).length, 4, 'the page sections are the header and the three messages');
    assert.match(page, /## #2 System \[hidden\]/);
    assert.equal(messageHeading(message(7, 'Aria', 'x', { sendDate: 'October 3, 2026 11:05pm' })), '## #7 Aria [char] October 3, 2026 11:05pm');
    assert.equal(renderChatPage({ title: 'E', messages: [] }), 'Chat “E” has no messages.');
});

test('messages are cut out by number or as the last N, whole, within the size limit, with the number to continue from', () => {
    const page = renderChatPage({ title: 'T', messages: longChat() });
    const spans = parseMessageSpans(page);
    const range = sliceMessages(page, spans, { from: 40, to: 42, chars: 2000 });
    assert.deepEqual([range.from, range.to, range.count, range.next], [40, 42, 3, null]);
    assert.match(range.text, /## #41 Sanya \[user\].*\nI swear I will bring the silver key/s);
    const latest = sliceMessages(page, spans, { last: 3 });
    assert.deepEqual([latest.from, latest.to], [117, 119]);
    const limited = sliceMessages(page, spans, { from: 0, to: 119, chars: 600 });
    assert.ok(limited.count < 120 && limited.next === limited.to + 1, 'stops at a message boundary and says where to continue');
    assert.ok(limited.text.length <= 600 + 200);
    assert.equal(sliceMessages(page, spans, { from: 500, to: 600 }).count, 0);
    assert.equal(locateMessage(spans, page.indexOf('silver key')).mesid, 41);
    assert.equal(locateMessage(spans, 3), null, 'the header of the page belongs to no message');
    const huge = renderChatPage({ title: 'H', messages: [message(0, 'Aria', 'x'.repeat(20000)), message(1, 'Sanya', 'short', { isUser: true })] });
    const cutUp = sliceMessages(huge, parseMessageSpans(huge), { from: 0, chars: 99999 });
    assert.equal(cutUp.count, 1);
    assert.ok(cutUp.cutOffset > 0 && cutUp.next === 1, 'a message longer than the limit is cut and the rest is read by offset');
    assert.ok(cutUp.text.length < CHAT_READ_MAX_CHARS + 120);
});

test('the overview of an open chat names its size, speakers and range, the first and the last line, and how to read on', () => {
    const messages = longChat();
    const text = describeChatOpening({ id: 'p3', title: 'Aria — chat', messages, chars: 99000, live: true });
    assert.match(text, /^Chat p3 — “Aria — chat” \(the chat open in SillyTavern right now\): 120 messages \(#0–#119\), 99000 characters\. Speakers: Aria, Sanya\./);
    assert.match(text, /First: #0 Aria: /);
    assert.match(text, /Last: #119 Sanya: /);
    assert.match(text, /chat\.read \{"id": "p3", "last": 10\}.*chat\.find \{"id": "p3"/s);
});

test('a chat page may be indexed by meaning far deeper than a web page', () => {
    const page = renderChatPage({ title: 'T', messages: longChat() });
    const outline = computeOutline(page);
    assert.equal(chunkPage(page, outline, { maxChunks: 10 }).length, 10);
    assert.ok(chunkPage(page, outline, { maxChunks: CHAT_MAX_CHUNKS }).length > 100);
    assert.equal(chunkPage('x\n'.repeat(5000), []).length <= MAX_CHUNKS, true, 'a web page keeps its old cap');
});

test('the archive service lists the chats of a card (newest first) and reads one file, and refuses names that point outside', async () => {
    const calls = [];
    const engine = createEngine();
    const fetch = async (url, init) => {
        calls.push([url, JSON.parse(init.body)]);
        if (url === '/api/characters/chats') return { ok: true, json: async () => [{ file_name: 'old.jsonl', chat_items: 3, file_size: '1kb', last_mes: '2026-09-01', mes: 'bye' }, { file_name: 'new.jsonl', chat_items: 9, file_size: '2kb', last_mes: '2026-10-02', mes: 'hello' }] };
        return { ok: true, json: async () => [{ chat_metadata: {} }, { name: 'Aria', mes: 'Hi.' }] };
    };
    registerStChatArchiveService(engine.buses.services, { getContext: () => ({ getRequestHeaders: () => ({ 'X-CSRF-Token': 't' }) }), fetch });
    const ask = (contract, params) => engine.buses.services.request ? engine.buses.services.request(contract, params) : null;
    const { request } = await import('../libraries/shared/request.js');
    const listed = await request(engine.buses.services, 'stChatArchive.list', { params: { avatar: 'Aria.png' } });
    assert.deepEqual(listed.value.map(chat => [chat.file, chat.messages]), [['new', 9], ['old', 3]]);
    assert.deepEqual(calls[0], ['/api/characters/chats', { avatar_url: 'Aria.png' }]);
    const read = await request(engine.buses.services, 'stChatArchive.read', { params: { avatar: 'Aria.png', file: 'new.jsonl' } });
    assert.equal(read.value.length, 2);
    assert.deepEqual(calls[1], ['/api/chats/get', { ch_name: 'Aria', file_name: 'new', avatar_url: 'Aria.png' }]);
    for (const params of [{ avatar: '../x.png', file: 'a' }, { avatar: 'Aria', file: 'a' }, { avatar: 'Aria.png', file: '../secret' }, { avatar: 'Aria.png', file: '' }]) {
        const refused = await request(engine.buses.services, params.file === undefined || 'file' in params && /\.\./.test(params.file) || params.file === '' ? 'stChatArchive.read' : 'stChatArchive.list', { params });
        assert.equal(refused.ok, false, JSON.stringify(params));
    }
    assert.ok(ask);
});

function build({ generate, openMessages = longChat(), saved = {}, openAvatar = 'Aria.png' } = {}) {
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
    for (const name of ['ui.anchors.list', 'tracking.trackers', 'macros.programs', 'lorebook.find', 'promptManager.presets']) bus.register(name, () => []);
    bus.register('characterCard.list', () => [{ avatar: 'Aria.png', name: 'Aria', tags: [] }, { avatar: 'Bram.png', name: 'Bram', tags: [] }]);
    bus.register('chatHistory.messages', () => openMessages);
    const services = engine.buses.services;
    registerStWebSearchService(services, { getContext: () => ({}), fetch: async () => { throw new Error('no network in this test'); } });
    services.register('stCharacter.current', () => (openAvatar ? { avatar: openAvatar, name: 'Aria' } : null));
    services.register('stPromptData.read', () => ({ char: 'Aria', chatId: 'Aria - 2026-10-03', user: 'Sanya' }));
    services.register('stChatArchive.list', ({ avatar }) => (saved[avatar] ?? []).map(chat => ({ file: chat.file, messages: chat.raw.length - 1, size: '9kb', lastMessageAt: chat.last, lastMessage: 'bye' })));
    services.register('stChatArchive.read', ({ avatar, file }) => { const chat = (saved[avatar] ?? []).find(item => item.file === file); if (!chat) throw new Error(`there is no chat "${file}"`); return chat.raw; });
    const modules = { list: () => [], enabled: () => [], enable: async () => {}, disable: async () => {} };
    const guide = createGuideCore(engine.registerCaller('core.guide', 'cores', { tier: 'official', networkAccess: true }), { publish: () => {}, mount: () => ({}), modules, loadText: async () => '' });
    return { guide, calls };
}

const action = (name, params) => '```action\n' + JSON.stringify({ action: name, params }) + '\n```';
// Рамка результата экранирует `#` обратной косой, чтобы заголовки не стали разметкой чата гида: в проверках берём текст без неё.
const textOf = call => call.messages.map(item => item.content).join('\n').replace(/\\#/g, '#');

test('she opens the chat that is open now without loading it into the conversation, finds a promise by words, and reads around it by number', async () => {
    const replies = [action('chat.open', {}), action('chat.find', { id: 'p1', query: 'silver key moon' }), action('chat.read', { id: 'p1', from: 40, to: 45 }), 'It was #41.<done/>'];
    const { guide, calls } = build({ generate: count => replies[count - 1] });
    await guide.load();
    await guide.ask('Where did I promise to bring back the key?');
    assert.match(textOf(calls.find(call => Array.isArray(call.messages) && /Chat p1 — “Aria — Aria - 2026-10-03” \(the chat open in SillyTavern right now\): 120 messages/.test(textOf(call)))), /Speakers: Aria, Sanya/);
    const afterFind = calls.find(call => Array.isArray(call.messages) && /Places in chat p1 for “silver key moon”/.test(textOf(call)));
    assert.match(textOf(afterFind), /#41 Sanya \[user\].*silver key/s);
    assert.ok(!textOf(afterFind).includes('turn 99'), 'the body of the chat is not in the conversation');
    const afterRead = calls.find(call => Array.isArray(call.messages) && /Chat p1, messages #40–#45 \(of 120\)/.test(textOf(call)));
    assert.match(textOf(afterRead), /## #44 Aria \[char\].*the key stays yours until the moon rises/s);
    assert.match(textOf(afterRead), /\[End of the range\.\]/);
    assert.equal(guide.messages.peek().at(-1).text, 'It was #41.');
});

test('a saved chat of a named character is listed and opened by file; without a file only the open chat can be opened', async () => {
    const raw = [{ chat_metadata: {} }, { name: 'Bram', is_user: false, mes: 'The old road is closed.', send_date: 'd1' }, { name: 'Sanya', is_user: true, mes: 'Then we go by the river.' }];
    const { guide, calls } = build({ saved: { 'Bram.png': [{ file: 'Bram - 2026-09-30', raw, last: '2026-09-30' }] }, generate: count => [action('chat.list', { name: 'Bram' }), action('chat.open', { name: 'Bram', file: 'Bram - 2026-09-30' }), action('chat.open', { name: 'Bram' }), 'Done.<done/>'][count - 1] });
    await guide.load();
    await guide.ask('Show me my old chat with Bram');
    const listing = calls.find(call => Array.isArray(call.messages) && /Chats of Bram \(Bram\.png\), newest first:/.test(textOf(call)));
    assert.match(textOf(listing), /1\. Bram - 2026-09-30 — 2 messages, last 2026-09-30, 9kb/);
    const opened = calls.find(call => Array.isArray(call.messages) && /Chat p1 — “Bram — Bram - 2026-09-30” \(.*whole\)/s.test(textOf(call)));
    assert.match(textOf(opened), /## #0 Bram \[char\] d1\nThe old road is closed\./);
    assert.match(textOf(opened), /## #1 Sanya \[user\]\nThen we go by the river\./);
    const refused = calls.find(call => Array.isArray(call.messages) && /Which chat of Bram\?/.test(textOf(call)));
    assert.ok(refused, 'a character without a file is refused with the way forward');
});

test('reading an unknown page, an empty range and a page that is not a chat all say what to do instead of failing silently', async () => {
    const { guide } = build({ generate: () => 'ok<done/>' });
    await guide.load();
    const result = await guide.runAction('chat.read', { id: 'p9', last: 3 });
    assert.equal(result.ok, false);
    assert.match(result.message, /There is no open page “p9”/);
    await guide.runAction('chat.open', {});
    const empty = await guide.runAction('chat.read', { id: 'p1', from: 500, to: 600 });
    assert.equal(empty.ok, false);
    assert.match(empty.message, /The chat has 120 messages, #0 to #119/);
    const web = await guide.runAction('web.read', { url: 'file://x' });
    assert.equal(web.ok, false);
    assert.equal((await guide.runAction('chat.find', { id: 'p1' })).ok, false, 'a query is needed');
    const nothing = await guide.runAction('chat.find', { id: 'p1', query: 'unicorn' });
    assert.equal(nothing.ok, true);
    assert.match(nothing.detail, /Nothing in chat p1 for “unicorn”/);
});

test('no open chat is said plainly; the four chat actions are automatic and carried by the article', async () => {
    const { guide } = build({ openMessages: [], openAvatar: null, generate: () => 'ok<done/>' });
    await guide.load();
    const none = await guide.runAction('chat.open', {});
    assert.equal(none.ok, false);
    assert.match(none.message, /No chat is open in SillyTavern/);
    assert.equal((await guide.runAction('chat.list', {})).ok, false, 'no character is open and none is named');
    const article = readArticle('knowledge/chat-crawler.md');
    for (const name of ['chat.list', 'chat.open', 'chat.read', 'chat.find']) assert.ok(article.includes(`\`${name}\``), name);
    assert.ok(JSON.parse(readArticle('knowledge/index.json')).articles.includes('chat-crawler.md'));
    assert.match(readArticle('knowledge/character-testing.md'), /`chat\.open`, then `chat\.find`/);
});
