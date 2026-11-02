/**
 * Сжатая часть префикса лога: отдельный ключ памяти чата. Записи только
 * дописываются; перезапись разрешена лишь сводке закрытой арки.
 */
export function createDigestStore({ enqueue, call, namespace }) {
    let records = [];

    function saveDigests(next) {
        return enqueue(async () => {
            records = Array.isArray(next) ? next.filter(record => record && typeof record === 'object') : [];
            await call('storage.chatMemory.set', { namespace, key: 'turnDigests', value: records });
            return records;
        });
    }

    return {
        digests: () => records.map(record => ({ ...record })),
        saveDigests,
        load: value => { records = Array.isArray(value) ? value : []; },
    };
}
