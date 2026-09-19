/**
 * Сторона «репозиторий GitHub» для синхронизации: легковесная — на каждый проход уходят ТОЛЬКО изменившиеся файлы и ровно один
 * коммит. Механика (Git Data API, у него нет лимита в один файл на запрос, как у Contents API):
 *   1. один запрос — ветка → коммит → дерево; дерево целиком (`recursive`) даёт хеши всех файлов репозитория — они в том же формате
 *      «git blob sha», что и локальные (см. [content-hash.js](content-hash.js)), поэтому что изменилось видно БЕЗ скачивания;
 *   2. изменившиеся файлы заливаются как blob'ы (`git/blobs`), удалённые помечаются `sha: null`;
 *   3. одно новое дерево от прежнего (`base_tree`), один коммит, сдвиг ветки.
 * Файлы скачиваются Contents API в сыром виде (до 100 МБ; работает и для приватных репозиториев с токеном).
 *
 * Сеть приходит инъекцией (`http`) — тесты гоняют всё против фейкового GitHub в памяти. Сторона «пакетная» (`batched`): исполнитель
 * зовёт `commit()` один раз в конце и лишь тогда считает отправленное синхронизированным.
 */

const API = 'https://api.github.com';
export const DEFAULT_GITHUB_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const GITHUB_HARD_LIMIT_BYTES = 95 * 1024 * 1024;
const INIT_FILE = '.stme-sync';

/** `owner/repo`, `https://github.com/owner/repo(.git)`, `git@github.com:owner/repo.git` → `{ owner, repo }` или `null`. */
export function parseRepositoryInput(input) {
    const text = String(input ?? '').trim().replace(/\.git$/i, '').replace(/\/+$/, '');
    const match = /^(?:https?:\/\/github\.com\/|git@github\.com:)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(text);
    return match ? { owner: match[1], repo: match[2] } : null;
}

export function sanitizeGithubSettings(raw = {}) {
    const parsed = parseRepositoryInput(raw.repository ?? `${raw.owner ?? ''}/${raw.repo ?? ''}`);
    const maxMb = Number(raw.maxFileMb ?? Number(raw.maxFileBytes) / 1048576);
    const rootDir = String(raw.rootDir ?? '').split('/').map(segment => segment.trim()).filter(segment => segment && segment !== '.' && segment !== '..').join('/');
    return {
        enabled: Boolean(raw.enabled),
        owner: parsed?.owner ?? '',
        repo: parsed?.repo ?? '',
        branch: String(raw.branch ?? 'main').trim() || 'main',
        token: String(raw.token ?? '').trim(),
        rootDir,
        maxFileBytes: Number.isFinite(maxMb) && maxMb > 0 ? Math.min(Math.round(maxMb * 1024 * 1024), GITHUB_HARD_LIMIT_BYTES) : DEFAULT_GITHUB_MAX_FILE_BYTES,
    };
}

export const isGithubConfigured = settings => Boolean(settings?.enabled && settings.owner && settings.repo && settings.token);

const encodePath = path => String(path).split('/').map(encodeURIComponent).join('/');

/** Понятное сообщение вместо «HTTP 403». */
export function describeGithubFailure(status, bodyText = '', headers = {}) {
    let detail = '';
    try { detail = JSON.parse(bodyText)?.message ?? ''; } catch { detail = ''; }
    if (status === 401) return 'GitHub rejected the token (401): check that it is correct and not expired.';
    if (status === 403 && headers['x-ratelimit-remaining'] === '0') return 'GitHub rate limit reached (403): try again later.';
    if (status === 403) return `GitHub refused access (403): the token needs write access to this repository. ${detail}`.trim();
    if (status === 404) return 'GitHub says the repository or branch was not found (404): check the name and that the token can see it.';
    if (status === 409) return 'The repository is empty (409).';
    if (status === 422) return `GitHub rejected the change (422): ${detail || 'the branch moved — it will be retried on the next sync'}.`;
    return `GitHub answered HTTP ${status}${detail ? `: ${detail}` : ''}`;
}

/** Записи дерева → манифест «путь → { hash, size }» относительно `rootDir`; каталоги и файлы вне корня отбрасываются. */
export function manifestFromTree(tree = [], rootDir = '') {
    const prefix = rootDir ? `${rootDir}/` : '';
    const entries = {};
    for (const item of tree) {
        if (item.type !== 'blob' || !item.path.startsWith(prefix)) continue;
        const path = item.path.slice(prefix.length);
        if (!path || path === INIT_FILE || path.split('/').some(segment => segment === '.git')) continue;
        entries[path] = { hash: item.sha, size: item.size ?? 0, modified: 0 };
    }
    return entries;
}

/** Правки → элементы нового дерева. `sha: null` удаляет файл. */
export function buildTreeItems({ writes = [], deletes = [] } = {}, rootDir = '') {
    const prefix = rootDir ? `${rootDir}/` : '';
    return [
        ...writes.map(({ path, sha }) => ({ path: `${prefix}${path}`, mode: '100644', type: 'blob', sha })),
        ...deletes.map(path => ({ path: `${prefix}${path}`, mode: '100644', type: 'blob', sha: null })),
    ];
}

export function createGithubRemote({ http, settings, deviceName = 'device', toBase64 = blob => blobToBase64(blob) } = {}) {
    const headers = (extra = {}) => ({ Accept: 'application/vnd.github+json', Authorization: `Bearer ${settings.token}`, 'X-GitHub-Api-Version': '2022-11-28', ...extra });
    const repoUrl = `${API}/repos/${settings.owner}/${settings.repo}`;
    let head = null;   // { commit, tree }
    const writes = [];
    const deletes = [];

    async function api(path, { method = 'GET', body, accept, responseType } = {}) {
        const response = await http({
            url: path.startsWith('http') ? path : `${repoUrl}${path}`,
            method,
            headers: headers({ ...(body ? { 'Content-Type': 'application/json' } : {}), ...(accept ? { Accept: accept } : {}) }),
            body: body ? JSON.stringify(body) : undefined,
            responseType,
        });
        return response;
    }
    const json = response => { try { return JSON.parse(response.text); } catch { return null; } };
    const fail = response => new Error(describeGithubFailure(response.status, response.text, response.headers));

    /** Пустой репозиторий не принимает blob'ы — создаём служебный файл, и появляется первая ветка. */
    async function initializeEmptyRepository() {
        const created = await api(`/contents/${encodePath(settings.rootDir ? `${settings.rootDir}/${INIT_FILE}` : INIT_FILE)}`, {
            method: 'PUT',
            body: { message: 'Initialize sync', content: btoa('ST Module Engine sync'), branch: settings.branch },
        });
        if (!created.ok) throw fail(created);
    }

    async function loadHead() {
        const response = await api(`/branches/${encodeURIComponent(settings.branch)}`);
        if (response.status === 404 || response.status === 409) return null;
        if (!response.ok) throw fail(response);
        const data = json(response);
        return { commit: data?.commit?.sha, tree: data?.commit?.commit?.tree?.sha };
    }

    return {
        batched: true,

        async manifest() {
            head = await loadHead();
            if (!head) {
                const repository = await api('');
                if (!repository.ok) throw fail(repository);
                return {};
            }
            const response = await api(`/git/trees/${head.tree}?recursive=1`);
            if (!response.ok) throw fail(response);
            const data = json(response);
            if (data?.truncated) throw new Error('The repository has too many files for one listing — use a dedicated repository or a subfolder.');
            return manifestFromTree(data?.tree, settings.rootDir);
        },

        async read(path) {
            const fullPath = settings.rootDir ? `${settings.rootDir}/${path}` : path;
            const response = await api(`/contents/${encodePath(fullPath)}?ref=${encodeURIComponent(settings.branch)}`, { accept: 'application/vnd.github.raw+json', responseType: 'blob' });
            if (!response.ok || !response.blob) throw fail(response);
            return response.blob;
        },

        async write(path, blob) {
            if (blob.size > settings.maxFileBytes) throw new Error(`"${path}" is larger than the ${Math.round(settings.maxFileBytes / 1048576)} MB limit for the repository.`);
            if (!head) { await initializeEmptyRepository(); head = await loadHead(); }
            const response = await api('/git/blobs', { method: 'POST', body: { content: await toBase64(blob), encoding: 'base64' } });
            if (!response.ok) throw fail(response);
            writes.push({ path, sha: json(response)?.sha });
        },

        async remove(path) { deletes.push(path); },

        async commit() {
            if (!writes.length && !deletes.length) return null;
            if (!head) throw new Error('GitHub commit: the branch head is unknown.');
            const tree = await api('/git/trees', { method: 'POST', body: { base_tree: head.tree, tree: buildTreeItems({ writes, deletes }, settings.rootDir) } });
            if (!tree.ok) throw fail(tree);
            const message = `Sync from ${deviceName}: ${writes.length} changed, ${deletes.length} removed`;
            const commit = await api('/git/commits', { method: 'POST', body: { message, tree: json(tree)?.sha, parents: [head.commit] } });
            if (!commit.ok) throw fail(commit);
            const sha = json(commit)?.sha;
            const ref = await api(`/git/refs/heads/${encodeURIComponent(settings.branch)}`, { method: 'PATCH', body: { sha, force: false } });
            if (!ref.ok) throw fail(ref);
            writes.length = 0;
            deletes.length = 0;
            head = { commit: sha, tree: json(tree)?.sha };
            return sha;
        },
    };
}

async function blobToBase64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return btoa(binary);
}
