import { request } from '../../../libraries/shared/request.js';
import { nextInstanceId, safeBodyHtml, widgetBlockId, WIDGET_LAYOUT } from '../../../libraries/shared/widget-contract.js';
import { escapeHtml, widgetUnavailableHtml } from '../../../libraries/shared/home-html.js';
import { createWidgetManager } from './widgets.js';
import { createItemPicker } from './picker.js';

const DEFAULT_BASE_URL = new URL('../../../widgets/', import.meta.url).href;

/**
 * Виджеты на рабочем столе Module Engine: склейка менеджера виджетов (widgets.js — реестр и экземпляры) с экраном. Здесь — то, что нужно экрану:
 * что стоит на столе (`state.widgets`), тело и кнопки каждого экземпляра, выбор виджета для добавления, права виджета (Гейт как у Модулей) и регистрация
 * на лету (контракты Шины, событие окна, очередь до загрузки). Экран сам рисует и хранит положения — отсюда он получает только данные.
 *
 * Состояние (`state`, общий объект ядра экрана): `widgets` — `[{ instanceId, widgetId }]`, `widgetData` — по экземпляру `{ ключ: значение }` (то, что виджет
 * кладёт через `host.storage`), `saved` — положения блоков (здесь только чистятся). Сохранение — `save()`, перерисовка — `requestRender()`.
 */
export function createWidgetDesk({
    host, doc = globalThis.document, win = globalThis, state, save, requestRender, registerWidgetCaller,
    baseUrl = DEFAULT_BASE_URL,
    fetchJson = url => globalThis.fetch(url, { cache: 'no-cache' }).then(response => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); }),
    importModule = url => import(url),
} = {}) {
    let renderTimer = null;
    let catalogLoaded = null;

    // Перерисовка по просьбе виджета/реестра склеивается: несколько «invalidate» подряд — один кадр.
    const scheduleRender = () => { win.clearTimeout(renderTimer); renderTimer = win.setTimeout(() => requestRender(), 0); };

    /** Что получает виджет: `request` (только к контрактам, разрешённым его `rights`, Гейт настоящий) и `storage` (его собственные ключи на этом экземпляре). */
    function createHost(widget, instanceId) {
        const caller = registerWidgetCaller?.(widget.id, widget.rights) ?? null;
        return {
            layout: WIDGET_LAYOUT,
            // Подписка на события движка (`st.characterDeleted`, `ui.home.cardsChanged`, …); вернуть отписку — обязанность виджета в `stop()`.
            subscribe: (event, callback) => host.events.subscribe(event, callback),
            request: (contract, params, { via = 'cores' } = {}) => (caller?.[via]
                ? request(caller[via], contract, { params })
                : Promise.resolve({ ok: false, error: { message: 'this widget has no access to the engine' } })),
            storage: {
                get: async key => state.widgetData[instanceId]?.[key],
                set: async (key, value) => { (state.widgetData[instanceId] ??= {})[key] = value; await save(); },
            },
        };
    }

    const manager = createWidgetManager({
        baseUrl, fetchJson, importModule, createHost,
        onChange: () => scheduleRender(),
    });

    const picker = createItemPicker({
        document: doc,
        title: 'Add a widget to the desktop',
        emptyText: 'No widgets installed. Drop one into the widgets folder or register it from code.',
        onPick: widgetId => {
            const instanceId = nextInstanceId(state.widgets.map(item => item.instanceId));
            state.widgets.push({ instanceId, widgetId });
            manager.mount(instanceId, widgetId);
            void save();
            requestRender();
        },
    });

    // Регистрация на лету — без единого импорта из нашего кода: контракт Шины, событие окна и очередь (для тех, кто загрузился раньше нас).
    const cleanups = [];
    const own = host?.own;
    if (own?.register) {
        cleanups.push(own.register('desktop.widgets.register', params => manager.register(params?.definition, { source: 'runtime' })));
        cleanups.push(own.register('desktop.widgets.unregister', params => manager.unregister(params?.id)));
        cleanups.push(own.register('desktop.widgets.list', () => manager.available()));
    }
    const onRegisterEvent = event => { manager.register(event.detail, { source: 'runtime' }); };
    const onUnregisterEvent = event => { manager.unregister(event.detail?.id); };
    win.addEventListener?.('stme:widget:register', onRegisterEvent);
    win.addEventListener?.('stme:widget:unregister', onUnregisterEvent);
    cleanups.push(() => { win.removeEventListener?.('stme:widget:register', onRegisterEvent); win.removeEventListener?.('stme:widget:unregister', onUnregisterEvent); });
    const drainQueue = () => {
        const queued = Array.isArray(win.__stmeWidgetQueue) ? win.__stmeWidgetQueue.splice(0) : [];
        for (const definition of queued) manager.register(definition, { source: 'runtime' });
    };

    return {
        manager,
        /** Загружает папку `widgets/` один раз и разбирает очередь регистраций; экземпляры на столе оживают, если их виджеты нашлись. */
        loadCatalog() {
            drainQueue();
            catalogLoaded ??= manager.loadCatalog().then(result => {
                for (const failure of result.failed) console.warn(`[home] widget "${failure.id}" was not loaded: ${failure.error}`);
                manager.sync(state.widgets);
                return result;
            });
            return catalogLoaded;
        },
        /** Что стоит на столе, с размерами из определений: вход для `buildBlocks`. */
        blockSpecs: () => state.widgets.map(({ instanceId, widgetId }) => ({ instanceId, widgetId, size: manager.size(widgetId) ?? undefined })),
        /** Тело и кнопки экземпляра. Виджета нет или он упал — заглушка с причиной: место на столе не теряется. */
        dataFor(block) {
            const { instance, error } = manager.state(block.instanceId);
            if (!instance) {
                const reason = error === 'not installed' ? 'Not installed — it comes back when the widget is added again.' : `Failed to start: ${error}`;
                return { html: widgetUnavailableHtml(manager.title(block.widgetId), reason), actions: [] };
            }
            let rows = [];
            try { rows = typeof instance.rows === 'function' ? instance.rows() ?? [] : []; } catch (error) { console.warn(`[home] widget rows failed: ${error?.message ?? error}`); }
            const search = instance.search && typeof instance.search === 'object' ? { placeholder: String(instance.search.placeholder ?? 'Search…'), value: String(instance.search.value ?? '') } : null;
            return { html: safeBodyHtml(instance, escapeHtml), actions: Array.isArray(instance.actions) ? instance.actions : [], rows: Array.isArray(rows) ? rows : [], search };
        },
        handlers: {
            onAddWidget: () => picker.open(manager.available().map(item => ({ id: item.id, name: item.title, hint: item.description }))),
            onWidgetAction: (instanceId, actionId, rowId) => {
                try { manager.state(instanceId).instance?.onAction?.(actionId, rowId); } catch (error) { console.warn(`[home] widget action failed: ${error?.message ?? error}`); }
            },
            onWidgetSearch: (instanceId, value) => {
                try { manager.state(instanceId).instance?.onSearch?.(value); } catch (error) { console.warn(`[home] widget search failed: ${error?.message ?? error}`); }
            },
            onRemoveWidget: instanceId => {
                state.widgets = state.widgets.filter(item => item.instanceId !== instanceId);
                delete state.widgetData[instanceId];
                delete state.saved[widgetBlockId(instanceId)];
                manager.unmount(instanceId);
                void save();
                requestRender();
            },
        },
        /** Стол показан: оживить экземпляры (часы снова тикают). */
        activate: () => manager.sync(state.widgets),
        /** Стол скрыт (открыт чат): остановить все экземпляры — таймеры виджетов не работают, пока их не видно. */
        deactivate: () => { picker.close(); manager.sync([]); },
        dispose() { win.clearTimeout(renderTimer); picker.close(); manager.dispose(); for (const cleanup of cleanups) cleanup?.(); },
    };
}
