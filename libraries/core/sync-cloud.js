import { computeGitBlobSha } from './content-hash.js';

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
const MAX_INDEX_ATTEMPTS = 4;

export class CloudConflictError extends Error {
    constructor(message = 'The index was changed by another device.') { super(message); this.code = 'conflict'; }
}

const parse = text => { try { return JSON.parse(text); } catch { return null; } };

export function describeCloudFailure(provider, status, text = '') {
    const name = provider === 'google' ? 'Google Drive' : 'Dropbox';
    const data = parse(text);
    const detail = data?.error_summary ?? data?.error?.message ?? (typeof data?.error === 'string' ? data.error : '');
    if (status === 401) return `${name} rejected the sign-in (401): connect the account again.`;
    if (status === 403) return `${name} refused access (403)${detail ? `: ${detail}` : ''}.`;
    if (status === 429) return `${name} is rate-limiting requests (429): try again later.`;
    if (status === 507 || /insufficient_space|storageQuota/.test(detail)) return `${name} is out of space.`;
    return `${name} answered HTTP ${status}${detail ? `: ${detail}` : ''}`;
}

/** Добавляет токен к запросу и один раз повторяет его после 401 с принудительно обновлённым токеном. */
export function createAuthedHttp({ http, tokens }) {
    return async request => {
        const send = token => http({ ...request, headers: { ...request.headers, Authorization: `Bearer ${token}` } });
        const response = await send(await tokens.accessToken());
        return response.status === 401 ? send(await tokens.forceRefresh()) : response;
    };
}

// ── Dropbox ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Заголовок `Dropbox-API-Arg` обязан быть ASCII: всё, что выше, экранируется. */
const asciiJson = value => JSON.stringify(value).replace(/[-￿]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

export function createDropboxStore({ http }) {
    const CONTENT = 'https://content.dropboxapi.com/2/files';
    const API = 'https://api.dropboxapi.com/2/files';
    const fail = response => new Error(describeCloudFailure('dropbox', response.status, response.text));
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
    const fail = response => new Error(describeCloudFailure('google', response.status, response.text));
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

export const blobNameFor = async path => `b-${await computeGitBlobSha(new TextEncoder().encode(path))}`;

export function createCloudRemote({ store, maxFileBytes = CLOUD_MAX_FILE_BYTES, now = () => Date.now() } = {}) {
    const writes = new Map();     // путь -> { h, s, m }
    const deletes = new Set();
    let index = null;

    async function loadIndex() {
        await store.refresh?.();
        const file = await store.readText(INDEX_NAME);
        const data = file ? parse(file.text) : null;
        return { files: data?.v === 1 && data.files && typeof data.files === 'object' ? data.files : {}, version: file?.version ?? null };
    }

    return {
        batched: true,

        async manifest() {
            index = await loadIndex();
            return Object.fromEntries(Object.entries(index.files).map(([path, entry]) => [path, { hash: entry.h, size: entry.s ?? 0, modified: entry.m ?? 0 }]));
        },

        async read(path) {
            const blob = await store.readBlob(await blobNameFor(path));
            if (!blob) throw new Error(`"${path}" is listed in the cloud index but its data is missing.`);
            return blob;
        },

        async write(path, blob, meta = {}) {
            if (blob.size > maxFileBytes) throw new Error(`"${path}" is larger than the ${Math.round(maxFileBytes / 1048576)} MB limit for the cloud.`);
            await store.writeBlob(await blobNameFor(path), blob);
            writes.set(path, { h: meta.hash, s: blob.size, m: meta.modified || now() });
            deletes.delete(path);
        },

        async remove(path) { deletes.add(path); writes.delete(path); },

        async commit() {
            if (!writes.size && !deletes.size) return null;
            let lastError = null;
            for (let attempt = 0; attempt < MAX_INDEX_ATTEMPTS; attempt += 1) {
                const current = attempt === 0 && index ? index : await loadIndex();
                const files = { ...current.files };
                for (const [path, entry] of writes) files[path] = entry;
                for (const path of deletes) delete files[path];
                try {
                    await store.writeText(INDEX_NAME, JSON.stringify({ v: 1, files }), { version: current.version, mustNotExist: current.version == null });
                    for (const path of deletes) await store.remove(await blobNameFor(path)).catch(() => {});
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
