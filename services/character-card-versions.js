/**
 * Сервис хранилища версий карточек персонажей: снимки сырой карточки в indexedDB (те же приём и причина, что у `pm-presets.js` — снимков много,
 * а файл настроек ST переписывается целиком). Ничего не знает о формате карточки: кладёт, читает, удаляет и обрезает самые старые.
 * Запись: `{ key: "<avatar>:<at>", avatar, at, label, card }`; `list` отдаёт записи БЕЗ тела `card`.
 */
const DATABASE_NAME = 'stme-beta-character-card-versions';
const DATABASE_VERSION = 1;
const STORE_NAME = 'versions';
export const MAX_VERSIONS_PER_CARD = 40;

function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function runInStore(mode, run) {
    const database = await openDatabase();
    try {
        return await new Promise((resolve, reject) => {
            const transaction = database.transaction(STORE_NAME, mode);
            const request = run(transaction.objectStore(STORE_NAME));
            transaction.oncomplete = () => resolve(request?.result);
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
        });
    } finally {
        database.close();
    }
}

/** Настоящее хранилище; тесты подставляют своё с теми же операциями. */
export function createIndexedDbVersionStore() {
    return {
        all: () => runInStore('readonly', store => store.getAll()),
        get: key => runInStore('readonly', store => store.get(String(key))),
        put: record => runInStore('readwrite', store => store.put(record)),
        delete: key => runInStore('readwrite', store => store.delete(String(key))),
    };
}

export function registerCharacterCardVersionsService(bus, { store = createIndexedDbVersionStore() } = {}) {
    const listForAvatar = async avatar => ((await store.all()) ?? []).filter(record => record.avatar === avatar).sort((a, b) => b.at - a.at);

    async function putVersion({ record } = {}) {
        if (!record?.avatar || !record?.at || !record?.card) throw new Error('characterCardVersions.put: avatar, at and card are required.');
        await store.put({ ...record, key: `${record.avatar}:${record.at}` });
        // Без потолка снимки растут вечно: у карточки, которую правят десятки раз, это сотни копий по десятку килобайт.
        for (const stale of (await listForAvatar(record.avatar)).slice(MAX_VERSIONS_PER_CARD)) await store.delete(stale.key);
        return true;
    }

    const unregisters = [
        bus.register('characterCardVersions.list', async params => (await listForAvatar(params?.avatar)).map(({ card, ...summary }) => summary), { loadMetric: () => 1 }),
        bus.register('characterCardVersions.get', async params => (await store.get(params?.key)) ?? null, { loadMetric: () => 1 }),
        bus.register('characterCardVersions.put', params => putVersion(params), { loadMetric: () => 1 }),
        bus.register('characterCardVersions.delete', async params => { await store.delete(params?.key); return true; }, { loadMetric: () => 1 }),
    ];
    return () => { for (const unregister of unregisters) unregister(); };
}
