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

/**
 * `image.url({ id })` — адрес для `<img src>` (object URL) по картинке из хранилища; `null`, если такой нет. Один адрес на картинку, пока
 * его не отзовут (`image.revokeUrl`): иначе каждая перерисовка подвала создавала бы новый и копила память. Модулю не нужен `URL` браузера —
 * работа с ним остаётся в Сервисе.
 */
export function registerImageStoreService(bus, { createObjectUrl = blob => URL.createObjectURL(blob), revokeObjectUrl = url => URL.revokeObjectURL(url), getBlob = id => withStore('readonly', store => store.get(String(id))) } = {}) {
    const urls = new Map();
    async function urlOf(id) {
        const key = String(id ?? '');
        if (!key) return null;
        if (!urls.has(key)) urls.set(key, getBlob(key).then(blob => (blob ? createObjectUrl(blob) : null)));
        const url = await urls.get(key);
        if (!url) urls.delete(key);
        return url;
    }
    async function revoke(id) {
        const key = String(id ?? '');
        const pending = urls.get(key);
        urls.delete(key);
        const url = await pending;
        if (url) revokeObjectUrl(url);
        return true;
    }
    const unregisters = [
        bus.register('image.url', params => urlOf(params?.id), { loadMetric: () => 0 }),
        bus.register('image.revokeUrl', params => revoke(params?.id), { loadMetric: () => 0 }),
        bus.register('image.put', params => withStore('readwrite', store => store.put(params?.blob, String(params?.id))), { loadMetric: () => 1 }),
        bus.register('image.get', params => withStore('readonly', store => store.get(String(params?.id))), { loadMetric: () => 1 }),
        bus.register('image.delete', async params => { await revoke(params?.id); return withStore('readwrite', store => store.delete(String(params?.id))); }, { loadMetric: () => 1 }),
    ];
    return () => { for (const unregister of unregisters) unregister(); };
}
