/**
 * Сервис состояния синхронизации — локальное хранилище «ключ → значение» в IndexedDB этого браузера. Здесь живёт то, что нельзя и не
 * нужно держать в настройках ST (`extensionSettings` пишется в `settings.json` целиком и не для сотен тысяч записей): кэш хешей
 * файлов по штампам и «база» каждой пары (что было у обеих сторон при прошлой удачной синхронизации).
 *
 * Локальность здесь — свойство, а не недостаток: состояние описывает именно ЭТО устройство. Потеряется (очистка данных сайта) —
 * следующая синхронизация просто пересчитает хеши и сравнит всё заново; данные при этом не теряются, а совпадающие файлы не
 * передаются повторно. Единственная цена — файлы, изменённые на обеих сторонах за это время, станут конфликтами (обе версии
 * сохранятся).
 */

const DB_NAME = 'stme-sync-state';
const STORE = 'kv';

export function registerSyncStateService(bus, { indexedDB = globalThis.indexedDB } = {}) {
    const open = () => new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE); };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });

    async function withStore(mode, run) {
        const db = await open();
        try {
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(STORE, mode);
                const request = run(tx.objectStore(STORE));
                tx.oncomplete = () => resolve(request?.result ?? null);
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted.'));
            });
        } finally {
            db.close();
        }
    }

    const key = params => String(params?.key ?? '');
    const unregisters = [
        bus.register('syncState.get', async params => (await withStore('readonly', store => store.get(key(params)))) ?? null, { loadMetric: () => 1 }),
        bus.register('syncState.set', async params => { await withStore('readwrite', store => store.put(params?.value, key(params))); return true; }, { loadMetric: () => 1 }),
        bus.register('syncState.remove', async params => { await withStore('readwrite', store => store.delete(key(params))); return true; }, { loadMetric: () => 1 }),
    ];
    return () => { for (const unregister of unregisters) unregister(); };
}
