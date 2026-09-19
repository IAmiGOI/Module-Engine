import assert from 'node:assert/strict';
import { computeGitBlobSha } from '../../libraries/core/content-hash.js';

/** Маленький GitHub в памяти: ровно те запросы, что использует сторона репозитория. */
export function createFakeGithub({ empty = false } = {}) {
    const blobs = new Map();       // sha -> Uint8Array
    const trees = new Map();       // treeSha -> { path: sha }
    const commits = new Map();     // commitSha -> { tree, parents }
    let headCommit = null;
    let counter = 0;
    const calls = [];
    const reply = (status, data, extra = {}) => ({ status, ok: status >= 200 && status < 300, text: JSON.stringify(data ?? {}), headers: {}, ...extra });

    async function commitFiles(files) {
        const shaByPath = {};
        for (const [path, text] of Object.entries(files)) {
            const bytes = new TextEncoder().encode(text);
            const sha = await computeGitBlobSha(bytes);
            blobs.set(sha, bytes);
            shaByPath[path] = sha;
        }
        counter += 1;
        trees.set(`tree${counter}`, shaByPath);
        commits.set(`commit${counter}`, { tree: `tree${counter}`, parents: headCommit ? [headCommit] : [] });
        headCommit = `commit${counter}`;
    }
    if (!empty) commitFiles({});

    async function http({ url, method = 'GET', headers, body }) {
        const path = url.replace('https://api.github.com/repos/o/r', '');
        calls.push(`${method} ${path.split('?')[0]}`);
        assert.equal(headers.Authorization, 'Bearer secret-token');
        const data = body ? JSON.parse(body) : null;
        if (method === 'GET' && path === '') return reply(200, { full_name: 'o/r' });
        if (method === 'GET' && path.startsWith('/branches/')) {
            if (!headCommit) return reply(404, { message: 'Branch not found' });
            return reply(200, { commit: { sha: headCommit, commit: { tree: { sha: commits.get(headCommit).tree } } } });
        }
        if (method === 'GET' && path.startsWith('/git/trees/')) {
            const files = trees.get(path.split('?')[0].split('/').pop());
            return reply(200, { truncated: false, tree: Object.entries(files).map(([p, sha]) => ({ path: p, type: 'blob', sha, size: blobs.get(sha).length })) });
        }
        if (method === 'GET' && path.startsWith('/contents/')) {
            const wanted = decodeURIComponent(path.slice('/contents/'.length).split('?')[0]);
            const sha = trees.get(commits.get(headCommit).tree)[wanted];
            if (!sha) return reply(404, { message: 'Not Found' });
            return { status: 200, ok: true, text: '', headers: {}, blob: new Blob([blobs.get(sha)]) };
        }
        if (method === 'PUT' && path.startsWith('/contents/')) { await commitFiles({ [decodeURIComponent(path.slice(10))]: 'init' }); return reply(201, {}); }
        if (method === 'POST' && path === '/git/blobs') {
            if (!headCommit) return reply(409, { message: 'Git Repository is empty.' });
            const bytes = Uint8Array.from(atob(data.content), char => char.charCodeAt(0));
            const sha = await computeGitBlobSha(bytes);
            blobs.set(sha, bytes);
            return reply(201, { sha });
        }
        if (method === 'POST' && path === '/git/trees') {
            const next = { ...trees.get(data.base_tree) };
            for (const item of data.tree) { if (item.sha === null) delete next[item.path]; else next[item.path] = item.sha; }
            counter += 1;
            trees.set(`tree${counter}`, next);
            return reply(201, { sha: `tree${counter}` });
        }
        if (method === 'POST' && path === '/git/commits') {
            counter += 1;
            commits.set(`commit${counter}`, { tree: data.tree, parents: data.parents, message: data.message });
            return reply(201, { sha: `commit${counter}` });
        }
        if (method === 'PATCH' && path.startsWith('/git/refs/heads/')) {
            if (!commits.get(data.sha).parents.includes(headCommit)) return reply(422, { message: 'Update is not a fast forward' });
            headCommit = data.sha;
            return reply(200, {});
        }
        return reply(500, { message: `unhandled ${method} ${path}` });
    }
    return { http, calls, files: () => trees.get(commits.get(headCommit).tree), commitCount: () => commits.size, headCommit: () => headCommit, textOf: sha => new TextDecoder().decode(blobs.get(sha)), commitFiles, commits };
}

