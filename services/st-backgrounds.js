/**
 * Сервис фонов ST — единственное место, знающее про её `/api/backgrounds/*`: список, загрузка, удаление и обновление списка в
 * интерфейсе. Логический адаптер: спросить/сделать и вернуть. Что и когда ставить, решает Ядро фонов.
 *
 * Загрузка — тот же `multipart`-запрос, что делает сама ST (поле `avatar`), поэтому файл получает обычные миниатюры и метаданные
 * и виден в её списке фонов как родной. Сервер только сохраняет файл: сам фон он не меняет.
 */

const ALL_ENDPOINT = '/api/backgrounds/all';
const UPLOAD_ENDPOINT = '/api/backgrounds/upload';
const DELETE_ENDPOINT = '/api/backgrounds/delete';

export function registerStBackgroundsService(bus, {
    getContext,
    fetch: fetchImpl = globalThis.fetch?.bind(globalThis),
    FileCtor = globalThis.File,
    FormDataCtor = globalThis.FormData,
    refreshList = () => import('/scripts/backgrounds.js').then(module => module.getBackgrounds?.()),
} = {}) {
    function headers(options = {}) {
        return getContext()?.getRequestHeaders?.(options) ?? {};
    }

    async function list() {
        const response = await fetchImpl(ALL_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers() }, body: '{}' });
        if (!response.ok) throw new Error(`backgrounds list: HTTP ${response.status}`);
        const data = await response.json();
        return (data?.images ?? []).map(item => (typeof item === 'string' ? item : item.filename)).filter(Boolean);
    }

    async function upload({ name, blob } = {}) {
        if (!name || !blob) throw new Error('stBackgrounds.upload: "name" and "blob" are required.');
        const form = new FormDataCtor();
        form.append('avatar', new FileCtor([blob], name, { type: blob.type || 'application/octet-stream' }));
        const response = await fetchImpl(UPLOAD_ENDPOINT, { method: 'POST', headers: headers({ omitContentType: true }), body: form, cache: 'no-cache' });
        if (!response.ok) throw new Error(`backgrounds upload "${name}": HTTP ${response.status}`);
        return response.text();
    }

    async function remove({ name } = {}) {
        if (!name) throw new Error('stBackgrounds.delete: "name" is required.');
        const response = await fetchImpl(DELETE_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers() }, body: JSON.stringify({ bg: name }) });
        if (!response.ok) throw new Error(`backgrounds delete "${name}": HTTP ${response.status}`);
        return true;
    }

    /** Перечитать список в интерфейсе ST (её `getBackgrounds()`); сбой не критичен — список обновится при следующем открытии. */
    async function refresh() {
        try { await refreshList(); return true; } catch { return false; }
    }

    const unregisters = [
        bus.register('stBackgrounds.list', () => list(), { loadMetric: () => 0 }),
        bus.register('stBackgrounds.upload', params => upload(params), { loadMetric: () => 0 }),
        bus.register('stBackgrounds.delete', params => remove(params), { loadMetric: () => 0 }),
        bus.register('stBackgrounds.refresh', () => refresh(), { loadMetric: () => 0 }),
    ];
    return () => { for (const unregister of unregisters) unregister(); };
}
