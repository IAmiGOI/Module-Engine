import { FatalSyncError, isFatalHttpStatus } from './sync-errors.js';
import { describeCloudFailure } from './sync-cloud.js';
import { parseBackupName } from './backup-plan.js';

/**
 * Google Drive для облачных бэкапов — отдельная папка `ST Module Engine Backups` (видна в «Моём диске»; право `drive.file` даёт приложению
 * только созданное им самим, чужое не задеть). Внутри — по папке на бэкап (имя см. backup-plan.js), а в ней файлы под настоящими путями.
 * Сеть инъекцией: `http({ url, method, headers, body, responseType }) → { status, ok, text?, blob?, headers }` — уже с авторизацией.
 */

export const BACKUP_ROOT_NAME = 'ST Module Engine Backups';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
/** Файлы крупнее этого заливаются «возобновляемой» загрузкой: один запрос с телом без обёртки multipart (меньше памяти). */
export const RESUMABLE_FROM_BYTES = 8 * 1024 * 1024;
const FILE_FIELDS = 'id,name,size,mimeType,sha256Checksum,appProperties';
const parse = text => { try { return JSON.parse(text); } catch { return null; } };
const quote = value => String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export function createBackupDrive({ http }) {
    const fail = response => (isFatalHttpStatus(response.status) ? new FatalSyncError(describeCloudFailure('google', response.status, response.text)) : new Error(describeCloudFailure('google', response.status, response.text)));
    const json = async (url, options = {}) => {
        const response = await http({ url, headers: options.body ? { 'Content-Type': 'application/json' } : undefined, ...options, body: options.body ? JSON.stringify(options.body) : undefined });
        if (!response.ok) throw fail(response);
        return parse(response.text) ?? {};
    };

    async function query(q, fields) {
        const found = [];
        let pageToken = '';
        do {
            const url = `${API}/files?pageSize=1000&orderBy=createdTime&q=${encodeURIComponent(q)}&fields=${encodeURIComponent(`nextPageToken,files(${fields})`)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
            const data = await json(url, { method: 'GET' });
            found.push(...(data.files ?? []));
            pageToken = data.nextPageToken ?? '';
        } while (pageToken);
        return found;
    }

    let rootId = null;
    async function ensureRoot() {
        if (rootId) return rootId;
        const existing = await query(`mimeType='${FOLDER_MIME}' and name='${quote(BACKUP_ROOT_NAME)}' and trashed=false`, 'id');
        rootId = existing[0]?.id ?? (await json(`${API}/files?fields=id`, { method: 'POST', body: { name: BACKUP_ROOT_NAME, mimeType: FOLDER_MIME } })).id;
        return rootId;
    }

    async function createFolder(name, parentId, appProperties) {
        const data = await json(`${API}/files?fields=id`, { method: 'POST', body: { name, mimeType: FOLDER_MIME, parents: [parentId], ...(appProperties ? { appProperties } : {}) } });
        return data.id;
    }

    /** Все бэкапы в корневой папке, которые мы узнаём по имени: [{ id, name, ...parseBackupName, appProperties }]. */
    async function listBackups() {
        const folders = await query(`'${await ensureRoot()}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`, 'id,name,appProperties');
        return folders.map(folder => ({ id: folder.id, name: folder.name, appProperties: folder.appProperties ?? {}, ...parseBackupName(folder.name) })).filter(item => item.at != null);
    }

    /** Папка `dirs` внутри `parentId` (создаётся по пути, id запоминаются на время одной операции — `cache` общий на бэкап). */
    async function ensureDir(parentId, dirs, cache) {
        let current = parentId;
        for (let depth = 0; depth < dirs.length; depth += 1) {
            const key = `${parentId}/${dirs.slice(0, depth + 1).join('/')}`;
            if (!cache.has(key)) cache.set(key, await createFolder(dirs[depth], current));
            current = cache.get(key);
        }
        return current;
    }

    async function upload(parentId, name, blob) {
        if (blob.size >= RESUMABLE_FROM_BYTES) {
            const start = await http({ url: `${UPLOAD}?uploadType=resumable&fields=${FILE_FIELDS}`, method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(blob.size) }, body: JSON.stringify({ name, parents: [parentId] }) });
            if (!start.ok) throw fail(start);
            const location = start.headers?.location ?? start.headers?.Location ?? start.headers?.get?.('location');
            if (!location) throw new Error('Google Drive did not return an upload address.');
            const done = await http({ url: location, method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: blob });
            if (!done.ok) throw fail(done);
            return parse(done.text) ?? {};
        }
        const boundary = `stme${Math.random().toString(16).slice(2)}`;
        const body = new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [parentId] })}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`, blob, `\r\n--${boundary}--`]);
        const response = await http({ url: `${UPLOAD}?uploadType=multipart&fields=${FILE_FIELDS}`, method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
        if (!response.ok) throw fail(response);
        return parse(response.text) ?? {};
    }

    /** Копия файла внутри Диска (без скачивания и загрузки). */
    const copy = (fileId, parentId, name) => json(`${API}/files/${fileId}/copy?fields=${FILE_FIELDS}`, { method: 'POST', body: { name, parents: [parentId] } });

    /** Все файлы папки с вложенными, с путями относительно неё: [{ id, path, size, sha256 }] (SHA-256 сообщает сам Диск). */
    async function listTree(folderId) {
        const out = [];
        const walk = async (id, prefix) => {
            const children = await query(`'${id}' in parents and trashed=false`, FILE_FIELDS);
            for (const child of children) {
                if (child.mimeType === FOLDER_MIME) await walk(child.id, `${prefix}${child.name}/`);
                else out.push({ id: child.id, path: `${prefix}${child.name}`, size: Number(child.size ?? 0), sha256: child.sha256Checksum ?? null });
            }
        };
        await walk(folderId, '');
        return out;
    }

    const rename = (id, name, appProperties) => json(`${API}/files/${id}?fields=id,name`, { method: 'PATCH', body: { name, ...(appProperties ? { appProperties } : {}) } });
    async function remove(id) {
        const response = await http({ url: `${API}/files/${id}`, method: 'DELETE' });
        if (!response.ok && response.status !== 404) throw fail(response);
    }
    async function download(id) {
        const response = await http({ url: `${API}/files/${id}?alt=media`, method: 'GET', responseType: 'blob' });
        if (!response.ok) throw fail(response);
        return response.blob;
    }
    /** Сколько места осталось на Диске: { limit, used, free } (`limit` — null у безлимитных). */
    async function quota() {
        const data = (await json(`${API}/about?fields=storageQuota`, { method: 'GET' })).storageQuota ?? {};
        const limit = data.limit != null ? Number(data.limit) : null;
        const used = Number(data.usage ?? 0);
        return { limit, used, free: limit == null ? null : Math.max(0, limit - used) };
    }

    return { ensureRoot, listBackups, createFolder, ensureDir, upload, copy, listTree, rename, remove, download, quota };
}
