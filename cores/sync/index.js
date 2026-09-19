import { request } from '../../libraries/shared/request.js';
import { computeGitBlobSha } from '../../libraries/core/content-hash.js';
import { buildManifest } from '../../libraries/core/sync-manifest.js';
import { runSync } from '../../libraries/core/sync-runner.js';
import { createRpcEndpoint } from '../../libraries/core/sync-wire.js';
import {
    createBox, createPayloadJoiner, deriveFromPairingCode, deriveFromSecret, formatPairingCode, generateDeviceId,
    generatePairingCode, generateSecret, normalizePairingCode, splitPayload,
} from '../../libraries/core/sync-secrets.js';
import { createGithubRemote, isGithubConfigured, sanitizeGithubSettings } from '../../libraries/core/sync-github.js';
import { CLOUD_MAX_FILE_BYTES, createAuthedHttp, createCloudRemote, createDriveStore, createDropboxStore } from '../../libraries/core/sync-cloud.js';
import {
    buildDropboxAuthUrl, computeCodeChallenge, createTokenManager, exchangeDropboxCode, generateCodeVerifier, pollGoogleDeviceFlow, startGoogleDeviceFlow,
} from '../../libraries/core/sync-oauth.js';
import { CLOUD_PROVIDER_LABELS, resolveCloudApp } from '../../libraries/core/sync-cloud-apps.js';
import { buildIceServers, relayToIceServers, categoryOfPath, createCategoryFilter, describeConfigForUi, intersectCategories, sanitizeSyncConfig } from '../../libraries/core/sync-config.js';

/**
 * Ядро синхронизации — держит пользовательские файлы ST одинаковыми на нескольких устройствах: напрямую между устройствами
 * (WebRTC, без облака и без лимита размера) и, по желанию, через репозиторий GitHub (только изменившиеся файлы, один коммит на проход).
 *
 * Что здесь, а что в Библиотеках: сравнение файлов, исполнитель прохода, провод, шифрование, сторона GitHub, сборка манифеста —
 * чистые Библиотеки (`libraries/core/sync-*.js`, каждая с тестами на памяти). Ядро только соединяет: собирает адаптеры «сторон»
 * из Сервисов (`stUserData` — файлы ST, `syncState` — база и кэш, `syncSignal`/`syncPeer` — сеть), хранит настройки, ведёт
 * сопряжение и сессии, запускает проходы по расписанию.
 *
 * ## Модель
 *  - **Пара** — устройство, с которым мы сопряжены (общий секрет). Сопряжение: одно устройство показывает короткий одноразовый
 *    код, на другом его вводят; по коду поднимается временная «комната» на публичной доске (ntfy), где устройства обменивают
 *    настоящий долгоживущий секрет. Дальше комната выводится из секрета, код больше не нужен.
 *  - **Сессия** — живое соединение с парой. Устройство с МЕНЬШИМ `deviceId` — ведущее: оно создаёт предложение соединения и ведёт
 *    проход (сверяет манифесты, гоняет файлы, шлёт итоговую базу ведомому). Ведомый лишь отвечает на запросы (`manifest`,
 *    `read`, `write`, `remove`, `finish`) и может попросить ведущего начать проход (`requestSync`).
 *  - **База** — «что было у обеих сторон при прошлой удачной синхронизации» (хеши по путям): без неё нельзя отличить удаление
 *    от появления файла на другой стороне. Хранится локально (`syncState`), у каждой пары своя; ведущий после прохода отдаёт
 *    её ведомому, чтобы тот мог вести следующий проход сам.
 *  - **Кэш хешей** — путь → штамп и хеш: файл читается только если его штамп изменился. После записи файла (он мог измениться при
 *    импорте самим ST — карточка получает новое `create_date`) за ним закрепляется хеш источника: иначе тот же файл гонялся бы
 *    между устройствами по кругу.
 *
 * Молчит, когда сказать нечего: нет пар/сети — ничего в интерфейсе, повторится по расписанию.
 */

const NAMESPACE = 'core.sync';
const CONFIG_KEY = 'config';
const NETWORK_TIMEOUT_MS = 20000;
const PRESENCE_INTERVAL_MS = 60000;
const CONNECT_TIMEOUT_MS = 30000;
const SIGNAL_MAX_AGE_MS = 15 * 60000;
const PAIRING_TTL_MS = 10 * 60000;
const SIGNAL_SINCE = '15m';

const unwrap = result => {
    if (!result.ok) throw new Error(result.error?.message ?? 'request failed');
    return result.value;
};
const two = value => String(value).padStart(2, '0');
const stampLabel = time => { const d = new Date(time); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}-${two(d.getMinutes())}`; };
const randomHex = random => Array.from(random.getRandomValues(new Uint8Array(6)), byte => byte.toString(16).padStart(2, '0')).join('');

export function createSyncCore(host, {
    now = () => Date.now(),
    log = console,
    publish,
    random = globalThis.crypto,
    describeDevice = () => globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || 'Device',
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = handle => clearTimeout(handle),
    setRepeating = (fn, ms) => setInterval(fn, ms),
    clearRepeating = handle => clearInterval(handle),
    networkTimeoutMs = NETWORK_TIMEOUT_MS,
    connectTimeoutMs = CONNECT_TIMEOUT_MS,
    presenceIntervalMs = PRESENCE_INTERVAL_MS,
} = {}) {
    const publishEvent = publish ?? ((event, payload) => host.events.emit(event, payload));
    const service = (contract, params, options = {}) => request(host.services, contract, { params, ...options }).then(unwrap);
    const network = (contract, params, options = {}) => request(host.network, contract, { params, ...options }).then(unwrap);
    const notify = () => publishEvent('sync.changed', {});

    let config = null;
    let running = null;          // { target, startedAt }
    let abortRequested = false;
    let progress = null;
    let lastRun = null;
    let githubLast = null;
    let cloudLast = null;
    let cloudAuth = null;    // вход в облачный диск: { provider, kind: 'code' | 'device', status, url, userCode, message, … }
    let intervalHandle = null;
    let started = false;

    // ── Настройки ───────────────────────────────────────────────────────────────────────────────────────────────────

    async function loadConfig() {
        if (config) return config;
        const result = await request(host.own, 'storage.settings.get', { params: { namespace: NAMESPACE, key: CONFIG_KEY, fallback: null } });
        const stored = result.ok ? result.value : null;
        config = sanitizeSyncConfig(stored, { generateDeviceId: () => generateDeviceId({ random }), defaultDeviceName: describeDevice() });
        if (!stored?.deviceId) await saveConfig();
        return config;
    }

    async function saveConfig() {
        await request(host.own, 'storage.settings.set', { params: { namespace: NAMESPACE, key: CONFIG_KEY, value: config } });
    }

    // ── Кэш хешей, база, блокировка ────────────────────────────────────────────────────────────────────────────────

    let cacheState = null;
    let queue = Promise.resolve();
    const exclusive = task => { const result = queue.then(task, task); queue = result.catch(() => {}); return result; };
    const touchedPaths = new Set();

    const readState = async key => (await service('syncState.get', { key })) ?? null;
    const writeState = (key, value) => service('syncState.set', { key, value });

    async function loadCache() {
        if (!cacheState) cacheState = (await readState('cache')) ?? {};
        return cacheState;
    }
    async function flushCache() {
        if (cacheState) await writeState('cache', cacheState);
    }

    async function scanLocal(categories, onProgress) {
        return exclusive(async () => {
            const cache = await loadCache();
            const listing = await service('stUserData.list', { categories });
            const result = await buildManifest({ listing, cache, read: path => service('stUserData.read', { path }), hash: computeGitBlobSha, onProgress });
            const scanned = new Set(categories);
            const kept = Object.fromEntries(Object.entries(cache).filter(([path]) => !scanned.has(categoryOfPath(path))));
            cacheState = { ...kept, ...result.cache };
            await flushCache();
            return { manifest: result.manifest, failed: new Set(result.failed.map(item => item.path)) };
        });
    }

    async function writeLocal(path, blob, meta) {
        return exclusive(async () => {
            const cache = await loadCache();
            const { stamp } = await service('stUserData.write', { path, blob });
            if (stamp != null && meta?.hash) cache[path] = { stamp, hash: meta.hash }; else delete cache[path];
            touchedPaths.add(path);
        });
    }

    async function removeLocal(path) {
        return exclusive(async () => {
            const cache = await loadCache();
            await service('stUserData.remove', { path });
            delete cache[path];
            touchedPaths.add(path);
        });
    }

    function createLocalSide(categories, onProgress) {
        let failed = new Set();
        return {
            failedPaths: () => failed,
            async manifest() { const scan = await scanLocal(categories, onProgress); failed = scan.failed; return scan.manifest; },
            read: path => service('stUserData.read', { path }),
            write: writeLocal,
            remove: removeLocal,
        };
    }

    /** Обновить то, что ST держит в памяти: список персонажей и фонов. */
    async function refreshStInterface() {
        const sections = new Set([...touchedPaths].map(path => path.slice(0, path.indexOf('/'))));
        touchedPaths.clear();
        if (sections.has('characters')) await service('stUserData.refresh', { categories: ['characters'] }).catch(() => {});
        if (sections.has('backgrounds')) await service('stBackgrounds.refresh', {}).catch(() => {});
    }

    // ── Один проход против одной стороны ────────────────────────────────────────────────────────────────────────────

    function setProgress(target, state) {
        progress = state ? { target, ...state } : null;
        publishEvent('sync.progress', { progress });
    }

    async function runAgainst({ target, baseKey, remote, categories, isEnabled, extraInclude }) {
        const local = createLocalSide(categories, state => setProgress(target, { phase: 'scanning', ...state }));
        const base = (await readState(`base:${baseKey}`)) ?? {};
        const localManifest = await local.manifest();
        const skip = local.failedPaths();
        const include = (path, entries) => isEnabled()(path) && !skip.has(path) && (extraInclude?.(path, entries) ?? true);
        const result = await runSync({
            local, remote, base, include, localManifest,
            conflictLabel: `${config.deviceName} ${stampLabel(now())}`,
            onProgress: state => setProgress(target, { phase: 'syncing', ...state }),
            isAborted: () => abortRequested,
        });
        await writeState(`base:${baseKey}`, result.base);
        await flushCache();
        await refreshStInterface();
        return result;
    }

    const summarize = result => ({
        ok: result.ok, aborted: result.aborted, stopped: result.stopped ?? null, counts: result.counts,
        errors: result.errors.slice(0, 5).map(error => (error.path === '*' ? error.message : `${error.path}: ${error.message}`)),
    });

    // ── GitHub ──────────────────────────────────────────────────────────────────────────────────────────────────────

    async function runGithub() {
        const settings = config.github;
        if (!isGithubConfigured(settings)) return { outcome: 'unconfigured' };
        const remote = createGithubRemote({
            settings,
            deviceName: config.deviceName,
            http: params => network('http.request', params, { timeoutMs: networkTimeoutMs * 6 }),
        });
        try {
            const result = await runAgainst({
                target: 'github', baseKey: 'github', remote, categories: config.categories,
                isEnabled: () => createCategoryFilter(config.categories),
                extraInclude: (path, { local }) => !(local && local.size > settings.maxFileBytes),
            });
            githubLast = { at: now(), ...summarize(result) };
            return { outcome: 'done', ...githubLast };
        } catch (error) {
            githubLast = { at: now(), ok: false, errors: [error?.message ?? String(error)] };
            return { outcome: 'failed', ...githubLast };
        }
    }

    // ── Облачный диск (Dropbox / Google Drive) — дополнительный способ, по желанию ───────────────────────────────────────

    const authHttp = params => network('http.request', params, { timeoutMs: networkTimeoutMs });
    const cloudLabel = () => CLOUD_PROVIDER_LABELS[config.cloud.provider];

    function createCloudStore() {
        const provider = config.cloud.provider;
        const app = resolveCloudApp(provider, config.cloud);
        const tokens = createTokenManager({
            provider, http: authHttp, clientId: app.clientId, clientSecret: app.clientSecret, now,
            getTokens: () => config.cloud.tokens,
            save: async next => { config.cloud = { ...config.cloud, tokens: next }; await saveConfig(); },
        });
        const http = createAuthedHttp({ http: params => network('http.request', params, { timeoutMs: networkTimeoutMs * 6 }), tokens });
        return provider === 'google' ? createDriveStore({ http }) : createDropboxStore({ http });
    }

    async function runCloud() {
        if (!config.cloud.enabled || !config.cloud.tokens) return { outcome: 'unconfigured' };
        const provider = config.cloud.provider;
        try {
            const remote = createCloudRemote({ store: createCloudStore(), now });
            const result = await runAgainst({
                target: 'cloud', baseKey: `cloud:${provider}`, remote, categories: config.categories,
                isEnabled: () => createCloudFilter(),
                extraInclude: (file, { local }) => !(local && local.size > CLOUD_MAX_FILE_BYTES),
            });
            cloudLast = { at: now(), provider, ...summarize(result) };
            return { outcome: 'done', ...cloudLast };
        } catch (error) {
            cloudLast = { at: now(), provider, ok: false, errors: [error?.message ?? String(error)] };
            return { outcome: 'failed', ...cloudLast };
        }
    }
    const createCloudFilter = () => createCategoryFilter(config.categories);

    function cancelCloudSignIn() {
        if (cloudAuth?.timer) clearTimer(cloudAuth.timer);
        if (cloudAuth?.status === 'waiting') cloudAuth = { ...cloudAuth, status: 'cancelled', message: 'Cancelled.', timer: null };
        notify();
        return true;
    }

    async function completeCloudSignIn(tokens) {
        config.cloud = { ...config.cloud, tokens, enabled: true };
        await saveConfig();
        cloudAuth = { provider: config.cloud.provider, kind: cloudAuth?.kind, status: 'done', message: `Connected to ${cloudLabel()}.` };
        notify();
    }

    function failCloudSignIn(message) {
        if (cloudAuth?.timer) clearTimer(cloudAuth.timer);
        cloudAuth = { provider: config.cloud.provider, kind: cloudAuth?.kind, status: 'failed', message };
        notify();
    }

    function scheduleGooglePoll(delay) {
        const current = cloudAuth;
        current.timer = setTimer(async () => {
            if (cloudAuth !== current || current.status !== 'waiting') return;
            if (now() > current.deadline) { failCloudSignIn('The code expired. Start again.'); return; }
            try {
                const app = resolveCloudApp('google', config.cloud);
                const result = await pollGoogleDeviceFlow({ http: authHttp, clientId: app.clientId, clientSecret: app.clientSecret, deviceCode: current.deviceCode, now: now() });
                if (cloudAuth !== current) return;
                if (result.status === 'done') await completeCloudSignIn(result.tokens);
                else if (result.status === 'denied') failCloudSignIn('Access was denied in the browser.');
                else if (result.status === 'expired') failCloudSignIn('The code expired. Start again.');
                else { if (result.status === 'slow_down') current.intervalMs += 5000; scheduleGooglePoll(current.intervalMs); }
            } catch (error) {
                if (cloudAuth === current) failCloudSignIn(error?.message ?? 'Sign-in failed.');
            }
        }, delay);
    }

    async function beginCloudSignIn({ provider } = {}) {
        await loadConfig();
        const chosen = provider in CLOUD_PROVIDER_LABELS ? provider : config.cloud.provider;
        config.cloud = { ...config.cloud, provider: chosen };
        await saveConfig();
        const app = resolveCloudApp(chosen, config.cloud);
        if (!app.clientId || (chosen === 'google' && !app.clientSecret)) {
            throw new Error(`There is no ${CLOUD_PROVIDER_LABELS[chosen]} app key yet. Paste your own under "Use my own app key", or wait for the built-in one.`);
        }
        if (cloudAuth?.status === 'waiting') cancelCloudSignIn();
        if (chosen === 'dropbox') {
            const verifier = generateCodeVerifier({ random });
            cloudAuth = { provider: chosen, kind: 'code', status: 'waiting', verifier, url: buildDropboxAuthUrl({ clientId: app.clientId, challenge: await computeCodeChallenge(verifier) }), message: 'Open the link, allow access, then paste the code Dropbox shows.' };
        } else {
            const flow = await startGoogleDeviceFlow({ http: authHttp, clientId: app.clientId });
            cloudAuth = { provider: chosen, kind: 'device', status: 'waiting', url: flow.verificationUrl, userCode: flow.userCode, deviceCode: flow.deviceCode, intervalMs: flow.intervalMs, deadline: now() + flow.expiresInMs, message: 'Open the link and enter the code. This page continues by itself.' };
            scheduleGooglePoll(flow.intervalMs);
        }
        notify();
        return { kind: cloudAuth.kind, url: cloudAuth.url, userCode: cloudAuth.userCode };
    }

    async function finishCloudSignIn({ code } = {}) {
        await loadConfig();
        if (cloudAuth?.status !== 'waiting' || cloudAuth.kind !== 'code') throw new Error('Start signing in first.');
        const app = resolveCloudApp('dropbox', config.cloud);
        try {
            await completeCloudSignIn(await exchangeDropboxCode({ http: authHttp, clientId: app.clientId, code, verifier: cloudAuth.verifier, now: now() }));
        } catch (error) {
            failCloudSignIn(error?.message ?? 'Sign-in failed.');
            throw error;
        }
        return true;
    }

    async function disconnectCloud() {
        await loadConfig();
        cancelCloudSignIn();
        const provider = config.cloud.provider;
        config.cloud = { ...config.cloud, tokens: null, enabled: false };
        await saveConfig();
        await service('syncState.remove', { key: `base:cloud:${provider}` }).catch(() => {});
        cloudAuth = null;
        cloudLast = null;
        notify();
        return true;
    }

    async function testCloud() {
        await loadConfig();
        if (!config.cloud.tokens) return { ok: false, message: 'Connect an account first.' };
        try {
            const manifest = await createCloudRemote({ store: createCloudStore(), now }).manifest();
            return { ok: true, message: `Connected to ${cloudLabel()}. It holds ${Object.keys(manifest).length} synced file(s).` };
        } catch (error) {
            return { ok: false, message: error?.message ?? String(error) };
        }
    }

    // ── Сессии с устройствами ───────────────────────────────────────────────────────────────────────────────────────

    const rooms = new Map();        // pairId -> { topic, box, joiner, subscription }
    const sessions = new Map();     // pairId -> session
    const helloTimers = new Map();  // pairId -> handle
    const lastHelloAt = new Map();
    const pairFor = id => config.pairs.find(pair => pair.id === id);
    const iceServers = () => buildIceServers(config.iceServers);
    const problems = new Map();     // pairId -> почему соединение не поднялось (показывается в карточке)
    const openWaiters = new Map();  // pairId -> [функции, ждущие открытия канала]
    const settleWaiters = (pairId, opened) => { for (const finish of openWaiters.get(pairId) ?? []) finish(opened); openWaiters.delete(pairId); };

    async function publishSealed(room, message) {
        const sealed = await room.box.seal({ ...message, from: config.deviceId, ts: now() });
        const lines = splitPayload(sealed, randomHex(random), 3000);
        await network('syncSignal.publish', { server: config.signalServer, topic: room.topic, lines }, { timeoutMs: networkTimeoutMs });
    }

    async function ensureRoom(pair) {
        if (rooms.has(pair.id)) return rooms.get(pair.id);
        const { topic, key } = await deriveFromSecret(pair.secret);
        const room = { topic, box: await createBox(key, { random }), joiner: createPayloadJoiner(), subscription: null };
        rooms.set(pair.id, room);
        room.subscription = await network('syncSignal.subscribe', {
            server: config.signalServer, topic, since: SIGNAL_SINCE,
            handler: line => { handleSignalLine(pair.id, line).catch(error => log.warn?.('[ST Module Engine (Beta)] Sync: signal error —', error?.message ?? error)); },
        });
        return room;
    }

    async function closeRoom(pairId) {
        const room = rooms.get(pairId);
        rooms.delete(pairId);
        if (room?.subscription) await network('syncSignal.unsubscribe', { id: room.subscription.id }).catch(() => {});
    }

    async function announce(pair) {
        const room = rooms.get(pair.id);
        if (!room) return;
        lastHelloAt.set(pair.id, now());
        await publishSealed(room, { kind: 'hello', name: config.deviceName }).catch(error => log.info?.('[ST Module Engine (Beta)] Sync: presence not published —', error?.message ?? error));
    }

    /** Пока с парой нет живой сессии, изредка напоминаем о себе — доска помнит сообщения ограниченное время. */
    function scheduleHello(pair, delay) {
        clearTimer(helloTimers.get(pair.id));
        helloTimers.set(pair.id, setTimer(async () => {
            if (!started || !pairFor(pair.id)) return;
            if (!sessions.get(pair.id)) await announce(pair);
            scheduleHello(pair, presenceIntervalMs);
        }, delay));
    }

    async function handleSignalLine(pairId, line) {
        const pair = pairFor(pairId);
        const room = rooms.get(pairId);
        if (!pair || !room) return;
        const whole = room.joiner.push(line);
        if (whole == null) return;
        const message = await room.box.open(whole);
        if (!message || message.from !== pair.id || Math.abs(now() - message.ts) > SIGNAL_MAX_AGE_MS) return;
        if (message.kind === 'hello') await onHello(pair, message);
        else if (message.kind === 'offer' && message.to === config.deviceId) await onOffer(pair, message);
        else if (message.kind === 'answer' && message.to === config.deviceId) await onAnswer(pair, message);
    }

    const iAmLeaderFor = pair => config.deviceId < pair.id;

    async function onHello(pair, message) {
        if (pair.name !== message.name && typeof message.name === 'string') { pair.name = message.name.slice(0, 60); await saveConfig(); }
        if (sessions.get(pair.id)) return;
        if (iAmLeaderFor(pair)) { await beginOffer(pair); return; }
        // Ведомый: отвечаем приветствием, но не чаще раза в 20 секунд — чтобы ведущий увидел нас и прислал предложение.
        if (now() - (lastHelloAt.get(pair.id) ?? 0) > 20000) await announce(pair);
    }

    function newSession(pair, role, sessionId) {
        const session = { pairId: pair.id, role, sessionId, status: 'connecting', peerHandle: null, endpoint: null, timers: [], enabled: [], startedAt: now() };
        session.endpoint = createRpcEndpoint({
            send: async frame => { await network('syncPeer.send', { id: session.peerHandle, frame }); },
            handlers: createHandlers(session),
        });
        sessions.set(pair.id, session);
        session.timers.push(setTimer(() => { if (session.status !== 'open') closeSession(session, 'connection timed out'); }, connectTimeoutMs));
        notify();
        return session;
    }

    async function openPeer(session, options) {
        const opened = await network('syncPeer.open', {
            iceServers: iceServers(),
            ...options,
            onOpen: () => onChannelOpen(session),
            onFrame: frame => session.endpoint?.receive(frame),
            onClose: reason => onSessionClosed(session, reason),
        }, { timeoutMs: networkTimeoutMs });
        session.peerHandle = opened.id;
    }

    async function beginOffer(pair) {
        if (sessions.get(pair.id)) return;
        const room = rooms.get(pair.id);
        if (!room) return;
        const session = newSession(pair, 'leader', randomHex(random));
        try {
            await openPeer(session, {
                initiator: true,
                onSignal: signal => { publishSealed(room, { kind: 'offer', to: pair.id, sessionId: session.sessionId, signal }).catch(() => closeSession(session, 'signal failed')); },
            });
        } catch (error) {
            closeSession(session, error?.message ?? 'could not start the connection');
        }
    }

    async function onOffer(pair, message) {
        if (iAmLeaderFor(pair)) return;
        const existing = sessions.get(pair.id);
        if (existing?.status === 'open') return;
        if (existing) closeSession(existing, 'replaced by a newer offer');
        const room = rooms.get(pair.id);
        if (!room) return;
        const session = newSession(pair, 'follower', message.sessionId);
        try {
            await openPeer(session, {
                initiator: false,
                remote: message.signal,
                onSignal: signal => { publishSealed(room, { kind: 'answer', to: pair.id, sessionId: session.sessionId, signal }).catch(() => closeSession(session, 'signal failed')); },
            });
        } catch (error) {
            closeSession(session, error?.message ?? 'could not answer');
        }
    }

    async function onAnswer(pair, message) {
        const session = sessions.get(pair.id);
        if (!session || session.role !== 'leader' || session.sessionId !== message.sessionId || session.status !== 'connecting' || session.peerHandle == null) return;
        try { await network('syncPeer.accept', { id: session.peerHandle, signal: message.signal }); } catch (error) { closeSession(session, error?.message ?? 'answer rejected'); }
    }

    function onChannelOpen(session) {
        if (sessions.get(session.pairId) !== session) return;
        session.status = 'open';
        problems.delete(session.pairId);
        settleWaiters(session.pairId, true);
        notify();
        if (session.role !== 'leader' || !config.autoSync) return;
        runSession(session).catch(error => log.warn?.('[ST Module Engine (Beta)] Sync: first pass failed —', error?.message ?? error));
    }

    /** Ручной запуск: устройство без открытого канала сначала зовём к соединению, а не молча пропускаем. true, если канал открылся. */
    async function connectNow(pair, waitMs = 25000) {
        if (sessions.get(pair.id)?.status === 'open') return true;
        problems.delete(pair.id);
        try {
            await ensureRoom(pair);
            await announce(pair);
            if (iAmLeaderFor(pair)) await beginOffer(pair);
        } catch (error) {
            problems.set(pair.id, `Could not reach the signalling service: ${error?.message ?? error}`);
            return false;
        }
        return new Promise(resolve => {
            const timer = setTimer(() => finish(sessions.get(pair.id)?.status === 'open'), waitMs);
            const finish = opened => { clearTimer(timer); resolve(opened); };
            openWaiters.set(pair.id, [...(openWaiters.get(pair.id) ?? []), finish]);
        });
    }

    function closeSession(session, reason) {
        onSessionClosed(session, reason);
        if (session.peerHandle != null) network('syncPeer.close', { id: session.peerHandle }).catch(() => {});
    }

    function onSessionClosed(session, reason) {
        for (const timer of session.timers.splice(0)) clearTimer(timer);
        session.endpoint?.close(new Error(reason ?? 'closed'));
        if (sessions.get(session.pairId) !== session) return;
        sessions.delete(session.pairId);
        const neverOpened = session.status !== 'open';
        session.status = 'closed';
        // Канал так и не открылся — запоминаем причину: без неё карточка молча показывала «offline» и разобраться было нечем.
        if (neverOpened && !/replaced|stopped|removed/.test(String(reason))) {
            problems.set(session.pairId, `Could not connect (${reason ?? 'no answer'}). The devices found each other but could not open a direct channel — usually one of them is on mobile data or behind a strict router. A relay (TURN) server fixes that: see "Connection help" below.`);
        }
        settleWaiters(session.pairId, false);
        notify();
        const pair = pairFor(session.pairId);
        if (pair && started) scheduleHello(pair, 8000);
    }

    // ── Сторона «устройство» и обработчики запросов ведомого ────────────────────────────────────────────────────────

    function createPeerRemote(session) {
        const rpc = (method, params, body) => session.endpoint.call(method, params, { body });
        return {
            async manifest() {
                const { result, body } = await rpc('manifest', { categories: config.categories });
                session.enabled = Array.isArray(result?.enabled) ? result.enabled : [];
                return body ? JSON.parse(await body.text()) : {};
            },
            async read(path) { const { body } = await rpc('read', { path }); return body ?? new Blob([]); },
            async write(path, blob, meta) { await rpc('write', { path, hash: meta?.hash, modified: meta?.modified }, blob); },
            async remove(path) { await rpc('remove', { path }); },
        };
    }

    function createHandlers(session) {
        return {
            hello: () => ({ deviceId: config.deviceId, name: config.deviceName }),
            async manifest({ categories }) {
                const enabled = intersectCategories(config.categories, categories ?? []);
                const { manifest } = await scanLocal(config.categories);
                const include = createCategoryFilter(enabled);
                const entries = Object.fromEntries(Object.entries(manifest).filter(([path]) => include(path)));
                return { result: { enabled: config.categories }, body: new Blob([JSON.stringify(entries)]) };
            },
            async read({ path }) { return { body: await service('stUserData.read', { path }) }; },
            async write({ path, hash, modified }, { body }) { await writeLocal(path, body ?? new Blob([]), { hash, modified }); return { ok: true }; },
            async remove({ path }) { await removeLocal(path); return { ok: true }; },
            async finish(_params, { body }) {
                if (body) await writeState(`base:pair:${session.pairId}`, JSON.parse(await body.text()));
                await flushCache();
                await refreshStInterface();
                notify();
                return { ok: true };
            },
            async requestSync() {
                if (session.role !== 'leader') throw new Error('this device is not leading the session');
                runSession(session).catch(() => {});
                return { started: true };
            },
        };
    }

    async function runPeer(session) {
        const pair = pairFor(session.pairId);
        if (!pair || session.status !== 'open') return { outcome: 'offline' };
        const remote = createPeerRemote(session);
        const result = await runAgainst({
            target: `device:${pair.name}`, baseKey: `pair:${pair.id}`, remote, categories: config.categories,
            isEnabled: () => createCategoryFilter(intersectCategories(config.categories, session.enabled)),
        });
        if (!result.aborted) {
            await session.endpoint.call('finish', {}, { body: new Blob([JSON.stringify(result.base)]) }).catch(() => {});
            pair.lastSync = now();
            await saveConfig();
        }
        return { outcome: 'done', pair: pair.name, ...summarize(result) };
    }

    // ── Сопряжение ──────────────────────────────────────────────────────────────────────────────────────────────────

    let pairing = null;   // { mode, code, expiresAt, status, message, room, timers, subscription }

    async function endPairing(status, message) {
        if (!pairing) return;
        const current = pairing;
        pairing = { ...current, status, message };
        for (const timer of current.timers) clearTimer(timer);
        for (const repeater of current.repeaters) clearRepeating(repeater);
        if (current.subscription) await network('syncSignal.unsubscribe', { id: current.subscription.id }).catch(() => {});
        notify();
    }

    async function addPair({ id, name, secret }) {
        const existing = pairFor(id);
        if (existing) { existing.secret = secret; existing.name = name; } else config.pairs.push({ id, name: String(name ?? 'Device').slice(0, 60), secret, pairedAt: now(), lastSync: null });
        await saveConfig();
        await closeRoom(id);
        const pair = pairFor(id);
        await ensureRoom(pair);
        await announce(pair);
        scheduleHello(pair, presenceIntervalMs);
    }

    async function openPairingRoom(code) {
        const { topic, key } = await deriveFromPairingCode(code);
        const room = { topic, box: await createBox(key, { random }), joiner: createPayloadJoiner() };
        pairing.room = room;
        pairing.subscription = await network('syncSignal.subscribe', {
            server: config.signalServer, topic, since: SIGNAL_SINCE,
            handler: line => { handlePairingLine(line).catch(() => {}); },
        });
        return room;
    }

    async function handlePairingLine(line) {
        if (!pairing || pairing.status !== 'waiting') return;
        const whole = pairing.room.joiner.push(line);
        if (whole == null) return;
        const message = await pairing.room.box.open(whole);
        if (!message || message.from === config.deviceId || Math.abs(now() - message.ts) > SIGNAL_MAX_AGE_MS) return;
        if (pairing.mode === 'host' && message.kind === 'join') {
            const secret = generateSecret({ random });
            await publishSealed(pairing.room, { kind: 'welcome', to: message.from, name: config.deviceName, secret });
            await addPair({ id: message.from, name: String(message.name ?? 'Device'), secret });
            await endPairing('done', `Paired with ${message.name ?? 'the device'}.`);
        } else if (pairing.mode === 'join' && message.kind === 'welcome' && message.to === config.deviceId) {
            await addPair({ id: message.from, name: String(message.name ?? 'Device'), secret: message.secret });
            await endPairing('done', `Paired with ${message.name ?? 'the device'}.`);
        }
    }

    async function startPairing() {
        await loadConfig();
        if (pairing?.status === 'waiting') await endPairing('cancelled', 'Cancelled.');
        const code = generatePairingCode({ random });
        pairing = { mode: 'host', code, expiresAt: now() + PAIRING_TTL_MS, status: 'waiting', message: 'Enter this code on the other device.', timers: [], repeaters: [], subscription: null };
        try { await openPairingRoom(code); } catch (error) { await endPairing('failed', error?.message ?? 'Could not start pairing.'); throw error; }
        pairing.timers.push(setTimer(() => endPairing('expired', 'The code expired.'), PAIRING_TTL_MS));
        notify();
        return { code };
    }

    async function joinPairing({ code } = {}) {
        await loadConfig();
        const normalized = normalizePairingCode(code);
        if (!normalized) throw new Error('That does not look like a pairing code (10 characters, like K7QM4-X2P9D).');
        if (pairing?.status === 'waiting') await endPairing('cancelled', 'Cancelled.');
        pairing = { mode: 'join', code: formatPairingCode(normalized), expiresAt: now() + 90000, status: 'waiting', message: 'Looking for the other device…', timers: [], repeaters: [], subscription: null };
        try {
            const room = await openPairingRoom(normalized);
            const knock = () => publishSealed(room, { kind: 'join', name: config.deviceName }).catch(() => {});
            await knock();
            pairing.repeaters.push(setRepeating(knock, 8000));
            pairing.timers.push(setTimer(() => endPairing('failed', 'The other device did not answer. Start pairing there first, then enter the code here.'), 90000));
        } catch (error) {
            await endPairing('failed', error?.message ?? 'Could not join.');
            throw error;
        }
        notify();
        return { joining: true };
    }

    async function removePair({ id } = {}) {
        await loadConfig();
        const session = sessions.get(id);
        if (session) closeSession(session, 'pair removed');
        clearTimer(helloTimers.get(id));
        await closeRoom(id);
        config.pairs = config.pairs.filter(pair => pair.id !== id);
        await saveConfig();
        await service('syncState.remove', { key: `base:pair:${id}` }).catch(() => {});
        notify();
        return true;
    }

    // ── Запуск проходов ─────────────────────────────────────────────────────────────────────────────────────────────

    /** Один проход за раз на всё Ядро: замок, события для интерфейса и светофора, итог в `last`. */
    async function runExclusive(target, work) {
        if (running) return { outcome: 'busy' };
        running = { target, startedAt: now() };
        abortRequested = false;
        publishEvent('sync.started', { target });
        notify();
        const outcome = { peers: [], github: null, cloud: null };
        try {
            await work(outcome);
        } catch (error) {
            outcome.error = error?.message ?? String(error);
        } finally {
            running = null;
            setProgress(null, null);
            lastRun = { at: now(), ...outcome };
            publishEvent('sync.finished', { ...lastRun });
            notify();
        }
        return lastRun;
    }

    /** Проход по одной сессии, где это устройство ведущее (открытие канала, просьба ведомого). */
    const runSession = session => runExclusive(`device:${pairFor(session.pairId)?.name ?? ''}`, async outcome => { outcome.peers.push(await runPeer(session)); });

    /**
     * Цели прохода: `all` — всё включённое (кнопка «Sync now»); `scheduled` — то, что включено для фона; `background` — фон без
     * устройств (запуск страницы: устройства сами синхронизируются при соединении); либо одна цель: `peers`, `github`, `cloud`.
     */
    function resolveWants(target) {
        if (target === 'all') return { peers: true, github: config.github.enabled, cloud: config.cloud.enabled };
        const background = { github: config.github.enabled && config.github.auto, cloud: config.cloud.enabled && config.cloud.auto };
        if (target === 'scheduled') return { peers: config.autoSync, ...background };
        if (target === 'background') return { peers: false, ...background };
        return { peers: target === 'peers', github: target === 'github', cloud: target === 'cloud' };
    }

    async function run({ target = 'all' } = {}) {
        await loadConfig();
        return runExclusive(target, async outcome => {
            const wants = resolveWants(target);
            if (wants.peers && (target === 'all' || target === 'peers')) {
                for (const pair of config.pairs) {
                    if (sessions.get(pair.id)?.status === 'open') continue;
                    setProgress(`device:${pair.name}`, { phase: 'connecting', done: 0, total: 0 });
                    await connectNow(pair);
                }
                setProgress(null, null);
            }
            if (wants.peers) {
                for (const session of [...sessions.values()]) {
                    if (session.status !== 'open') continue;
                    if (session.role === 'leader') outcome.peers.push(await runPeer(session));
                    else await session.endpoint.call('requestSync', {}).then(() => outcome.peers.push({ outcome: 'requested', pair: pairFor(session.pairId)?.name })).catch(error => outcome.peers.push({ outcome: 'failed', error: error.message }));
                }
            }
            if (wants.github) outcome.github = await runGithub();
            if (wants.cloud) outcome.cloud = await runCloud();
        });
    }

    async function configure(patch = {}) {
        await loadConfig();
        const next = { ...config };
        if (typeof patch.deviceName === 'string') next.deviceName = patch.deviceName;
        if (Array.isArray(patch.categories)) next.categories = patch.categories;
        if (typeof patch.autoSync === 'boolean') next.autoSync = patch.autoSync;
        if (patch.intervalMin != null) next.intervalMin = patch.intervalMin;
        if (typeof patch.signalServer === 'string') next.signalServer = patch.signalServer;
        // Пароль ретранслятора карточке не возвращается, поэтому пустое поле значит «оставить прежний».
        if (patch.relay && typeof patch.relay === 'object') next.iceServers = relayToIceServers({ ...patch.relay, credential: patch.relay.credential || config.iceServers?.[0]?.credential });
        if (patch.github && typeof patch.github === 'object') {
            const token = patch.github.token ? patch.github.token : (patch.clearToken ? '' : config.github.token);
            const repository = typeof patch.github.repository === 'string' ? patch.github.repository : `${config.github.owner}/${config.github.repo}`;
            const maxFileMb = patch.github.maxFileMb ?? Math.round(config.github.maxFileBytes / 1048576);
            next.github = { ...sanitizeGithubSettings({ ...config.github, ...patch.github, token, repository, maxFileMb }), auto: patch.github.auto ?? config.github.auto };
        }
        if (patch.cloud && typeof patch.cloud === 'object') {
            const cloud = patch.cloud;
            const apps = { ...config.cloud.apps };
            for (const id of Object.keys(apps)) if (cloud.apps?.[id]) apps[id] = { ...apps[id], ...cloud.apps[id] };
            next.cloud = {
                ...config.cloud, apps,
                ...(typeof cloud.provider === 'string' ? { provider: cloud.provider } : {}),
                ...(typeof cloud.enabled === 'boolean' ? { enabled: cloud.enabled } : {}),
                ...(typeof cloud.auto === 'boolean' ? { auto: cloud.auto } : {}),
            };
        }
        const signalServerChanged = next.signalServer !== config.signalServer;
        config = sanitizeSyncConfig({ ...next, deviceId: config.deviceId, pairs: config.pairs, iceServers: next.iceServers }, { generateDeviceId: () => config.deviceId, defaultDeviceName: describeDevice() });
        await saveConfig();
        if (signalServerChanged) await restartRooms();
        restartSchedule();
        notify();
        return describeConfigForUi(config);
    }

    async function restartRooms() {
        for (const id of [...rooms.keys()]) await closeRoom(id);
        for (const pair of config.pairs) { await ensureRoom(pair); await announce(pair); }
    }

    function restartSchedule() {
        if (intervalHandle) clearRepeating(intervalHandle);
        intervalHandle = null;
        if (!started) return;
        intervalHandle = setRepeating(() => {
            const wants = resolveWants('scheduled');
            // Пустой проход (нет открытых сессий, GitHub и облако не в фоне) не запускается: он ничего не сделал бы, но шумел событиями.
            const hasPeers = wants.peers && [...sessions.values()].some(session => session.status === 'open');
            if (!hasPeers && !wants.github && !wants.cloud) return;
            run({ target: 'scheduled' }).catch(() => {});
        }, config.intervalMin * 60000);
    }

    async function testGithub() {
        await loadConfig();
        if (!isGithubConfigured(config.github)) return { ok: false, message: 'Enable GitHub sync and fill in the repository and the token first.' };
        try {
            const remote = createGithubRemote({ settings: config.github, deviceName: config.deviceName, http: params => network('http.request', params, { timeoutMs: networkTimeoutMs }) });
            const manifest = await remote.manifest();
            return { ok: true, message: `Connected. The repository holds ${Object.keys(manifest).length} synced file(s).` };
        } catch (error) {
            return { ok: false, message: error?.message ?? String(error) };
        }
    }

    async function status() {
        await loadConfig();
        return {
            config: describeConfigForUi(config),
            running: running ? { ...running } : null,
            progress,
            last: lastRun,
            githubLast,
            cloudLast,
            cloudAuth: cloudAuth ? { provider: cloudAuth.provider, kind: cloudAuth.kind, status: cloudAuth.status, url: cloudAuth.url ?? null, userCode: cloudAuth.userCode ?? null, message: cloudAuth.message } : null,
            pairing: pairing ? { mode: pairing.mode, code: pairing.code, status: pairing.status, message: pairing.message, expiresAt: pairing.expiresAt } : null,
            connections: config.pairs.map(pair => ({ id: pair.id, name: pair.name, status: sessions.get(pair.id)?.status ?? 'offline', role: sessions.get(pair.id)?.role ?? null, lastSync: pair.lastSync, problem: problems.get(pair.id) ?? null })),
        };
    }

    /** Вызывается после восстановления настроек: открывает «комнаты» пар и запускает расписание. */
    async function start() {
        await loadConfig();
        started = true;
        for (const pair of config.pairs) {
            try { await ensureRoom(pair); await announce(pair); scheduleHello(pair, presenceIntervalMs); } catch (error) { log.info?.('[ST Module Engine (Beta)] Sync: could not open a room —', error?.message ?? error); }
        }
        restartSchedule();
        const background = resolveWants('background');
        if (background.github || background.cloud) run({ target: 'background' }).catch(() => {});
        return true;
    }

    async function stop() {
        started = false;
        if (intervalHandle) clearRepeating(intervalHandle);
        intervalHandle = null;
        for (const handle of helloTimers.values()) clearTimer(handle);
        helloTimers.clear();
        for (const session of [...sessions.values()]) closeSession(session, 'stopped');
        for (const id of [...rooms.keys()]) await closeRoom(id);
        if (pairing?.status === 'waiting') await endPairing('cancelled', 'Cancelled.');
    }

    const unregisters = [
        host.own.register('sync.status', () => status()),
        host.own.register('sync.configure', params => configure(params)),
        host.own.register('sync.run', params => run(params)),
        host.own.register('sync.abort', () => { abortRequested = true; return true; }),
        host.own.register('sync.pair.start', () => startPairing()),
        host.own.register('sync.pair.join', params => joinPairing(params)),
        host.own.register('sync.pair.cancel', async () => { await endPairing('cancelled', 'Cancelled.'); return true; }),
        host.own.register('sync.pair.remove', params => removePair(params)),
        host.own.register('sync.github.test', () => testGithub()),
        host.own.register('sync.cloud.begin', params => beginCloudSignIn(params)),
        host.own.register('sync.cloud.finish', params => finishCloudSignIn(params)),
        host.own.register('sync.cloud.cancel', () => cancelCloudSignIn()),
        host.own.register('sync.cloud.disconnect', () => disconnectCloud()),
        host.own.register('sync.cloud.test', () => testCloud()),
    ];

    return {
        start, stop, status, run, configure, startPairing, joinPairing, removePair, testGithub, testCloud, beginCloudSignIn, finishCloudSignIn, disconnectCloud,
        unregister: () => { for (const unregister of unregisters) unregister(); },
    };
}

