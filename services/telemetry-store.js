/**
 * Сервис хранения телеметрии — IndexedDB этого браузера, не настройки и не метаданные чата: записей тысячи, чат от них
 * не должен пухнуть. Кольцо вызовов (последние TELEMETRY_LIMIT) и сводки по дням, которые переживают обрезку кольца.
 * Без IndexedDB (тесты, старый браузер) — в памяти до перезагрузки.
 */
import { TELEMETRY_LIMIT, rollupDays } from '../libraries/core/telemetry.js';

const DB_NAME = 'stme-telemetry';
const CALLS = 'calls';
const KV = 'kv';

function memoryStore() {
    let calls = [];
    let nextId = 1;
    const kv = new Map();
    return {
        add: async records => { for (const record of records) calls.push({ ...record, id: nextId++ }); },
        all: async () => calls.map(record => ({ ...record })),
        trim: async limit => { if (calls.length > limit) calls = calls.slice(calls.length - limit); },
        get: async key => (kv.has(key) ? kv.get(key) : null),
        set: async (key, value) => { kv.set(key, value); },
        clear: async () => { calls = []; kv.delete('days'); },
    };
}

function idbStore(indexedDB) {
    const open = () => new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(CALLS)) db.createObjectStore(CALLS, { keyPath: 'id', autoIncrement: true });
            if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    async function tx(names, mode, run) {
        const db = await open();
        try {
            return await new Promise((resolve, reject) => {
                const transaction = db.transaction(names, mode);
                const result = run(transaction);
                transaction.oncomplete = () => resolve(result?.result ?? result ?? null);
                transaction.onerror = () => reject(transaction.error);
                transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
            });
        } finally { db.close(); }
    }
    return {
        add: records => tx([CALLS], 'readwrite', t => { for (const record of records) t.objectStore(CALLS).add({ ...record }); }),
        all: () => tx([CALLS], 'readonly', t => t.objectStore(CALLS).getAll()),
        trim: async limit => {
            const count = await tx([CALLS], 'readonly', t => t.objectStore(CALLS).count());
            if (count <= limit) return;
            const extra = count - limit;
            await tx([CALLS], 'readwrite', t => {
                let removed = 0;
                const cursor = t.objectStore(CALLS).openCursor();
                cursor.onsuccess = () => {
                    const at = cursor.result;
                    if (!at || removed >= extra) return;
                    at.delete(); removed += 1; at.continue();
                };
            });
        },
        get: key => tx([KV], 'readonly', t => t.objectStore(KV).get(key)),
        set: (key, value) => tx([KV], 'readwrite', t => { t.objectStore(KV).put(value, key); }),
        clear: () => tx([CALLS, KV], 'readwrite', t => { t.objectStore(CALLS).clear(); t.objectStore(KV).delete('days'); }),
    };
}

export function registerTelemetryStoreService(bus, { indexedDB = globalThis.indexedDB, limit = TELEMETRY_LIMIT } = {}) {
    const store = indexedDB ? idbStore(indexedDB) : memoryStore();
    // Записи идут по одной очереди: параллельная обрезка и добавление в IndexedDB путают счёт.
    let queue = Promise.resolve();
    const serial = job => { const run = queue.then(job, job); queue = run.catch(() => {}); return run; };

    async function append(params) {
        const records = (Array.isArray(params?.records) ? params.records : [params?.record]).filter(record => record && typeof record === 'object');
        if (!records.length) return { ok: true, added: 0 };
        return serial(async () => {
            await store.add(records);
            await store.set('days', rollupDays(await store.get('days'), records));
            await store.trim(limit);
            return { ok: true, added: records.length };
        });
    }

    const unregisters = [
        bus.register('telemetry.append', params => append(params), { loadMetric: () => 1 }),
        bus.register('telemetry.list', async () => (await store.all()) ?? [], { loadMetric: () => 1 }),
        bus.register('telemetry.days', async () => (await store.get('days')) ?? {}, { loadMetric: () => 1 }),
        bus.register('telemetry.kv.get', async params => (await store.get(`kv:${String(params?.key ?? '')}`)) ?? null, { loadMetric: () => 1 }),
        bus.register('telemetry.kv.set', async params => { await store.set(`kv:${String(params?.key ?? '')}`, params?.value ?? null); return true; }, { loadMetric: () => 1 }),
        bus.register('telemetry.clear', () => serial(async () => { await store.clear(); return true; }), { loadMetric: () => 1 }),
    ];
    return () => { for (const unregister of unregisters) unregister(); };
}
