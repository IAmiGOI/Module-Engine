/**
 * Сервис хранилища изображений — та же причина и тот же разрез, что у
 * [audio-store.js](audio-store.js): байты картинки в `storage.settings`
 * жить не могут (ST читает/пишет `extensionSettings` целиком как JSON),
 * поэтому отдельный `indexedDB`-стор, отдельная база. Первый реальный
 * потребитель — [Модуль «Карта»](../modules/map/index.js)'s загрузка
 * изображения карты (ROADMAP.md 5.44); ничего не знает о картах, регионах
 * или о том, ЧЬЯ это картинка — только положить/прочитать/удалить по id.
 *
 * Хранилище локальное для этого браузера — потеря стора (другой браузер,
 * чистка данных сайта) теряет саму картинку, но не остальные данные карты
 * (узлы/рёбра/настройки), которые персистятся отдельно через
 * `storage.settings`.
 */
const DB_NAME = 'stme-beta-images';
const DB_VERSION = 1;
const STORE_NAME = 'images';

function openDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
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
            const store = tx.objectStore(STORE_NAME);
            const request = run(store);
            tx.oncomplete = () => resolve(request?.result);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted.'));
        });
    } finally {
        db.close();
    }
}

export function registerImageStoreService(bus) {
    const unregisters = [
        bus.register('image.put', params => withStore('readwrite', store => store.put(params?.blob, String(params?.id))), { loadMetric: () => 1 }),
        bus.register('image.get', params => withStore('readonly', store => store.get(String(params?.id))), { loadMetric: () => 1 }),
        bus.register('image.delete', params => withStore('readwrite', store => store.delete(String(params?.id))), { loadMetric: () => 1 }),
    ];
    return () => { for (const unregister of unregisters) unregister(); };
}
