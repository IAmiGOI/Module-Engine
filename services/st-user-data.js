/**
 * Сервис пользовательских данных ST — единственное место, знающее эндпоинты SillyTavern, за которыми лежит то, что синхронизируется
 * между устройствами: персонажи, чаты, группы, миры, фоны, аватарки персон. Логический адаптер: перечислить, прочитать, записать,
 * удалить — что и когда синхронизировать, решает Ядро синхронизации.
 *
 * Все файлы описываются ПУТЯМИ вида `<раздел>/<имя>` (`chats/Alice/2026-09-19 @14h.jsonl`) — на проводе и в базе нет ничего
 * специфичного для ST. Для каждого файла есть дешёвый «штамп» изменений (ETag/размер/время из заголовков или из листинга): пока
 * он не изменился, файл не перечитывается. Штамп `null` — «штампа нет, читать всегда» (миры, группы: они мелкие).
 *
 * Ограничения ST, которые здесь обходятся (проверены по коду ST 1.18):
 *  - у чатов/групп/миров нет «отдать файл как есть», только разобранный JSON; поэтому JSONL собирается заново `JSON.stringify` по
 *    строке — ровно так ST и пишет файл сам, содержимое совпадает;
 *  - вычисляемые сервером поля групп (`date_added`, `create_date`, `date_last_chat`, `chat_size` — из времени создания файла) у
 *    разных устройств разные, поэтому в синхронизируемое содержимое не входят;
 *  - открытый сейчас чат перезаписывать нельзя: ST держит его в памяти и сохранит поверх. Такая запись откладывается
 *    (`error.deferred`) и повторится на следующем проходе;
 *  - папка чатов персонажа создаётся её же эндпоинтом `chats/get`.
 */

import { DEFERRED_PREFIX } from '../libraries/core/sync-runner.js';

export const SYNC_CATEGORIES = Object.freeze([
    { id: 'characters', label: 'Characters' },
    { id: 'chats', label: 'Chats (including group chats)' },
    { id: 'worlds', label: 'Lorebooks' },
    { id: 'presets', label: 'Presets & prompts (samplers, Prompt Manager, instruct, themes, Quick Replies)' },
    { id: 'backgrounds', label: 'Backgrounds' },
    { id: 'personas', label: 'Persona avatars' },
]);

/** Наши собственные фоны из репозитория фонов ставятся на каждом устройстве сами — синхронизировать их незачем. */
const OWN_BACKGROUND_PREFIX = 'stme-';
const GROUP_VOLATILE_FIELDS = ['date_added', 'create_date', 'date_last_chat', 'chat_size'];
const DEFAULT_CONCURRENCY = 6;

export class DeferredWriteError extends Error {
    constructor(message) { super(`${DEFERRED_PREFIX}${message}`); this.deferred = true; }
}

const enc = encodeURIComponent;
const stripExt = (name, ext) => (name.endsWith(ext) ? name.slice(0, -ext.length) : name);

async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) { const index = next; next += 1; results[index] = await fn(items[index], index); }
    });
    await Promise.all(workers);
    return results;
}

export function registerStUserDataService(bus, {
    getContext,
    fetch: fetchImpl = globalThis.fetch?.bind(globalThis),
    FileCtor = globalThis.File,
    FormDataCtor = globalThis.FormData,
    BlobCtor = globalThis.Blob,
    concurrency = DEFAULT_CONCURRENCY,
    now = () => Date.now(),
    refreshCharacters = () => getContext()?.getCharacters?.(),
} = {}) {
    const headers = (options = {}) => getContext()?.getRequestHeaders?.(options) ?? {};

    async function postJson(url, body = {}) {
        const response = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers() }, body: JSON.stringify(body), cache: 'no-store' });
        if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
        return response;
    }
    const postForJson = async (url, body) => (await postJson(url, body)).json();

    async function upload(url, file, fields = {}) {
        const form = new FormDataCtor();
        for (const [key, value] of Object.entries(fields)) form.append(key, value);
        form.append('avatar', file);
        const response = await fetchImpl(url, { method: 'POST', headers: headers({ omitContentType: true }), body: form, cache: 'no-store' });
        if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
        return response;
    }

    /** Штамп статически отдаваемого файла — по заголовкам HEAD, без чтения тела. */
    async function headStamp(url) {
        const response = await fetchImpl(url, { method: 'HEAD', cache: 'no-store' });
        if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
        const get = name => response.headers?.get?.(name) ?? '';
        const lastModified = get('last-modified');
        return { stamp: `${get('etag')}|${get('content-length')}|${lastModified}`, size: Number(get('content-length')) || 0, modified: Date.parse(lastModified) || 0 };
    }

    async function getBlob(url) {
        const response = await fetchImpl(url, { method: 'GET', cache: 'no-store' });
        if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
        return response.blob();
    }

    const jsonlBlob = lines => new BlobCtor([lines.map(line => JSON.stringify(line)).join('\n')], { type: 'application/x-ndjson' });
    async function parseJsonl(blob) {
        const text = await blob.text();
        return text.split('\n').map(line => line.trim()).filter(Boolean).map(line => JSON.parse(line));
    }

    // ── Провайдеры: раздел → { category, list, read, write, remove, stamp } ────────────────────────────────────────────

    /** Общий вид «статически отдаваемых файлов» (фоны, персонажи, аватарки персон). */
    function staticFileProvider({ id, category, urlBase, listNames, uploadFile, deleteFile }) {
        const url = name => `${urlBase}/${enc(name)}`;
        return {
            id, category,
            async list() {
                const names = await listNames();
                return mapLimit(names, concurrency, async name => ({ path: `${id}/${name}`, ...(await headStamp(url(name))) }));
            },
            read: name => getBlob(url(name)),
            async write(name, blob) { await uploadFile(name, blob); return headStamp(url(name)); },
            remove: name => deleteFile(name),
        };
    }

    const backgrounds = staticFileProvider({
        id: 'backgrounds', category: 'backgrounds', urlBase: '/backgrounds',
        async listNames() {
            const data = await postForJson('/api/backgrounds/all', {});
            return (data?.images ?? []).map(item => (typeof item === 'string' ? item : item.filename)).filter(name => name && !name.startsWith(OWN_BACKGROUND_PREFIX));
        },
        uploadFile: (name, blob) => upload('/api/backgrounds/upload', new FileCtor([blob], name, { type: blob.type || 'application/octet-stream' })),
        deleteFile: name => postJson('/api/backgrounds/delete', { bg: name }),
    });

    const personas = staticFileProvider({
        id: 'personas', category: 'personas', urlBase: '/User Avatars',
        listNames: async () => (await postForJson('/api/avatars/get', {})) ?? [],
        uploadFile: (name, blob) => upload('/api/avatars/upload', new FileCtor([blob], name, { type: 'image/png' }), { overwrite_name: name }),
        deleteFile: name => postJson('/api/avatars/delete', { avatar: name }),
    });

    const characters = staticFileProvider({
        id: 'characters', category: 'characters', urlBase: '/characters',
        async listNames() {
            const list = await postForJson('/api/characters/all', {});
            return (Array.isArray(list) ? list : []).map(character => character.avatar).filter(name => typeof name === 'string' && name.endsWith('.png'));
        },
        uploadFile: (name, blob) => upload('/api/characters/import', new FileCtor([blob], name, { type: 'image/png' }), { file_type: 'png', preserved_name: stripExt(name, '.png') }),
        deleteFile: name => postJson('/api/characters/delete', { avatar_url: name, delete_chats: false }),
    });

    /** Открыт ли сейчас этот чат (его файл нельзя перезаписывать из-под ST). */
    function isOpenChat({ folder, file, groupId }) {
        const context = getContext() ?? {};
        if (groupId) return context.groupId != null && String(context.chatId) === String(file) && String(context.groupId) === String(groupId);
        const current = context.characters?.[context.characterId]?.avatar;
        return Boolean(current) && stripExt(current, '.png') === folder && String(context.chatId) === String(file);
    }

    const chatInfoStamp = info => `${info.file_size}|${info.chat_items}|${info.last_mes}`;
    const chatModified = info => Date.parse(info.last_mes) || Number(info.last_mes) || 0;

    const chats = {
        id: 'chats', category: 'chats',
        async list() {
            const list = await postForJson('/api/characters/all', {});
            const folders = (Array.isArray(list) ? list : []).map(character => character.avatar).filter(name => typeof name === 'string' && name.endsWith('.png'));
            const perCharacter = await mapLimit(folders, concurrency, async avatar => {
                const infos = await postForJson('/api/characters/chats', { avatar_url: avatar });
                const folder = stripExt(avatar, '.png');
                return (Array.isArray(infos) ? infos : []).filter(info => info?.file_name).map(info => ({ path: `chats/${folder}/${info.file_name}`, stamp: chatInfoStamp(info), size: 0, modified: chatModified(info) }));
            });
            return perCharacter.flat();
        },
        async read(name) {
            const [folder, file] = splitChatName(name);
            const data = await postForJson('/api/chats/get', { ch_name: folder, file_name: stripExt(file, '.jsonl'), avatar_url: `${folder}.png` });
            if (!Array.isArray(data)) throw new Error(`chat "${name}" could not be read`);
            return jsonlBlob(data);
        },
        async write(name, blob) {
            const [folder, file] = splitChatName(name);
            const base = stripExt(file, '.jsonl');
            if (isOpenChat({ folder, file: base })) throw new DeferredWriteError(`chat "${name}" is open right now — it will be updated on the next sync`);
            await postJson('/api/chats/get', { ch_name: folder, file_name: '', avatar_url: `${folder}.png` });   // создаёт папку персонажа, если её ещё нет
            await postJson('/api/chats/save', { ch_name: folder, file_name: base, avatar_url: `${folder}.png`, chat: await parseJsonl(blob), force: true });
            return this.statOne(name);
        },
        async remove(name) {
            const [folder, file] = splitChatName(name);
            if (isOpenChat({ folder, file: stripExt(file, '.jsonl') })) throw new DeferredWriteError(`chat "${name}" is open right now`);
            await postJson('/api/chats/delete', { chatfile: file, avatar_url: `${folder}.png` });
        },
        async statOne(name) {
            const [folder, file] = splitChatName(name);
            const infos = await postForJson('/api/characters/chats', { avatar_url: `${folder}.png` });
            const info = (Array.isArray(infos) ? infos : []).find(item => item.file_name === file);
            return info ? { stamp: chatInfoStamp(info), size: 0, modified: chatModified(info) } : { stamp: null };
        },
    };

    const cleanGroup = group => Object.fromEntries(Object.entries(group).filter(([key]) => !GROUP_VOLATILE_FIELDS.includes(key)));
    const listGroups = async () => (await postForJson('/api/groups/all', {})) ?? [];

    const groups = {
        id: 'groups', category: 'chats',
        async list() { return (await listGroups()).map(group => ({ path: `groups/${group.id}.json`, stamp: null, size: 0, modified: 0 })); },
        async read(name) {
            const id = stripExt(name, '.json');
            const group = (await listGroups()).find(item => String(item.id) === id);
            if (!group) throw new Error(`group "${id}" not found`);
            return new BlobCtor([JSON.stringify(cleanGroup(group))], { type: 'application/json' });
        },
        async write(name, blob) {
            await postJson('/api/groups/edit', JSON.parse(await blob.text()));
            return { stamp: null };
        },
        async remove(name) { await postJson('/api/groups/delete', { id: stripExt(name, '.json') }); },
    };

    const groupChats = {
        id: 'groupChats', category: 'chats',
        async list() {
            const ids = [...new Set((await listGroups()).flatMap(group => (Array.isArray(group.chats) ? group.chats : [])))];
            const found = await mapLimit(ids, concurrency, async id => {
                try {
                    const info = await postForJson('/api/chats/group/info', { id });
                    return info?.file_name ? { path: `groupChats/${id}.jsonl`, stamp: chatInfoStamp(info), size: 0, modified: chatModified(info) } : null;
                } catch { return null; }
            });
            return found.filter(Boolean);
        },
        async read(name) {
            const data = await postForJson('/api/chats/group/get', { id: stripExt(name, '.jsonl') });
            if (!Array.isArray(data)) throw new Error(`group chat "${name}" could not be read`);
            return jsonlBlob(data);
        },
        async write(name, blob) {
            const id = stripExt(name, '.jsonl');
            if (isOpenChat({ file: id, groupId: getContext()?.groupId })) throw new DeferredWriteError(`group chat "${name}" is open right now — it will be updated on the next sync`);
            await postJson('/api/chats/group/save', { id, chat: await parseJsonl(blob), force: true });
            return this.statOne(name);
        },
        async remove(name) { await postJson('/api/chats/group/delete', { id: stripExt(name, '.jsonl') }); },
        async statOne(name) {
            try {
                const info = await postForJson('/api/chats/group/info', { id: stripExt(name, '.jsonl') });
                return info?.file_name ? { stamp: chatInfoStamp(info), size: 0, modified: chatModified(info) } : { stamp: null };
            } catch { return { stamp: null }; }
        },
    };

    const worlds = {
        id: 'worlds', category: 'worlds',
        async list() { return ((await postForJson('/api/worldinfo/list', {})) ?? []).map(world => ({ path: `worlds/${world.file_id}.json`, stamp: null, size: 0, modified: 0 })); },
        async read(name) {
            const data = await postForJson('/api/worldinfo/get', { name: stripExt(name, '.json') });
            if (!data || typeof data !== 'object' || !('entries' in data)) throw new Error(`lorebook "${name}" could not be read`);
            return new BlobCtor([JSON.stringify(data)], { type: 'application/json' });
        },
        async write(name, blob) {
            await postJson('/api/worldinfo/edit', { name: stripExt(name, '.json'), data: JSON.parse(await blob.text()) });
            return { stamp: null };
        },
        async remove(name) { await postJson('/api/worldinfo/delete', { name: stripExt(name, '.json') }); },
    };

    // ── Пресеты, темы, Quick Replies ──────────────────────────────────────────────────────────────────────────────
    // Промпты Prompt Manager — часть пресетов Chat Completion (`prompts`/`prompt_order` внутри `OpenAI Settings/*.json`). Список и
    // содержимое ВСЕХ пресетов отдаёт один вызов `settings/get` (он читает каждый файл), поэтому ответ запоминается: без этого
    // каждое чтение файла стоило бы N чтений. Имя файла у instruct/context/… и тем берётся из поля `name` внутри — как делает сам ST.
    // MovingUI сюда не входит: это положения окон под конкретный экран (у ноутбука и телефона они разные), и удалить его через API нельзя.
    const PRESET_KINDS = [
        ['openai', 'openai_setting_names', 'openai_settings', 'files'],
        ['textgenerationwebui', 'textgenerationwebui_preset_names', 'textgenerationwebui_presets', 'files'],
        ['kobold', 'koboldai_setting_names', 'koboldai_settings', 'files'],
        ['novel', 'novelai_setting_names', 'novelai_settings', 'files'],
        ['instruct', 'instruct', null, 'objects'],
        ['context', 'context', null, 'objects'],
        ['sysprompt', 'sysprompt', null, 'objects'],
        ['reasoning', 'reasoning', null, 'objects'],
    ];
    // Каталог живёт в пределах ОДНОГО сканирования (его сбрасывает `list()` ниже): три раздела подряд не читают все файлы трижды, а правка
    // пресета между двумя проходами не теряется. Чтения отдельных файлов после сканирования берут тот же снимок, но не старше этого срока.
    const CATALOG_READ_MS = 15000;
    let catalog = null;
    let catalogAt = 0;

    const stampOfText = text => { let hash = 5381; for (let index = 0; index < text.length; index += 1) hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0; return `${text.length}:${hash.toString(16)}`; };
    const canonical = value => JSON.stringify(typeof value === 'string' ? JSON.parse(value) : value);

    async function loadCatalog(maxAgeMs) {
        if (catalog && now() - catalogAt < maxAgeMs) return catalog;
        const data = await postForJson('/api/settings/get', {});
        const entries = new Map();
        const safe = (path, value) => { try { entries.set(path, canonical(value)); } catch { /* битый файл пресета пропускается, как это делает ST */ } };
        for (const [kind, namesKey, contentsKey, shape] of PRESET_KINDS) {
            if (shape === 'files') (data?.[namesKey] ?? []).forEach((name, index) => safe(`presets/${kind}/${name}.json`, data[contentsKey]?.[index]));
            else for (const preset of data?.[namesKey] ?? []) if (preset?.name) safe(`presets/${kind}/${preset.name}.json`, preset);
        }
        for (const theme of data?.themes ?? []) if (theme?.name) safe(`themes/${theme.name}.json`, theme);
        for (const preset of data?.quickReplyPresets ?? []) if (preset?.name) safe(`quickReplies/${preset.name}.json`, preset);
        catalog = entries;
        catalogAt = now();
        return entries;
    }
    const forgetCatalog = () => { catalog = null; };

    function catalogProvider(id) {
        const strip = name => stripExt(name, '.json');
        return {
            id, category: 'presets',
            async list() {
                const entries = await loadCatalog(CATALOG_READ_MS);
                return [...entries].filter(([path]) => path.startsWith(`${id}/`)).map(([path, text]) => ({ path, stamp: stampOfText(text), size: text.length, modified: 0 }));
            },
            async read(name) {
                const text = (await loadCatalog(CATALOG_READ_MS)).get(`${id}/${name}`);
                if (text == null) throw new Error(`preset "${id}/${name}" was not found`);
                return new BlobCtor([text], { type: 'application/json' });
            },
            async write(name, blob) {
                const text = canonical(await blob.text());
                const preset = JSON.parse(text);
                if (id === 'presets') {
                    const slash = name.indexOf('/');
                    await postJson('/api/presets/save', { name: strip(name.slice(slash + 1)), apiId: name.slice(0, slash), preset });
                } else if (id === 'themes') await postJson('/api/themes/save', preset);
                else await postJson('/api/quick-replies/save', preset);
                forgetCatalog();
                return { stamp: stampOfText(text), size: text.length, modified: 0 };
            },
            async remove(name) {
                if (id === 'presets') {
                    const slash = name.indexOf('/');
                    await postJson('/api/presets/delete', { name: strip(name.slice(slash + 1)), apiId: name.slice(0, slash) });
                } else await postJson(id === 'themes' ? '/api/themes/delete' : '/api/quick-replies/delete', { name: strip(name) });
                forgetCatalog();
            },
        };
    }
    const presets = catalogProvider('presets');
    const themes = catalogProvider('themes');
    const quickReplies = catalogProvider('quickReplies');

    function splitChatName(name) {
        const slash = name.indexOf('/');
        if (slash < 1) throw new Error(`invalid chat path "${name}"`);
        return [name.slice(0, slash), name.slice(slash + 1)];
    }

    const providers = [characters, chats, groups, groupChats, worlds, presets, themes, quickReplies, backgrounds, personas];
    const byId = new Map(providers.map(provider => [provider.id, provider]));

    function resolve(path) {
        const slash = String(path).indexOf('/');
        const provider = slash > 0 ? byId.get(path.slice(0, slash)) : null;
        if (!provider) throw new Error(`stUserData: no provider for "${path}"`);
        return { provider, name: path.slice(slash + 1) };
    }

    const wanted = categories => (Array.isArray(categories) && categories.length ? providers.filter(provider => categories.includes(provider.category)) : providers);

    async function list({ categories } = {}) {
        forgetCatalog();   // каждое сканирование начинается с ЖИВЫХ данных ST
        const results = [];
        for (const provider of wanted(categories)) results.push(...await provider.list());
        return results;
    }
    async function read({ path } = {}) { const { provider, name } = resolve(path); return provider.read(name); }
    async function write({ path, blob } = {}) {
        const { provider, name } = resolve(path);
        const stat = await provider.write(name, blob);
        return { stamp: stat?.stamp ?? null };
    }
    async function remove({ path } = {}) { const { provider, name } = resolve(path); await provider.remove(name); return true; }

    /** Обновить список персонажей в интерфейсе ST после записи карточек (иначе новый персонаж появится только после перезагрузки). */
    async function refresh({ categories } = {}) {
        if (!categories || categories.includes('characters')) { try { await refreshCharacters(); } catch { /* список обновится при следующем открытии */ } }
        return true;
    }

    const unregisters = [
        bus.register('stUserData.categories', () => SYNC_CATEGORIES.map(category => ({ ...category })), { loadMetric: () => 0 }),
        bus.register('stUserData.list', params => list(params), { loadMetric: () => 0 }),
        bus.register('stUserData.read', params => read(params), { loadMetric: () => 0 }),
        bus.register('stUserData.write', params => write(params), { loadMetric: () => 0 }),
        bus.register('stUserData.remove', params => remove(params), { loadMetric: () => 0 }),
        bus.register('stUserData.refresh', params => refresh(params), { loadMetric: () => 0 }),
    ];
    return () => { for (const unregister of unregisters) unregister(); };
}
