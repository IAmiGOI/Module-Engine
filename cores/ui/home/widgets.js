import { normalizeWidget, isValidInstance } from '../../../libraries/shared/widget-contract.js';

/**
 * Менеджер виджетов рабочего стола: реестр определений и живые экземпляры. Про DOM, WebGL и сервисы не знает — только контракт виджета
 * (libraries/shared/widget-contract.js). Определения приходят двумя путями, оба без зависимостей у виджета:
 *   1. ПАПКА `widgets/` — список в `widgets/index.json`, каждый виджет — `widgets/<id>/widget.js` (`export default { … }`), грузится динамическим `import`;
 *   2. РЕГИСТРАЦИЯ НА ЛЕТУ — `register(definition)` (контракт Шины `desktop.widgets.register`, событие окна `stme:widget:register`): чужое расширение
 *      кладёт свой виджет без единого импорта из нашего кода.
 * Горячая замена: повторная регистрация того же `id` пересоздаёт его экземпляры (старые получают `stop()`), `unregister` снимает их; сохранённые на столе
 * экземпляры не пропадают — пока определения нет, блок показывает «недоступен», а когда оно появится, экземпляр оживает сам.
 *
 * Браузерное и Шинное — инъекцией: `fetchJson`, `importModule`, `createHost(widget, instanceId)` (даёт виджету `request` с ЕГО правами и `storage`).
 */
export function createWidgetManager({ baseUrl, fetchJson, importModule, createHost = () => ({}), onChange = () => {} } = {}) {
    const definitions = new Map();   // id -> { widget, source }
    const instances = new Map();     // instanceId -> { widgetId, instance, error }
    const wanted = new Map();        // instanceId -> widgetId — что стоит на столе (даже если определения сейчас нет)

    const notify = event => { try { onChange(event); } catch (error) { console.warn('[widgets] onChange failed:', error?.message ?? error); } };

    function mountInstance(instanceId, widgetId) {
        const entry = definitions.get(widgetId);
        if (!entry) { instances.set(instanceId, { widgetId, instance: null, error: 'not installed' }); return false; }
        try {
            const host = { ...createHost(entry.widget, instanceId), instanceId, widgetId, invalidate: () => notify({ type: 'invalidate', instanceId }) };
            const instance = entry.widget.create(host);
            if (!isValidInstance(instance)) throw new Error('create(host) did not return an instance with html()');
            instances.set(instanceId, { widgetId, instance, error: null });
            Promise.resolve(instance.start?.()).catch(error => console.warn(`[widgets] ${widgetId}.start failed:`, error?.message ?? error));
            return true;
        } catch (error) {
            instances.set(instanceId, { widgetId, instance: null, error: error?.message ?? String(error) });
            return false;
        }
    }

    function unmountInstance(instanceId) {
        const entry = instances.get(instanceId);
        if (!entry) return;
        try { entry.instance?.stop?.(); } catch (error) { console.warn(`[widgets] ${entry.widgetId}.stop failed:`, error?.message ?? error); }
        instances.delete(instanceId);
    }

    /** Регистрирует (или заменяет — горячая замена) определение. `{ ok }` или `{ ok: false, error }`. */
    function register(definition, { source = 'runtime' } = {}) {
        const result = normalizeWidget(definition);
        if (!result.ok) return result;
        const { widget } = result;
        const replacing = definitions.has(widget.id);
        for (const [instanceId, entry] of [...instances]) if (entry.widgetId === widget.id) unmountInstance(instanceId);
        definitions.set(widget.id, { widget, source });
        for (const [instanceId, widgetId] of wanted) if (widgetId === widget.id) mountInstance(instanceId, widgetId);
        notify({ type: 'defs', id: widget.id, replaced: replacing });
        return { ok: true, replaced: replacing };
    }

    /** Снимает определение и его экземпляры (на столе остаются заглушками «недоступен»). */
    function unregister(id) {
        if (!definitions.has(id)) return false;
        for (const [instanceId, entry] of [...instances]) if (entry.widgetId === id) { unmountInstance(instanceId); instances.set(instanceId, { widgetId: id, instance: null, error: 'not installed' }); }
        definitions.delete(id);
        notify({ type: 'defs', id, removed: true });
        return true;
    }

    /** Загружает папку `widgets/`: читает `index.json`, импортирует каждый `widget.js`. Не вышло с одним — остальные грузятся. */
    async function loadCatalog() {
        const loaded = [];
        const failed = [];
        let ids = [];
        try {
            const index = await fetchJson(`${baseUrl}index.json`);
            ids = Array.isArray(index?.widgets) ? index.widgets.filter(id => typeof id === 'string') : [];
        } catch (error) {
            return { loaded, failed: [{ id: 'index.json', error: error?.message ?? String(error) }] };
        }
        for (const id of ids) {
            try {
                const module = await importModule(`${baseUrl}${id}/widget.js`);
                const result = register(module?.default, { source: 'folder' });
                if (result.ok) loaded.push(id); else failed.push({ id, error: result.error });
            } catch (error) {
                failed.push({ id, error: error?.message ?? String(error) });
            }
        }
        return { loaded, failed };
    }

    /** Ставит экземпляр на стол (или оживляет сохранённый). */
    function mount(instanceId, widgetId) {
        wanted.set(instanceId, widgetId);
        unmountInstance(instanceId);
        return mountInstance(instanceId, widgetId);
    }

    function unmount(instanceId) {
        wanted.delete(instanceId);
        unmountInstance(instanceId);
    }

    /** Синхронизирует набор экземпляров со списком со стола `[{ instanceId, widgetId }]`: лишние снимает, новые ставит. */
    function sync(list) {
        const ids = new Set(list.map(item => item.instanceId));
        for (const instanceId of [...wanted.keys()]) if (!ids.has(instanceId)) unmount(instanceId);
        for (const { instanceId, widgetId } of list) if (!instances.has(instanceId) || wanted.get(instanceId) !== widgetId) mount(instanceId, widgetId);
    }

    return {
        register, unregister, loadCatalog, mount, unmount, sync,
        has: id => definitions.has(id),
        /** Доступные для добавления: `[{ id, title, description, size, source }]` по названию. */
        available: () => [...definitions.values()].map(({ widget, source }) => ({ id: widget.id, title: widget.title, description: widget.description, size: widget.size, source })).sort((a, b) => a.title.localeCompare(b.title)),
        size: widgetId => definitions.get(widgetId)?.widget.size ?? null,
        title: widgetId => definitions.get(widgetId)?.widget.title ?? widgetId,
        /** Состояние экземпляра: `{ instance, error }` (`instance: null` — недоступен). */
        state: instanceId => instances.get(instanceId) ?? { instance: null, error: 'not installed' },
        dispose() { for (const instanceId of [...instances.keys()]) unmountInstance(instanceId); wanted.clear(); definitions.clear(); },
    };
}
