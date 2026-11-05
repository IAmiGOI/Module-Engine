import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { createSettingsCore } from '../cores/settings/index.js';
import { createGameSettingsPanelCore } from '../cores/ui/game-settings-panel.js';
import { DEFAULT_GAME_SETTINGS, modeOf, patchGameSettings } from '../libraries/core/game-settings.js';

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
    let state = { values: { ...DEFAULT_GAME_SETTINGS }, mode: 'classic', defaults: { ...DEFAULT_GAME_SETTINGS } };
    const publish = () => engine.events.emit('decision.gameSettings.changed', structuredClone(state));
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

test('the window shows the four groups, the modes and one consequence line under each option', () => {
    const { panel } = build();
    panel.show();
    const text = textOf(panel.tree());
    for (const title of ['Story', 'Your character', 'Writing', 'Display']) assert.match(text, new RegExp(title));
    for (const label of ['Story', 'Classic', 'Hardcore']) assert.match(text, new RegExp(label));
    assert.match(text, /Every attempt stands on its own odds/);
    assert.match(text, /Advanced: edit prompts/);
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
