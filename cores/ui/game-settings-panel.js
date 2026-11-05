import { h } from './tree.js';
import { signal, computed } from './reactive.js';
import { request } from '../../libraries/shared/request.js';
import { createDragHandlers, clampToViewport } from '../../libraries/shared/draggable.js';
import { FloatingPanel, Button, Row, Toast } from '../../libraries/shared/widgets.js';
import { GAME_GROUPS, GAME_MODES, GAME_OPTIONS, modeValues } from '../../libraries/core/game-settings.js';
import { MAX_GAME_MIXES, matchGameMix } from '../../libraries/core/game-mixes.js';
import { modeTiles } from './game-settings/modes.js';
import { optionGroups } from './game-settings/options.js';
import { mixesRow } from './game-settings/mixes.js';
import { DEFAULT_SIZE, loadPanelWindow, savePanelWindow } from './game-settings/window.js';

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
    // Основа для пометок: у готового режима — он сам, у Custom — Classic.
    const baseValues = computed(() => modeValues(mode() === 'custom' ? 'classic' : mode()));
    const baseLabel = computed(() => (mode() === 'custom' ? 'Classic' : GAME_MODES.find(item => item.id === mode())?.label ?? 'Classic'));
    const sameAsDefault = computed(() => {
        const saved = defaults();
        return Boolean(saved) && GAME_OPTIONS.every(option => optionSignals.get(option.id)() === saved[option.id]);
    });
    const undo = signal(null);
    let undoTimer = null;
    // Сохранённые наборы: глобальные, поэтому не сбрасываются со сменой чата.
    const mixes = signal([]);
    const activeMixId = signal('');
    const mixEditing = signal(null); // { mode: 'new' | 'rename', id? }
    const mixName = signal('');
    const liveValues = computed(() => Object.fromEntries(GAME_OPTIONS.map(option => [option.id, optionSignals.get(option.id)()])));
    const matchedMixId = computed(() => matchGameMix(mixes(), liveValues())?.id ?? '');
    const atLimit = computed(() => mixes().length >= MAX_GAME_MIXES);

    let unsubscribeOpen = null;
    const subscriptions = [];
    const flash = text => {
        status.set(text);
        const timer = setTimeout(() => { if (status.peek() === text) status.set(''); }, 3000);
        timer?.unref?.();
    };

    function applyState(answer = {}) {
        const values = answer?.values && typeof answer.values === 'object' ? answer.values : {};
        for (const option of GAME_OPTIONS) {
            const signalFor = optionSignals.get(option.id);
            signalFor.set(values[option.id] ?? option.classic);
        }
        mode.set(String(answer?.mode ?? 'classic'));
        if (answer?.defaults && typeof answer.defaults === 'object') defaults.set({ ...answer.defaults });
        if (Array.isArray(answer?.mixes)) mixes.set(answer.mixes.map(mix => ({ ...mix, values: { ...mix.values } })));
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

    const currentValues = () => Object.fromEntries(GAME_OPTIONS.map(option => [option.id, optionSignals.get(option.id).peek()]));

    function clearUndo() {
        if (undoTimer) clearTimeout(undoTimer);
        undoTimer = null;
        undo.set(null);
    }

    async function reset() {
        if (saving.peek()) return;
        const previous = currentValues();
        saving.set(true);
        try {
            const answer = await call('decision.gameSettings.reset');
            if (answer.ok) {
                applyState(answer.value ?? {});
                undo.set({ text: 'Reset to Classic', values: previous });
                if (undoTimer) clearTimeout(undoTimer);
                undoTimer = setTimeout(clearUndo, 8000);
                undoTimer?.unref?.();
            } else flash(answer.error?.message ?? 'Could not reset');
        } finally {
            saving.set(false);
        }
    }

    async function undoReset() {
        const saved = undo.peek();
        clearUndo();
        if (!saved) return;
        await savePatch(saved.values);
    }

    /** «Reset this option» — к значению основы: режима, а у Custom — Classic. */
    function resetOption(id) {
        const base = baseValues.peek();
        if (!Object.prototype.hasOwnProperty.call(base, id)) return;
        savePatch({ [id]: base[id] }).catch(() => {});
    }

    function applyMode(modeId) {
        const patch = modeValues(modeId);
        savePatch(patch).catch(() => {});
    }

    function openAdvanced() {
        host.events.emit('decisionPrompts.openRequested', {});
    }

    function startSaveNew() {
        if (atLimit.peek()) return;
        mixEditing.set({ mode: 'new' });
        mixName.set('');
    }

    function startRename(id) {
        const mix = mixes.peek().find(item => item.id === id);
        if (!mix) return;
        mixEditing.set({ mode: 'rename', id });
        mixName.set(mix.name);
    }

    function cancelMixEditing() {
        mixEditing.set(null);
        mixName.set('');
    }

    async function saveMixName() {
        const editing = mixEditing.peek();
        if (!editing) return;
        const name = mixName.peek().trim();
        const answer = editing.mode === 'rename'
            ? await call('decision.gameSettings.renameMix', { id: editing.id, name })
            : await call('decision.gameSettings.saveMix', { name });
        if (!answer.ok) { flash(answer.error?.message ?? 'Could not save the mix'); return; }
        applyState(answer.value ?? {});
        if (editing.mode === 'new' && answer.value?.savedId) activeMixId.set(answer.value.savedId);
        cancelMixEditing();
    }

    async function applyMix(id) {
        const answer = await call('decision.gameSettings.applyMix', { id });
        if (!answer.ok) { flash(answer.error?.message ?? 'Could not apply the mix'); return; }
        applyState(answer.value ?? {});
        activeMixId.set(id);
    }

    async function removeMix(id) {
        const answer = await call('decision.gameSettings.removeMix', { id });
        if (!answer.ok) { flash(answer.error?.message ?? 'Could not remove the mix'); return; }
        applyState(answer.value ?? {});
        if (activeMixId.peek() === id) activeMixId.set('');
    }

    async function updateMix() {
        const id = activeMixId.peek();
        if (!id) return;
        const answer = await call('decision.gameSettings.updateMix', { id });
        if (!answer.ok) { flash(answer.error?.message ?? 'Could not update the mix'); return; }
        applyState(answer.value ?? {});
        flash('Mix updated');
    }

    function body() {
        return h('div', { class: 'stme-panel stme-gs-window-body' },
            modeTiles({ mode, onMode: applyMode }),
            mixesRow({
                mixes, matchedId: matchedMixId, activeId: activeMixId, editing: mixEditing, nameSignal: mixName, atLimit,
                onApply: applyMix, onRename: startRename, onRemove: removeMix, onSaveNew: startSaveNew,
                onUpdate: updateMix, onSaveName: saveMixName, onCancelName: cancelMixEditing,
            }),
            ...optionGroups({
                groups: GAME_GROUPS, options: GAME_OPTIONS,
                signalFor: id => optionSignals.get(id),
                baseFor: () => baseValues(), baseLabel: () => baseLabel(),
                onSet: (id, value) => { savePatch({ [id]: value }).catch(() => {}); },
                onReset: resetOption,
            }),
            h('div', { class: 'stme-gs-footer' },
                Row(
                    Button(computed(() => (sameAsDefault() ? 'New chats use this mix' : 'Use for new chats')), useDefault, { disabled: computed(() => sameAsDefault()) }),
                    Button('Reset to Classic', reset, { disabled: saving })),
                computed(() => (undo() ? Toast(undo().text, { tone: 'ok', action: { label: 'Undo', onClick: undoReset }, onDismiss: clearUndo }) : null)),
                computed(() => (status() ? h('small', { class: 'stme-gs-status', role: 'status' }, status()) : null))),
            h('div', { class: 'stme-gs-advanced' },
                h('button', { type: 'button', class: 'stme-gs-link', 'on:click': openAdvanced }, 'Advanced: edit prompts'),
                h('small', { class: 'stme-gs-note' }, 'The full prompt editor, for the rare case.')));
    }

    const windowState = { visible, collapsed, position, size };
    const saveWindowState = () => savePanelWindow({ call, namespace: UI_NAMESPACE, key: WINDOW_KEY, state: windowState });
    const loadWindowState = () => loadPanelWindow({ call, namespace: UI_NAMESPACE, key: WINDOW_KEY, state: windowState });

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
        applyMode, useDefault, reset, resetOption, undoReset, openAdvanced,
        baseValues, baseLabel, sameAsDefault, undo, currentValues,
        mixes, activeMixId, mixEditing, mixName, matchedMixId, atLimit,
        startSaveNew, startRename, cancelMixEditing, saveMixName, applyMix, removeMix, updateMix,
        isVisible: () => visible.peek(),
        stop() {
            unsubscribeOpen?.();
            for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
            serviceCall('stDecisionUi.uninstall', {}).catch(() => {});
        },
    };
}
