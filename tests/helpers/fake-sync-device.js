import { createEngine } from '../../libraries/shared/engine.js';
import { createSyncCore } from '../../cores/sync/index.js';
import { categoryOfPath } from '../../libraries/core/sync-config.js';
import { request } from '../../libraries/shared/request.js';
import { DEFERRED_PREFIX } from '../../libraries/core/sync-runner.js';

/**
 * Одно «устройство» для проверки Ядра синхронизации: свой движок, свои файлы ST в памяти, свои настройки и локальное состояние.
 * Сеть (доска сигналов и WebRTC) — общая, из fake-sync-network.js.
 *
 * `lossy` имитирует ST: при записи некоторых файлов содержимое слегка меняется (карточка получает новое `create_date`).
 */
export function createFakeDevice({ id, name, network, clock, files = {}, categories, lossy = () => null, deferWrite = () => false, presenceIntervalMs = 60000, overrides = {} }) {
    const engine = createEngine();
    const settings = new Map();
    const state = new Map();
    const store = new Map(Object.entries(files).map(([path, text]) => [path, { text, version: 1 }]));
    const events = [];
    const log = [];
    let refreshed = [];

    settings.set('core.sync/config', { deviceId: id, deviceName: name, ...(categories ? { categories } : {}), ...overrides });
    engine.buses.cores.register('storage.settings.get', ({ namespace, key, fallback }) => settings.get(`${namespace}/${key}`) ?? fallback);
    engine.buses.cores.register('storage.settings.set', ({ namespace, key, value }) => { settings.set(`${namespace}/${key}`, JSON.parse(JSON.stringify(value))); return true; });

    const stampOf = path => `v${store.get(path).version}`;
    engine.buses.services.register('stUserData.list', ({ categories: wanted } = {}) => [...store.keys()]
        .filter(path => !wanted || wanted.includes(categoryOfPath(path)))
        .map(path => ({ path, stamp: stampOf(path), size: store.get(path).text.length, modified: store.get(path).modified ?? 1000 })));
    engine.buses.services.register('stUserData.read', ({ path }) => {
        log.push(`read:${path}`);
        if (!store.has(path)) throw new Error(`no such file ${path}`);
        return new Blob([store.get(path).text]);
    });
    engine.buses.services.register('stUserData.write', async ({ path, blob }) => {
        if (deferWrite(path)) throw new Error(`${DEFERRED_PREFIX}chat is open`);
        log.push(`write:${path}`);
        const incoming = await blob.text();
        const text = lossy(path, incoming) ?? incoming;
        store.set(path, { text, version: (store.get(path)?.version ?? 0) + 1, modified: clock.now() });
        return { stamp: stampOf(path) };
    });
    engine.buses.services.register('stUserData.remove', ({ path }) => { log.push(`remove:${path}`); store.delete(path); return true; });
    engine.buses.services.register('stUserData.refresh', ({ categories: wanted }) => { refreshed.push(...(wanted ?? [])); return true; });
    engine.buses.services.register('stBackgrounds.refresh', () => { refreshed.push('backgrounds'); return true; });
    engine.buses.services.register('syncState.get', ({ key }) => state.get(key) ?? null);
    engine.buses.services.register('syncState.set', ({ key, value }) => { state.set(key, JSON.parse(JSON.stringify(value))); return true; });
    engine.buses.services.register('syncState.remove', ({ key }) => { state.delete(key); return true; });
    network.registerOn(engine.buses.network, { label: name });
    let httpHandler = () => { throw new Error('no network for http.request in this test'); };
    engine.buses.network.register('http.request', params => httpHandler(params));

    const core = createSyncCore(engine.registerCaller('core.sync', 'cores', { tier: 'official', networkAccess: true }), {
        now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, setRepeating: clock.setRepeating, clearRepeating: clock.clearRepeating,
        publish: (event, payload) => events.push([event, payload]),
        log: { info() {}, warn() {} },
        describeDevice: () => name,
        presenceIntervalMs,
        connectTimeoutMs: 30000,
        ...overrides.core,
    });

    return {
        id, name, core, engine, store, state, settings, events, log,
        text: path => store.get(path)?.text,
        put: (path, text, modified = clock.now()) => { store.set(path, { text, version: (store.get(path)?.version ?? 0) + 1, modified }); },
        paths: () => [...store.keys()].sort(),
        refreshed: () => refreshed,
        clearLog: () => { log.length = 0; },
        setHttp: handler => { httpHandler = handler; },
        call: (contract, params) => request(engine.buses.cores, contract, { params }).then(result => { if (!result.ok) throw new Error(result.error.message); return result.value; }),
    };
}
