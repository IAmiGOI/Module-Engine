/**
 * Воркер постоянного кэша растров (IndexedDB) — вся тяжёлая работа кэша вне главного потока: чтение записи, декодирование WebP в
 * ImageBitmap (передаётся на главный поток без копирования), кодирование новой картинки в WebP и запись. Главный поток занимается
 * только загрузкой готовой текстуры в GPU. Протокол: `{ id, op, ... }` → `{ id, result }` (`op`: get | has | put).
 * Схема БД та же, что у `services/raster-cache.js` (тот остаётся запасным путём, когда Worker недоступен).
 */
const DB_NAME = 'stme-raster-cache';
const STORE = 'rows';

let dbPromise = null;
function db() {
    dbPromise ??= new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
            const store = request.result.createObjectStore(STORE, { keyPath: 'key' });
            store.createIndex('chatKey', 'chatKey');
            store.createIndex('at', 'at');
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    }).catch(() => null);
    return dbPromise;
}
const wrap = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });

async function get({ key }) {
    const database = await db();
    if (!database) return { result: null };
    const record = await wrap(database.transaction(STORE).objectStore(STORE).get(key)).catch(() => null);
    if (!record) return { result: null };
    const image = await createImageBitmap(record.blob).catch(() => null);
    if (!image) return { result: null };
    return { result: { image, height: record.height, width: record.width, physHeight: record.physHeight, images: record.images }, transfer: [image] };
}

async function has({ key }) {
    const database = await db();
    if (!database) return { result: false };
    const count = await wrap(database.transaction(STORE).objectStore(STORE).count(key)).catch(() => 0);
    return { result: count > 0 };
}

async function put({ key, chatKey, at, bitmap, height, width, physHeight, images }) {
    const database = await db();
    if (!database) return { result: false };
    const canvas = new OffscreenCanvas(width, physHeight);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, physHeight);
    bitmap.close?.();
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.92 }).catch(() => null);
    if (!blob) return { result: false };
    const record = { key, chatKey, at, bytes: blob.size, blob, height, width, physHeight, images: images ?? [] };
    await wrap(database.transaction(STORE, 'readwrite').objectStore(STORE).put(record)).catch(() => {});
    return { result: true };
}

const handlers = { get, has, put };
self.onmessage = async ({ data }) => {
    const { id, op } = data;
    try {
        const { result, transfer } = await handlers[op](data);
        self.postMessage({ id, result }, transfer ?? []);
    } catch (error) {
        self.postMessage({ id, error: String(error?.message ?? error) });
    }
};
