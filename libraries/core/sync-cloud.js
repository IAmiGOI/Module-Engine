import { computeGitBlobSha } from './content-hash.js';
import { FatalSyncError, isFatalHttpStatus } from './sync-errors.js';
import { buildPack, COMPRESSED_PREFIX, gunzip, isPackable, maybeCompress, PACK_MAX_BYTES, PACK_MIN_MEMBERS, PACK_PREFIX, packGroupOf, parsePack, sliceFromPack } from './sync-pack.js';

/**
 * Облачный диск как сторона синхронизации (Dropbox и Google Drive) — ДОПОЛНИТЕЛЬНЫЙ способ рядом с прямым обменом между
 * устройствами и GitHub: не требует, чтобы устройства были онлайн одновременно, и хранит только то, что изменилось.
 *
 * Раскладка в папке приложения провайдера (пользователь её не видит и чужих файлов там нет):
 *   `index.json`      — `{ v: 1, files: { путь: { h: хеш, s: размер, m: время } } }` — единственный источник правды «что где лежит»;
 *   `b-<sha1 пути>`   — содержимое файла. Имя выводится из пути, поэтому не зависит от длины и символов имени (у Google нет
 *                       вложенных папок без id, у Dropbox лимиты на длину) — плоская раскладка одинакова у обоих провайдеров.
 * Изменение идёт так: сначала заливаются файлы, потом ОДИН раз обновляется индекс (с проверкой версии — если другое устройство
 * успело изменить индекс, читаем заново, накладываем свои правки и пробуем снова). Пока индекс не записан, отправленное не
 * считается синхронизированным (`batched`/`commit`, как у GitHub).
 *
 * Хранилище — маленький интерфейс `{ readText, writeText, readBlob, writeBlob, remove, refresh? }`; REST двух провайдеров живёт
 * ниже. Сеть инъекцией: `http({ url, method, headers, body, responseType }) → { status, ok, text?, blob?, headers }`.
 */

export const INDEX_NAME = 'index.json';
export const CLOUD_MAX_FILE_BYTES = 95 * 1024 * 1024;
/** Индекс записывается каждые столько изменённых файлов: оборвавшийся проход (квота, обрыв сети) сохраняет уже залитое ВИДИМЫМ для других устройств. */
export const CLOUD_CHECKPOINT_EVERY = 25;
const MAX_INDEX_ATTEMPTS = 4;

export class CloudConflictError extends Error {
    constructor(message = 'The index was changed by another device.') { super(message); this.code = 'conflict'; }
}

const parse = text => { try { return JSON.parse(text); } catch { return null; } };

export function describeCloudFailure(provider, status, text = '') {
    const name = provider === 'google' ? 'Google Drive' : 'Dropbox';
    const data = parse(text);
    // Точка в конце добавляется ниже сама — у Google в тексте она уже есть («…exceeded.» + «.» давало «..»).
    const detail = String(data?.error_summary ?? data?.error?.message ?? (typeof data?.error === 'string' ? data.error : '')).replace(/[.\s]+$/, '');
    const reason = data?.error?.errors?.[0]?.reason ?? '';
    if (reason === 'storageQuotaExceeded' || /quota|insufficient_space/i.test(detail)) return `${name} is full: the storage quota is used up. Free some space in the account and sync again — files already uploaded are kept.`;
    if (status === 401) return `${name} rejected the sign-in (401): connect the account again.`;
    if (status === 403) return `${name} refused access (403)${detail ? `: ${detail}` : ''}.`;
    if (status === 429) return `${name} is rate-limiting requests (429): try again later.`;
    if (status === 507) return `${name} is out of space.`;
    return `${name} answered HTTP ${status}${detail ? `: ${detail}` : ''}`;
}

/** Паузы перед повторами, когда облако просит притормозить (лимит запросов) или на секунду споткнулось. Параллельная передача упирается
 *  именно в лимиты, поэтому «притормози» — не фатальная ошибка: подождать и повторить, а остановка прохода — только если не помогло. */
export const RETRY_DELAYS_MS = Object.freeze([500, 1500, 4000, 9000]);
const isRetryable = response => response.status === 429
    || [500, 502, 503, 504].includes(response.status)
    || (response.status === 403 && /rateLimitExceeded|too_many_requests|too_many_write_operations/i.test(response.text ?? ''));
const retryAfterMs = response => {
    const seconds = Number(response.headers?.['retry-after']);
    return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 30) * 1000 : null;
};

/** Добавляет токен к запросу, один раз повторяет его после 401 с принудительно обновлённым токеном и повторяет с паузой при лимите запросов. */
export function createAuthedHttp({ http, tokens, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), retryDelays = RETRY_DELAYS_MS }) {
    return async request => {
        const send = token => http({ ...request, headers: { ...request.headers, Authorization: `Bearer ${token}` } });
        let response = await send(await tokens.accessToken());
        if (response.status === 401) response = await send(await tokens.forceRefresh());
        for (const delay of retryDelays) {
            if (!isRetryable(response)) break;
            await sleep((retryAfterMs(response) ?? delay) + Math.floor(Math.random() * 250));   // разброс, чтобы параллельные запросы не ударили все разом
            response = await send(await tokens.accessToken());
        }
        return response;
    };
}

// ── Dropbox ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Заголовок `Dropbox-API-Arg` обязан быть ASCII: всё, что выше, экранируется. */
const asciiJson = value => JSON.stringify(value).replace(/[-￿]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

export function createDropboxStore({ http }) {
    const CONTENT = 'https://content.dropboxapi.com/2/files';
    const API = 'https://api.dropboxapi.com/2/files';
    const fail = response => (isFatalHttpStatus(response.status) || /insufficient_space/.test(response.text ?? '') ? new FatalSyncError(describeCloudFailure('dropbox', response.status, response.text)) : new Error(describeCloudFailure('dropbox', response.status, response.text)));
    const isConflict = response => response.status === 409 && /conflict/.test(response.text ?? '');
    const isMissing = response => response.status === 409 && /not_found/.test(response.text ?? '');

    async function download(name) {
        const response = await http({ url: `${CONTENT}/download`, method: 'POST', headers: { 'Dropbox-API-Arg': asciiJson({ path: `/${name}` }) }, responseType: 'blob' });
        if (isMissing(response)) return null;
        if (!response.ok) throw fail(response);
        const result = parse(response.headers?.['dropbox-api-result']);
        return { blob: response.blob, version: result?.rev ?? null };
    }

    async function upload(name, blob, version, { mustNotExist = false } = {}) {
        const mode = version ? { '.tag': 'update', update: version } : (mustNotExist ? 'add' : 'overwrite');
        const response = await http({
            url: `${CONTENT}/upload`, method: 'POST',
            headers: { 'Dropbox-API-Arg': asciiJson({ path: `/${name}`, mode, mute: true }), 'Content-Type': 'application/octet-stream' },
            body: blob,
        });
        if (isConflict(response)) throw new CloudConflictError();
        if (!response.ok) throw fail(response);
        return parse(response.text)?.rev ?? null;
    }

    return {
        provider: 'dropbox',
        async readText(name) { const file = await download(name); return file ? { text: await file.blob.text(), version: file.version } : null; },
        writeText: (name, text, { version, mustNotExist } = {}) => upload(name, new Blob([text], { type: 'application/json' }), version, { mustNotExist }),
        async readBlob(name) { return (await download(name))?.blob ?? null; },
        async writeBlob(name, blob) { await upload(name, blob, null); },
        async remove(name) {
            const response = await http({ url: `${API}/delete_v2`, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: `/${name}` }) });
            if (!response.ok && !isMissing(response)) throw fail(response);
        },
    };
}

// ── Google Drive (обычная папка «ST Module Engine Sync», право `drive.file`) ────────────────────────────────────────

export const DRIVE_FOLDER_NAME = 'ST Module Engine Sync';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export function createDriveStore({ http }) {
    const API = 'https://www.googleapis.com/drive/v3/files';
    const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
    const fail = response => (isFatalHttpStatus(response.status) ? new FatalSyncError(describeCloudFailure('google', response.status, response.text)) : new Error(describeCloudFailure('google', response.status, response.text)));
    let folderId = null;
    let listing = null;   // имя -> { id, version }

    async function query(q, fields) {
        const found = [];
        let pageToken = '';
        do {
            const url = `${API}?pageSize=1000&orderBy=createdTime&q=${encodeURIComponent(q)}&fields=${encodeURIComponent(`nextPageToken,files(${fields})`)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
            const response = await http({ url, method: 'GET' });
            if (!response.ok) throw fail(response);
            const data = parse(response.text) ?? {};
            found.push(...(data.files ?? []));
            pageToken = data.nextPageToken ?? '';
        } while (pageToken);
        return found;
    }

    /** Папка синхронизации: с правом `drive.file` приложению видны только созданные им самим папки и файлы, поэтому чужое не заденем. */
    async function ensureFolder() {
        if (folderId) return folderId;
        const existing = await query(`mimeType='${FOLDER_MIME}' and name='${DRIVE_FOLDER_NAME}' and trashed=false`, 'id');
        if (existing.length) { folderId = existing[0].id; return folderId; }   // самая ранняя — если две устройства создали одновременно
        const response = await http({ url: `${API}?fields=id`, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: DRIVE_FOLDER_NAME, mimeType: FOLDER_MIME }) });
        if (!response.ok) throw fail(response);
        folderId = parse(response.text)?.id;
        return folderId;
    }

    async function refresh() {
        const folder = await ensureFolder();
        const files = await query(`'${folder}' in parents and trashed=false`, 'id,name,version');
        listing = new Map(files.map(file => [file.name, { id: file.id, version: String(file.version ?? '') }]));
        return listing;
    }
    const known = async name => (listing ?? await refresh()).get(name) ?? null;

    async function download(name) {
        const entry = await known(name);
        if (!entry) return null;
        const response = await http({ url: `${API}/${entry.id}?alt=media`, method: 'GET', responseType: 'blob' });
        if (response.status === 404) return null;
        if (!response.ok) throw fail(response);
        return { blob: response.blob, version: entry.version };
    }

    async function upload(name, blob, expectedVersion, { mustNotExist = false } = {}) {
        const conditional = Boolean(expectedVersion) || mustNotExist;
        if (conditional) await refresh();   // условная запись решает по свежему списку: у Drive допустимы файлы-двойники по имени
        const entry = await known(name);
        if (entry && mustNotExist) throw new CloudConflictError();
        if (entry && expectedVersion && entry.version !== expectedVersion) throw new CloudConflictError();
        let response;
        if (entry) {
            response = await http({ url: `${UPLOAD}/${entry.id}?uploadType=media&fields=id,version`, method: 'PATCH', headers: { 'Content-Type': 'application/octet-stream' }, body: blob });
        } else {
            const boundary = `stme${Math.random().toString(16).slice(2)}`;
            const metadata = JSON.stringify({ name, parents: [await ensureFolder()] });
            const body = new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`, blob, `\r\n--${boundary}--`]);
            response = await http({ url: `${UPLOAD}?uploadType=multipart&fields=id,version`, method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
        }
        if (!response.ok) throw fail(response);
        const data = parse(response.text) ?? {};
        listing?.set(name, { id: data.id ?? entry?.id, version: String(data.version ?? '') });
        return String(data.version ?? '');
    }

    return {
        provider: 'google',
        refresh,
        async readText(name) { const file = await download(name); return file ? { text: await file.blob.text(), version: file.version } : null; },
        writeText: (name, text, { version, mustNotExist } = {}) => upload(name, new Blob([text], { type: 'application/json' }), version, { mustNotExist }),
        async readBlob(name) { return (await download(name))?.blob ?? null; },
        async writeBlob(name, blob) { await upload(name, blob, null); },
        async remove(name) {
            const entry = await known(name);
            if (!entry) return;
            const response = await http({ url: `${API}/${entry.id}`, method: 'DELETE' });
            if (!response.ok && response.status !== 404) throw fail(response);
            listing?.delete(name);
        },
    };
}

// ── Сторона для исполнителя прохода ─────────────────────────────────────────────────────────────────────────────────

const nameHash = async path => computeGitBlobSha(new TextEncoder().encode(path));
export const blobNameFor = async path => `b-${await nameHash(path)}`;
export const compressedNameFor = async path => `${COMPRESSED_PREFIX}${await nameHash(path)}`;
const PACK_CACHE_SIZE = 3;

/**
 * Что ещё лежит в индексе на запись пути (поля сверх `h`/`s`/`m`/`k` старые устройства не знают и сохраняют как есть при слиянии индекса):
 *  - `z: 1`            — данные сжаты gzip'ом и лежат под именем `z-<sha1 пути>` (а не `b-…`);
 *  - `pk`, `po`, `pl`  — файл лежит внутри блока `k-<pk>` со смещением `po` и длиной `pl` (в несжатом теле блока).
 * Хеш `h` ВСЕГДА хеш настоящих байт файла: трёхстороннее сравнение (`sync-plan.js`) о сжатии и блоках ничего не знает.
 */
export function createCloudRemote({ store, maxFileBytes = CLOUD_MAX_FILE_BYTES, now = () => Date.now(), pack = {} } = {}) {
    const { minMembers = PACK_MIN_MEMBERS, maxBytes = PACK_MAX_BYTES, enabled = true, compress = true } = pack;
    const writes = new Map();     // путь -> запись индекса { h, s, m, k?, z?, pk?, po?, pl? }
    const deletes = new Set();
    const pending = new Map();    // группа (папка персонажа) -> [{ path, bytes, entry }] — старые чаты ждут коммита, чтобы собраться в блок
    let pendingBytes = 0;
    let index = null;
    let listed = {};   // что индекс говорил о каждом пути при последнем `manifest()` (для `annotate`, пока `index` может быть уже сброшен коммитом)
    const packCache = new Map();  // имя блока -> Promise<разобранный блок>; общий для параллельных чтений: блок на 30 чатов качается один раз

    async function loadIndex() {
        await store.refresh?.();
        const file = await store.readText(INDEX_NAME);
        const data = file ? parse(file.text) : null;
        return { files: data?.v === 1 && data.files && typeof data.files === 'object' ? data.files : {}, version: file?.version ?? null };
    }

    const entryFor = (path, meta, size, extra = {}) => ({ h: meta.hash, s: size, m: meta.modified || now(), ...(meta.key ? { k: meta.key } : {}), ...extra });

    /** Блок из накопленных старых чатов одной папки; если их мало — обычные сжатые файлы. */
    async function flushGroup(members) {
        if (!members.length) return;
        if (members.length < minMembers) {
            for (const member of members) await storeSingle(member.path, member.bytes, member.entry);
            return;
        }
        const built = await buildPack(members.map(member => ({ path: member.path, bytes: member.bytes })));
        const id = await computeGitBlobSha(built.bytes);
        await store.writeBlob(`${PACK_PREFIX}${id}`, new Blob([built.bytes]));
        for (const [position, member] of members.entries()) {
            writes.set(member.path, { ...member.entry, pk: id, po: built.entries[position].offset, pl: built.entries[position].length });
            deletes.delete(member.path);
        }
    }

    /** Один файл: сжатый (`z-`), если это текст и выигрыш есть, иначе как есть (`b-`). */
    async function storeSingle(path, bytes, entry) {
        const packed = compress ? await maybeCompress(path, bytes) : { bytes, compressed: false };
        await store.writeBlob(packed.compressed ? await compressedNameFor(path) : await blobNameFor(path), new Blob([packed.bytes]));
        writes.set(path, packed.compressed ? { ...entry, z: 1 } : entry);
        deletes.delete(path);
    }

    async function flushPending() {
        if (!pending.size) return;
        const groups = [...pending.values()];
        pending.clear();
        pendingBytes = 0;
        for (const members of groups) await flushGroup(members);
    }

    function loadPack(id) {
        const name = `${PACK_PREFIX}${id}`;
        if (!packCache.has(name)) {
            const loading = (async () => {
                const blob = await store.readBlob(name);
                if (!blob) throw new Error(`A pack of old chats (${id.slice(0, 8)}…) is listed in the cloud index but its data is missing.`);
                return parsePack(new Uint8Array(await blob.arrayBuffer()));
            })();
            loading.catch(() => packCache.delete(name));
            packCache.set(name, loading);
            while (packCache.size > PACK_CACHE_SIZE) packCache.delete(packCache.keys().next().value);
        }
        return packCache.get(name);
    }

    const currentEntry = path => writes.get(path) ?? listed[path];

    return {
        batched: true,
        checkpointEvery: CLOUD_CHECKPOINT_EVERY,

        async manifest() {
            index = await loadIndex();
            listed = index.files;
            return Object.fromEntries(Object.entries(index.files).map(([path, entry]) => [path, { hash: entry.h, size: entry.s ?? 0, modified: entry.m ?? 0, ...(entry.k ? { key: entry.k } : {}) }]));
        },

        async read(path) {
            for (const members of pending.values()) {
                const waiting = members.find(member => member.path === path);
                if (waiting) return new Blob([waiting.bytes]);
            }
            const entry = currentEntry(path);
            if (entry?.pk) return new Blob([sliceFromPack(await loadPack(entry.pk), path)]);
            if (entry?.z) {
                const blob = await store.readBlob(await compressedNameFor(path));
                if (!blob) throw new Error(`"${path}" is listed in the cloud index but its data is missing.`);
                return new Blob([await gunzip(new Uint8Array(await blob.arrayBuffer()))]);
            }
            const blob = await store.readBlob(await blobNameFor(path));
            if (!blob) throw new Error(`"${path}" is listed in the cloud index but its data is missing.`);
            return blob;
        },

        async write(path, blob, meta = {}) {
            if (blob.size > maxFileBytes) throw new Error(`"${path}" is larger than the ${Math.round(maxFileBytes / 1048576)} MB limit for the cloud.`);
            // `k` — смысловой отпечаток (карточка персонажа): ST переписывает карточку при каждом импорте, байты меняются, а содержимое нет —
            // без отпечатка в индексе каждое такое переписывание выглядело бы правкой и перезаливало файл целиком.
            const entry = entryFor(path, meta, blob.size);
            if (enabled && isPackable(path, { modified: entry.m, size: blob.size, now: now() })) {
                const bytes = new Uint8Array(await blob.arrayBuffer());
                const group = packGroupOf(path);
                if (!pending.has(group)) pending.set(group, []);
                pending.get(group).push({ path, bytes, entry });
                writes.delete(path);
                deletes.delete(path);
                pendingBytes += bytes.length;
                if (pendingBytes > maxBytes) await flushPending();   // слабому устройству не держать десятки мегабайт в памяти
                return;
            }
            await storeSingle(path, new Uint8Array(await blob.arrayBuffer()), entry);
        },

        /** Дописать в индексе отпечаток, НЕ трогая сами данные: карточка в облаке та же по содержимому, байты лежат как лежали. */
        async annotate(path, { key } = {}) {
            const current = currentEntry(path);
            if (!current || !key) return;
            writes.set(path, { ...current, k: key });
            deletes.delete(path);
        },

        async remove(path) {
            deletes.add(path);
            writes.delete(path);
            for (const [group, members] of pending) {
                const kept = members.filter(member => member.path !== path);
                if (kept.length) pending.set(group, kept); else pending.delete(group);
            }
        },

        async commit() {
            await flushPending();
            if (!writes.size && !deletes.size) return null;
            let lastError = null;
            for (let attempt = 0; attempt < MAX_INDEX_ATTEMPTS; attempt += 1) {
                const current = attempt === 0 && index ? index : await loadIndex();
                const files = { ...current.files };
                for (const [path, entry] of writes) files[path] = entry;
                for (const path of deletes) delete files[path];
                try {
                    await store.writeText(INDEX_NAME, JSON.stringify({ v: 1, files }), { version: current.version, mustNotExist: current.version == null });
                    // Прибраться за собой (мелкие сбои не важны — это лишь мусор): старые данные под другим именем и блоки, на которые больше никто не ссылается.
                    const touched = [...new Set([...writes.keys(), ...deletes])];
                    const stillUsed = new Set(Object.values(files).map(entry => entry.pk).filter(Boolean));
                    const orphanPacks = new Set(touched.map(path => current.files[path]?.pk).filter(id => id && !stillUsed.has(id)));
                    for (const path of touched) {
                        const before = current.files[path];
                        const after = files[path];
                        const wasName = before?.pk ? null : (before?.z ? await compressedNameFor(path) : await blobNameFor(path));
                        const isName = !after || after.pk ? null : (after.z ? await compressedNameFor(path) : await blobNameFor(path));
                        if (wasName && wasName !== isName) await store.remove(wasName).catch(() => {});
                    }
                    for (const id of orphanPacks) { packCache.delete(`${PACK_PREFIX}${id}`); await store.remove(`${PACK_PREFIX}${id}`).catch(() => {}); }
                    writes.clear();
                    deletes.clear();
                    index = null;
                    return true;
                } catch (error) {
                    if (error?.code !== 'conflict') throw error;
                    lastError = error;
                    index = null;
                }
            }
            throw lastError ?? new CloudConflictError();
        },
    };
}
