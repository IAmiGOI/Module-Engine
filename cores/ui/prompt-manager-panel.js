import { h } from './tree.js';
import { signal, computed } from './reactive.js';
import { request } from '../../libraries/shared/request.js';
import { createDragHandlers, clampToViewport } from '../../libraries/shared/draggable.js';
import { FloatingPanel } from '../../libraries/shared/widgets.js';
import { createOrderTab } from './prompt-manager/order-tab.js';
import { createPreviewTab } from './prompt-manager/preview-tab.js';
import { createLogTab } from './prompt-manager/log-tab.js';
import { createSettingsTab } from './prompt-manager/settings-tab.js';
import { createCotTab } from './prompt-manager/cot-tab.js';
import { createRulesTab } from './prompt-manager/rules-tab.js';
import { createCotBlocks } from './prompt-manager/cot-blocks.js';

/**
 * Prompt Manager (PROMPT_MANAGER_PLAN.md, «Интерфейс»): порядок промптов, предпросмотр «что уйдёт модели»,
 * журнал запросов с кешем префикса, настройки и параметры генерации; читает и пишет ТОЛЬКО через контракты
 * `promptManager.*`. Своё плавающее окно, открывается ИКОНКОЙ ST «AI Response Configuration» — сама иконка
 * перехвачена (`services/st-pm-ui.js`), штатная панель ST под ней не открывается вообще (решение владельца,
 * ROADMAP.md 5.141: никакого нативного окна ST рядом ни в каком виде, ни целиком, ни частично). Любую вкладку
 * можно вынести в отдельное плавающее окно.
 */
const MODULE_UI_NAMESPACE = 'core.ui.promptManager';
const WINDOW_KEY = 'window';
const TABS = [['order', 'Order'], ['preview', 'Preview'], ['log', 'Log & cache'], ['cot', 'CoT'], ['rules', 'Text rules'], ['settings', 'Settings']];
const DEFAULT_SIZE = { width: 980, height: 680 };

/** Выбор файла: скрытый `<input type=file>`, кликаем из обработчика кнопки (без пользовательского клика диалог не откроется). */
function pickFromDisk() {
    return new Promise(resolve => {
        const input = globalThis.document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';
        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            resolve(file ? { name: file.name, text: await file.text() } : null);
        });
        input.addEventListener('cancel', () => resolve(null));
        input.click();
    });
}

export function createPromptManagerPanelCore(host, { mount, pickFile = pickFromDisk } = {}) {
    const call = (contract, params) => request(host.own, contract, { params });
    const download = async (filename, content) => (await request(host.services, 'file.download', { params: { filename, content } })).ok;
    const visible = signal(false);
    const collapsed = signal(false);
    const position = signal({});
    const size = signal({ ...DEFAULT_SIZE });
    const tab = signal('order');
    const status = signal('');
    const popouts = signal([]); // отдельные окна вкладок: { id, key, position, size }
    let popoutCounter = 0;

    // Состояние редактора: черновик пресета в памяти, «изменён» — пока не нажат Save.
    const presets = signal([]);
    const activeId = signal('');
    const preset = signal(null);
    const dirty = signal(false);
    const rev = signal(0);
    let pluginTypes = [];
    const enabled = signal(true);
    let settings = {};
    let revTimer = null;

    const state = {
        preset, activeId, dirty, rev, enabled, settings: () => settings, pluginTypes: () => pluginTypes,
        presetOptions: () => presets().map(item => ({ value: item.id, label: item.name })),
    };

    const flash = text => { status.set(text); setTimeout(() => { if (status.peek() === text) status.set(''); }, 4000); };
    const bumpRev = () => { clearTimeout(revTimer); revTimer = setTimeout(() => rev.set(rev.peek() + 1), 300); };

    async function reloadList() {
        const list = await call('promptManager.presets');
        presets.set(list.ok ? list.value : []);
    }

    async function loadPreset(id) {
        const answer = id ? await call('promptManager.preset', { id }) : null;
        preset.set(answer?.ok && answer.value ? structuredClone(answer.value.preset) : null);
        activeId.set(answer?.ok && answer.value ? id : '');
        dirty.set(false);
    }

    async function refresh() {
        const answer = await call('promptManager.settings');
        settings = answer.ok ? answer.value : {};
        enabled.set(settings.enabled !== false);
        pluginTypes = (await call('promptManager.conditionTypes')).value ?? [];
        await reloadList();
        if (!presets.peek().length && !settings.autoPrepared) { await call('promptManager.autoPrepare'); settings = (await call('promptManager.settings')).value ?? settings; await reloadList(); }
        await loadPreset(settings.activePresetId ?? presets.peek()[0]?.id ?? '');
    }

    const actions = {
        /** Структурная правка: новая копия пресета, всё окно перестраивается. */
        edit(mutator) { const next = structuredClone(preset.peek()); mutator(next); preset.set(next); dirty.set(true); },
        /** Правка поля на месте: форма не перерисовывается (не теряет фокус), список подписей обновляется с задержкой. */
        patch(mutator) { const current = preset.peek(); if (!current) return; mutator(current); dirty.set(true); bumpRev(); },
        async configure(patch) {
            const answer = await call('promptManager.configure', { patch });
            if (answer.ok) { settings = answer.value; enabled.set(settings.enabled !== false); }
        },
        async selectPreset(id) {
            if (dirty.peek() && !globalThis.confirm?.('Discard unsaved changes of this preset?')) return;
            await loadPreset(id);
            await actions.configure({ activePresetId: id });
        },
        async save() {
            const id = activeId.peek();
            if (!id || !preset.peek()) return;
            const record = (await call('promptManager.preset', { id })).value;
            const saved = await call('promptManager.savePreset', { record: { ...record, preset: preset.peek() }, label: 'edit' });
            if (saved.ok) { dirty.set(false); await reloadList(); flash('Saved.'); } else flash(`Save failed: ${saved.error.message}`);
        },
        async remove() {
            const id = activeId.peek();
            if (!id || !globalThis.confirm?.('Delete this preset and its versions? The original ST preset file is not touched.')) return;
            await call('promptManager.deletePreset', { id });
            await reloadList();
            await loadPreset(presets.peek()[0]?.id ?? '');
            await actions.configure({ activePresetId: activeId.peek() || null });
        },
        async duplicate() {
            const answer = await call('promptManager.duplicatePreset', { id: activeId.peek() });
            if (!answer.ok) { flash(answer.error.message); return; }
            await reloadList();
            await actions.selectPreset(answer.value.id);
        },
        async rollback(key) {
            const answer = await call('promptManager.rollback', { presetId: activeId.peek(), key });
            if (answer.ok) { await loadPreset(activeId.peek()); flash('Rolled back.'); } else flash(answer.error.message);
        },
        async exportSt() {
            const answer = await call('promptManager.exportSt', { id: activeId.peek() });
            if (!answer.ok) { flash(answer.error.message); return; }
            await download(`${presets.peek().find(item => item.id === activeId.peek())?.name ?? 'preset'}.json`, JSON.stringify(answer.value, null, 2));
            flash('Exported for SillyTavern (passwords and keys removed).');
        },
        async exportNative() {
            const answer = await call('promptManager.exportNative', { id: activeId.peek() });
            if (!answer.ok) { flash(answer.error.message); return; }
            await download(`${presets.peek().find(item => item.id === activeId.peek())?.name ?? 'preset'}.me-preset.json`, JSON.stringify(answer.value, null, 2));
            flash('Exported in the Module Engine format.');
        },
        async pickFile(kind) {
            const picked = await pickFile();
            if (!picked) return;
            let json;
            try { json = JSON.parse(picked.text); } catch (error) { flash(`Not a valid file: ${error.message}`); return; }
            const answer = kind === 'native'
                ? await call('promptManager.importNative', { file: json })
                : await call('promptManager.importSt', { json, name: picked.name.replace(/\.json$/i, ''), sourceName: null });
            if (!answer.ok) { flash(`Import failed: ${answer.error.message}`); return; }
            await reloadList();
            await actions.selectPreset(answer.value.id);
            flash('Imported.');
        },
        async resetContribution(node) {
            await actions.save();
            const answer = await call('promptManager.resetContribution', { id: node.contribution, contribution: { id: node.contribution, name: node.name, defaultPlacement: node.defaultPlacement ?? 'before-history' } });
            if (answer.ok) { await loadPreset(activeId.peek()); flash('Returned to the default position.'); }
        },
    };

    const tabs = {
        order: createOrderTab({ state, actions }),
        preview: createPreviewTab({ call }),
        log: createLogTab({ call }),
    cot: createCotTab({ state, actions, call }),
    rules: createRulesTab({ state, actions, pickFile }),
        settings: createSettingsTab({ state, actions, call }),
    };
    const tabViews = Object.fromEntries(Object.entries(tabs).map(([key, value]) => [key, value.tree()]));

    /** Вкладка в отдельное окно (несколько окон по блокам, решение владельца): у окна свои положение и размер, состояние общее. */
    function popOut(key) {
        const index = popoutCounter++;
        const entry = { id: `popout-${index}`, key, position: signal({ left: 80 + index * 28, top: 90 + index * 28 }), size: signal({ width: 560, height: 520 }), collapsed: signal(false) };
        popouts.set([...popouts.peek(), entry]);
    }
    const closePopout = id => popouts.set(popouts.peek().filter(entry => entry.id !== id));

    function popoutWindow(entry) {
        const title = TABS.find(([key]) => key === entry.key)?.[1] ?? entry.key;
        return FloatingPanel(`Prompt Manager · ${title}`, {
            position: entry.position, size: entry.size, collapsed: entry.collapsed, className: 'stme-pm-window', minWidth: 360, minHeight: 240,
            onToggle: value => entry.collapsed.set(value), onClose: () => closePopout(entry.id),
            drag: createDragHandlers(entry.position, { onDrop: dropped => entry.position.set(clampToViewport(dropped, { ...entry.size.peek(), viewportWidth: globalThis.innerWidth ?? 1920, viewportHeight: globalThis.innerHeight ?? 1080 })) }),
            onResize: next => entry.size.set(next),
        }, h('div', { class: 'stme-panel stme-pm-body' }, tabs[entry.key].tree()));
    }

    function selectTab(key) {
        tab.set(key);
        if (key === 'log') tabs.log.refresh();
        if (key === 'cot') tabs.cot.refresh();
        if (key === 'settings') { tabs.settings.loadVersions(); tabs.settings.loadPlugins(); }
    }

    const tabButton = ([key, title]) => h('button', {
        type: 'button', 'on:click': () => selectTab(key),
        class: computed(() => (tab() === key ? 'menu_button stme-pm-tab stme-pm-tab-active' : 'menu_button stme-pm-tab')),
    }, title);

    async function saveWindowState() {
        await call('storage.settings.set', { namespace: MODULE_UI_NAMESPACE, key: WINDOW_KEY, value: { visible: visible.peek(), collapsed: collapsed.peek(), position: position.peek(), size: size.peek() } });
    }

    /**
     * Никогда не открывавшееся окно (нет сохранённой позиции) ставится явно у верхнего правого края, а не отдаётся
     * CSS-анкеру `right/bottom` — тот якорит от НИЖНЕГО правого угла и вместе с шириной окна (980px) на обычном экране
     * оставлял его от края до края, наползая на левую колонку иконок ST/движка (владелец: «в левом верхнем углу,
     * частично под панелью»). Отступ слева не меньше 72px — там как раз эта колонка.
     */
    function defaultPosition(currentSize) {
        const viewportWidth = globalThis.innerWidth ?? 1920;
        return { left: Math.max(72, viewportWidth - currentSize.width - 24), top: 60 };
    }

    async function loadWindowState() {
        const result = await call('storage.settings.get', { namespace: MODULE_UI_NAMESPACE, key: WINDOW_KEY, fallback: {} });
        const saved = (result.ok ? result.value : null) ?? {};
        visible.set(Boolean(saved.visible));
        collapsed.set(Boolean(saved.collapsed));
        const savedSize = saved.size ?? {};
        size.set({ width: savedSize.width > 0 ? savedSize.width : DEFAULT_SIZE.width, height: savedSize.height > 0 ? savedSize.height : DEFAULT_SIZE.height });
        const viewport = { viewportWidth: globalThis.innerWidth ?? 1920, viewportHeight: globalThis.innerHeight ?? 1080 };
        position.set(saved.position?.left === undefined
            ? clampToViewport(defaultPosition(size.peek()), { ...size.peek(), ...viewport })
            : clampToViewport(saved.position, { ...size.peek(), ...viewport }));
    }

    // Окно — только редактор; включение/выключение самой сборки живёт в настройках движка (владелец: «убери кнопку
    // включения PM из самого его окна и помести в настройки движка», `cores/ui/panel-cards/prompt-manager-card.js`).
    // Выключенный PM тут не прячет вкладки — правка пресета не зависит от того, использует ли его сборка прямо сейчас.
    const windowBody = [
        h('div', { class: 'stme-pm-tabs' }, TABS.map(tabButton),
            h('button', { type: 'button', class: 'menu_button stme-pm-tab stme-pm-popout', title: 'Open this tab in its own window', 'on:click': () => popOut(tab.peek()) }, '⧉'),
            computed(() => (status() ? h('span', { class: 'stme-pm-status' }, status()) : null))),
        computed(() => (enabled() ? null : h('p', { class: 'stme-pm-warning' }, 'Prompt Manager is off in engine settings — SillyTavern builds the request itself, edits here won\'t apply until it\'s turned back on.'))),
        h('div', { class: 'stme-pm-body' }, TABS.map(([key]) => h('div', { class: 'stme-pm-tabpage', style: computed(() => ({ display: tab() === key ? 'block' : 'none' })) }, tabViews[key]))),
    ];

    function tree() {
        return h('div', { class: 'stme-pm-root' }, computed(() => popouts().map(popoutWindow)), computed(() => (visible() ? FloatingPanel('Prompt Manager', {
            position, size, collapsed, className: 'stme-pm-window', minWidth: 420, minHeight: 280,
            onToggle: value => { collapsed.set(value); saveWindowState(); },
            onClose: () => { visible.set(false); saveWindowState(); },
            drag: createDragHandlers(position, { onDrop: dropped => { position.set(clampToViewport(dropped, { ...size.peek(), viewportWidth: globalThis.innerWidth ?? 1920, viewportHeight: globalThis.innerHeight ?? 1080 })); saveWindowState(); } }),
            onResize: next => { size.set(next); saveWindowState(); },
        }, h('div', { class: 'stme-panel stme-pm-window-body' }, windowBody)) : null)));
    }

    /** Открывается ИКОНКОЙ ST, перехваченной сервисом (`stPmUi.install`) — штатная панель ST под ней не появляется вообще. */
    async function open() {
        await loadWindowState();
        const finalUi = mount(tree());
        await finalUi.settled?.();
        return finalUi;
    }

    function show() { visible.set(true); saveWindowState(); refresh(); }
    function hide() { visible.set(false); saveWindowState(); }
    /** Иконка ST переоткрывает окно — теперь тоже закрывает (владелец: «кнопка... не закрывает его»). */
    function toggle() { if (visible.peek()) hide(); else show(); }

    const cotBlocks = createCotBlocks(host);
    host.events.subscribe('promptManager.openRequested', () => toggle());
    host.events.subscribe('promptManager.prepared', () => { if (visible.peek()) refresh().catch(() => {}); });
    /** Малый вид Guided CoT: строка «thinking: step 2 of 4» уведомлением; расширенный вид — в окне на вкладке CoT. */
    host.events.subscribe('promptManager.cotProgress', payload => {
        if (payload?.phase === 'done' && payload.display === 'extended') request(host.own, 'ui.notify', { params: { tone: 'muted', text: `${payload.name || `Step ${payload.index + 1}`}: ${String(payload.text ?? '').slice(0, 300)}` } });
        if (payload?.phase === 'start') request(host.own, 'ui.notify', { params: { key: 'pm-cot', tone: 'muted', text: `Thinking: step ${payload.index + 1} of ${payload.total}${payload.display === 'extended' && payload.name ? ` — ${payload.name}` : ''}` } });
    });
    host.events.subscribe('promptManager.cotFailed', payload => request(host.own, 'ui.notify', { params: { tone: 'error', text: payload?.message ?? 'Guided CoT failed.' } }));
    host.events.subscribe('promptManager.unsupported', payload => request(host.own, 'ui.notify', { params: { tone: 'error', text: payload?.reason ?? 'Prompt Manager is off.' } }));

    return { tree, open, show, hide, cotBlocks, popOut, popouts, refresh, state, actions, selectTab, isVisible: () => visible.peek(), stop() {} };
}
