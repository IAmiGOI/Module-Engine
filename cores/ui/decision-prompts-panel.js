import { h } from './tree.js';
import { signal, computed } from './reactive.js';
import { request } from '../../libraries/shared/request.js';
import { createDragHandlers, clampToViewport } from '../../libraries/shared/draggable.js';
import { FloatingPanel } from '../../libraries/shared/widgets.js';
import { defaultPromptSections } from '../../libraries/core/decision-prompt-model.js';
import { appendBlocks } from '../../libraries/core/decision-prompt-presets.js';
import { createSectionTab } from './decision-prompts/section-tab.js';
import { createPreviewTab } from './decision-prompts/preview-tab.js';

/**
 * Окно разделов промптов директора и прозаика — выборочно возвращённый старый
 * Prompt Manager. Системные строки закреплены, пользовательский блок двигается
 * только внутри себя и встаёт на прежнюю глубину (2 цикла / @5).
 *
 * Часть 13: главный путь — окно `game-settings-panel.js`; это окно осталось
 * рабочим и открывается ссылкой «Advanced: edit prompts» (событие
 * `decisionPrompts.openRequested`). Иконку ST оно больше не перехватывает.
 */
const MODULE_UI_NAMESPACE = 'core.ui.decisionPrompts';
const WINDOW_KEY = 'window';
const DEFAULT_SIZE = { width: 980, height: 680 };
const TABS = [['director', 'Director'], ['writer', 'Writer'], ['preview', 'Preview']];

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

export function createDecisionPromptsPanelCore(host, { mount, pickFile = pickFromDisk } = {}) {
    const call = (contract, params) => request(host.own, contract, { params });
    const serviceCall = (contract, params) => request(host.services, contract, { params });
    const download = async (filename, content) => (await serviceCall('file.download', { params: { filename, content } })).ok;

    const visible = signal(false);
    const collapsed = signal(false);
    const position = signal({});
    const size = signal({ ...DEFAULT_SIZE });
    const tab = signal('director');
    const status = signal('');
    const sections = signal(defaultPromptSections());
    const dirty = signal(false);
    const saving = signal(false);
    let settings = {};

    const flash = text => { status.set(text); setTimeout(() => { if (status.peek() === text) status.set(''); }, 4000); };
    const notify = async (tone, text) => { await call('ui.notify', { tone, text }); flash(text); };
    const getSection = sectionId => () => sections()[sectionId];

    async function refresh() {
        const answer = await call('decision.settings');
        settings = answer.ok ? answer.value ?? {} : {};
        sections.set(structuredClone(settings.promptSections ?? defaultPromptSections()));
        dirty.set(false);
    }

    function editSections(updater) {
        const next = updater(structuredClone(sections.peek()));
        sections.set(next);
        dirty.set(true);
    }

    function appendImported({ director = [], writer = [] }) {
        editSections(next => {
            if (director.length) next.director = appendBlocks(next.director, director);
            if (writer.length) next.writer = appendBlocks(next.writer, writer);
            return next;
        });
    }

    async function save() {
        if (saving.peek()) return;
        saving.set(true);
        try {
            const answer = await call('decision.configure', { patch: { promptSections: sections.peek() } });
            if (!answer.ok) { flash(`Save failed: ${answer.error?.message ?? 'unknown error'}`); return; }
            settings = answer.value ?? settings;
            // Новые id блоков из импорта и миграции приходят уже нормализованными.
            sections.set(structuredClone(settings.promptSections ?? sections.peek()));
            dirty.set(false);
            flash('Saved.');
        } finally { saving.set(false); }
    }

    const tabs = {
        director: createSectionTab({ sectionId: 'director', getSection: getSection('director'), editSections, pickFile, download, notify, appendImported }),
        writer: createSectionTab({ sectionId: 'writer', getSection: getSection('writer'), editSections, pickFile, download, notify, appendImported }),
        preview: createPreviewTab({ call }),
    };
    const tabViews = { director: tabs.director.tree(), writer: tabs.writer.tree(), preview: tabs.preview.tree() };

    function selectTab(key) {
        tab.set(key);
        if (key === 'preview') tabs.preview.refresh();
    }

    const tabButton = ([key, title]) => h('button', {
        type: 'button', 'on:click': () => selectTab(key),
        class: computed(() => (tab() === key ? 'menu_button stme-dp-tab stme-dp-tab-active' : 'menu_button stme-dp-tab')),
    }, title);

    async function saveWindowState() {
        await call('storage.settings.set', {
            namespace: MODULE_UI_NAMESPACE, key: WINDOW_KEY,
            value: { visible: visible.peek(), collapsed: collapsed.peek(), position: position.peek(), size: size.peek() },
        });
    }

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
        const viewport = { viewportWidth: globalThis.innerWidth ?? 1920, viewportHeight: globalThis.innerHeight ?? 1080 };
        size.set({
            width: Math.min(savedSize.width > 0 ? savedSize.width : DEFAULT_SIZE.width, viewport.viewportWidth - 32),
            height: Math.min(savedSize.height > 0 ? savedSize.height : DEFAULT_SIZE.height, viewport.viewportHeight - 32),
        });
        position.set(saved.position?.left === undefined
            ? clampToViewport(defaultPosition(size.peek()), { ...size.peek(), ...viewport })
            : clampToViewport(saved.position, { ...size.peek(), ...viewport }));
    }

    const saveBar = () => computed(() => (dirty() ? h('div', { class: 'stme-dp-savebar', role: 'status' },
        h('span', { class: 'stme-dp-savebar-text' }, '● Unsaved changes in these sections'),
        h('button', { type: 'button', class: 'menu_button stme-dp-savebar-discard', 'on:click': () => refresh() }, 'Discard'),
        h('button', { type: 'button', class: 'menu_button stme-dp-savebar-save', disabled: computed(() => saving()), 'on:click': save }, computed(() => (saving() ? 'Saving…' : 'Save (Ctrl+S)'))),
    ) : null));

    const saveShortcut = event => {
        if ((event.ctrlKey || event.metaKey) && !event.altKey && String(event.key).toLowerCase() === 's') { event.preventDefault?.(); save(); }
    };

    const windowBody = [
        h('div', { class: 'stme-dp-tabs' }, TABS.map(tabButton),
            computed(() => (status() ? h('span', { class: 'stme-dp-status' }, status()) : null))),
        h('div', { class: 'stme-dp-body' }, TABS.map(([key]) => h('div', { class: 'stme-dp-tabpage', style: computed(() => ({ display: tab() === key ? 'block' : 'none' })) }, tabViews[key]))),
        saveBar(),
    ];

    function tree() {
        const minWidth = Math.min(420, (globalThis.innerWidth ?? 1920) - 32);
        return h('div', { class: 'stme-dp-root' }, computed(() => (visible() ? FloatingPanel('Prompts: Director / Writer', {
            position, size, collapsed, className: 'stme-dp-window', minWidth, minHeight: 280,
            onToggle: value => { collapsed.set(value); saveWindowState(); },
            onClose: () => { visible.set(false); saveWindowState(); },
            drag: createDragHandlers(position, { onDrop: dropped => { position.set(clampToViewport(dropped, { ...size.peek(), viewportWidth: globalThis.innerWidth ?? 1920, viewportHeight: globalThis.innerHeight ?? 1080 })); saveWindowState(); } }),
            onResize: next => { size.set(next); saveWindowState(); },
        }, h('div', { class: 'stme-panel stme-dp-window-body', 'on:keydown': saveShortcut }, windowBody)) : null)));
    }

    function show() { visible.set(true); saveWindowState(); refresh(); }
    function hide() { visible.set(false); saveWindowState(); }
    function toggle() { if (visible.peek()) hide(); else show(); }

    let unsubscribeOpen = null;
    async function open() {
        await loadWindowState();
        if (visible.peek()) await refresh().catch(() => {});
        const finalUi = mount(tree());
        await finalUi.settled?.();
        unsubscribeOpen = host.events.subscribe('decisionPrompts.openRequested', () => toggle());
        return finalUi;
    }

    return {
        tree, open, show, hide, toggle, refresh, save,
        tabs, selectTab, sections, dirty,
        isVisible: () => visible.peek(),
        stop() { unsubscribeOpen?.(); },
    };
}
