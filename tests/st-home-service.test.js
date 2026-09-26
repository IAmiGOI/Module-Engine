import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerStHomeService, readRecentChat, homeChatKey } from '../services/st-home.js';

/** Фейковый родной `.recentChat`: атрибуты и дочерние узлы по селекторам. */
function fakeChat({ avatar = 'a.png', group = '', file = 'c1', character = 'Seraphina', message = 'Hi there', pinned = false, clicks = [] } = {}) {
    const node = (textContent, extra = {}) => ({ textContent, getAttribute: name => extra[name] ?? null, click: () => clicks.push(textContent || extra.tag), ...extra });
    const children = {
        '.characterName': node(character), '.chatDate': node('26.9.2026', { title: 'September 26' }), '.chatMessage': node(`  ${message}\n `),
        '.counterBlock small': node('23'), '.fileSize': node('20KB'), '.avatar img': node('', { src: '/thumb/a.png' }),
        '.pinChat.active': pinned ? node('pin') : null, '.recentChatPinned': null,
        '.pinChat': { click: () => clicks.push('pin') }, '.renameChat': { click: () => clicks.push('rename') }, '.deleteChat': { click: () => clicks.push('delete') },
    };
    const attrs = { 'data-avatar': avatar, 'data-group': group, 'data-file': file };
    return { getAttribute: name => attrs[name] ?? null, querySelector: selector => children[selector] ?? null, click: () => clicks.push('open') };
}

function setup({ welcome = true, chats = [], buttons = {}, context = null, script = null } = {}) {
    const engine = createEngine();
    const panel = welcome ? {} : null;
    const doc = {
        querySelector: selector => (selector === '#chat .welcomePanel' ? panel : buttons[selector] ?? null),
        querySelectorAll: selector => (selector === '#chat .welcomePanel .recentChat' ? chats : []),
        getElementById: id => (id === 'chat' ? { id } : null),
    };
    registerStHomeService(engine.buses.services, { document: doc, getContext: () => context, importScript: async () => script });
    const caller = engine.registerCaller('module.probe', 'modules', { tier: 'community', allowedContracts: ['stHome.state', 'stHome.chatAction', 'stHome.quick', 'stHome.container', 'stHome.characters', 'stHome.openCharacter', 'stHome.importCharacter', 'stHome.deleteCharacter'] });
    return { caller };
}
const call = (caller, contract, params) => new Promise(resolve => caller.services.subscribe(contract, { params }, resolve));

test('a native recent chat is read into a neutral shape (text cleaned, key stable, pinned detected)', () => {
    const chat = readRecentChat(fakeChat({ pinned: true }));
    assert.equal(chat.key, 'a.png|c1');
    assert.deepEqual([chat.character, chat.message, chat.count, chat.size, chat.thumbnail, chat.pinned, chat.isGroup], ['Seraphina', 'Hi there', '23', '20KB', '/thumb/a.png', true, false]);
    assert.equal(readRecentChat(fakeChat({ avatar: '', group: 'g1' })).isGroup, true);
    assert.equal(homeChatKey({ group: 'g1', file: 'x' }), 'g1|x');
});

test('stHome.state says whether the native welcome screen is open and lists its chats; no welcome screen → nothing', async () => {
    const { caller } = setup({ chats: [fakeChat(), fakeChat({ file: 'c2' })] });
    const result = await call(caller, 'stHome.state');
    assert.equal(result.value.welcome, true);
    assert.deepEqual(result.value.chats.map(chat => chat.key), ['a.png|c1', 'a.png|c2']);
    const closed = await call(setup({ welcome: false, chats: [fakeChat()] }).caller, 'stHome.state');
    assert.deepEqual(closed.value, { welcome: false, chats: [] });
});

test('chat actions press the NATIVE elements of the chat with that key (open = the card itself); an unknown key does nothing', async () => {
    const clicks = [];
    const { caller } = setup({ chats: [fakeChat({ clicks }), fakeChat({ file: 'c2', clicks })] });
    for (const action of ['open', 'pin', 'rename', 'delete']) assert.equal((await call(caller, 'stHome.chatAction', { key: 'a.png|c2', action })).value, true);
    assert.deepEqual(clicks, ['open', 'pin', 'rename', 'delete']);
    assert.equal((await call(caller, 'stHome.chatAction', { key: 'nope|x', action: 'open' })).value, false);
    assert.equal((await call(caller, 'stHome.chatAction', { key: 'a.png|c1', action: 'explode' })).value, false);
});

test('quick actions press the native button when it exists, and report false when it does not', async () => {
    const clicks = [];
    const { caller } = setup({ buttons: { '#rightNavDrawerIcon': { click: () => clicks.push('characters') } } });
    assert.equal((await call(caller, 'stHome.quick', { native: 'characters' })).value, true);
    assert.equal((await call(caller, 'stHome.quick', { native: 'api' })).value, false, 'no such button right now');
    assert.equal((await call(caller, 'stHome.quick', { native: 'unknown' })).value, false);
    assert.deepEqual(clicks, ['characters']);
    assert.deepEqual((await call(caller, 'stHome.container')).value, { id: 'chat' });
});

test('stHome.characters lists the ST characters (name-sorted, with a small thumbnail and the full-resolution image); a context without characters gives an empty list', async () => {
    const context = { characters: [{ avatar: 'b.png', name: 'Bob' }, { avatar: 'a.png', name: 'Alice' }, { name: 'no avatar' }], getThumbnailUrl: (type, file) => `/thumb/${type}/${file}` };
    const result = await call(setup({ context }).caller, 'stHome.characters');
    assert.deepEqual(result.value, [
        { avatar: 'a.png', name: 'Alice', thumbnail: '/thumb/avatar/a.png', image: '/characters/a.png' },
        { avatar: 'b.png', name: 'Bob', thumbnail: '/thumb/avatar/b.png', image: '/characters/b.png' },
    ], 'the card gets the ORIGINAL file (image), the list gets the small server thumbnail');
    assert.deepEqual((await call(setup().caller, 'stHome.characters')).value, []);
});

test('stHome.openCharacter selects the character by avatar through ST (its last chat opens), without opening the character panel; an unknown avatar does nothing', async () => {
    const selected = [];
    const context = { characters: [{ avatar: 'a.png', name: 'Alice' }, { avatar: 'b.png', name: 'Bob' }], selectCharacterById: async (id, options) => { selected.push([id, options]); } };
    const { caller } = setup({ context });
    assert.equal((await call(caller, 'stHome.openCharacter', { avatar: 'b.png' })).value, true);
    assert.deepEqual(selected, [[1, { switchMenu: false }]]);
    assert.equal((await call(caller, 'stHome.openCharacter', { avatar: 'ghost.png' })).value, false);
    assert.equal(selected.length, 1);
});

test('stHome.importCharacter presses the NATIVE import button of ST (its file dialog and import logic do the work); no button — false', async () => {
    const clicks = [];
    const { caller } = setup({ buttons: { '#character_import_button': { click: () => clicks.push('import') } } });
    assert.equal((await call(caller, 'stHome.importCharacter')).value, true);
    assert.deepEqual(clicks, ['import']);
    assert.equal((await call(setup().caller, 'stHome.importCharacter')).value, false);
});

test('stHome.deleteCharacter calls the own deleteCharacter of ST for a known avatar (chats deleted by default); unknown avatar, missing function or a refusal → false', async () => {
    const calls = [];
    const context = { characters: [{ avatar: 'a.png', name: 'Alice' }] };
    const script = { deleteCharacter: async (avatar, options) => { calls.push([avatar, options]); return true; } };
    const { caller } = setup({ context, script });
    assert.equal((await call(caller, 'stHome.deleteCharacter', { avatar: 'a.png' })).value, true);
    assert.deepEqual(calls, [['a.png', { deleteChats: true }]]);
    assert.equal((await call(caller, 'stHome.deleteCharacter', { avatar: 'a.png', deleteChats: false })).value, true);
    assert.deepEqual(calls.at(-1), ['a.png', { deleteChats: false }]);
    assert.equal((await call(caller, 'stHome.deleteCharacter', { avatar: 'ghost.png' })).value, false);
    assert.equal(calls.length, 2, 'an unknown avatar never reaches ST');
    assert.equal((await call(setup({ context, script: {} }).caller, 'stHome.deleteCharacter', { avatar: 'a.png' })).value, false);
    assert.equal((await call(setup({ context, script: { deleteCharacter: async () => false } }).caller, 'stHome.deleteCharacter', { avatar: 'a.png' })).value, false);
});
