/**
 * Сервис постоянного кэша растеризованных строк Chat Viewport (IndexedDB). Готовая текстура строки хранится
 * сжатой картинкой (WebP на прозрачном фоне) вместе с измеренной высотой и позициями картинок тела, поэтому
 * при повторном открытии чата строка не растеризуется и не измеряется заново — только декодируется.
 *
 * Ключ строки считает вызывающий (хеш от готового HTML, ширины, devicePixelRatio, CSS и заглушки под аватарку),
 * так что правка текста, смена темы/ширины автоматически дают другой ключ, а старые записи просто устаревают.
 *
 * Политика хранения: последние 5 чатов + 2 самых больших из остальных, плюс общий потолок по размеру
 * (самые давние строки вытесняются первыми). Все браузерные API (`indexedDB`, canvas) инжектируются,
 * чтобы в Node сервис тестировался на фейках.
 */

const DB_NAME = 'stme-raster-cache';
const STORE = 'rows';
const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
const KEEP_RECENT_CHATS = 5;
const KEEP_LARGEST_CHATS = 2;

/** Чистая функция выбора, какие чаты оставить: последние N по времени + K самых больших из остальных. */
export function chooseChatsToKeep(chatStats, { recent = KEEP_RECENT_CHATS, largest = KEEP_LARGEST_CHATS } = {}) {
    const byRecency = [...chatStats].sort((a, b) => b.lastUsed - a.lastUsed);
    const keep = new Set(byRecency.slice(0, recent).map(chat => chat.chatKey));
    const rest = byRecency.slice(recent).sort((a, b) => b.rows - a.rows);
    for (const chat of rest.slice(0, largest)) keep.add(chat.chatKey);
    return keep;
}

function openDb(indexedDB) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
            const store = request.result.createObjectStore(STORE, { keyPath: 'key' });
            store.createIndex('chatKey', 'chatKey');
            store.createIndex('at', 'at');
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

const wrap = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });

async function encodeImage(image, width, height) {
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
    canvas.getContext('2d').drawImage(image, 0, 0, width, height);
    if (canvas.convertToBlob) return canvas.convertToBlob({ type: 'image/webp', quality: 0.92 });
    return new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.92));
}

export function registerRasterCacheService(servicesBus, {
    indexedDB = globalThis.indexedDB,
    getChatKey = () => globalThis.SillyTavern?.getContext?.()?.chatId ?? 'unknown',
    encode = encodeImage,
    decode = blob => globalThis.createImageBitmap(blob),
    maxBytes = DEFAULT_MAX_BYTES,
    now = () => Date.now(),
    // Воркер выносит чтение/декодирование/кодирование/запись с главного потока. `null` — без воркера (тесты, старые браузеры):
    // тогда всё идёт прежним путём в этом же потоке. По умолчанию создаётся только в браузере со штатным indexedDB.
    worker = (indexedDB === globalThis.indexedDB && typeof globalThis.Worker === 'function')
        ? (() => { try { return new globalThis.Worker(new URL('./raster-cache-worker.js', import.meta.url), { type: 'module' }); } catch { return null; } })()
        : null,
} = {}) {
    let dbPromise = null;
    let workerSeq = 0;
    const workerCalls = new Map();
    if (worker) {
        worker.onmessage = ({ data }) => { const call = workerCalls.get(data.id); workerCalls.delete(data.id); if (call) (data.error ? call.reject(new Error(data.error)) : call.resolve(data.result)); };
        worker.onerror = () => { for (const call of workerCalls.values()) call.reject(new Error('raster cache worker failed')); workerCalls.clear(); };
    }
    const callWorker = (message, transfer = []) => new Promise((resolve, reject) => {
        workerSeq += 1;
        workerCalls.set(workerSeq, { resolve, reject });
        worker.postMessage({ id: workerSeq, ...message }, transfer);
    });
    const db = () => { if (!indexedDB) return Promise.resolve(null); dbPromise ??= openDb(indexedDB).catch(() => null); return dbPromise; };

    async function get({ key } = {}) {
        if (worker) { try { return await callWorker({ op: 'get', key }); } catch { /* воркер сломался — читаем здесь */ } }
        const database = await db();
        if (!database) return null;
        const record = await wrap(database.transaction(STORE).objectStore(STORE).get(key)).catch(() => null);
        if (!record) return null;
        const image = await decode(record.blob).catch(() => null);
        if (!image) return null;
        return { image, height: record.height, width: record.width, physHeight: record.physHeight, images: record.images };
    }

    // Кодирование картинки в WebP — синхронная тяжёлая работа главного потока (замер: ~8% профиля прокрутки). Запись поэтому не
    // делается сразу: строки встают в очередь, и по одной, в простое (`requestIdleCallback`, иначе таймер), кодируются и пишутся.
    const pending = [];
    let draining = false;
    function drain() {
        if (draining) return;
        draining = true;
        const step = () => {
            const job = pending.shift();
            if (!job) { draining = false; return; }
            putNow(job).catch(() => {}).finally(() => schedule(step));
        };
        schedule(step);
    }
    const schedule = fn => (typeof globalThis.requestIdleCallback === 'function' ? globalThis.requestIdleCallback(fn, { timeout: 3000 }) : setTimeout(fn, 60));
    /** Есть ли на диске запись с таким ключом — без декодирования картинки (нужно фоновому прогреву чата). */
    async function has({ key } = {}) {
        if (pending.some(p => p.key === key)) return true;
        if (worker) { try { return await callWorker({ op: 'has', key }); } catch { /* воркер сломался — считаем здесь */ } }
        const database = await db();
        if (!database) return false;
        const count = await wrap(database.transaction(STORE).objectStore(STORE).count(key)).catch(() => 0);
        return count > 0;
    }

    async function put(job) {
        // Повторная запись того же ключа заменяет ожидающую; очередь ограничена — самые старые отбрасываются.
        const at = pending.findIndex(p => p.key === job.key);
        if (at >= 0) pending.splice(at, 1);
        pending.push(job);
        while (pending.length > 200) pending.shift();
        drain();
        return true;
    }

    async function putNow({ key, image, height, width, physHeight, images }) {
        if (worker) {
            try {
                const bitmap = await globalThis.createImageBitmap(image, { resizeWidth: width, resizeHeight: physHeight });
                return await callWorker({ op: 'put', key, chatKey: getChatKey(), at: now(), bitmap, height, width, physHeight, images }, [bitmap]);
            } catch { /* не вышло через воркер — пишем здесь */ }
        }
        const database = await db();
        if (!database) return false;
        const blob = await encode(image, width, physHeight).catch(() => null);
        if (!blob) return false;
        const record = { key, chatKey: getChatKey(), at: now(), bytes: blob.size, blob, height, width, physHeight, images: images ?? [] };
        await wrap(database.transaction(STORE, 'readwrite').objectStore(STORE).put(record)).catch(() => {});
        return true;
    }

    /** Применяет политику хранения: лишние чаты выбрасываются целиком, потом самые давние строки — до потолка по размеру. */
    async function prune() {
        const database = await db();
        if (!database) return false;
        const all = await wrap(database.transaction(STORE).objectStore(STORE).getAll()).catch(() => []);
        const stats = new Map();
        for (const record of all) {
            const stat = stats.get(record.chatKey) ?? { chatKey: record.chatKey, rows: 0, lastUsed: 0 };
            stat.rows += 1;
            stat.lastUsed = Math.max(stat.lastUsed, record.at);
            stats.set(record.chatKey, stat);
        }
        const keep = chooseChatsToKeep([...stats.values()]);
        const survivors = [];
        const doomed = [];
        for (const record of all) (keep.has(record.chatKey) ? survivors : doomed).push(record);
        let total = survivors.reduce((sum, record) => sum + record.bytes, 0);
        survivors.sort((a, b) => a.at - b.at);
        while (total > maxBytes && survivors.length) { const oldest = survivors.shift(); total -= oldest.bytes; doomed.push(oldest); }
        if (doomed.length) {
            const store = database.transaction(STORE, 'readwrite').objectStore(STORE);
            for (const record of doomed) store.delete(record.key);
        }
        return doomed.length;
    }

    async function clear() {
        const database = await db();
        if (!database) return false;
        await wrap(database.transaction(STORE, 'readwrite').objectStore(STORE).clear()).catch(() => {});
        return true;
    }

    const unregisters = [
        servicesBus.register('rasterCache.get', params => get(params), { loadMetric: () => 1 }),
        servicesBus.register('rasterCache.has', params => has(params), { loadMetric: () => 1 }),
        servicesBus.register('rasterCache.put', params => put(params), { loadMetric: () => 1 }),
        servicesBus.register('rasterCache.prune', () => prune(), { loadMetric: () => 1 }),
        servicesBus.register('rasterCache.clear', () => clear(), { loadMetric: () => 0 }),
    ];
    return () => { for (const unregister of unregisters) unregister(); };
}
