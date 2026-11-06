import { DECISION_NAMESPACE, DECISION_MEMORY_NAMESPACE } from '../../libraries/core/decision-settings.js';
import { createBankRecord } from '../../libraries/core/decision-banks.js';

/** Два слоя дата-банков: базовый (settings, общий для чатов) и копия чата. */
const BASE_KEY = 'characterBanks';
const CHAT_KEY = 'characterBanks';
const COLD_START_KEY = 'bankColdStart';
const MARKS_KEY = 'lorebookMarks';

function sanitizeMarks(value) {
    const out = {};
    for (const [book, record] of Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {})) {
        if (!record || typeof record !== 'object' || !Array.isArray(record.marks)) continue;
        const entryHashes = record.entryHashes && typeof record.entryHashes === 'object' && !Array.isArray(record.entryHashes)
            ? Object.fromEntries(Object.entries(record.entryHashes).map(([uid, hash]) => [String(uid), String(hash)])) : null;
        out[book] = { sourceHash: String(record.sourceHash ?? ''), marks: record.marks.filter(mark => mark && mark.uid !== undefined && String(mark.name ?? '').trim()), at: Number(record.at) || 0, ...(entryHashes ? { entryHashes } : {}) };
    }
    return out;
}

function sanitizeBanks(value) {
    const out = {};
    for (const [key, record] of Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {})) {
        if (!record || typeof record !== 'object') continue;
        out[key] = createBankRecord({ ...record, sourceKey: record.sourceKey || key });
    }
    return out;
}

export function createBankStore({ call }) {
    let base = {};
    let marks = {};
    let chat = {};
    let coldStart = { status: 'idle', total: 0, done: 0, errors: 0, startedAt: 0, updatedAt: 0 };
    let tail = Promise.resolve();
    let epoch = 0; // каждая загрузка — новый чат (или его перечитка): старые сборки сверяются с ней перед записью

    function enqueue(task) {
        const run = tail.then(task, task);
        tail = run.then(() => {}, () => {});
        return run;
    }

    async function load() {
        epoch += 1;
        const [baseValue, marksValue, chatValue, coldValue] = await Promise.all([
            call('storage.settings.get', { namespace: DECISION_NAMESPACE, key: BASE_KEY, fallback: {} }),
            call('storage.settings.get', { namespace: DECISION_NAMESPACE, key: MARKS_KEY, fallback: {} }),
            call('storage.chatMemory.get', { namespace: DECISION_MEMORY_NAMESPACE, key: CHAT_KEY, fallback: {} }),
            call('storage.chatMemory.get', { namespace: DECISION_MEMORY_NAMESPACE, key: COLD_START_KEY, fallback: null }),
        ]);
        base = sanitizeBanks(baseValue);
        marks = sanitizeMarks(marksValue);
        chat = sanitizeBanks(chatValue);
        coldStart = coldValue && typeof coldValue === 'object' ? { ...coldStart, ...coldValue } : { status: 'idle', total: 0, done: 0, errors: 0, startedAt: 0, updatedAt: 0 };
        return { base, marks, chat, coldStart };
    }

    const resolve = next => (typeof next === 'function' ? next() : next);
    const saveBase = next => enqueue(async () => {
        base = sanitizeBanks(resolve(next));
        await call('storage.settings.set', { namespace: DECISION_NAMESPACE, key: BASE_KEY, value: base });
        return base;
    });
    const saveMarks = next => enqueue(async () => {
        marks = sanitizeMarks(next);
        await call('storage.settings.set', { namespace: DECISION_NAMESPACE, key: MARKS_KEY, value: marks });
        return marks;
    });
    const saveChat = next => enqueue(async () => {
        chat = sanitizeBanks(resolve(next));
        await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: CHAT_KEY, value: chat });
        return chat;
    });
    const saveColdStart = next => enqueue(async () => {
        coldStart = { ...coldStart, ...next, updatedAt: Date.now() };
        await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: COLD_START_KEY, value: coldStart });
        return coldStart;
    });

    return {
        load, saveBase, saveMarks, saveChat, saveColdStart, epoch: () => epoch,
        base: () => ({ ...base }), marks: () => ({ ...marks }), chat: () => ({ ...chat }), coldStart: () => ({ ...coldStart }),
        // Слияние внутри очереди: карта, снятая в момент вызова, теряла записи соседних параллельных правок
        // (последняя затирала остальные — банки «не правились» и правились снова при каждом входе в чат).
        putBase: record => saveBase(() => ({ ...base, [record.sourceKey]: record })).then(() => record),
        putChat: record => saveChat(() => ({ ...chat, [record.sourceKey]: record })).then(() => record),
    };
}
