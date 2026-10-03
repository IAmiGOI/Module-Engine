import { createHash } from 'node:crypto';

/** Google Drive на памяти — ровно столько REST, сколько нужно облачным бэкапам: папки, загрузка (multipart и resumable), копия, переименование, удаление, SHA-256, квота. */
export function createFakeDrive({ quotaLimit = 15 * 1024 ** 3, corruptUpload = null } = {}) {
    const options = { corruptUpload };   // меняется по ходу теста: «сбой» → «починили»
    const items = new Map();
    let counter = 0;
    const calls = [];
    const FOLDER = 'application/vnd.google-apps.folder';
    const newId = () => `id${(counter += 1)}`;
    const reply = (status, data, extra = {}) => ({ status, ok: status >= 200 && status < 300, text: JSON.stringify(data ?? {}), headers: {}, ...extra });
    const sha = async blob => createHash('sha256').update(Buffer.from(await blob.arrayBuffer())).digest('hex');
    const describe = (item, fields) => {
        const all = { id: item.id, name: item.name, mimeType: item.mimeType, size: item.blob ? String(item.blob.size) : undefined, sha256Checksum: item.sha256, appProperties: item.appProperties };
        return Object.fromEntries(Object.entries(all).filter(([key, value]) => value !== undefined && (!fields || fields.includes(key))));
    };
    const descendants = id => { const out = []; for (const item of items.values()) if (item.parent === id) { out.push(item, ...descendants(item.id)); } return out; };
    const usage = () => [...items.values()].reduce((sum, item) => sum + (item.blob?.size ?? 0), 0);

    async function parseMultipart(blob, boundary) {
        const text = Buffer.from(await blob.arrayBuffer());
        const marker = Buffer.from(`--${boundary}`);
        const first = text.indexOf(marker), second = text.indexOf(marker, first + marker.length), third = text.indexOf(marker, second + marker.length);
        const metaPart = text.subarray(first + marker.length, second).toString();
        const metadata = JSON.parse(metaPart.slice(metaPart.indexOf('\r\n\r\n') + 4).trim());
        const contentPart = text.subarray(second + marker.length, third);
        const start = contentPart.indexOf(Buffer.from('\r\n\r\n')) + 4;
        return { metadata, content: new Blob([contentPart.subarray(start, contentPart.length - 2)]) };
    }

    async function http({ url, method = 'GET', headers = {}, body }) {
        calls.push(`${method} ${url.replace('https://www.googleapis.com', '').split('?')[0]}`);
        const u = new URL(url);
        const fields = (u.searchParams.get('fields') ?? '').replace(/files\(|\)/g, '').split(',');
        const path = u.pathname;
        if (path === '/drive/v3/about') return reply(200, { storageQuota: { limit: String(quotaLimit), usage: String(usage()) } });
        if (method === 'GET' && path === '/drive/v3/files') {
            const q = u.searchParams.get('q') ?? '';
            const parent = /'([^']+)' in parents/.exec(q)?.[1];
            const name = /name='((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\(.)/g, '$1');
            const folderOnly = q.includes(`mimeType='${FOLDER}'`);
            const list = [...items.values()].filter(item => !item.trashed && (!parent || item.parent === parent) && (name === undefined || item.name === name) && (!folderOnly || item.mimeType === FOLDER));
            return reply(200, { files: list.map(item => describe(item, fields)) });
        }
        if (method === 'POST' && path === '/drive/v3/files') {
            const data = JSON.parse(body);
            const item = { id: newId(), name: data.name, mimeType: data.mimeType ?? 'application/octet-stream', parent: data.parents?.[0] ?? null, appProperties: data.appProperties };
            items.set(item.id, item);
            return reply(200, describe(item, fields));
        }
        const copyMatch = /^\/drive\/v3\/files\/([^/]+)\/copy$/.exec(path);
        if (copyMatch && method === 'POST') {
            const source = items.get(copyMatch[1]);
            if (!source?.blob) return reply(404, { error: { message: 'not found' } });
            const data = JSON.parse(body);
            const item = { id: newId(), name: data.name, mimeType: source.mimeType, parent: data.parents[0], blob: source.blob, sha256: source.sha256 };
            items.set(item.id, item);
            return reply(200, describe(item, fields));
        }
        if (path === '/upload/drive/v3/files' && method === 'POST') {
            if (u.searchParams.get('uploadType') === 'resumable') {
                const data = JSON.parse(body);
                const sessionId = `session${(counter += 1)}`;
                items.set(sessionId, { session: true, metadata: data });
                return reply(200, {}, { headers: { location: `https://www.googleapis.com/upload/drive/v3/files/${sessionId}?uploadType=resumable` } });
            }
            const boundary = /boundary=(.+)$/.exec(headers['Content-Type'])[1];
            const { metadata, content } = await parseMultipart(body, boundary);
            const item = { id: newId(), name: metadata.name, mimeType: 'application/octet-stream', parent: metadata.parents[0], blob: content, sha256: metadata.name === options.corruptUpload ? '0'.repeat(64) : await sha(content) };
            items.set(item.id, item);
            return reply(200, describe(item, fields));
        }
        const resumable = /^\/upload\/drive\/v3\/files\/(session\d+)$/.exec(path);
        if (resumable && method === 'PUT') {
            const session = items.get(resumable[1]);
            items.delete(resumable[1]);
            const item = { id: newId(), name: session.metadata.name, mimeType: 'application/octet-stream', parent: session.metadata.parents[0], blob: body, sha256: await sha(body) };
            items.set(item.id, item);
            return reply(200, describe(item, ['id', 'name', 'size', 'mimeType', 'sha256Checksum']));
        }
        const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(path);
        if (one) {
            const item = items.get(one[1]);
            if (!item) return reply(404, { error: { message: 'not found' } });
            if (method === 'PATCH') { const data = JSON.parse(body); if (data.name) item.name = data.name; if (data.appProperties) item.appProperties = { ...item.appProperties, ...data.appProperties }; return reply(200, describe(item, fields)); }
            if (method === 'DELETE') { for (const child of descendants(item.id)) items.delete(child.id); items.delete(item.id); return reply(204, {}); }
            if (method === 'GET' && u.searchParams.get('alt') === 'media') return { status: 200, ok: true, blob: item.blob, text: '', headers: {} };
        }
        return reply(400, { error: { message: `fake drive: unsupported ${method} ${path}` } });
    }
    const tree = rootName => {
        const root = [...items.values()].find(item => item.name === rootName && item.mimeType === FOLDER);
        return root ? descendants(root.id).filter(item => item.blob).map(item => item.name) : [];
    };
    return { options, http, items, calls, usage, tree, corrupt: name => { const item = [...items.values()].find(entry => entry.name === name && entry.blob); item.sha256 = '0'.repeat(64); } };
}
