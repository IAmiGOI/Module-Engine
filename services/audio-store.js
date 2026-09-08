/**
 * Сервис хранилища аудио — единственное место во всём движке, которое знает
 * про `indexedDB`. Тот же разрез, что у [st-chat.js](st-chat.js) и
 * [dom.js](dom.js): логический адаптер — положить/прочитать/удалить — и всё.
 * Ни политики, ни индексов, ни знаний о том, ЧЬИ это треки: байты аудио в
 * настройках Модуля (`storage.settings`) жить не могут — ST читает и пишет
 * `extensionSettings` целиком как JSON, мегабайтные Blob'ы там чужие (см.
 * Alpha's `modules/music/audio-store.js` — тот же вывод, та же причина).
 *
 * Хранилище локальное для этого браузера: экспорт/перенос настроек Модуля
 * переносит МЕТАДАННЫЕ треков (имя, описание, вектор, playCount), но не байты.
 * Потеря стора (другой браузер, чистка данных сайта) теряет звук, но не
 * структуру библиотеки — треки можно переимпортировать под теми же id.
 *
 * Модуль обращается сюда ЧЕРЕЗ Гейт (`allowedContracts`), не напрямую:
 * сервисные контракты — единственный легальный путь Модуля к Сервисам.
 */
const DB_NAME = 'stme-beta-audio';
const DB_VERSION = 1;
const STORE_NAME = 'tracks';

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

export function registerAudioStoreService(bus) {
    const unregisters = [
        bus.register('audio.put', params => withStore('readwrite', store => store.put(params?.blob, String(params?.id))), { loadMetric: () => 1 }),
        bus.register('audio.get', params => withStore('readonly', store => store.get(String(params?.id))), { loadMetric: () => 1 }),
        bus.register('audio.delete', params => withStore('readwrite', store => store.delete(String(params?.id))), { loadMetric: () => 1 }),
    ];
    return () => { for (const unregister of unregisters) unregister(); };
}
