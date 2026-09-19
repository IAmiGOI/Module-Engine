/**
 * Фейковые Dropbox и Google Drive в памяти: ровно те запросы, что использует сторона облака. Ответ — в форме `http.request`
 * (`{ status, ok, text?, blob?, headers }`). Токен проверяется: чужой отвергается 401 (проверка обновления токена).
 */

const reply = (status, data, extra = {}) => ({ status, ok: status >= 200 && status < 300, text: JSON.stringify(data ?? {}), headers: {}, ...extra });

export function createFakeDropbox({ validToken = () => true } = {}) {
    const files = new Map();      // path -> { blob, rev }
    const calls = [];
    let revCounter = 0;
    const beforeUpload = [];      // хуки для имитации гонки: (path) => void

    async function http({ url, method = 'GET', headers = {}, body }) {
        calls.push(`${method} ${url.replace('https://', '').split('?')[0]}`);
        const token = /^Bearer (.+)$/.exec(headers.Authorization ?? '')?.[1];
        if (!validToken(token)) return reply(401, { error_summary: 'expired_access_token/' });
        const arg = headers['Dropbox-API-Arg'] ? JSON.parse(headers['Dropbox-API-Arg']) : null;
        if (url.endsWith('/files/upload')) {
            for (const hook of beforeUpload.splice(0)) await hook(arg.path);
            const existing = files.get(arg.path);
            if (arg.mode?.['.tag'] === 'update' && existing?.rev !== arg.mode.update) return reply(409, { error_summary: 'path/conflict/file/.' });
            if (arg.mode === 'add' && existing) return reply(409, { error_summary: 'path/conflict/file/.' });
            revCounter += 1;
            files.set(arg.path, { blob: body, rev: `rev${revCounter}` });
            return reply(200, { rev: `rev${revCounter}` });
        }
        if (url.endsWith('/files/download')) {
            const file = files.get(arg.path);
            if (!file) return reply(409, { error_summary: 'path/not_found/.' });
            return { status: 200, ok: true, blob: file.blob, headers: { 'dropbox-api-result': JSON.stringify({ rev: file.rev }) } };
        }
        if (url.endsWith('/files/delete_v2')) {
            const path = JSON.parse(body).path;
            if (!files.has(path)) return reply(409, { error_summary: 'path_lookup/not_found/.' });
            files.delete(path);
            return reply(200, {});
        }
        return reply(500, { error_summary: `unhandled ${method} ${url}` });
    }
    return { http, files, calls, beforeUpload, names: () => [...files.keys()].sort() };
}

export function createFakeDrive({ validToken = () => true } = {}) {
    const files = new Map();      // id -> { name, blob, version }
    const calls = [];
    let counter = 0;
    const beforeUpload = [];

    async function http({ url, method = 'GET', headers = {}, body }) {
        const short = url.replace('https://www.googleapis.com', '').split('?')[0];
        calls.push(`${method} ${short}`);
        const token = /^Bearer (.+)$/.exec(headers.Authorization ?? '')?.[1];
        if (!validToken(token)) return reply(401, { error: { message: 'Invalid Credentials' } });
        if (method === 'GET' && short === '/drive/v3/files') {
            const q = decodeURIComponent(/[?&]q=([^&]*)/.exec(url)?.[1] ?? '');
            const wantsFolder = /mimeType='application\/vnd\.google-apps\.folder'/.test(q);
            const folderName = /name='([^']+)'/.exec(q)?.[1];
            const parent = /'([^']+)' in parents/.exec(q)?.[1];
            const picked = [...files.entries()].filter(([, file]) => (wantsFolder ? file.folder && file.name === folderName : !file.folder && file.parent === parent));
            return reply(200, { files: picked.map(([id, file]) => ({ id, name: file.name, version: String(file.version) })) });
        }
        if (method === 'POST' && short === '/drive/v3/files') {
            const data = JSON.parse(body);
            counter += 1;
            files.set(`id${counter}`, { name: data.name, folder: data.mimeType === 'application/vnd.google-apps.folder', version: 1 });
            return reply(200, { id: `id${counter}` });
        }
        const media = /^\/drive\/v3\/files\/([^/]+)$/.exec(short);
        if (method === 'GET' && media) {
            const file = files.get(media[1]);
            return file ? { status: 200, ok: true, blob: file.blob, headers: {} } : reply(404, {});
        }
        if (method === 'DELETE' && media) { files.delete(media[1]); return reply(204, {}); }
        if (method === 'POST' && short === '/upload/drive/v3/files') {
            for (const hook of beforeUpload.splice(0)) await hook();
            const text = await body.text();
            const boundary = /boundary=(.+)$/.exec(headers['Content-Type'])[1];
            const parts = text.split(`--${boundary}`).map(part => part.trim()).filter(part => part && part !== '--');
            const metadata = JSON.parse(parts[0].split('\r\n\r\n')[1]);
            const content = parts[1].split('\r\n\r\n').slice(1).join('\r\n\r\n');
            counter += 1;
            const id = `id${counter}`;
            assertParent(metadata);
            files.set(id, { name: metadata.name, blob: new Blob([content]), version: 1, parent: metadata.parents[0] });
            return reply(200, { id, version: '1' });
        }
        const patch = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(short);
        if (method === 'PATCH' && patch) {
            for (const hook of beforeUpload.splice(0)) await hook();
            const file = files.get(patch[1]);
            file.blob = body;
            file.version += 1;
            return reply(200, { id: patch[1], version: String(file.version) });
        }
        return reply(500, { error: { message: `unhandled ${method} ${url}` } });
    }
    function assertParent(metadata) { const folder = files.get(metadata.parents?.[0]); if (!folder?.folder) throw new Error('files must go into the sync folder'); }
    return { http, files, calls, beforeUpload, names: () => [...files.values()].filter(file => !file.folder).map(file => file.name).sort() };
}
