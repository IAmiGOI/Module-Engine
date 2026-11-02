import { DECISION_NAMESPACE, DECISION_MEMORY_NAMESPACE } from '../../libraries/core/decision-settings.js';
import { createBankRecord } from '../../libraries/core/decision-banks.js';

/** Два слоя дата-банков: базовый (settings, общий для чатов) и копия чата. */
const BASE_KEY = 'characterBanks';
const CHAT_KEY = 'characterBanks';
const COLD_START_KEY = 'bankColdStart';

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
    let chat = {};
    let coldStart = { status: 'idle', total: 0, done: 0, errors: 0, startedAt: 0, updatedAt: 0 };
    let tail = Promise.resolve();

    function enqueue(task) {
        const run = tail.then(task, task);
        tail = run.then(() => {}, () => {});
        return run;
    }

    async function load() {
        const [baseValue, chatValue, coldValue] = await Promise.all([
            call('storage.settings.get', { namespace: DECISION_NAMESPACE, key: BASE_KEY, fallback: {} }),
            call('storage.chatMemory.get', { namespace: DECISION_MEMORY_NAMESPACE, key: CHAT_KEY, fallback: {} }),
            call('storage.chatMemory.get', { namespace: DECISION_MEMORY_NAMESPACE, key: COLD_START_KEY, fallback: null }),
        ]);
        base = sanitizeBanks(baseValue);
        chat = sanitizeBanks(chatValue);
        coldStart = coldValue && typeof coldValue === 'object' ? { ...coldStart, ...coldValue } : { status: 'idle', total: 0, done: 0, errors: 0, startedAt: 0, updatedAt: 0 };
        return { base, chat, coldStart };
    }

    const saveBase = next => enqueue(async () => {
        base = sanitizeBanks(next);
        await call('storage.settings.set', { namespace: DECISION_NAMESPACE, key: BASE_KEY, value: base });
        return base;
    });
    const saveChat = next => enqueue(async () => {
        chat = sanitizeBanks(next);
        await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: CHAT_KEY, value: chat });
        return chat;
    });
    const saveColdStart = next => enqueue(async () => {
        coldStart = { ...coldStart, ...next, updatedAt: Date.now() };
        await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: COLD_START_KEY, value: coldStart });
        return coldStart;
    });

    return {
        load, saveBase, saveChat, saveColdStart,
        base: () => ({ ...base }), chat: () => ({ ...chat }), coldStart: () => ({ ...coldStart }),
        putBase: record => saveBase({ ...base, [record.sourceKey]: record }).then(() => record),
        putChat: record => saveChat({ ...chat, [record.sourceKey]: record }).then(() => record),
    };
}
