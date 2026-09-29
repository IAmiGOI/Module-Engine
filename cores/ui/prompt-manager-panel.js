import { h } from './tree.js';
import { signal, computed } from './reactive.js';
import { request } from '../../libraries/shared/request.js';
import { createDragHandlers, clampToViewport } from '../../libraries/shared/draggable.js';
import { FloatingPanel, Button, Badge } from '../../libraries/shared/widgets.js';
import { createOrderTab } from './prompt-manager/order-tab.js';
import { createPreviewTab } from './prompt-manager/preview-tab.js';
import { createLogTab } from './prompt-manager/log-tab.js';
import { createSettingsTab } from './prompt-manager/settings-tab.js';

/**
 * Окно Prompt Manager (PROMPT_MANAGER_PLAN.md, «Интерфейс»): порядок промптов, предпросмотр «что уйдёт модели»,
 * журнал запросов с кешем префикса, настройки и параметры генерации. Форма — как у остальных окон движка (свой
 * `official`-корень через `uiEngine.mount()`); читает и пишет ТОЛЬКО через контракты `promptManager.*`.
 * Открывается кнопкой ST «Prompt Manager» (перехват — `services/st-pm-button.js`) и командой `show()`.
 */
const MODULE_UI_NAMESPACE = 'core.ui.promptManager';
const WINDOW_KEY = 'window';
const TABS = [['order', 'Order'], ['preview', 'Preview'], ['log', 'Log & cache'], ['settings', 'Settings']];
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

    // Состояние редактора: черновик пресета в памяти, «изменён» — пока не нажат Save.
    const presets = signal([]);
    const activeId = signal('');
    const preset = signal(null);
    const dirty = signal(false);
    const rev = signal(0);
    const enabled = signal(true);
    let settings = {};
    let revTimer = null;

    const state = {
        preset, activeId, dirty, rev, enabled, settings: () => settings,
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
        settings: createSettingsTab({ state, actions, call }),
    };
    const tabViews = Object.fromEntries(Object.entries(tabs).map(([key, value]) => [key, value.tree()]));

    async function saveWindowState() {
        await call('storage.settings.set', { namespace: MODULE_UI_NAMESPACE, key: WINDOW_KEY, value: { visible: visible.peek(), collapsed: collapsed.peek(), position: position.peek(), size: size.peek() } });
    }

    async function loadWindowState() {
        const result = await call('storage.settings.get', { namespace: MODULE_UI_NAMESPACE, key: WINDOW_KEY, fallback: {} });
        const saved = (result.ok ? result.value : null) ?? {};
        visible.set(Boolean(saved.visible));
        collapsed.set(Boolean(saved.collapsed));
        const savedSize = saved.size ?? {};
        size.set({ width: savedSize.width > 0 ? savedSize.width : DEFAULT_SIZE.width, height: savedSize.height > 0 ? savedSize.height : DEFAULT_SIZE.height });
        position.set(saved.position?.left === undefined ? {} : clampToViewport(saved.position, { ...size.peek(), viewportWidth: globalThis.innerWidth ?? 1920, viewportHeight: globalThis.innerHeight ?? 1080 }));
    }

    function tree() {
        return h('div', { class: 'stme-pm-root' }, computed(() => (visible() ? FloatingPanel('Prompt Manager', {
            position, size, collapsed, className: 'stme-pm-window', minWidth: 520, minHeight: 320,
            onToggle: value => { collapsed.set(value); saveWindowState(); },
            onClose: () => { visible.set(false); saveWindowState(); },
            drag: createDragHandlers(position, { onDrop: dropped => { position.set(clampToViewport(dropped, { ...size.peek(), viewportWidth: globalThis.innerWidth ?? 1920, viewportHeight: globalThis.innerHeight ?? 1080 })); saveWindowState(); } }),
            onResize: next => { size.set(next); saveWindowState(); },
        },
        h('div', { class: 'stme-pm-tabs' }, TABS.map(([key, title]) => Button(title, () => { tab.set(key); if (key === 'log') tabs.log.refresh(); if (key === 'settings') tabs.settings.loadVersions(); }, { variant: 'default' })),
            computed(() => (status() ? Badge(status()) : null))),
        h('div', { class: 'stme-pm-body' }, TABS.map(([key]) => h('div', { class: 'stme-pm-tabpage', style: computed(() => ({ display: tab() === key ? 'block' : 'none' })) }, tabViews[key]))),
        ) : null)));
    }

    async function open() {
        await loadWindowState();
        const finalUi = mount(tree());
        await finalUi.settled?.();
        return finalUi;
    }

    function show() { visible.set(true); saveWindowState(); refresh(); }
    function hide() { visible.set(false); saveWindowState(); }

    host.events.subscribe('promptManager.openRequested', () => show());

    return { tree, open, show, hide, refresh, state, actions, isVisible: () => visible.peek(), stop() {} };
}
