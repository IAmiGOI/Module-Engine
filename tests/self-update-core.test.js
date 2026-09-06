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
            // Функция — чтобы ответ мог ЗАВИСЕТЬ от того, про какую установку спросили:
            // у настоящей ST это две РАЗНЫЕ папки, и промах — это 404.
            const answer = typeof version === 'function' ? version(body) : version;
            if (!answer) return { ok: false, status: 404, json: async () => ({}) };
            return { ok: true, status: 200, json: async () => answer };
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
        // Пять секунд назад — ещё остывает. Запись СТРУКТУРНАЯ (не голое
        // время): `outcome` отличает «применилось/не применилось» от «попытка
        // не завершилась» (см. следующий тест) — паузу держит только первое.
        sessionAt: JSON.stringify({ at: 1_000_000 - 5000, outcome: 'updated' }),
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

test('a wrong guess about the install type is CORRECTED by a second try, not left as a silent 404', async () => {
    // `/discover` недоступен → «не общая». Но расширение лежит именно в общей
    // папке: без второй попытки это был бы 404 и полное молчание — та самая
    // болезнь Alpha, только зашедшая с другой стороны.
    const { core, calls } = buildEngine({
        discover: null,
        version: body => (body.global ? { isUpToDate: true, currentCommitHash: SHA_LOCAL, currentBranchName: 'Main-Stable' } : null),
    });

    const status = await core.check();

    assert.equal(status.checked, true);
    assert.equal(status.global, true, 'вторая попытка нашла общую установку');
    assert.deepEqual(calls.version.map(entry => Boolean(entry.global)), [false, true], 'сначала догадка, потом другой вариант');
});

test('when BOTH tries fail the reason survives all the way out — "unavailable" alone is undebuggable', async () => {
    const { core } = buildEngine({ discover: null, version: null });

    const outcome = await core.run({ force: true });

    assert.equal(outcome.outcome, 'unavailable');
    assert.match(outcome.reason, /per-user lookup/);
    assert.match(outcome.reason, /global lookup/);
});

test('the update ANNOUNCES its run — the screen is drawn by someone else, and has no other way to know', async () => {
    const { engine, core } = buildEngine({
        discover: [],
        version: { isUpToDate: false, currentCommitHash: SHA_LOCAL, currentBranchName: 'Main-Stable' },
        update: { isUpToDate: true },
    });
    const seen = [];
    for (const event of ['selfUpdate.started', 'selfUpdate.applied', 'selfUpdate.failed', 'selfUpdate.upToDate']) {
        engine.events.subscribe(event, () => seen.push(event));
    }

    await core.run({ force: true });

    assert.deepEqual(seen, ['selfUpdate.started', 'selfUpdate.applied']);
});

test('a failed pull announces the failure WITH its reason — the banner has nothing else to show', async () => {
    const { engine, core } = buildEngine({
        discover: [],
        version: { isUpToDate: false, currentCommitHash: SHA_LOCAL, currentBranchName: 'Main-Stable' },
        update: null,
    });
    const seen = [];
    engine.events.subscribe('selfUpdate.failed', payload => seen.push(payload));

    await core.run({ force: true });

    assert.equal(seen.length, 1);
    assert.match(String(seen[0].reason), /HTTP 500/);
});

test('being up to date announces exactly that, and NOTHING that would put a screen in the way', async () => {
    const { engine, core } = buildEngine({
        discover: [],
        version: { isUpToDate: true, currentCommitHash: SHA_LOCAL, currentBranchName: 'Main-Stable' },
    });
    const seen = [];
    for (const event of ['selfUpdate.started', 'selfUpdate.upToDate']) engine.events.subscribe(event, () => seen.push(event));

    await core.run({ force: true });

    assert.deepEqual(seen, ['selfUpdate.upToDate']);
});

test('a check that could not run at all stays SILENT on boot, and speaks only when a person asked', async () => {
    const quiet = buildEngine({ discover: null, version: null });
    const asked = buildEngine({ discover: null, version: null });
    const quietSeen = [];
    const askedSeen = [];
    quiet.engine.events.subscribe('selfUpdate.failed', payload => quietSeen.push(payload));
    asked.engine.events.subscribe('selfUpdate.failed', payload => askedSeen.push(payload));

    await quiet.core.run();          // автоматический ход при старте
    await asked.core.run({ force: true }); // нажатая кнопка

    assert.deepEqual(quietSeen, [], 'не-git установка не повод шуметь у того, кто просто скопировал папку');
    assert.equal(askedSeen.length, 1, 'а на явное нажатие промолчать нельзя');
});

// --- Пауза остывания: пережить перезагрузку, не потерять сообщение --------

test('cooling down after a FAILED attempt re-announces the failure on the next automatic check — a page reload must not make the banner vanish along with the tab', async () => {
    const { engine, core } = buildEngine({
        discover: [],
        version: { isUpToDate: false, currentCommitHash: SHA_LOCAL, currentBranchName: 'Main-Stable' },
        update: null, // apply() откажет
    });
    await core.run({ force: true }); // первая попытка — провалилась, пауза началась
    const seen = [];
    engine.events.subscribe('selfUpdate.failed', payload => seen.push(payload));

    const outcome = await core.run(); // автоматическая проверка — как при перезагрузке

    assert.equal(outcome.outcome, 'cooling-down');
    assert.equal(seen.length, 1, 'полоса обязана вернуться, а не пропасть вместе с перезагрузкой');
    assert.match(String(seen[0].reason), /HTTP 500/);
});

test('cooling down after a SUCCESSFUL update stays silent — nothing failed, there is nothing to say', async () => {
    const { engine, core } = buildEngine({
        discover: [],
        version: { isUpToDate: false, currentCommitHash: SHA_LOCAL, currentBranchName: 'Main-Stable' },
        update: { isUpToDate: true },
    });
    await core.run({ force: true }); // применилось и «перезагрузилось»
    const seen = [];
    for (const event of ['selfUpdate.failed', 'selfUpdate.started']) engine.events.subscribe(event, payload => seen.push(payload));

    const outcome = await core.run();

    assert.equal(outcome.outcome, 'cooling-down');
    assert.deepEqual(seen, [], 'успешное обновление в паузе молчит, как и раньше');
});

test('an attempt interrupted mid-apply (page reloaded before we learned the outcome) does not block the very next check — the pause exists against a loop, not against uncertainty', async () => {
    const { calls, core } = buildEngine({
        discover: [],
        version: { isUpToDate: false, currentCommitHash: SHA_LOCAL, currentBranchName: 'Main-Stable' },
        update: { isUpToDate: true },
    });
    // Имитация: страница ушла в перезагрузку/закрылась РОВНО между «начали
    // применять» и тем, как узнали исход, — запись так и осталась pending.
    calls.session['stme.beta.updateAttempt'] = JSON.stringify({ at: 1_000_000 - 1000, outcome: 'pending' });

    const outcome = await core.run(); // автоматический ход, БЕЗ force

    assert.equal(outcome.outcome, 'updated', 'неизвестный исход не считается остыванием — проверка идёт сразу же');
});

test('a stale record from BEFORE this shape existed (a bare timestamp, not JSON) is treated as no record at all, not as a crash', async () => {
    const { calls, core } = buildEngine({
        discover: [],
        version: { isUpToDate: true, currentCommitHash: SHA_LOCAL, currentBranchName: 'Main-Stable' },
    });
    calls.session['stme.beta.updateAttempt'] = '999999'; // старый формат — голое время

    await assert.doesNotReject(core.run());
});
