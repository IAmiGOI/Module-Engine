import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTreeItems, createGithubRemote, describeGithubFailure, isGithubConfigured, manifestFromTree, parseRepositoryInput, sanitizeGithubSettings } from '../libraries/core/sync-github.js';
import { runSync } from '../libraries/core/sync-runner.js';
import { computeGitBlobSha } from '../libraries/core/content-hash.js';
import { createFakeGithub } from './helpers/fake-github.js';

const settings = sanitizeGithubSettings({ enabled: true, repository: 'https://github.com/o/r', token: 'secret-token' });

function localSide(initial = {}) {
    const files = new Map(Object.entries(initial));
    return {
        files,
        async manifest() { const out = {}; for (const [path, text] of files) out[path] = { hash: await computeGitBlobSha(new TextEncoder().encode(text)), size: text.length, modified: 1 }; return out; },
        async read(path) { return new Blob([files.get(path)]); },
        async write(path, blob) { files.set(path, await blob.text()); },
        async remove(path) { files.delete(path); },
    };
}

test('repository input is understood in the common spellings and rejected otherwise', () => {
    for (const text of ['o/r', 'https://github.com/o/r', 'https://github.com/o/r.git', 'git@github.com:o/r.git', ' o/r/ ']) {
        assert.deepEqual(parseRepositoryInput(text), { owner: 'o', repo: 'r' }, text);
    }
    assert.equal(parseRepositoryInput('just-a-word'), null);
    assert.equal(parseRepositoryInput('https://gitlab.com/o/r'), null);
});

test('settings are sanitized: a size cap in MB is clamped, the root folder is trimmed, it only counts as configured with a token', () => {
    const clean = sanitizeGithubSettings({ enabled: true, repository: 'o/r', branch: '  ', token: ' tok ', rootDir: '/sync/../x/', maxFileMb: 9999 });
    assert.equal(clean.branch, 'main');
    assert.equal(clean.token, 'tok');
    assert.equal(clean.rootDir, 'sync/x');
    assert.equal(clean.maxFileBytes, 95 * 1024 * 1024);
    assert.equal(isGithubConfigured(clean), true);
    assert.equal(isGithubConfigured({ ...clean, token: '' }), false);
    assert.equal(isGithubConfigured(sanitizeGithubSettings({})), false);
});

test('an already sanitized settings object survives being sanitized again, size cap included', () => {
    const once = sanitizeGithubSettings({ enabled: true, repository: 'o/r', token: 't', maxFileMb: 7 });
    assert.deepEqual(sanitizeGithubSettings(once), once);
});

test('the tree becomes a manifest relative to the root folder, skipping folders, the init file and foreign paths', () => {
    const manifest = manifestFromTree([
        { path: 'sync', type: 'tree' },
        { path: 'sync/backgrounds/a.png', type: 'blob', sha: 'h1', size: 5 },
        { path: 'sync/.stme-sync', type: 'blob', sha: 'x' },
        { path: 'README.md', type: 'blob', sha: 'y' },
    ], 'sync');
    assert.deepEqual(manifest, { 'backgrounds/a.png': { hash: 'h1', size: 5, modified: 0 } });
    assert.deepEqual(buildTreeItems({ writes: [{ path: 'a', sha: 's' }], deletes: ['b'] }, 'sync'), [
        { path: 'sync/a', mode: '100644', type: 'blob', sha: 's' },
        { path: 'sync/b', mode: '100644', type: 'blob', sha: null },
    ]);
});

test('failures are described in plain words', () => {
    assert.match(describeGithubFailure(401), /token/);
    assert.match(describeGithubFailure(403, '', { 'x-ratelimit-remaining': '0' }), /rate limit/);
    assert.match(describeGithubFailure(404), /not found/);
    assert.match(describeGithubFailure(422, JSON.stringify({ message: 'nope' })), /nope/);
});

test('a sync pushes only the changed files as ONE commit, and a repeat sync makes no requests beyond listing', async () => {
    const github = createFakeGithub();
    const local = localSide({ 'backgrounds/a.png': 'AAA', 'chats/x.jsonl': 'line1' });
    const remote = createGithubRemote({ http: github.http, settings, deviceName: 'PC' });
    const first = await runSync({ local, remote, base: {} });
    assert.equal(first.ok, true, JSON.stringify(first.errors));
    assert.equal(first.counts.pushed, 2);
    assert.equal(github.commitCount(), 2, 'the initial empty commit plus exactly one sync commit');
    assert.deepEqual(Object.keys(github.files()).sort(), ['backgrounds/a.png', 'chats/x.jsonl']);
    assert.match(github.commits.get(github.headCommit()).message, /Sync from PC: 2 changed, 0 removed/);

    github.calls.length = 0;
    const second = await runSync({ local, remote: createGithubRemote({ http: github.http, settings }), base: first.base });
    assert.deepEqual(second.counts, { pushed: 0, pulled: 0, deletedLocal: 0, deletedRemote: 0, conflicts: 0, failed: 0, deferred: 0 });
    assert.deepEqual(github.calls, ['GET /branches/main', 'GET /git/trees/tree1'.replace('tree1', github.calls[1].split('/').pop())], 'only the listing');

    local.files.set('chats/x.jsonl', 'line1\nline2');
    const third = await runSync({ local, remote: createGithubRemote({ http: github.http, settings }), base: second.base });
    assert.equal(third.counts.pushed, 1);
    assert.equal(github.commitCount(), 3);
    assert.equal(github.calls.filter(call => call === 'POST /git/blobs').length, 1, 'only one blob uploaded — the unchanged file was not re-sent');
});

test('files changed in the repository are pulled down, and deletions on either side propagate', async () => {
    const github = createFakeGithub();
    await github.commitFiles({ 'worlds/lore.json': '{"a":1}', 'backgrounds/old.png': 'OLD' });
    const local = localSide({ 'backgrounds/old.png': 'OLD' });
    const first = await runSync({ local, remote: createGithubRemote({ http: github.http, settings }), base: {} });
    assert.equal(local.files.get('worlds/lore.json'), '{"a":1}');

    local.files.delete('backgrounds/old.png');
    const second = await runSync({ local, remote: createGithubRemote({ http: github.http, settings }), base: first.base });
    assert.equal(second.counts.deletedRemote, 1);
    assert.equal('backgrounds/old.png' in github.files(), false);
});

test('an empty repository is initialized on the first push', async () => {
    const github = createFakeGithub({ empty: true });
    const local = localSide({ 'a.png': 'A' });
    const result = await runSync({ local, remote: createGithubRemote({ http: github.http, settings }), base: {} });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.deepEqual(Object.keys(github.files()).sort(), ['.stme-sync', 'a.png']);
});

test('a file above the size cap is refused with a clear reason and never reaches GitHub', async () => {
    const github = createFakeGithub();
    const tiny = { ...settings, maxFileBytes: 3 };
    const local = localSide({ 'big.bin': '0123456789', 'ok.bin': 'ab' });
    const result = await runSync({ local, remote: createGithubRemote({ http: github.http, settings: tiny }), base: {} });
    assert.equal(result.counts.pushed, 1);
    assert.match(result.errors[0].message, /larger than/);
    assert.deepEqual(Object.keys(github.files()), ['ok.bin']);
});

test('if the branch moved between listing and committing, nothing is remembered as synced', async () => {
    const github = createFakeGithub();
    const remote = createGithubRemote({ http: github.http, settings });
    const local = localSide({ 'a': '1' });
    const racing = { ...remote, async commit() { await github.commitFiles({ 'other-device.txt': 'x' }); return remote.commit(); } };
    Object.defineProperty(racing, 'batched', { value: true });
    const result = await runSync({ local, remote: racing, base: {} });
    assert.equal(result.ok, false);
    assert.deepEqual(result.base, {});
    assert.match(result.errors.at(-1).message, /rejected the change|fast forward|moved/);
});

test('a wrong token gives a readable error instead of a crash', async () => {
    const http = async () => ({ status: 401, ok: false, text: '{"message":"Bad credentials"}', headers: {} });
    await assert.rejects(createGithubRemote({ http, settings }).manifest(), /token/);
});
