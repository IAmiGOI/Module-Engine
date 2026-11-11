/**
 * Входящий ящик правок — файл `me-patch.json` в пользовательских файлах ST (`data/<user>/user/files/`). Его кладут снаружи
 * (разработчик, инструменты), не трогая файл чата: открытая вкладка всё равно сохранила бы чат поверх. Сервис только читает,
 * удаляет и пишет отчёт `me-patch-result.json`; что делать с правками, решает Ядро решений.
 *
 * Контракты: `stPatchInbox.read` → объект правок или `null`; `stPatchInbox.remove`; `stPatchInbox.reply { result }`.
 */
const INBOX = 'me-patch.json';
const REPLY = 'me-patch-result.json';

export function registerStPatchInboxService(bus, { getContext, fetch: fetchImpl = globalThis.fetch?.bind(globalThis) } = {}) {
    const headers = () => ({ 'Content-Type': 'application/json', ...(getContext()?.getRequestHeaders?.() ?? {}) });

    async function read() {
        let response;
        try { response = await fetchImpl(`/user/files/${INBOX}?t=${Date.now()}`, { cache: 'no-store' }); } catch { return null; }
        if (!response?.ok) return null;
        try { return await response.json(); } catch { return null; }
    }

    async function remove() {
        const response = await fetchImpl('/api/files/delete', { method: 'POST', headers: headers(), body: JSON.stringify({ path: `user/files/${INBOX}` }) }).catch(() => null);
        return Boolean(response?.ok);
    }

    async function reply({ result = null } = {}) {
        const data = btoa(unescape(encodeURIComponent(JSON.stringify({ at: new Date().toISOString(), result }, null, 1))));
        const response = await fetchImpl('/api/files/upload', { method: 'POST', headers: headers(), body: JSON.stringify({ name: REPLY, data }) }).catch(() => null);
        return Boolean(response?.ok);
    }

    const unregisters = [
        bus.register('stPatchInbox.read', () => read(), { loadMetric: () => 0 }),
        bus.register('stPatchInbox.remove', () => remove(), { loadMetric: () => 0 }),
        bus.register('stPatchInbox.reply', params => reply(params ?? {}), { loadMetric: () => 0 }),
    ];
    return () => { for (const unregister of unregisters) unregister(); };
}
