import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeBuses } from '../libraries/shared/fake-buses.js';
import { registerStUserDataService, SYNC_CATEGORIES } from '../services/st-user-data.js';
import { request } from '../libraries/shared/request.js';

/** Фейковый ST: ровно те эндпоинты и формы ответов, что проверены по коду ST 1.18. */
function createFakeSt() {
    const state = {
        characters: new Map([['Alice.png', 'ALICE-PNG'], ['Bob.png', 'BOB-PNG']]),
        chats: new Map([['Alice', new Map([['Chat one.jsonl', [{ chat_metadata: { a: 1 } }, { name: 'Alice', mes: 'hi', send_date: '2026-09-19T10:00:00.000Z' }]]])]]),
        groups: new Map([['1700', { id: '1700', name: 'Trio', chats: ['1700'], date_added: 111, create_date: 'x', date_last_chat: 5, chat_size: 9 }]]),
        groupChats: new Map([['1700', [{ chat_metadata: {} }, { name: 'Trio', mes: 'hello', send_date: '2026-09-19T11:00:00.000Z' }]]]),
        worlds: new Map([['Lore', { entries: { 0: { content: 'x' } } }]]),
        backgrounds: new Map([['room.png', 'ROOM'], ['stme-forest.png', 'OWN']]),
        personas: new Map([['me.png', 'ME']]),
        // Пресеты: «файловые» (openai/kobold/…) хранятся строкой JSON, «объектные» (instruct/context/…, темы, Quick Replies) — объектом с полем name.
        presetFiles: { openai: new Map([['Default', { temperature: 1, prompts: [{ identifier: 'main', name: 'Main Prompt', content: 'Write {{char}}\'s next reply.' }], prompt_order: [{ character_id: 100000, order: [{ identifier: 'main', enabled: true }] }] }]]), textgenerationwebui: new Map(), kobold: new Map(), novel: new Map() },
        presetObjects: { instruct: new Map([['ChatML', { name: 'ChatML', input_sequence: '<|im_start|>user' }]]), context: new Map(), sysprompt: new Map(), reasoning: new Map() },
        themes: new Map([['Midnight', { name: 'Midnight', main_text_color: 'rgba(220,220,210,1)' }]]),
        quickReplies: new Map([['Quick', { name: 'Quick', qrList: [] }]]),
        movingUI: new Map([['Layout', { name: 'Layout' }]]),
    };
    const settingsGetCalls = [];
    const calls = [];
    let context = { characters: [{ avatar: 'Alice.png' }], characterId: 0, chatId: 'other chat', groupId: null };
    const json = data => ({ ok: true, status: 200, json: async () => data, blob: async () => new Blob([JSON.stringify(data)]), headers: new Headers() });
    const stampOf = text => ({ etag: `W/"${text.length}-1"`, 'content-length': String(text.length), 'last-modified': 'Sat, 19 Sep 2026 10:00:00 GMT' });
    const staticDirs = { '/characters/': state.characters, '/backgrounds/': state.backgrounds, '/User Avatars/': state.personas };

    async function fetchFake(url, { method = 'GET', body } = {}) {
        calls.push(`${method} ${url}`);
        for (const [prefix, map] of Object.entries(staticDirs)) {
            if (!url.startsWith(prefix)) continue;
            const name = decodeURIComponent(url.slice(prefix.length));
            if (!map.has(name)) return { ok: false, status: 404 };
            const text = map.get(name);
            return { ok: true, status: 200, headers: new Headers(stampOf(text)), blob: async () => new Blob([text]) };
        }
        const data = body instanceof FormData ? Object.fromEntries(body.entries()) : (body ? JSON.parse(body) : {});
        switch (url) {
            case '/api/characters/all': return json([...state.characters.keys()].map(avatar => ({ avatar, name: avatar })));
            case '/api/characters/chats': {
                const folder = data.avatar_url.replace('.png', '');
                const dir = state.chats.get(folder);
                if (!dir) return json({ error: true });
                return json([...dir.entries()].map(([file, chat]) => ({ file_name: file, file_size: `${JSON.stringify(chat).length}b`, chat_items: chat.length - 1, last_mes: chat.at(-1).send_date })));
            }
            case '/api/chats/get': {
                const folder = data.avatar_url.replace('.png', '');
                if (!state.chats.has(folder)) { state.chats.set(folder, new Map()); return json({}); }
                return json(state.chats.get(folder).get(`${data.file_name}.jsonl`) ?? []);
            }
            case '/api/chats/save': state.chats.get(data.avatar_url.replace('.png', '')).set(`${data.file_name}.jsonl`, data.chat); assert.equal(data.force, true); return json({ ok: true });
            case '/api/chats/delete': state.chats.get(data.avatar_url.replace('.png', '')).delete(data.chatfile); return json({ ok: true });
            case '/api/groups/all': return json([...state.groups.values()]);
            case '/api/groups/edit': state.groups.set(data.id, data); return json({ ok: true });
            case '/api/groups/delete': state.groups.delete(data.id); return json({ ok: true });
            case '/api/chats/group/info': { const chat = state.groupChats.get(data.id); return json(chat ? { file_name: `${data.id}.jsonl`, file_size: '1kb', chat_items: chat.length - 1, last_mes: chat.at(-1).send_date } : {}); }
            case '/api/chats/group/get': return json(state.groupChats.get(data.id) ?? []);
            case '/api/chats/group/save': state.groupChats.set(data.id, data.chat); return json({ ok: true });
            case '/api/chats/group/delete': state.groupChats.delete(data.id); return json({ ok: true });
            case '/api/worldinfo/list': return json([...state.worlds.keys()].map(file_id => ({ file_id, name: file_id })));
            case '/api/worldinfo/get': return json(state.worlds.get(data.name) ?? { entries: {} });
            case '/api/worldinfo/edit': state.worlds.set(data.name, data.data); return json({ ok: true });
            case '/api/worldinfo/delete': state.worlds.delete(data.name); return json({});
            case '/api/backgrounds/all': return json({ images: [...state.backgrounds.keys()] });
            case '/api/backgrounds/upload': { const file = data.avatar; state.backgrounds.set(file.name, await file.text()); return json({}); }
            case '/api/backgrounds/delete': state.backgrounds.delete(data.bg); return json({});
            case '/api/avatars/get': return json([...state.personas.keys()]);
            case '/api/avatars/upload': state.personas.set(data.overwrite_name, await data.avatar.text()); return json({ path: data.overwrite_name });
            case '/api/avatars/delete': state.personas.delete(data.avatar); return json({});
            case '/api/characters/import': assert.equal(data.file_type, 'png'); state.characters.set(`${data.preserved_name}.png`, await data.avatar.text()); return json({ file_name: data.preserved_name });
            case '/api/characters/delete': state.characters.delete(data.avatar_url); return json({});
            case '/api/settings/get': {
                settingsGetCalls.push(1);
                const files = kind => [...state.presetFiles[kind].keys()];
                const contents = kind => [...state.presetFiles[kind].values()].map(preset => JSON.stringify(preset, null, 4));
                return json({
                    settings: '{}',
                    openai_setting_names: files('openai'), openai_settings: contents('openai'),
                    textgenerationwebui_preset_names: files('textgenerationwebui'), textgenerationwebui_presets: contents('textgenerationwebui'),
                    koboldai_setting_names: files('kobold'), koboldai_settings: contents('kobold'),
                    novelai_setting_names: files('novel'), novelai_settings: contents('novel'),
                    instruct: [...state.presetObjects.instruct.values()], context: [...state.presetObjects.context.values()],
                    sysprompt: [...state.presetObjects.sysprompt.values()], reasoning: [...state.presetObjects.reasoning.values()],
                    themes: [...state.themes.values()], quickReplyPresets: [...state.quickReplies.values()], movingUIPresets: [...state.movingUI.values()],
                });
            }
            case '/api/presets/save':
                if (state.presetFiles[data.apiId]) state.presetFiles[data.apiId].set(data.name, data.preset); else state.presetObjects[data.apiId].set(data.name, data.preset);
                return json({ name: data.name });
            case '/api/presets/delete': (state.presetFiles[data.apiId] ?? state.presetObjects[data.apiId]).delete(data.name); return json({});
            case '/api/themes/save': state.themes.set(data.name, data); return json({});
            case '/api/themes/delete': state.themes.delete(data.name); return json({});
            case '/api/quick-replies/save': state.quickReplies.set(data.name, data); return json({});
            case '/api/quick-replies/delete': state.quickReplies.delete(data.name); return json({});
            default: return { ok: false, status: 404 };
        }
    }
    return { state, calls, settingsGetCalls, fetch: fetchFake, setContext: value => { context = value; }, getContext: () => ({ ...context, getRequestHeaders: () => ({ 'X-CSRF-Token': 't' }), getCharacters: async () => { calls.push('getCharacters'); } }) };
}

function setup() {
    const st = createFakeSt();
    const buses = createFakeBuses();
    registerStUserDataService(buses.services, { getContext: st.getContext, fetch: st.fetch });
    const call = (contract, params) => request(buses.services, contract, { params }).then(result => { if (!result.ok) throw new Error(result.error.message); return result.value; });
    return { st, call };
}

const text = async blob => blob.text();

test('listing covers every category with stable paths and cheap stamps, and skips our own backgrounds', async () => {
    const { call } = setup();
    const listing = await call('stUserData.list', {});
    const paths = listing.map(item => item.path).sort();
    assert.deepEqual(paths, [
        'backgrounds/room.png', 'characters/Alice.png', 'characters/Bob.png', 'chats/Alice/Chat one.jsonl',
        'groupChats/1700.jsonl', 'groups/1700.json', 'personas/me.png', 'presets/instruct/ChatML.json', 'presets/openai/Default.json',
        'quickReplies/Quick.json', 'themes/Midnight.json', 'worlds/Lore.json',
    ]);
    const character = listing.find(item => item.path === 'characters/Alice.png');
    assert.match(character.stamp, /W\/"9-1"\|9\|Sat, 19 Sep 2026/);
    assert.equal(character.modified, Date.parse('Sat, 19 Sep 2026 10:00:00 GMT'));
    assert.equal(listing.find(item => item.path === 'worlds/Lore.json').stamp, null, 'small files without a stamp are always re-read');
});

test('listing can be narrowed to categories, so an unchecked category costs no requests', async () => {
    const { call, st } = setup();
    const listing = await call('stUserData.list', { categories: ['backgrounds'] });
    assert.deepEqual(listing.map(item => item.path), ['backgrounds/room.png']);
    assert.equal(st.calls.some(entry => entry.includes('/api/characters')), false);
    assert.deepEqual((await call('stUserData.categories', {})).map(item => item.id), SYNC_CATEGORIES.map(item => item.id));
});

test('a static file (character card, background, persona avatar) is read as-is and written back through ST\'s own upload', async () => {
    const { call, st } = setup();
    assert.equal(await text(await call('stUserData.read', { path: 'characters/Alice.png' })), 'ALICE-PNG');
    await call('stUserData.write', { path: 'characters/Carol.png', blob: new Blob(['CAROL-PNG']) });
    assert.equal(st.state.characters.get('Carol.png'), 'CAROL-PNG');
    await call('stUserData.write', { path: 'backgrounds/new.png', blob: new Blob(['NEW']) });
    assert.equal(st.state.backgrounds.get('new.png'), 'NEW');
    await call('stUserData.write', { path: 'personas/me.png', blob: new Blob(['ME2']) });
    assert.equal(st.state.personas.get('me.png'), 'ME2');
    const stat = await call('stUserData.write', { path: 'characters/Alice.png', blob: new Blob(['ALICE-V2']) });
    assert.match(stat.stamp, /\|8\|/, 'the stamp of the freshly written file comes back');
});

test('names with spaces and non-ASCII characters are addressed safely', async () => {
    const { call, st } = setup();
    st.state.backgrounds.set('Тёмный лес #1.png', 'DARK');
    assert.equal(await text(await call('stUserData.read', { path: 'backgrounds/Тёмный лес #1.png' })), 'DARK');
});

test('a chat is exported as JSONL exactly like ST writes it, and imports back into the right folder', async () => {
    const { call, st } = setup();
    const blob = await call('stUserData.read', { path: 'chats/Alice/Chat one.jsonl' });
    const lines = (await blob.text()).split('\n');
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[1]).mes, 'hi');

    await call('stUserData.write', { path: 'chats/Zed/New chat.jsonl', blob: new Blob([`{"chat_metadata":{}}\n{"name":"Zed","mes":"yo"}`]) });
    assert.deepEqual(st.state.chats.get('Zed').get('New chat.jsonl'), [{ chat_metadata: {} }, { name: 'Zed', mes: 'yo' }], 'the character folder is created on demand');
});

test('the chat that is open in ST is never overwritten from under it — the write is deferred', async () => {
    const { call, st } = setup();
    st.setContext({ characters: [{ avatar: 'Alice.png' }], characterId: 0, chatId: 'Chat one', groupId: null });
    await assert.rejects(
        call('stUserData.write', { path: 'chats/Alice/Chat one.jsonl', blob: new Blob(['{"chat_metadata":{}}']) }),
        error => /open right now/.test(error.message),
    );
    assert.equal(st.state.chats.get('Alice').get('Chat one.jsonl').length, 2, 'the file was left alone');
});

test('groups are synced without the fields the server computes from the file creation time', async () => {
    const { call, st } = setup();
    const blob = await call('stUserData.read', { path: 'groups/1700.json' });
    const group = JSON.parse(await blob.text());
    assert.deepEqual(Object.keys(group).sort(), ['chats', 'id', 'name']);
    await call('stUserData.write', { path: 'groups/1800.json', blob: new Blob([JSON.stringify({ id: '1800', name: 'Duo', chats: ['1800'] })]) });
    assert.equal(st.state.groups.get('1800').name, 'Duo');
});

test('group chats and lorebooks round-trip', async () => {
    const { call, st } = setup();
    const chat = await call('stUserData.read', { path: 'groupChats/1700.jsonl' });
    await call('stUserData.write', { path: 'groupChats/1900.jsonl', blob: chat });
    assert.equal(st.state.groupChats.get('1900').length, 2);
    const world = await call('stUserData.read', { path: 'worlds/Lore.json' });
    await call('stUserData.write', { path: 'worlds/Copy.json', blob: world });
    assert.deepEqual(st.state.worlds.get('Copy'), { entries: { 0: { content: 'x' } } });
});

test('removing goes through ST\'s own delete endpoints for every category', async () => {
    const { call, st } = setup();
    await call('stUserData.remove', { path: 'characters/Bob.png' });
    await call('stUserData.remove', { path: 'backgrounds/room.png' });
    await call('stUserData.remove', { path: 'worlds/Lore.json' });
    await call('stUserData.remove', { path: 'groups/1700.json' });
    await call('stUserData.remove', { path: 'chats/Alice/Chat one.jsonl' });
    assert.equal(st.state.characters.has('Bob.png'), false);
    assert.equal(st.state.backgrounds.has('room.png'), false);
    assert.equal(st.state.worlds.has('Lore'), false);
    assert.equal(st.state.groups.has('1700'), false);
    assert.equal(st.state.chats.get('Alice').size, 0);
});

test('an unknown section is refused, and refreshing asks ST to reload its character list', async () => {
    const { call, st } = setup();
    await assert.rejects(call('stUserData.read', { path: 'mystery/file' }), /no provider/);
    await call('stUserData.refresh', { categories: ['characters'] });
    assert.ok(st.calls.includes('getCharacters'));
});

test('Prompt Manager prompts travel inside the Chat Completion preset, unchanged, and other kinds of presets are listed too', async () => {
    const { call, st } = setup();
    const blob = await call('stUserData.read', { path: 'presets/openai/Default.json' });
    const preset = JSON.parse(await blob.text());
    assert.equal(preset.prompts[0].name, 'Main Prompt');
    assert.equal(preset.prompts[0].content, "Write {{char}}'s next reply.");
    assert.deepEqual(preset.prompt_order[0].order[0], { identifier: 'main', enabled: true });
    assert.equal(JSON.parse(await (await call('stUserData.read', { path: 'presets/instruct/ChatML.json' })).text()).input_sequence, '<|im_start|>user');
    assert.equal(JSON.parse(await (await call('stUserData.read', { path: 'themes/Midnight.json' })).text()).name, 'Midnight');
    void st;
});

test('presets are written through ST\'s own save endpoints into the right kind, themes and Quick Replies too, and the stamp matches what a later listing shows', async () => {
    const { call, st } = setup();
    const promptPreset = { temperature: 0.7, prompts: [{ identifier: 'jailbreak', name: 'Post-history', content: 'Stay in character.' }] };
    const stat = await call('stUserData.write', { path: 'presets/openai/My Prompts.json', blob: new Blob([JSON.stringify(promptPreset)]) });
    assert.deepEqual(st.state.presetFiles.openai.get('My Prompts'), promptPreset);
    await call('stUserData.write', { path: 'presets/sysprompt/Narrator.json', blob: new Blob([JSON.stringify({ name: 'Narrator', content: 'You narrate.' })]) });
    assert.equal(st.state.presetObjects.sysprompt.get('Narrator').content, 'You narrate.');
    await call('stUserData.write', { path: 'themes/Sunrise.json', blob: new Blob([JSON.stringify({ name: 'Sunrise', blur_strength: 3 })]) });
    await call('stUserData.write', { path: 'quickReplies/Macros.json', blob: new Blob([JSON.stringify({ name: 'Macros', qrList: [{ label: 'a' }] })]) });
    assert.equal(st.state.themes.get('Sunrise').blur_strength, 3);
    assert.equal(st.state.quickReplies.get('Macros').qrList[0].label, 'a');
    const listed = (await call('stUserData.list', { categories: ['presets'] })).find(item => item.path === 'presets/openai/My Prompts.json');
    assert.equal(listed.stamp, stat.stamp, 'the file is recognised as "as written" — no pointless re-read or bounce');
});

test('an edited preset changes its stamp, and removing goes through the right delete endpoint', async () => {
    const { call, st } = setup();
    const before = (await call('stUserData.list', { categories: ['presets'] })).find(item => item.path === 'presets/openai/Default.json').stamp;
    st.state.presetFiles.openai.set('Default', { temperature: 2, prompts: [] });
    const after = (await call('stUserData.list', { categories: ['presets'] })).find(item => item.path === 'presets/openai/Default.json').stamp;
    assert.notEqual(before, after);
    await call('stUserData.remove', { path: 'presets/openai/Default.json' });
    await call('stUserData.remove', { path: 'themes/Midnight.json' });
    await call('stUserData.remove', { path: 'quickReplies/Quick.json' });
    await call('stUserData.remove', { path: 'presets/instruct/ChatML.json' });
    assert.equal(st.state.presetFiles.openai.has('Default'), false);
    assert.equal(st.state.themes.has('Midnight'), false);
    assert.equal(st.state.quickReplies.has('Quick'), false);
    assert.equal(st.state.presetObjects.instruct.has('ChatML'), false);
});

test('one scan reads the preset catalog ONCE for all three sections, and MovingUI layouts never take part', async () => {
    const { call, st } = setup();
    const listing = await call('stUserData.list', { categories: ['presets'] });
    assert.equal(st.settingsGetCalls.length, 1, 'presets, themes and Quick Replies share one settings/get');
    assert.equal(listing.some(item => /Layout|movingUI/i.test(item.path)), false, 'window layouts differ per screen and cannot even be deleted through ST');
    await call('stUserData.read', { path: 'presets/openai/Default.json' });
    assert.equal(st.settingsGetCalls.length, 1, 'reads right after a scan reuse it');
});
