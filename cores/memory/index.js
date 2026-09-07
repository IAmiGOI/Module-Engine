import { request } from '../../libraries/shared/request.js';
import { readNamespacedValue, writeNamespacedValue, removeNamespacedValue, listNamespacedKeys } from '../../libraries/core/namespaced-store.js';

/** Defensive reader — a missing/blank namespace or key fails loudly (caught by the bus's own error envelope, see ARCHITECTURE.md "Контракт на ошибки"), never silently reads/writes the wrong bucket. */
function requireLocation(params) {
    const namespace = String(params?.namespace ?? '').trim();
    const key = String(params?.key ?? '').trim();
    if (!namespace) throw new Error('storage.chatMemory: "namespace" is required.');
    if (!key) throw new Error('storage.chatMemory: "key" is required.');
    return { namespace, key };
}

/**
 * Ядро внутренней памяти чата (CORES.md) — произвольные данные, привязанные
 * к текущему чату, в любом формате; шире, чем Ядро сохранения будет для
 * настроек (см. ARCHITECTURE.md "Персистентность"). Registers
 * `storage.chatMemory.{get,set,remove,keys}` on the Шина ядер; the actual
 * ST binding (chatMetadata + saveMetadataDebounced) lives entirely in the
 * thin Сервис ([services/chat-metadata.js](../../services/chat-metadata.js)),
 * reached through the regular Гейт via `host.services` — same Ядро/Сервис
 * split already used for DOM and HTTP.
 *
 * `namespace` is DECLARED by the caller in every request's params, not a
 * verified caller id — the Шина/Гейт only prove RIGHTS to call
 * `storage.chatMemory.*` at all, never WHICH namespace string a call
 * carries (that would require threading a verified caller id through every
 * contract handler, a bus-wide change out of scope here — see this Ядро's
 * own test file for the explicit tradeoff). Mirrors Alpha's own long-standing
 * `moduleId`-as-a-passed-parameter convention (never structurally enforced
 * there either) — official-tier callers are trusted by definition; a
 * community-tier caller can only reach this contract at all if its own key
 * explicitly grants it.
 *
 * Every operation re-reads the raw store fresh from the Сервис rather than
 * caching it — the current chat can change between calls, and a stale
 * cached blob would silently write into the WRONG chat's metadata.
 *
 * **`set()`/`remove()` run through a queue, not straight through.** Both are
 * read-modify-write: read the whole raw blob, mutate a `namespace`/`key`
 * inside it, write it back. `readNamespacedValue()`'s fallback for a
 * namespace/key that has never been written is a FRESH object each call —
 * so two concurrent first-ever writes to the same namespace (e.g. two
 * Модуля both annotating the same chatHistory bucket on the same
 * `generation.completed`) can each read the same empty state, mutate their
 * own separate copy, and the second write-back silently discards the
 * first's. `enqueue()` below serializes every set/remove against every
 * other one on this Ядро, closing that window; `get()`/`keys()` stay
 * unqueued since a plain read is never torn.
 */
export function createChatMemoryCore(host) {
    async function readRaw() {
        const result = await request(host.services, 'chatMetadata.read', {});
        if (!result.ok) throw new Error(result.error.message);
        return result.value ?? {};
    }

    async function writeRaw(raw) {
        const result = await request(host.services, 'chatMetadata.write', { params: { raw } });
        if (!result.ok) throw new Error(result.error.message);
    }

    // A tail promise that always settles, so one failed write in the chain
    // never wedges every write queued after it.
    let tail = Promise.resolve();
    function enqueue(task) {
        const run = tail.then(task, task);
        tail = run.then(() => {}, () => {});
        return run;
    }

    const unregisterGet = host.own.register('storage.chatMemory.get', async params => {
        const { namespace, key } = requireLocation(params);
        const raw = await readRaw();
        return readNamespacedValue(raw, namespace, key, params?.fallback);
    });

    const unregisterSet = host.own.register('storage.chatMemory.set', params => enqueue(async () => {
        const { namespace, key } = requireLocation(params);
        const raw = await readRaw();
        writeNamespacedValue(raw, namespace, key, params?.value);
        await writeRaw(raw);
        return true;
    }));

    // Only writes back when something was ACTUALLY removed — a remove() of an
    // already-absent key must not trigger a needless chatMetadata save, same
    // discipline Alpha's own stores already followed (see Alpha's
    // notebook/store.js doc comment on why a no-op must never look like a write).
    const unregisterRemove = host.own.register('storage.chatMemory.remove', params => enqueue(async () => {
        const { namespace, key } = requireLocation(params);
        const raw = await readRaw();
        const removed = removeNamespacedValue(raw, namespace, key);
        if (removed) await writeRaw(raw);
        return removed;
    }));

    const unregisterKeys = host.own.register('storage.chatMemory.keys', async params => {
        const namespace = String(params?.namespace ?? '').trim();
        if (!namespace) throw new Error('storage.chatMemory: "namespace" is required.');
        return listNamespacedKeys(await readRaw(), namespace);
    });

    /**
     * Форсирует немедленное, настоящее сохранение поверх обычного `set()` —
     * найдено живьём (жалоба пользователя): `set()` (и, соответственно,
     * `context.saveMetadataDebounced()` за ним, см. `services/chat-metadata.js`'s
     * doc-comment на `flush()`) откладывает реальную запись на секунду;
     * перезагрузка страницы раньше теряет данные молча. Прогоняется ЧЕРЕЗ
     * ту же очередь `enqueue()`, что и `set()`/`remove()` — гарантирует, что
     * флашится состояние ПОСЛЕ всех уже поставленных в очередь записей, а
     * не что-то посреди ещё не выполнившегося read-modify-write.
     */
    const unregisterFlush = host.own.register('storage.chatMemory.flush', () => enqueue(async () => {
        const result = await request(host.services, 'chatMetadata.flush', {});
        if (!result.ok) throw new Error(result.error.message);
        return true;
    }));

    return {
        unregister: () => { unregisterGet(); unregisterSet(); unregisterRemove(); unregisterKeys(); unregisterFlush(); },
    };
}
