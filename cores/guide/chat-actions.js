import { createPageSearch } from './page-search.js';
import { normalizeSavedChat, renderChatPage, parseMessageSpans, locateMessage, sliceMessages, describeChatOpening, CHAT_PAGE_MAX_CHARS, SMALL_CHAT_CHARS } from '../../libraries/core/chat-page.js';

/**
 * Краулер гида по чатам (по образцу лорбука и веб-страниц): чат открывается страницей в бэкенде — каждое сообщение раздел `## #номер Имя [роль] дата`, — а в разговор идёт только
 * обзор. Дальше она читает по номерам (`chat.read`) и ищет по словам и по смыслу (`chat.find`). Открыть можно живой чат ST (он не обязан быть с известным персонажем: группа тоже)
 * и любой сохранённый чат персонажа (`chat.list`, затем `chat.open` с файлом). Все четыре действия безопасные и только читают: ничего в чатах не меняют; после результата она получает ещё один ход.
 */
const ALIASES = Object.freeze({ id: ['id', 'page_id', 'pageId', 'page'], query: ['query', 'q', 'search', 'text', 'keywords'], file: ['file', 'chat', 'chat_file', 'filename'], name: ['name', 'character'] });
const flatten = params => ({ ...(params ?? {}), ...(params?.arguments && typeof params.arguments === 'object' ? params.arguments : {}), ...(params?.parameters && typeof params.parameters === 'object' ? params.parameters : {}) });
const pick = (params, key) => { for (const alias of ALIASES[key]) if (params[alias] !== undefined && params[alias] !== null && String(params[alias]).trim() !== '') return params[alias]; return undefined; };
const stripExt = file => String(file ?? '').replace(/\.jsonl$/i, '');
const sameName = (first, second) => String(first ?? '').trim().toLowerCase() === String(second ?? '').trim().toLowerCase();

export function createChatActions({ call, callService }) {
    const failure = message => ({ ok: false, message });
    const pageSearch = createPageSearch({ callService });

    /** Персонаж, о чьих чатах речь: названный (по файлу карточки или имени) или открытый сейчас. */
    async function resolveCharacter(params) {
        const named = params.avatar ?? pick(params, 'name');
        const open = await callService('stCharacter.current');
        const current = open.ok ? open.value : null;
        if (!named) return current?.avatar ? { avatar: current.avatar, name: current.name ?? current.avatar, isOpen: true } : { error: 'No character is open. Name one: {"name": "Aria"} or its avatar file.' };
        const listed = await call('characterCard.list');
        const entries = listed.ok ? listed.value ?? [] : [];
        const wanted = String(named);
        const matches = entries.filter(entry => entry.avatar === wanted || sameName(entry.name, wanted) || sameName(String(entry.avatar).replace(/\.png$/i, ''), wanted));
        if (matches.length > 1) return { error: `Several characters are called “${wanted}” — use the avatar file: ${matches.map(entry => entry.avatar).join(', ')}.` };
        if (!matches.length) return { error: `There is no character “${wanted}”.` };
        return { avatar: matches[0].avatar, name: matches[0].name, isOpen: matches[0].avatar === current?.avatar };
    }

    async function openChatId() {
        const info = await callService('stPromptData.read');
        return info.ok ? { chatId: String(info.value?.chatId ?? ''), char: String(info.value?.char ?? '') } : { chatId: '', char: '' };
    }

    /** Страница открыта в бэкенде: ответ гиду — обзор (короткий чат — целиком). */
    async function openAsPage({ url, title, messages, live }) {
        const text = renderChatPage({ title, messages });
        const opened = await callService('stWebSearch.openText', { url, text, maxChars: CHAT_PAGE_MAX_CHARS });
        if (!opened.ok) return failure(`The chat did not open: ${opened.error.message}`);
        const page = opened.value;
        if (page.chars <= SMALL_CHAT_CHARS) {
            const whole = await callService('stWebSearch.view', { id: page.id, offset: 0, chars: SMALL_CHAT_CHARS });
            if (whole.ok) return { ok: true, message: `Opened the chat “${title}” (${messages.length} message${messages.length === 1 ? '' : 's'}, short).`, detail: `Chat ${page.id} — “${title}” (${page.chars} characters, whole):\n${whole.value.text}` };
        }
        return { ok: true, message: `Opened the chat “${title}”: ${messages.length} messages, ${page.chars} characters.`, detail: describeChatOpening({ id: page.id, title, messages, chars: page.chars, live }) };
    }

    async function chatSpans(id) {
        const body = await callService('stWebSearch.text', { id });
        if (!body.ok) return { error: body.error.message };
        const spans = parseMessageSpans(body.value.text);
        if (!spans.length) return { error: `Page ${id} is not a chat. Open a chat with chat.open first.` };
        return { text: body.value.text, spans, url: body.value.url };
    }

    return {
        'chat.list': {
            safe: true,
            thenContinue: true,
            description: 'List the saved chats of a character (file name, message count, date of the last message, the last line; the one open now is marked). Params: {"name": "Aria"} or {"avatar": "Aria.png"}; without them, the character open in SillyTavern. Then open one with chat.open {"file": "<file>"}. Only reads.',
            async run(raw = {}) {
                const params = flatten(raw);
                const who = await resolveCharacter(params);
                if (who.error) return failure(who.error);
                const listed = await callService('stChatArchive.list', { avatar: who.avatar });
                if (!listed.ok) return failure(`The chats could not be listed: ${listed.error.message}`);
                const chats = listed.value;
                if (!chats.length) return { ok: true, message: `${who.name} has no saved chats.`, detail: `${who.name} (${who.avatar}) has no saved chats.` };
                const { chatId } = who.isOpen ? await openChatId() : { chatId: '' };
                const lines = chats.slice(0, 40).map((chat, index) => `${index + 1}. ${chat.file} — ${chat.messages} messages, last ${chat.lastMessageAt || 'unknown'}, ${chat.size}${chat.file === chatId ? ' [OPEN NOW]' : ''}${chat.lastMessage ? `\n   last line: ${chat.lastMessage.replace(/\s+/g, ' ').slice(0, 140)}` : ''}`);
                return { ok: true, message: `${who.name} has ${chats.length} saved chat${chats.length === 1 ? '' : 's'}.`, detail: `Chats of ${who.name} (${who.avatar}), newest first:\n${lines.join('\n')}${chats.length > 40 ? `\n…and ${chats.length - 40} more` : ''}` };
            },
        },
        'chat.open': {
            safe: true,
            thenContinue: true,
            description: 'Open a chat in the engine memory WITHOUT pulling it into the conversation (chats can be thousands of messages). Params: none = the chat open in SillyTavern right now (a group chat too); or {"name": "Aria", "file": "<chat file from chat.list>"} (or "avatar") for a saved chat of a character. You get the page id, message count, who speaks, the first and last lines. Then read with chat.read and search with chat.find. A short chat comes whole. Only reads; message numbers (#N) are the same as in SillyTavern.',
            async run(raw = {}) {
                const params = flatten(raw);
                const file = stripExt(pick(params, 'file'));
                const named = params.avatar ?? pick(params, 'name');
                if (!file && !named) {
                    const messages = await call('chatHistory.messages', { limit: 1000000, includeSystem: true });
                    if (!messages.ok) return failure(messages.error.message);
                    if (!(messages.value ?? []).length) return failure('No chat is open in SillyTavern (or it has no messages yet). Name a saved chat instead: chat.list, then chat.open with a file.');
                    const { chatId, char } = await openChatId();
                    return openAsPage({ url: 'chat:live', title: [char, chatId].filter(Boolean).join(' — ') || 'open chat', messages: messages.value, live: true });
                }
                const who = await resolveCharacter(params);
                if (who.error) return failure(who.error);
                if (!file) return failure(`Which chat of ${who.name}? List them with chat.list and open one with {"file": "<file>"}; without a file only the chat open right now can be opened.`);
                const saved = await callService('stChatArchive.read', { avatar: who.avatar, file });
                if (!saved.ok) return failure(`The chat could not be read: ${saved.error.message}`);
                const messages = normalizeSavedChat(saved.value);
                if (!messages.length) return failure(`The chat “${file}” has no messages.`);
                return openAsPage({ url: `chat:${who.avatar}/${file}`, title: `${who.name} — ${file}`, messages, live: false });
            },
        },
        'chat.read': {
            safe: true,
            thenContinue: true,
            description: 'Read messages of a chat opened with chat.open. Params: {"id": "p5", "last": 10} for the latest ones, or {"id": "p5", "from": 40, "to": 55} by message number (#N), optionally "chars" (default 4000, up to 8000). Messages come whole, in order; the result says from which number to continue. Hidden messages are marked [hidden] (SillyTavern does not send them to the model).',
            async run(raw = {}) {
                const params = flatten(raw);
                const id = pick(params, 'id');
                if (!id) return failure('That action did not get what it needs. Send it as {"id": "p5", "last": 10} or {"id": "p5", "from": 40, "to": 55}.');
                const found = await chatSpans(id);
                if (found.error) return failure(found.error);
                const hasRange = ['from', 'to', 'last'].some(key => params[key] !== undefined && params[key] !== null && params[key] !== '');
                const piece = sliceMessages(found.text, found.spans, hasRange ? { from: params.from, to: params.to, last: params.last, chars: params.chars } : { last: 10, chars: params.chars });
                if (!piece.count) return failure(`There are no messages in that range. The chat has ${found.spans.length} messages, #${found.spans[0].mesid} to #${found.spans.at(-1).mesid}.`);
                const tail = piece.cutOffset !== null
                    ? `The last message is cut: read the rest with web.page {"id": "${id}", "offset": ${piece.cutOffset}}.${piece.next !== null ? ` The next message is #${piece.next}.` : ''}`
                    : piece.next !== null ? `More: continue from message #${piece.next}.` : piece.to === found.spans.at(-1).mesid ? 'This is the end of the chat.' : 'End of the range.';
                return { ok: true, message: `Read messages #${piece.from}–#${piece.to} of chat ${id} (${piece.count}).`, detail: `Chat ${id}, messages #${piece.from}–#${piece.to} (of ${piece.total}):\n\n${piece.text}\n\n[${tail}]` };
            },
        },
        'chat.find': {
            safe: true,
            thenContinue: true,
            description: 'Look for something in a chat opened with chat.open — by the words AND by the meaning ("when did she lie to me" finds the message even without the word "lie"). Params: {"id": "p5", "query": "the promise at the bridge"}. Returns the best messages with a bit of text around the place: message number, who wrote it. Read the surroundings with chat.read {"from", "to"}. The first meaning search in a long chat takes a few seconds and finishes over the next searches.',
            async run(raw = {}) {
                const params = flatten(raw);
                const id = pick(params, 'id');
                const query = pick(params, 'query');
                if (!id || !query) return failure('That action did not get what it needs. Send it as {"id": "p5", "query": "the promise at the bridge"}.');
                const found = await chatSpans(id);
                if (found.error) return failure(found.error);
                const searched = await pageSearch.search({ id, query });
                if (!searched.ok) return failure(searched.error.message);
                const { matches, meaning } = searched.value;
                const note = meaning === 'unavailable' ? ' (by words only: the meaning search is not available right now)' : meaning === 'partial' ? ' (the meaning search covers part of the chat so far; ask again to extend it)' : '';
                if (!matches.length) return { ok: true, message: `Looked for “${query}” in chat ${id}: nothing.`, detail: `Nothing in chat ${id} for “${query}”${note}. Try other words, or read the range you expect with chat.read.` };
                const lines = matches.map((match, index) => {
                    const span = locateMessage(found.spans, match.offset);
                    return `${index + 1}. ${span ? `#${span.mesid} ${span.name} [${span.role}]` : 'the header of the chat'}${match.via ? ` [${match.via}]` : ''}: …${match.snippet}…`;
                });
                return { ok: true, message: `Looked for “${query}” in chat ${id}: ${matches.length} place${matches.length === 1 ? '' : 's'}.`, detail: `Places in chat ${id} for “${query}”${note}:\n${lines.join('\n')}` };
            },
        },
    };
}
