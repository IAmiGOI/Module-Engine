import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { createSettingsCore } from '../cores/settings/index.js';
import { createGameSettingsPanelCore } from '../cores/ui/game-settings-panel.js';
import { DEFAULT_GAME_SETTINGS, modeOf, patchGameSettings } from '../libraries/core/game-settings.js';
import { addGameMix, renameGameMix, removeGameMix, updateGameMix } from '../libraries/core/game-mixes.js';

const resolve = value => (typeof value === 'function' ? resolve(value()) : value);
const tick = (ms = 20) => new Promise(done => setTimeout(done, ms));
function walkAll(node, match, out = []) {
    const value = resolve(node);
    if (Array.isArray(value)) { value.forEach(item => walkAll(item, match, out)); return out; }
    if (!value || typeof value !== 'object' || !value.tag) return out;
    if (match(value)) out.push(value);
    (value.children ?? []).forEach(child => walkAll(child, match, out));
    return out;
}
const hasClass = (node, name) => String(resolve(node.props?.class) ?? '').split(/\s+/).includes(name);
const textOf = node => {
    const value = resolve(node);
    if (Array.isArray(value)) return value.map(textOf).join('');
    if (value == null || value === false) return '';
    if (typeof value !== 'object') return String(value);
    return (value.children ?? []).map(textOf).join('');
};
const buttonByText = (node, text) => walkAll(node, item => item.tag === 'button' && textOf(item) === text)[0];
const modeTile = (node, label) => walkAll(node, item => item.tag === 'button' && hasClass(item, 'stme-gs-mode') && textOf(item).startsWith(label))[0];

function build() {
    const engine = createEngine();
    const context = { extensionSettings: {}, saveSettingsDebounced: () => {} };
    registerExtensionSettingsService(engine.buses.services, { getContext: () => context });
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));
    const host = engine.registerCaller('core.ui.gameSettings', 'cores', { tier: 'official' });
    const events = [];
    engine.events.subscribe('decision.gameSettings.changed', payload => events.push(payload));
    let state = { values: { ...DEFAULT_GAME_SETTINGS }, mode: 'classic', defaults: { ...DEFAULT_GAME_SETTINGS }, mixes: [] };
    let mixCounter = 0;
    const publish = () => engine.events.emit('decision.gameSettings.changed', structuredClone(state));
    const withMixes = next => { state = { ...state, mixes: next }; return structuredClone(state); };
    host.own.register('decision.gameSettings', () => structuredClone(state));
    host.own.register('decision.gameSettings.set', ({ patch }) => {
        state = { ...state, values: patchGameSettings(state.values, patch) };
        state.mode = modeOf(state.values);
        publish();
        return structuredClone(state);
    });
    host.own.register('decision.gameSettings.useDefault', () => {
        state = { ...state, defaults: { ...state.values } };
        publish();
        return structuredClone(state);
    });
    host.own.register('decision.gameSettings.reset', () => {
        state = { ...state, values: { ...DEFAULT_GAME_SETTINGS }, mode: 'classic' };
        publish();
        return structuredClone(state);
    });
    host.own.register('decision.gameSettings.saveMix', ({ name }) => {
        const result = addGameMix(state.mixes, { id: `mix_${(mixCounter += 1)}`, name, values: state.values });
        if (!result.ok) throw new Error(result.error);
        return { ...withMixes(result.mixes), savedId: result.mix.id };
    });
    host.own.register('decision.gameSettings.renameMix', ({ id, name }) => {
        const result = renameGameMix(state.mixes, id, name);
        if (!result.ok) throw new Error(result.error);
        return withMixes(result.mixes);
    });
    host.own.register('decision.gameSettings.removeMix', ({ id }) => {
        const result = removeGameMix(state.mixes, id);
        if (!result.ok) throw new Error(result.error);
        return withMixes(result.mixes);
    });
    host.own.register('decision.gameSettings.updateMix', ({ id }) => {
        const result = updateGameMix(state.mixes, id, state.values);
        if (!result.ok) throw new Error(result.error);
        return withMixes(result.mixes);
    });
    host.own.register('decision.gameSettings.applyMix', ({ id }) => {
        const mix = state.mixes.find(item => item.id === id);
        if (!mix) throw new Error('No such mix.');
        state = { ...state, values: { ...mix.values }, mode: modeOf(mix.values) };
        publish();
        return structuredClone(state);
    });
    const panel = createGameSettingsPanelCore(host, { mount: node => ({ settled: async () => {}, getRoot: () => node, unmount() {} }) });
    return { engine, panel, events, getState: () => state };
}

test('the window opens from the card event and closes on the same event', async () => {
    const { engine, panel } = build();
    await panel.open();
    assert.equal(panel.isVisible(), false);
    engine.events.emit('decisionGameSettings.openRequested', {});
    assert.equal(panel.isVisible(), true);
    engine.events.emit('decisionGameSettings.openRequested', {});
    assert.equal(panel.isVisible(), false);
});

test('the window shows the four groups, the modes, the Custom slot and one consequence line under each option', () => {
    const { panel } = build();
    panel.show();
    const text = textOf(panel.tree());
    for (const title of ['Story', 'Your character', 'Writing', 'Display']) assert.match(text, new RegExp(title));
    for (const label of ['Story', 'Classic', 'Hardcore', 'Custom']) assert.match(text, new RegExp(label));
    assert.match(text, /Every attempt stands on its own odds/);
    assert.match(text, /Advanced: edit prompts/);
    // Custom стоит в сетке ВСЕГДА — иначе при переходе в Custom плитки прыгают.
    assert.equal(walkAll(panel.tree(), node => hasClass(node, 'stme-gs-mode-custom')).length, 1);
});

test('a mode tile sets every segment at once and is highlighted', async () => {
    const { panel, getState } = build();
    await panel.open();
    panel.show();
    modeTile(panel.tree(), 'Story').props['on:click']();
    await tick();
    assert.equal(getState().mode, 'story');
    assert.equal(getState().values.difficulty, 'easy');
    assert.equal(getState().values.consequences, 'safe');
    assert.equal(panel.optionSignals.get('difficulty').peek(), 'easy');
    assert.equal(panel.optionSignals.get('pacing').peek(), 'eventful');
    assert.equal(panel.mode.peek(), 'story');
    assert.ok(walkAll(panel.tree(), node => hasClass(node, 'stme-gs-mode-active')).length >= 1);
});

test('a segment click makes the set Custom, saves it and raises the changed event', async () => {
    const { panel, events, getState } = build();
    await panel.open();
    panel.show();
    modeTile(panel.tree(), 'Story').props['on:click']();
    await tick();
    const before = events.length;

    const dark = walkAll(panel.tree(), item => item.tag === 'button' && resolve(item.props?.role) === 'radio' && textOf(item) === 'Dark')[0];
    assert.ok(dark, 'the Tone segment has a Dark value');
    dark.props['on:click']();
    await tick();

    assert.equal(getState().values.tone, 'dark');
    assert.equal(getState().mode, 'custom');
    assert.equal(panel.mode.peek(), 'custom');
    assert.equal(events.length, before + 1, 'a changed event is raised');
    assert.equal(events.at(-1).values.tone, 'dark');
    assert.equal(events.at(-1).mode, 'custom');
});

test('Use for new chats and Reset to Classic go through their own contracts', async () => {
    const { panel, getState } = build();
    await panel.open();
    panel.show();
    // Пока набор совпадает с умолчанием, кнопка это и говорит.
    assert.ok(buttonByText(panel.tree(), 'New chats use this mix'));
    await panel.setOption('tone', 'dark');
    buttonByText(panel.tree(), 'Use for new chats').props['on:click']();
    await tick();
    assert.equal(getState().defaults.tone, 'dark');

    buttonByText(panel.tree(), 'Reset to Classic').props['on:click']();
    await tick();
    assert.equal(getState().mode, 'classic');
    assert.equal(panel.mode.peek(), 'classic');
    assert.equal(getState().values.tone, 'balanced');
});

test('an option that made the set Custom is marked and can be reset on its own', async () => {
    const { panel, getState } = build();
    await panel.open();
    panel.show();
    await panel.setOption('tone', 'dark');
    assert.match(textOf(panel.tree()), /changed from Classic/);
    const reset = walkAll(panel.tree(), item => item.tag === 'button' && textOf(item) === 'Reset this option')[0];
    assert.ok(reset, 'the changed option offers its own reset');
    reset.props['on:click']();
    await tick();
    assert.equal(getState().values.tone, 'balanced');
    assert.equal(getState().mode, 'classic');
    assert.doesNotMatch(textOf(panel.tree()), /changed from Classic/);
});

test('Reset to Classic offers Undo, and Undo returns the whole previous set', async () => {
    const { panel, getState } = build();
    await panel.open();
    panel.show();
    await panel.setOption('tone', 'dark');
    await panel.setOption('romance', 'off');
    buttonByText(panel.tree(), 'Reset to Classic').props['on:click']();
    await tick();
    assert.equal(getState().mode, 'classic');

    const undo = buttonByText(panel.tree(), 'Undo');
    assert.ok(undo, 'the reset offers Undo');
    undo.props['on:click']();
    await tick();
    assert.equal(getState().values.tone, 'dark');
    assert.equal(getState().values.romance, 'off');
    assert.equal(getState().mode, 'custom');
});

test('Advanced: edit prompts opens the old prompt editor', async () => {
    const { engine, panel } = build();
    await panel.open();
    panel.show();
    let opened = 0;
    engine.events.subscribe('decisionPrompts.openRequested', () => { opened += 1; });
    const link = walkAll(panel.tree(), item => item.tag === 'button' && textOf(item) === 'Advanced: edit prompts')[0];
    assert.ok(link);
    link.props['on:click']();
    assert.equal(opened, 1);
});

test('a saved mix can be applied, tuned, updated, renamed and removed', async () => {
    const { panel, getState } = build();
    await panel.open();
    panel.show();
    await panel.setOption('tone', 'dark');
    panel.startSaveNew();
    panel.mixName.set('Noir');
    await panel.saveMixName();
    await tick();
    assert.equal(panel.mixes.peek().length, 1);
    assert.equal(panel.mixes.peek()[0].name, 'Noir');
    const id = panel.mixes.peek()[0].id;
    assert.equal(panel.activeMixId.peek(), id);

    await panel.reset();
    await tick();
    assert.equal(getState().values.tone, 'balanced');
    await panel.applyMix(id);
    await tick();
    assert.equal(getState().values.tone, 'dark');
    assert.equal(panel.matchedMixId.peek(), id, 'the applied mix is highlighted');

    await panel.setOption('tone', 'light');
    assert.equal(panel.matchedMixId.peek(), '', 'an edit stops the match');
    assert.equal(panel.mixes.peek()[0].values.tone, 'dark', 'the saved mix is untouched by an edit');

    await panel.updateMix();
    await tick();
    assert.equal(panel.mixes.peek()[0].values.tone, 'light', 'Update mix stores the current set explicitly');

    panel.startRename(id);
    panel.mixName.set('Rainy noir');
    await panel.saveMixName();
    await tick();
    assert.equal(panel.mixes.peek()[0].name, 'Rainy noir');

    await panel.removeMix(id);
    await tick();
    assert.deepEqual(panel.mixes.peek(), []);
});

test('the window saves at most eight mixes and says so', async () => {
    const { panel } = build();
    await panel.open();
    panel.show();
    for (let index = 0; index < 8; index += 1) {
        panel.startSaveNew();
        panel.mixName.set(`Mix ${index}`);
        await panel.saveMixName();
    }
    await tick();
    assert.equal(panel.mixes.peek().length, 8);
    assert.equal(panel.atLimit.peek(), true);
    const save = buttonByText(panel.tree(), 'Save as mix…');
    assert.equal(resolve(save.props.disabled), true, 'the button is disabled at the limit');
    panel.startSaveNew();
    assert.equal(panel.mixEditing.peek(), null, 'no new editor at the limit');
});

test('a saved mix is highlighted when the current set matches it', async () => {
    const { panel } = build();
    await panel.open();
    panel.show();
    await panel.setOption('tone', 'dark');
    panel.startSaveNew();
    panel.mixName.set('Noir');
    await panel.saveMixName();
    await tick();
    assert.equal(walkAll(panel.tree(), node => hasClass(node, 'stme-gs-mix-active')).length, 1);
    await panel.setOption('tone', 'light');
    assert.equal(walkAll(panel.tree(), node => hasClass(node, 'stme-gs-mix-active')).length, 0);
});
