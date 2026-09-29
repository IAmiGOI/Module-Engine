/**
 * Сервис хранилища пресетов Prompt Manager: пресеты и их версии в indexedDB (тот же приём и та же причина, что у
 * [graph-library.js](graph-library.js): файл настроек ST переписывается целиком, а пресет — десятки КБ, версий много).
 * Сервис ничего не знает о формате пресета — кладёт, читает, удаляет записи. `list` отдаёт записи БЕЗ тела (`preset`).
 * Версии — отдельное хранилище: запись `{ key: "<presetId>:<at>", presetId, at, label, preset }`.
 */
const DB_NAME = 'stme-beta-pm-presets';
const DB_VERSION = 1;

function openDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('presets')) db.createObjectStore('presets', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('versions')) db.createObjectStore('versions', { keyPath: 'key' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function withStore(name, mode, run) {
    const db = await openDb();
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(name, mode);
            const request = run(tx.objectStore(name));
            tx.oncomplete = () => resolve(request?.result);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted.'));
        });
    } finally {
        db.close();
    }
}

/** Настоящее хранилище; тесты подставляют своё с теми же операциями. */
export function createIndexedDbPresetStore() {
    return {
        all: name => withStore(name, 'readonly', store => store.getAll()),
        get: (name, key) => withStore(name, 'readonly', store => store.get(String(key))),
        put: (name, record) => withStore(name, 'readwrite', store => store.put(record)),
        delete: (name, key) => withStore(name, 'readwrite', store => store.delete(String(key))),
    };
}

export function registerPmPresetsService(bus, { store = createIndexedDbPresetStore() } = {}) {
    const unregisters = [
        bus.register('pmPresets.list', async () => (await store.all('presets') ?? []).map(({ preset, ...summary }) => summary), { loadMetric: () => 1 }),
        bus.register('pmPresets.get', async params => (await store.get('presets', params?.id)) ?? null, { loadMetric: () => 1 }),
        bus.register('pmPresets.put', async params => { await store.put('presets', params?.record); return true; }, { loadMetric: () => 1 }),
        bus.register('pmPresets.delete', async params => {
            await store.delete('presets', params?.id);
            for (const version of await store.all('versions') ?? []) if (version.presetId === params?.id) await store.delete('versions', version.key);
            return true;
        }, { loadMetric: () => 1 }),
        bus.register('pmPresets.versions.list', async params => (await store.all('versions') ?? [])
            .filter(version => version.presetId === params?.presetId).map(({ preset, ...summary }) => summary).sort((a, b) => b.at - a.at), { loadMetric: () => 1 }),
        bus.register('pmPresets.versions.get', async params => (await store.get('versions', params?.key)) ?? null, { loadMetric: () => 1 }),
        bus.register('pmPresets.versions.put', async params => { await store.put('versions', params?.record); return true; }, { loadMetric: () => 1 }),
        bus.register('pmPresets.versions.delete', async params => { await store.delete('versions', params?.key); return true; }, { loadMetric: () => 1 }),
    ];
    return () => { for (const unregister of unregisters) unregister(); };
}
