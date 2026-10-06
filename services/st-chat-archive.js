/**
 * Сервис сохранённых чатов ST — транспорт и ничего больше: список чатов персонажа и чтение одного файла чата (`/api/characters/chats`, `/api/chats/get`). Только чтение:
 * ничего не пишет и не создаёт (в отличие от sync-пути в st-user-data.js). Живой открытый чат читает `stChat.messages`; этот Сервис нужен для чатов, которые сейчас не открыты.
 * Что считать сообщением и как показать — Библиотека chat-page.js; здесь — сырые данные файла как их отдаёт ST.
 */
const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function registerStChatArchiveService(bus, { getContext, fetch: fetchImpl = globalThis.fetch?.bind(globalThis) } = {}) {
    const buildHeaders = () => getContext()?.getRequestHeaders?.() ?? {};

    async function postForJson(url, body) {
        const response = await fetchImpl(url, { method: 'POST', headers: { ...JSON_HEADERS, ...buildHeaders() }, body: JSON.stringify(body), cache: 'no-store' });
        if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
        return response.json();
    }

    // Файл карточки — имя вида `Aria.png` без путей: оно становится именем папки чатов на диске.
    function requireAvatar(avatar) {
        const name = String(avatar ?? '');
        if (!/^[^/\\]+\.png$/i.test(name) || name.includes('..')) throw new Error('stChatArchive: "avatar" is the card file name like Aria.png.');
        return name;
    }

    const stripExt = file => String(file ?? '').replace(/\.jsonl$/i, '');

    /** Чаты персонажа: `[{ file, messages, size, lastMessageAt, lastMessage }]`, по дате последнего сообщения — свежие первыми. */
    async function list({ avatar } = {}) {
        const data = await postForJson('/api/characters/chats', { avatar_url: requireAvatar(avatar) });
        if (!Array.isArray(data)) return [];
        return data.filter(info => info?.file_name).map(info => ({
            file: stripExt(info.file_name),
            messages: Number(info.chat_items) || 0,
            size: String(info.file_size ?? ''),
            lastMessageAt: String(info.last_mes ?? ''),
            lastMessage: String(info.mes ?? ''),
        })).sort((a, b) => String(b.lastMessageAt).localeCompare(String(a.lastMessageAt)));
    }

    /** Один файл чата как отдаёт ST: массив — заголовок файла и реплики. */
    async function read({ avatar, file } = {}) {
        const name = stripExt(file);
        if (!name || /[/\\]/.test(name) || name.includes('..')) throw new Error('stChatArchive: "file" is the chat file name from the list.');
        const folder = requireAvatar(avatar).replace(/\.png$/i, '');
        const data = await postForJson('/api/chats/get', { ch_name: folder, file_name: name, avatar_url: `${folder}.png` });
        if (!Array.isArray(data) || !data.length) throw new Error(`stChatArchive: there is no chat "${name}" for ${avatar}.`);
        return data;
    }

    const unregisters = [
        bus.register('stChatArchive.list', params => list(params), { loadMetric: () => 0 }),
        bus.register('stChatArchive.read', params => read(params), { loadMetric: () => 0 }),
    ];
    return () => { for (const unregister of unregisters) unregister(); };
}
