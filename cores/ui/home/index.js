import { request } from '../../../libraries/shared/request.js';
import { buildBlocks, composeHome, composeFlow, itemsForEvent, checklistProgress } from '../../../libraries/shared/home-model.js';
import { applyOrder } from '../../../libraries/shared/home-order.js';
import { nextInstanceId } from '../../../libraries/shared/widget-contract.js';
import { blockHtml, homeCss, visibleRecent } from '../../../libraries/shared/home-html.js';
import { createSurfaceScene } from '../surface/scene.js';
import { computeStageRect, resolveTokens, useFlowLayout } from './geometry.js';
import { createItemPicker } from './picker.js';
import { createWidgetDesk } from './widget-desk.js';
import { createCardsApi } from './cards.js';
import { createBlockDom, captureFocus, restoreFocus } from './blocks-dom.js';
import { createBlockInteraction } from './interaction.js';

const ACTIVE_CLASS = 'stme-home-active';
const STORAGE = Object.freeze({ namespace: 'core.ui.home', key: 'state' });
const REFRESH_DELAY_MS = 60;

/**
 * Ядро главного экрана: пока ST показывает СВОЙ стартовый экран (нет открытого чата), рисует вместо него наши блоки — недавние чаты, быстрые
 * действия, чек-лист первого запуска. Блоки «как глифы»: плита и кнопки — DOM, текст — WebGL (scene.js); их можно двигать мышью, положение
 * запоминается долями свободного места (адаптивно к окну). Данные и действия — через сервис `stHome` (services/st-home.js): родная панель ST
 * остаётся в DOM (её прячет CSS), а нажатия идут в её родные кнопки. Включается вместе с Chat Viewport (`home.enable()`/`disable()`).
 *
 * События: слушает `ui.inputBar.changed` (высота пилюли — нижняя граница сцены), `ui.chatViewport.columnChanged` (запоминает колонку чата, чтобы
 * вернуть её пилюле, когда экран закроется) и `model.workers.changed` (отмечает пункт «настроить модель»); сам сообщает `ui.chatViewport.columnChanged`
 * с `source: 'home'` — колонку для пилюли на главном экране.
 */
export function createHomeCore(host, {
    document: doc = globalThis.document, win = globalThis, getDevicePixelRatio, publish, MutationObserverCtor = globalThis.MutationObserver,
    registerWidgetCaller, widgetOptions = {}, touch = false,
} = {}) {
    const call = (contract, params) => request(host.services, contract, { params });
    const emit = publish ?? ((event, data) => host.events.emit(event, data));
    const persisted = { saved: {}, order: [], done: new Set(), dismissed: false, cards: [], widgets: [], widgetData: {} };
    let active = null;            // { scene, observer, cleanups }
    let shown = false;
    let chats = [];
    let characterList = [];       // персонажи ST (имя и миниатюра для карточек и выбора)
    let refreshTimer = null;
    let flowMode = false;         // телефон/узкое окно: стол идёт потоком с прокруткой, блоки переставляются (порядок), а не кладутся куда угодно
    let lastPlacements = [];
    let queue = Promise.resolve();
    const blocks = new Map();     // id -> { dom, sig, placement, detach }

    const save = () => request(host.own, 'storage.settings.set', { params: { ...STORAGE, value: { saved: persisted.saved, order: persisted.order, done: [...persisted.done], dismissed: persisted.dismissed, cards: persisted.cards, widgets: persisted.widgets, widgetData: persisted.widgetData, guidePlaced: true } } });
    async function load() {
        const result = await request(host.own, 'storage.settings.get', { params: { ...STORAGE, fallback: {} } });
        const value = (result.ok ? result.value : null) ?? {};
        persisted.saved = value.saved && typeof value.saved === 'object' ? value.saved : {};
        persisted.order = Array.isArray(value.order) ? value.order.filter(id => typeof id === 'string') : [];
        persisted.done = new Set(Array.isArray(value.done) ? value.done : []);
        persisted.dismissed = Boolean(value.dismissed);
        persisted.cards = Array.isArray(value.cards) ? value.cards.filter(avatar => typeof avatar === 'string') : [];
        persisted.widgets = Array.isArray(value.widgets) ? value.widgets.filter(item => item && typeof item.instanceId === 'string' && typeof item.widgetId === 'string') : [];
        persisted.widgetData = value.widgetData && typeof value.widgetData === 'object' ? value.widgetData : {};
        // Виджет гида ставится на стол сам — один раз; убранный пользователем больше не возвращается.
        if (!value.guidePlaced && !persisted.widgets.some(item => item.widgetId === 'guide')) persisted.widgets.unshift({ instanceId: nextInstanceId(persisted.widgets.map(item => item.instanceId)), widgetId: 'guide' });
    }

    // Виджеты рабочего стола (папка `widgets/` + регистрация на лету) — см. widget-desk.js.
    const desk = createWidgetDesk({ host, doc, win, state: persisted, save, requestRender: () => { void render(); }, registerWidgetCaller, ...widgetOptions });

    const cards = createCardsApi({ host, state: persisted, save, requestRender: () => { void render(); }, emit });
    const picker = createItemPicker({ document: doc, title: 'Add a character card', emptyText: 'No characters yet.', onPick: avatar => { cards.add(avatar); } });

    const handlers = {
        ...desk.handlers,
        onAddCard: () => { void openPicker(); },
        onChatAction: (key, action) => { void call('stHome.chatAction', { key, action }); },
        onOpenCharacter: avatar => { void call('stHome.openCharacter', { avatar }); },
        onRemoveCard: avatar => { cards.remove(avatar); },
        onQuick: action => {
            if (action.href) win.open(action.href, '_blank', 'noopener');
            else if (action.own === 'addWidget') desk.handlers.onAddWidget();
            else if (action.native) void call('stHome.quick', { native: action.native });
        },
        onToggleItem: id => {
            if (persisted.done.has(id)) persisted.done.delete(id); else persisted.done.add(id);
            void save();
            void render();
        },
        onDismissChecklist: () => { persisted.dismissed = true; void save(); void render(); },
        // Шаг чек-листа: просит открыть панель движка на нужной карточке (панель принадлежит `index.js` расширения — подписчик на это событие).
        onOpenStep: item => { emit('ui.enginePanel.reveal', { card: item.card, step: item.id }); },
    };

    async function openPicker() {
        const result = await call('stHome.characters');
        characterList = result.ok ? result.value : characterList;
        picker.open(characterList.map(character => ({ id: character.avatar, name: character.name, thumbnail: character.thumbnail, image: character.image })), persisted.cards);
    }

    // Персонажа, которого ещё нет в списке (только что импортирован), рисуем по одному файлу аватара — исходник лежит по адресу `/characters/<файл>`; имя придёт с обновлением списка.
    const characterInfo = avatar => characterList.find(character => character.avatar === avatar) ?? { name: '', thumbnail: '', image: `/characters/${encodeURIComponent(avatar)}` };
    function dataFor(block) {
        if (block.kind === 'recent') return { chats: visibleRecent(chats) };
        if (block.kind === 'character') return characterInfo(block.avatar);
        if (block.kind === 'widget') return desk.dataFor(block);
        return { done: persisted.done };
    }
    const signature = (block, data) => (block.kind === 'checklist' ? [...persisted.done].sort().join(',') : block.kind === 'actions' ? block.kind : JSON.stringify(data));

    const interaction = createBlockInteraction({
        win, blocks, getScene: () => active.scene, isFlow: () => flowMode, getPlacements: () => lastPlacements,
        onMoved: (id, saved) => { persisted.saved[id] = saved; void save(); },
        onReorder: order => { persisted.order = order; void save(); void render(); },
    });

    /**
     * Перерисовка НЕ перекрывается сама собой (найдено живьём: два `render()` подряд — добавили виджет и пришла перерисовка от таймера — мешали друг другу,
     * и WebGL-текст стоял на местах прошлой раскладки, а плиты DOM — уже на новых). Идущий проход дорабатывает, а все просьбы за это время склеиваются в один
     * следующий проход с самыми свежими данными.
     */
    let rendering = null;
    let renderAgain = false;
    function render() {
        if (rendering) { renderAgain = true; return rendering; }
        rendering = (async () => {
            do {
                renderAgain = false;
                try { await renderOnce(); } catch (error) { console.warn('[home] render failed:', error?.message ?? error); }
            } while (renderAgain);
        })().finally(() => { rendering = null; });
        return rendering;
    }

    /** Раскладывает блоки по сцене и синхронизирует DOM и текстуры: лишние убираются, изменившиеся перестраиваются, новые создаются. */
    async function renderOnce() {
        if (!active || !shown) return;
        const { scene } = active;
        // Карточка нового персонажа (импорт/выбор) — список ST мог устареть: перечитываем, если хоть одного нет.
        if (persisted.cards.some(avatar => !characterList.some(character => character.avatar === avatar))) {
            const fresh = await call('stHome.characters');
            if (fresh.ok) characterList = fresh.value;
        }
        const rect = computeStageRect({ doc, win });
        flowMode = useFlowLayout({ touch, width: rect.width });
        const list = buildBlocks({ recentChats: chats, checklistDone: persisted.done, checklistDismissed: true /* чек-лист первого запуска теперь у гида (cores/guide) */, characterCards: persisted.cards, widgets: desk.blockSpecs() });
        let placements;
        if (flowMode) {
            // Поток: содержимое выше окна — сцена прокручивается (холст и слои на полную высоту), сохранённые положения другого устройства не используются.
            const flow = composeFlow({ width: rect.width, blocks: applyOrder(list, persisted.order) });
            await scene.setRect({ ...rect, contentHeight: flow.height });
            placements = flow.placements;
        } else {
            await scene.setRect(rect);
            const stage = scene.size();
            placements = composeHome({ width: stage.width, height: stage.height, blocks: list, saved: persisted.saved });
        }
        lastPlacements = placements;
        scene.root.classList.toggle('stme-home-scroll', flowMode);
        const css = homeCss(resolveTokens({ doc, win }));
        const wanted = new Set(placements.map(p => p.id));
        for (const [id, entry] of blocks) {
            if (wanted.has(id)) continue;
            entry.detach?.(); entry.dom.remove(); blocks.delete(id);
            await scene.removeBody(id);
        }
        for (const placement of placements) {
            const data = dataFor(placement);
            const sig = signature(placement, data);
            let entry = blocks.get(placement.id);
            if (!entry || entry.sig !== sig) {
                const focus = captureFocus(doc, entry?.dom.el);
                entry?.detach?.(); entry?.dom.remove();
                entry = { dom: createBlockDom({ document: doc, block: placement, data, handlers }), sig, placement };
                blocks.set(placement.id, entry);
                scene.blocksLayer.append(entry.dom.el);
                restoreFocus(focus, entry.dom.el);
            }
            entry.placement = placement;
            // Способ движения зависит от раскладки: при смене (окно стало узким) блок перевязывается.
            if (entry.flow !== flowMode) { entry.detach?.(); interaction.bind(placement.id, entry); entry.flow = flowMode; }
            entry.dom.place(placement.x, placement.y);
            await scene.setBody(placement.id, { html: blockHtml(placement, data), width: placement.w, height: placement.h, css });
        }
        await scene.draw(placements);
    }

    async function show() {
        if (shown) return;
        shown = true;
        desk.activate();
        active.scene.root.style.display = '';
        doc.documentElement.classList.add(ACTIVE_CLASS);
    }

    async function hide() {
        if (!shown) return;
        shown = false;
        desk.deactivate();
        doc.documentElement.classList.remove(ACTIVE_CLASS);
        for (const [id, entry] of blocks) { entry.detach?.(); entry.dom.remove(); await active?.scene.removeBody(id); }
        blocks.clear();
        if (active) active.scene.root.style.display = 'none';
    }

    /** Открыт ли родной стартовый экран: да — показываем блоки, нет — убираем. Вызовы идут по очереди, чтобы не перекрывать друг друга. */
    function refresh() {
        queue = queue.then(async () => {
            if (!active) return;
            const state = await call('stHome.state');
            if (!active) return;
            if (state.ok && state.value.welcome) {
                chats = state.value.chats;
                const list = await call('stHome.characters');
                if (list.ok) characterList = list.value;
                await show();
                await render();
            } else await hide();
        }).catch(error => console.warn('[home] refresh failed:', error?.message ?? error));
        return queue;
    }
    const scheduleRefresh = () => { win.clearTimeout(refreshTimer); refreshTimer = win.setTimeout(refresh, REFRESH_DELAY_MS); };

    function markDone(ids) {
        const fresh = ids.filter(id => !persisted.done.has(id));
        if (!fresh.length) return;
        for (const id of fresh) persisted.done.add(id);
        void save();
        if (shown) void render();
    }

    async function enable() {
        if (active) return { ok: true };
        const scene = createSurfaceScene({ document: doc, call, getDevicePixelRatio });
        scene.root.style.display = 'none';
        await load();
        if (!(await scene.mount(doc.body))) { scene.root.remove(); return { ok: false, reason: 'no-webgl' }; }
        active = { scene, cleanups: [] };
        const container = await call('stHome.container');
        if (container.ok && container.value && MutationObserverCtor) {
            const observer = new MutationObserverCtor(scheduleRefresh);
            observer.observe(container.value, { childList: true });
            active.cleanups.push(() => observer.disconnect());
        }
        const onResize = () => { void render(); };
        win.addEventListener('resize', onResize);
        // Синхронизация приносит персонажей и чаты: после прохода перечитываем родной стартовый экран ST и список персонажей; смена списка персонажей
        // (импорт, удаление, обновление после синхронизации) обновляет карточки и «Recent chats».
        const onSynced = () => { if (shown) void call('stHome.reloadWelcome').then(() => scheduleRefresh()); };
        const onCharacters = () => { if (shown) scheduleRefresh(); };
        active.cleanups.push(
            () => win.removeEventListener('resize', onResize),
            host.events.subscribe('sync.finished', onSynced),
            host.events.subscribe('st.characterPageLoaded', onCharacters),
            host.events.subscribe('st.characterDeleted', onCharacters),
            // Пункт «настроить модель» отмечается сам, когда появился хотя бы один воркер (при удалении последнего галочка остаётся: шаг уже пройден).
            host.events.subscribe('model.workers.changed', payload => { if (payload?.count > 0) markDone(itemsForEvent('model.workers.changed')); }),
        );
        await refresh();
        // Папка `widgets/` грузится в фоне: стол уже показан, виджеты подхватываются, когда найдены.
        void desk.loadCatalog().then(() => { if (shown) void render(); });
        return { ok: true };
    }

    async function disable() {
        if (!active) return;
        const current = active;
        win.clearTimeout(refreshTimer);
        picker.close();
        desk.deactivate();
        await hide();
        active = null;
        for (const cleanup of current.cleanups) cleanup?.();
        await current.scene.dispose();
    }

    const unregisters = [
        host.own.register('home.enable', () => enable()),
        host.own.register('home.disable', () => disable()),
        host.own.register('home.isActive', () => active !== null),
        host.own.register('home.progress', () => checklistProgress(persisted.done)),
    ];
    return { enable, disable, isActive: () => active !== null, refresh, dispose: async () => { await disable(); desk.dispose(); cards.dispose(); for (const unregister of unregisters) unregister?.(); } };
}
