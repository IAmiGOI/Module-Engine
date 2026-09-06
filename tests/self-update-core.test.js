import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerHttpService } from '../services/http.js';
import { registerStExtensionsService } from '../services/st-extensions.js';
import { registerSessionService } from '../services/session.js';
import { createSelfUpdateCore } from '../cores/self-update/index.js';
import { deriveExtensionName, parseCommitSha, commitsMatch, describeUpdateDiagnosis } from '../libraries/core/update-check.js';

// --- Чистые функции ---------------------------------------------------------

test('deriveExtensionName() reads the folder name for BOTH install shapes — they look identical in the URL', () => {
    assert.equal(deriveExtensionName('http://x/scripts/extensions/third-party/Module-Engine/index.js'), 'Module-Engine');
    assert.equal(deriveExtensionName('http://x/scripts/extensions/Module-Engine/index.js'), 'Module-Engine');
});

test('deriveExtensionName() returns null outside a real ST page instead of throwing', () => {
    assert.equal(deriveExtensionName('file:///tmp/whatever.js'), null);
    assert.equal(deriveExtensionName(undefined), null);
});

test('parseCommitSha() reads the raw SHA GitHub returns for the sha media type', () => {
    assert.equal(parseCommitSha('  0a1b2c3d4e5f60718293a4b5c6d7e8f901234567 \n'), '0a1b2c3d4e5f60718293a4b5c6d7e8f901234567');
});

test('parseCommitSha() falls back to the JSON commit object — a proxy can strip our Accept header', () => {
    assert.equal(parseCommitSha('{"sha":"abc123","commit":{}}'), 'abc123');
});

test('parseCommitSha() returns null for a body that is neither — an error page must not read as a commit', () => {
    assert.equal(parseCommitSha('<html>404</html>'), null);
});

test('commitsMatch() ignores case — SillyTavern and GitHub disagree on it, and a literal compare never matched', () => {
    assert.equal(commitsMatch('ABC123', 'abc123'), true);
    assert.equal(commitsMatch('abc123', 'def456'), false);
    assert.equal(commitsMatch(null, 'abc123'), false);
});

test('describeUpdateDiagnosis() calls out the exact bug Alpha could never prove: "up to date" while the commits differ', () => {
    const described = describeUpdateDiagnosis(
        { applicable: true, matches: false, localSha: 'aaaaaaa1111', remoteSha: 'bbbbbbb2222', branch: 'main' },
        { upToDate: true },
    );

    assert.equal(described.level, 'warn');
    assert.match(described.text, /MISMATCH/);
    assert.match(described.text, /aaaaaaa/);
    assert.match(described.text, /bbbbbbb/);
});

test('describeUpdateDiagnosis() stays quiet-toned when ST already knows it is behind — that is normal, not a fault', () => {
    const described = describeUpdateDiagnosis(
        { applicable: true, matches: false, localSha: 'aaaaaaa', remoteSha: 'bbbbbbb', branch: 'main' },
        { upToDate: false },
    );

    assert.equal(described.level, 'info');
    assert.doesNotMatch(described.text, /MISMATCH/);
});

// --- Сценарный уровень ------------------------------------------------------

const SHA_LOCAL = '1111111111111111111111111111111111111111';
const SHA_REMOTE = '2222222222222222222222222222222222222222';

function buildEngine({ discover, version, update, remoteSha = SHA_LOCAL, sessionAt = '0', githubOk = true } = {}) {
    const engine = createEngine();
    const calls = { version: [], update: [], reloads: 0, session: {} };

    const stFetch = async (url, init) => {
        if (url.endsWith('/discover')) {
            if (!discover) return { ok: false, status: 404, json: async () => ({}) };
            return { ok: true, status: 200, json: async () => discover };
        }
        const body = JSON.parse(init.body);
        if (url.endsWith('/version')) {
            calls.version.push(body);
            if (!version) return { ok: false, status: 404, json: async () => ({}) };
            return { ok: true, status: 200, json: async () => version };
        }
        calls.update.push(body);
        if (!update) return { ok: false, status: 500, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => update };
    };
    registerStExtensionsService(engine.buses.services, { getContext: () => ({ getRequestHeaders: () => ({ 'X-Csrf': 'token' }) }), fetch: stFetch });

    registerSessionService(engine.buses.services, {
        storage: { getItem: key => calls.session[key] ?? sessionAt, setItem: (key, value) => { calls.session[key] = value; } },
        reload: () => { calls.reloads += 1; },
    });

    registerHttpService(engine.buses.network, {
        fetch: async () => ({ status: githubOk ? 200 : 500, ok: githubOk, headers: { entries: () => [] }, text: async () => remoteSha }),
    });

    const logs = [];
    const host = engine.registerCaller('core.selfUpdate', 'cores', { tier: 'official', networkAccess: true });
    const core = createSelfUpdateCore(host, {
        extensionName: 'Module-Engine',
        owner: 'IAmiGOI',
        repo: 'Module-Engine',
        log: { info: (...args) => logs.push(['info', args.join(' ')]), warn: (...args) => logs.push(['warn', args.join(' ')]), error: (...args) => logs.push(['error', args.join(' ')]) },
        now: () => 1_000_000,
    });
    return { engine, core, calls, logs };
}

test('a per-user install is NOT reported as global — the bug that made a real tester 404 for months', async () => {
    const { core, calls } = buildEngine({
        discover: [{ type: 'local', name: 'third-party/Module-Engine' }],
        version: { isUpToDate: true, currentCommitHash: SHA_LOCAL, currentBranchName: 'main' },
    });

    await core.check();

    assert.equal(calls.version[0].global, undefined, 'запрос уходит БЕЗ global — иначе сервер ищет не в той папке');
});

test('a real global install IS reported as global', async () => {
    const { core, calls } = buildEngine({
        discover: [{ type: 'global', name: 'third-party/Module-Engine' }],
        version: { isUpToDate: true, currentCommitHash: SHA_LOCAL, currentBranchName: 'main' },
    });

    await core.check();

    assert.equal(calls.version[0].global, true);
});

test('an unreachable discover falls back to "not global" — the safe side of a choice that has no safe default', async () => {
    const { core } = buildEngine({ version: { isUpToDate: true, currentCommitHash: SHA_LOCAL, currentBranchName: 'main' } });

    assert.equal(await core.isGlobalInstall(), false);
});

test('a non-git install reports "nothing to check" instead of an error the user has to see', async () => {
    const { core } = buildEngine({ discover: [] });

    const status = await core.check();

    assert.equal(status.checked, false);
});

test('the commit hash and branch ST returns are kept — without them there is nothing to cross-check', async () => {
    const { core } = buildEngine({
        discover: [{ type: 'local', name: 'third-party/Module-Engine' }],
        version: { isUpToDate: true, currentCommitHash: SHA_LOCAL, currentBranchName: 'main', remoteUrl: 'https://github.com/IAmiGOI/Module-Engine' },
    });

    const status = await core.check();

    assert.equal(status.currentCommitHash, SHA_LOCAL);
    assert.equal(status.currentBranchName, 'main');
});

test('being up to date does nothing at all — no update, no reload, no noise', async () => {
    const { core, calls } = buildEngine({
        discover: [{ type: 'local', name: 'third-party/Module-Engine' }],
        version: { isUpToDate: true, currentCommitHash: SHA_LOCAL, currentBranchName: 'main' },
    });

    const result = await core.run();

    assert.equal(result.outcome, 'up-to-date');
    assert.deepEqual(calls.update, []);
    assert.equal(calls.reloads, 0);
});

test('being behind pulls and reloads', async () => {
    const { core, calls } = buildEngine({
        discover: [{ type: 'local', name: 'third-party/Module-Engine' }],
        version: { isUpToDate: false, currentCommitHash: SHA_LOCAL, currentBranchName: 'main' },
        update: { isUpToDate: true },
        remoteSha: SHA_REMOTE,
    });

    const result = await core.run();

    assert.equal(result.outcome, 'updated');
    assert.equal(calls.update.length, 1);
    assert.equal(calls.reloads, 1);
});

test('a failed pull reports the failure and does NOT reload — reloading would just lose the message', async () => {
    const { core, calls } = buildEngine({
        discover: [{ type: 'local', name: 'third-party/Module-Engine' }],
        version: { isUpToDate: false, currentCommitHash: SHA_LOCAL, currentBranchName: 'main' },
        remoteSha: SHA_REMOTE,
    });

    const result = await core.run();

    assert.equal(result.outcome, 'failed');
    assert.equal(calls.reloads, 0);
});

test('the "we just tried" mark is a TIME, so a later check is not blocked forever', async () => {
    const { core } = buildEngine({
        discover: [{ type: 'local', name: 'third-party/Module-Engine' }],
        version: { isUpToDate: false, currentCommitHash: SHA_LOCAL, currentBranchName: 'main' },
        update: { isUpToDate: true },
        sessionAt: String(1_000_000 - 5000), // пять секунд назад — ещё остывает
    });

    assert.equal((await core.run()).outcome, 'cooling-down');
    assert.equal((await core.run({ force: true })).outcome, 'updated', 'явное действие пользователя паузу не соблюдает');
});

test('a mark from long ago does not block anything — Alpha\'s permanent flag killed every later check', async () => {
    const { core } = buildEngine({
        discover: [{ type: 'local', name: 'third-party/Module-Engine' }],
        version: { isUpToDate: true, currentCommitHash: SHA_LOCAL, currentBranchName: 'main' },
        sessionAt: '1', // 1970 год
    });

    assert.equal((await core.run()).outcome, 'up-to-date');
});

test('"up to date" while GitHub disagrees is WARNED about — the whole point of the direct code check', async () => {
    const { core, logs } = buildEngine({
        discover: [{ type: 'local', name: 'third-party/Module-Engine' }],
        version: { isUpToDate: true, currentCommitHash: SHA_LOCAL, currentBranchName: 'main' },
        remoteSha: SHA_REMOTE,
    });

    await core.run();

    const warning = logs.find(([level]) => level === 'warn');
    assert.ok(warning, 'расхождение обязано быть слышно');
    assert.match(warning[1], /MISMATCH/);
});

test('an unreachable GitHub never blocks the real update — the check observes, it does not decide', async () => {
    const { core, calls } = buildEngine({
        discover: [{ type: 'local', name: 'third-party/Module-Engine' }],
        version: { isUpToDate: false, currentCommitHash: SHA_LOCAL, currentBranchName: 'main' },
        update: { isUpToDate: true },
        githubOk: false,
    });

    const result = await core.run();

    assert.equal(result.outcome, 'updated');
    assert.equal(result.diagnosis.applicable, false);
});

test('a Core with no network right cannot reach GitHub — self-update is not exempt from the network Gate', async () => {
    const engine = createEngine();
    registerHttpService(engine.buses.network, { fetch: async () => ({ status: 200, ok: true, headers: { entries: () => [] }, text: async () => SHA_REMOTE }) });
    const host = engine.registerCaller('core.selfUpdate', 'cores', { tier: 'official' }); // networkAccess не выдан
    const core = createSelfUpdateCore(host, { extensionName: 'Module-Engine', owner: 'IAmiGOI', repo: 'Module-Engine', log: {} });

    const diagnosis = await core.diagnose({ currentCommitHash: SHA_LOCAL, currentBranchName: 'main' });

    assert.equal(diagnosis.applicable, false);
});

test('the ST extensions Сервис calls fetch WITH a receiver — an unbound browser fetch answers "Illegal invocation"', async () => {
    const engine = createEngine();
    // Браузерный `fetch` требует, чтобы `this` был окном. В Node он к этому
    // равнодушен, поэтому строгость воспроизводим сами — иначе проверка не
    // ловила бы ровно тот отказ, из-за которого самообновление не работало
    // вообще и молча.
    const original = globalThis.fetch;
    let receiver = 'never called';
    globalThis.fetch = function strictFetch() {
        receiver = this;
        if (this !== globalThis) throw new TypeError('Illegal invocation');
        return Promise.resolve({ ok: true, json: async () => [{ type: 'global', name: 'third-party/Module-Engine' }] });
    };
    try {
        registerStExtensionsService(engine.buses.services, { getContext: () => ({}) });
        const core = createSelfUpdateCore(engine.registerCaller('core.selfUpdate', 'cores', { tier: 'official', networkAccess: true }),
            { extensionName: 'third-party/Module-Engine', owner: 'IAmiGOI', repo: 'Module-Engine' });

        assert.equal(await core.isGlobalInstall(), true);
        assert.equal(receiver, globalThis, 'fetch получил окно, а не undefined');
    } finally {
        globalThis.fetch = original;
    }
});
