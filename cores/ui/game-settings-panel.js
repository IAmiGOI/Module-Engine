import { h } from './tree.js';
import { signal, computed } from './reactive.js';
import { request } from '../../libraries/shared/request.js';
import { createDragHandlers, clampToViewport } from '../../libraries/shared/draggable.js';
import { FloatingPanel, Button, Row, Segment } from '../../libraries/shared/widgets.js';
import { GAME_GROUPS, GAME_MODES, GAME_OPTIONS, modeValues } from '../../libraries/core/game-settings.js';

/**
 * Окно «Game settings» — вместо редактора промптов на главном пути. Сверху
 * режимы плитками, ниже опции группами с сегментами и одной строкой
 * последствия. Внизу — ссылка в старый редактор, он остаётся рабочим.
 *
 * Иконка ST «AI Response Configuration» открывает ЭТО окно (сервис
 * `stDecisionUi`); карточка Director / Writer шлёт событие
 * `decisionGameSettings.openRequested`.
 */
const UI_NAMESPACE = 'core.ui.gameSettings';
const WINDOW_KEY = 'window';
const DEFAULT_SIZE = { width: 560, height: 720 };

export function createGameSettingsPanelCore(host, { mount } = {}) {
    const call = (contract, params) => request(host.own, contract, { params });
    const serviceCall = (contract, params) => request(host.services, contract, { params });

    const visible = signal(false);
    const collapsed = signal(false);
    const position = signal({});
    const size = signal({ ...DEFAULT_SIZE });
    const mode = signal('classic');
    const defaults = signal(null);
    const saving = signal(false);
    const status = signal('');
    // Сигнал на опцию рождается один раз, а не в отрисовке: иначе узел на
    // следующей перерисовке остался бы подписан на старый (UI.md).
    const optionSignals = new Map(GAME_OPTIONS.map(option => [option.id, signal(option.classic)]));

    let unsubscribeOpen = null;
    const subscriptions = [];
    const flash = text => {
        status.set(text);
        setTimeout(() => { if (status.peek() === text) status.set(''); }, 3000);
    };

    function applyState(answer = {}) {
        const values = answer?.values && typeof answer.values === 'object' ? answer.values : {};
        for (const option of GAME_OPTIONS) {
            const signalFor = optionSignals.get(option.id);
            signalFor.set(values[option.id] ?? option.classic);
        }
        mode.set(String(answer?.mode ?? 'classic'));
        if (answer?.defaults && typeof answer.defaults === 'object') defaults.set({ ...answer.defaults });
    }

    async function refresh() {
        const answer = await call('decision.gameSettings');
        if (answer.ok) applyState(answer.value ?? {});
        return answer;
    }

    let saveSequence = 0;
    async function savePatch(patch) {
        const sequence = (saveSequence += 1);
        saving.set(true);
        try {
            const answer = await call('decision.gameSettings.set', { patch });
            // Быстрые клики идут один за другим: применить состояние обязан
            // только последний ответ, иначе первый вернул бы чужие опции.
            if (answer.ok) { if (sequence === saveSequence) applyState(answer.value ?? {}); }
            else flash(answer.error?.message ?? 'Could not save the settings');
        } finally {
            if (sequence === saveSequence) saving.set(false);
        }
    }

    async function useDefault() {
        if (saving.peek()) return;
        saving.set(true);
        try {
            const answer = await call('decision.gameSettings.useDefault');
            if (answer.ok) { applyState(answer.value ?? {}); flash('Saved for new chats'); }
            else flash(answer.error?.message ?? 'Could not save the default');
        } finally {
            saving.set(false);
        }
    }

    async function reset() {
        if (saving.peek()) return;
        saving.set(true);
        try {
            const answer = await call('decision.gameSettings.reset');
            if (answer.ok) applyState(answer.value ?? {});
            else flash(answer.error?.message ?? 'Could not reset');
        } finally {
            saving.set(false);
        }
    }

    function applyMode(modeId) {
        const patch = modeValues(modeId);
        savePatch(patch).catch(() => {});
    }

    function openAdvanced() {
        host.events.emit('decisionPrompts.openRequested', {});
    }

    function modeTile(item) {
        return h('button', {
            type: 'button',
            class: computed(() => (mode() === item.id ? 'stme-gs-mode stme-gs-mode-active' : 'stme-gs-mode')),
            'aria-pressed': computed(() => (mode() === item.id ? 'true' : 'false')),
            'on:click': () => applyMode(item.id),
        },
            h('span', { class: 'stme-gs-mode-label' }, item.label),
            h('small', { class: 'stme-gs-mode-note' }, item.note));
    }

    function customTile() {
        return h('div', { class: 'stme-gs-mode stme-gs-mode-active stme-gs-mode-custom', role: 'status' },
            h('span', { class: 'stme-gs-mode-label' }, 'Custom'),
            h('small', { class: 'stme-gs-mode-note' }, 'Your own mix; nothing was lost.'));
    }

    function optionRow(option) {
        const value = optionSignals.get(option.id);
        return h('div', { class: 'stme-gs-option' },
            h('div', { class: 'stme-gs-option-title' }, option.title),
            Segment(option.values.map(item => ({ value: item.value, label: item.label })), value, {
                label: option.title,
                onChange: next => savePatch({ [option.id]: next }).catch(() => {}),
            }),
            computed(() => h('small', { class: 'stme-gs-note' }, option.values.find(item => item.value === value())?.note ?? '')));
    }

    function groupBlock(group) {
        return h('section', { class: 'stme-gs-group' },
            h('h3', { class: 'stme-gs-group-title' }, group.title),
            ...GAME_OPTIONS.filter(option => option.group === group.id).map(optionRow));
    }

    function body() {
        return h('div', { class: 'stme-panel stme-gs-window-body' },
            h('div', { class: 'stme-gs-modes', role: 'group', 'aria-label': 'Game mode' },
                ...GAME_MODES.map(modeTile),
                computed(() => (mode() === 'custom' ? customTile() : null))),
            ...GAME_GROUPS.map(groupBlock),
            h('div', { class: 'stme-gs-footer' },
                Row(
                    Button('Use for new chats', useDefault, { disabled: saving }),
                    Button('Reset to Classic', reset, { disabled: saving })),
                computed(() => (status() ? h('small', { class: 'stme-gs-status', role: 'status' }, status()) : null))),
            h('div', { class: 'stme-gs-advanced' },
                h('button', { type: 'button', class: 'stme-gs-link', 'on:click': openAdvanced }, 'Advanced: edit prompts'),
                h('small', { class: 'stme-gs-note' }, 'The full prompt editor, for the rare case.')));
    }

    async function saveWindowState() {
        await call('storage.settings.set', {
            namespace: UI_NAMESPACE, key: WINDOW_KEY,
            value: { visible: visible.peek(), collapsed: collapsed.peek(), position: position.peek(), size: size.peek() },
        });
    }

    function defaultPosition(currentSize) {
        const viewportWidth = globalThis.innerWidth ?? 1920;
        return { left: Math.max(16, viewportWidth - currentSize.width - 24), top: 60 };
    }

    async function loadWindowState() {
        const result = await call('storage.settings.get', { namespace: UI_NAMESPACE, key: WINDOW_KEY, fallback: {} });
        const saved = (result.ok ? result.value : null) ?? {};
        visible.set(Boolean(saved.visible));
        collapsed.set(Boolean(saved.collapsed));
        const savedSize = saved.size ?? {};
        const viewport = { viewportWidth: globalThis.innerWidth ?? 1920, viewportHeight: globalThis.innerHeight ?? 1080 };
        size.set({
            width: Math.min(savedSize.width > 0 ? savedSize.width : DEFAULT_SIZE.width, viewport.viewportWidth - 16),
            height: Math.min(savedSize.height > 0 ? savedSize.height : DEFAULT_SIZE.height, viewport.viewportHeight - 32),
        });
        position.set(saved.position?.left === undefined
            ? clampToViewport(defaultPosition(size.peek()), { ...size.peek(), ...viewport })
            : clampToViewport(saved.position, { ...size.peek(), ...viewport }));
    }

    function tree() {
        const minWidth = Math.min(360, (globalThis.innerWidth ?? 1920) - 16);
        return h('div', { class: 'stme-gs-root' }, computed(() => (visible() ? FloatingPanel('Game settings', {
            position, size, collapsed, className: 'stme-gs-window', minWidth, minHeight: 320,
            onToggle: value => { collapsed.set(value); saveWindowState(); },
            onClose: () => { visible.set(false); saveWindowState(); },
            drag: createDragHandlers(position, {
                onDrop: dropped => {
                    position.set(clampToViewport(dropped, { ...size.peek(), viewportWidth: globalThis.innerWidth ?? 1920, viewportHeight: globalThis.innerHeight ?? 1080 }));
                    saveWindowState();
                },
            }),
            onResize: next => { size.set(next); saveWindowState(); },
        }, computed(body)) : null)));
    }

    function show() { visible.set(true); saveWindowState(); refresh().catch(() => {}); }
    function hide() { visible.set(false); saveWindowState(); }
    function toggle() { if (visible.peek()) hide(); else show(); }

    async function open() {
        await loadWindowState();
        await refresh().catch(() => {});
        const finalUi = mount(tree());
        await finalUi.settled?.();
        unsubscribeOpen = host.events.subscribe('decisionGameSettings.openRequested', () => toggle());
        // Смена чата: у нового чата свой набор (или умолчание) — окно не должно показывать чужой.
        subscriptions.push(host.events.subscribe('st.chatChanged', () => { refresh().catch(() => {}); }));
        await serviceCall('stDecisionUi.install', { onOpen: () => toggle() }).catch(() => {});
        return finalUi;
    }

    return {
        tree, open, show, hide, toggle, refresh, body,
        mode, optionSignals, defaults, saving, status,
        setOption: (id, value) => savePatch({ [id]: value }),
        applyMode, useDefault, reset, openAdvanced,
        isVisible: () => visible.peek(),
        stop() {
            unsubscribeOpen?.();
            for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
            serviceCall('stDecisionUi.uninstall', {}).catch(() => {});
        },
    };
}
