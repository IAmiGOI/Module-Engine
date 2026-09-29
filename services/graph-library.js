/**
 * Сервис библиотеки графов памяти — та же причина и тот же разрез, что у [image-store.js](image-store.js): граф с эмбеддингами
 * в `storage.settings` жить не может (файл настроек ST переписывается целиком), поэтому отдельная база `indexedDB`. Сервис
 * ничего не знает о графах — кладёт, читает и удаляет записи по `id`; формат записи, лимиты и разбор — в
 * [graph-snapshot.js](../cores/memory-graph/graph-snapshot.js). Библиотека локальна для браузера; между устройствами — экспорт файлом.
 *
 * `graphLibrary.list` возвращает записи БЕЗ самого графа (сводки для карточек), `.get` — запись целиком.
 */
const DB_NAME = 'stme-beta-graph-library';
const DB_VERSION = 1;
const STORE_NAME = 'graphs';

function openDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function withStore(mode, run) {
    const db = await openDb();
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, mode);
            const request = run(tx.objectStore(STORE_NAME));
            tx.oncomplete = () => resolve(request?.result);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted.'));
        });
    } finally {
        db.close();
    }
}

/** Настоящее хранилище на indexedDB — тесты подставляют свой (`store`) с теми же четырьмя операциями. */
export function createIndexedDbGraphStore() {
    return {
        all: () => withStore('readonly', store => store.getAll()),
        get: id => withStore('readonly', store => store.get(String(id))),
        put: record => withStore('readwrite', store => store.put(record)),
        delete: id => withStore('readwrite', store => store.delete(String(id))),
    };
}

export function registerGraphLibraryService(bus, { store = createIndexedDbGraphStore() } = {}) {
    const unregisters = [
        bus.register('graphLibrary.list', async () => (await store.all() ?? []).map(({ graph, ...summary }) => summary), { loadMetric: () => 1 }),
        bus.register('graphLibrary.get', async params => (await store.get(params?.id)) ?? null, { loadMetric: () => 1 }),
        bus.register('graphLibrary.put', async params => { await store.put(params?.record); return true; }, { loadMetric: () => 1 }),
        bus.register('graphLibrary.delete', async params => { await store.delete(params?.id); return true; }, { loadMetric: () => 1 }),
    ];
    return () => { for (const unregister of unregisters) unregister(); };
}
