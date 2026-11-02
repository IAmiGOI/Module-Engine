import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { createSettingsCore } from '../cores/settings/index.js';
import { createDecisionPromptsPanelCore } from '../cores/ui/decision-prompts-panel.js';
import { createDecisionCard } from '../cores/ui/panel-cards/decision-card.js';
import { signal } from '../cores/ui/reactive.js';

const resolve = value => (typeof value === 'function' ? resolve(value()) : value);

function walkAll(node, match, out = []) {
    const value = resolve(node);
    if (Array.isArray(value)) { value.forEach(item => walkAll(item, match, out)); return out; }
    if (!value || typeof value !== 'object' || !value.tag) return out;
    if (match(value)) out.push(value);
    (value.children ?? []).forEach(child => walkAll(child, match, out));
    return out;
}
const hasClass = (node, name) => String(resolve(node.props?.class) ?? '').split(/\s+/).includes(name);
const textOf = node => { const value = resolve(node); if (Array.isArray(value)) return value.map(textOf).join(''); if (value == null || value === false) return ''; if (typeof value !== 'object') return String(value); return (value.children ?? []).map(textOf).join(''); };
const tick = (ms = 20) => new Promise(done => setTimeout(done, ms));

function sectionFixture() {
    const block = { id: 'b1', name: 'Mine', role: 'system', content: 'Keep it tense.' };
    return { blocks: [block], tree: [{ type: 'item', block: 'b1', enabled: true }], presets: [], activePresetId: '' };
}

function build() {
    const engine = createEngine();
    const context = { extensionSettings: {}, saveSettingsDebounced: () => {} };
    registerExtensionSettingsService(engine.buses.services, { getContext: () => context });
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));
    const host = engine.registerCaller('core.ui.decisionPrompts', 'cores', { tier: 'official', allowedContracts: ['file.download', 'ui.notify'] });
    engine.buses.services.register('file.download', () => true);
    const saves = [];
    let settings = { promptSections: { director: sectionFixture(), writer: { blocks: [], tree: [], presets: [], activePresetId: '' } } };
    host.own.register('decision.settings', () => structuredClone(settings));
    host.own.register('decision.configure', ({ patch }) => { saves.push(structuredClone(patch)); settings = { ...settings, ...structuredClone(patch) }; return structuredClone(settings); });
    host.own.register('ui.notify', () => true);
    host.own.register('decision.preview', ({ section }) => ({
        rows: [
            { kind: 'system', label: `${section} instructions`, detail: 'system', text: 'LOCKED TEXT', locked: true },
            { kind: 'block', label: 'Your prompts', detail: '1 message', text: 'Keep it tense.' },
        ],
        warnings: [],
    }));
    const panel = createDecisionPromptsPanelCore(host, { mount: node => ({ settled: async () => {}, getRoot: () => node, unmount() {} }) });
    return { engine, panel, saves, getSettings: () => settings };
}

test('the window has Director, Writer and Preview tabs, opens from SillyTavern\'s icon event and closes on the same event', async () => {
    const { engine, panel } = build();
    await panel.open();
    assert.equal(panel.isVisible(), false, 'closed until asked to open');
    panel.show();
    const text = textOf(panel.tree());
    for (const tab of ['Director', 'Writer', 'Preview']) assert.match(text, new RegExp(tab));

    panel.hide();
    engine.events.emit('decisionPrompts.openRequested', {});
    assert.equal(panel.isVisible(), true);
    engine.events.emit('decisionPrompts.openRequested', {});
    assert.equal(panel.isVisible(), false, 'the same request closes it again');
});

test('system lines are rendered locked and a drop on them changes nothing', async () => {
    const { panel } = build();
    await panel.open();
    panel.show();
    const locked = walkAll(panel.tree(), node => hasClass(node, 'stme-dp-row-locked'));
    assert.ok(locked.length >= 1, 'the section starts with a locked system row');
    assert.equal(locked[0].props.draggable, 'false');
    const before = JSON.stringify(panel.sections.peek());
    locked[0].props['on:drop']({ preventDefault() {}, currentTarget: {} });
    assert.equal(JSON.stringify(panel.sections.peek()), before);
});

test('adding a prompt edits the draft, and Save writes both sections through decision.configure', async () => {
    const { panel, saves } = build();
    await panel.open();
    panel.show();
    await panel.refresh();
    const add = walkAll(panel.tree(), node => node.tag === 'button' && textOf(node) === '+ Prompt')[0];
    add.props['on:click']();
    assert.equal(panel.sections.peek().director.blocks.length, 2);
    assert.equal(panel.dirty(), true);
    await panel.save();
    assert.equal(saves.length, 1);
    assert.equal(saves[0].promptSections.director.blocks.length, 2);
    assert.equal(panel.dirty(), false);
});

test('the Preview tab asks decision.preview for the chosen section and shows locked text, the block and placeholders', async () => {
    const { panel } = build();
    await panel.open();
    panel.show();
    panel.selectTab('preview');
    await tick();
    const text = textOf(panel.tree());
    assert.match(text, /director instructions/);
    assert.match(text, /LOCKED TEXT/);
    assert.match(text, /Keep it tense/);
    assert.match(text, /Your prompts/);
});

test('the Director / Writer card has no prompt fields and its button opens the prompts window', async () => {
    const calls = [];
    const call = async (contract, params) => {
        calls.push({ contract, params });
        if (contract === 'decision.settings') return { ok: true, value: { promptSections: { director: sectionFixture(), writer: { blocks: [], tree: [], presets: [], activePresetId: '' } } } };
        if (contract === 'decision.lastRun') return { ok: true, value: null };
        if (contract === 'model.presets.get') return { ok: true, value: [] };
        return { ok: true, value: null };
    };
    let opened = 0;
    let openedDirector = 0;
    const card = createDecisionCard({ call, collapse: { bind: () => ({}) }, notify: async () => ({ ok: true }), workers: signal([]), openPrompts: () => { opened += 1; }, openDirector: () => { openedDirector += 1; } });
    await card.loadDecision();
    const node = card.decisionCard();
    const text = textOf(node);
    assert.doesNotMatch(text, /Director prompt|Writer prompt/);
    const button = walkAll(node, item => item.tag === 'button' && textOf(item) === 'Open prompts')[0];
    assert.ok(button, 'the card must offer a way into the window');
    button.props['on:click']();
    assert.equal(opened, 1);
    const director = walkAll(node, item => item.tag === 'button' && textOf(item) === 'Open director')[0];
    assert.ok(director, 'the card must offer the director window');
    director.props['on:click']();
    assert.equal(openedDirector, 1);
});
