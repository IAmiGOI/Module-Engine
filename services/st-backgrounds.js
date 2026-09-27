/**
 * Сервис фонов ST — единственное место, знающее про её `/api/backgrounds/*`: список, загрузка, удаление и обновление списка в
 * интерфейсе. Логический адаптер: спросить/сделать и вернуть. Что и когда ставить, решает Ядро фонов.
 *
 * Загрузка — тот же `multipart`-запрос, что делает сама ST (поле `avatar`), поэтому файл получает обычные миниатюры и метаданные
 * и виден в её списке фонов как родной. Сервер только сохраняет файл: сам фон он не меняет.
 *
 * `setActive` — какой фон СЕЙЧАС показан, а не список/файлы. У этого нет отдельного API (проверено по исходнику): родной путь —
 * `/bg <имя>` (нечёткий поиск по `.bg_example` в её собственной галерее, кликает по найденной миниатюре — тот же путь, что и у
 * пользователя мышью), доступен только через её слэш-команды (`getContext().executeSlashCommandsWithOptions`), внутренняя функция
 * не экспортирована. `/bg` без аргумента отдаёт имя текущего фона — этим же вызовом до и после проверяем, что имя действительно
 * изменилось (сам `/bg <имя>` при "не нашла" тоже отвечает пустой строкой — тостом, который отсюда не прочитать).
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

    /** Ставит фон СЕЙЧАС (нечёткое имя — см. doc-comment файла). `applied` — что реально стоит после попытки, всегда, даже при `ok:false`. */
    async function setActive({ name } = {}) {
        if (!name) throw new Error('stBackgrounds.setActive: "name" is required.');
        const run = getContext()?.executeSlashCommandsWithOptions;
        if (!run) throw new Error('stBackgrounds.setActive: SillyTavern\'s slash-command API is unavailable.');
        const before = await run.call(getContext(), '/bg');
        await run.call(getContext(), `/bg ${name}`);
        const after = await run.call(getContext(), '/bg');
        const applied = after?.pipe ?? '';
        const matched = applied.toLowerCase().includes(String(name).toLowerCase());
        return { ok: matched, applied, changed: applied !== (before?.pipe ?? '') };
    }

    const unregisters = [
        bus.register('stBackgrounds.list', () => list(), { loadMetric: () => 0 }),
        bus.register('stBackgrounds.upload', params => upload(params), { loadMetric: () => 0 }),
        bus.register('stBackgrounds.delete', params => remove(params), { loadMetric: () => 0 }),
        bus.register('stBackgrounds.refresh', () => refresh(), { loadMetric: () => 0 }),
        bus.register('stBackgrounds.setActive', params => setActive(params), { loadMetric: () => 0 }),
    ];
    return () => { for (const unregister of unregisters) unregister(); };
}
