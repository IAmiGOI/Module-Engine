import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { createSettingsCore } from '../cores/settings/index.js';
import { createPromptManagerPanelCore } from '../cores/ui/prompt-manager-panel.js';

const resolve = value => (typeof value === 'function' ? resolve(value()) : value);

/** Дерево `h()` — обычные объекты (props тоже могут быть сигналами); поиск по классу не требует настоящего DOM. */
function findByClass(node, className) {
    const value = resolve(node);
    if (Array.isArray(value)) { for (const item of value) { const found = findByClass(item, className); if (found) return found; } return null; }
    if (!value || typeof value !== 'object' || !value.tag) return null;
    const classes = String(resolve(value.props?.class) ?? '').split(/\s+/);
    if (classes.includes(className)) return value;
    for (const child of value.children ?? []) { const found = findByClass(child, className); if (found) return found; }
    return null;
}
const styleOf = node => resolve(node?.props?.style) ?? {};

function build({ settings = { enabled: true }, presets = [], presetById = {} } = {}) {
    const engine = createEngine();
    const settingsContext = { extensionSettings: {}, saveSettingsDebounced: () => {} };
    registerExtensionSettingsService(engine.buses.services, { getContext: () => settingsContext });
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));
    const host = engine.registerCaller('core.ui.promptManager', 'cores', { tier: 'official' });
    host.own.register('promptManager.settings', () => ({ ...settings }));
    host.own.register('promptManager.presets', () => presets);
    host.own.register('promptManager.preset', params => presetById[params?.id] ?? null);
    host.own.register('promptManager.conditionTypes', () => []);
    host.own.register('promptManager.autoPrepare', () => []);
    const panel = createPromptManagerPanelCore(host, { mount: node => ({ settled: async () => {}, getRoot: () => node, unmount() {} }) });
    return { engine, panel };
}

test('SillyTavern\'s icon toggles the window: first request opens it, a second one closes it again — owner: "кнопка... не закрывает его"', async () => {
    const { engine, panel } = build();
    await panel.open();
    assert.equal(panel.isVisible(), false, 'closed until asked to open');

    engine.events.emit('promptManager.openRequested', {});
    assert.equal(panel.isVisible(), true);

    engine.events.emit('promptManager.openRequested', {});
    assert.equal(panel.isVisible(), false, 'the SAME request a second time closes it again');
});

test('a window that has never been positioned opens clear of the left-docked icon column, not pinned to the top-left corner underneath it', async () => {
    const { panel } = build();
    await panel.open();
    panel.show();

    const window_ = findByClass(panel.tree(), 'stme-pm-window');
    assert.ok(window_, 'the window must actually be in the tree once visible');
    const { left, top } = styleOf(window_);
    assert.ok(parseFloat(left) >= 72, `left (${left}) must clear the icon column`);
    assert.ok(parseFloat(top) >= 0 && parseFloat(top) < 200, `top (${top}) should be a sane top offset, not the very corner`);
});

test('a position the owner actually dragged to is restored on the next open(), not overridden by the default', async () => {
    const { engine, panel } = build();
    const settings = engine.registerCaller('probe', 'cores', { tier: 'official' });
    const { request } = await import('../libraries/shared/request.js');
    await request(settings.own, 'storage.settings.set', { params: { namespace: 'core.ui.promptManager', key: 'window', value: { visible: false, position: { left: 15, top: 15 }, size: { width: 700, height: 500 } } } });

    await panel.open();
    panel.show();

    const window_ = findByClass(panel.tree(), 'stme-pm-window');
    const { left, top } = styleOf(window_);
    assert.equal(left, '15px');
    assert.equal(top, '15px');
});

test('a window left open across a page reload actually loads its data, not just its visibility — owner: "не вносит нужные данные в себя и остаётся открытым но пустым"', async () => {
    const preset = { params: { reasoning_effort: 'auto' }, tree: [], blocks: [] };
    const { engine, panel } = build({
        settings: { enabled: true, activePresetId: 'p1' },
        presets: [{ id: 'p1', name: 'My preset' }],
        presetById: { p1: { preset } },
    });
    const settingsCaller = engine.registerCaller('probe', 'cores', { tier: 'official' });
    const { request } = await import('../libraries/shared/request.js');
    await request(settingsCaller.own, 'storage.settings.set', { params: { namespace: 'core.ui.promptManager', key: 'window', value: { visible: true, position: { left: 15, top: 15 }, size: { width: 700, height: 500 } } } });

    await panel.open();

    assert.equal(panel.isVisible(), true, 'the persisted "visible: true" must be honored');
    assert.equal(panel.state.activeId(), 'p1', 'refresh() must run on restore, exactly like show() already does, so the preset actually loads instead of leaving the window blank');
    assert.deepEqual(panel.state.preset(), preset);
});

test('a size saved on a wide screen is clamped to a narrow one on reopen — a phone must not inherit a desktop-wide window (owner: "на малых разрешениях блок редактирования открывается под ним")', async () => {
    const { engine, panel } = build();
    const settings = engine.registerCaller('probe', 'cores', { tier: 'official' });
    const { request } = await import('../libraries/shared/request.js');
    await request(settings.own, 'storage.settings.set', { params: { namespace: 'core.ui.promptManager', key: 'window', value: { visible: false, position: { left: 15, top: 15 }, size: { width: 980, height: 680 } } } });

    const previousWidth = globalThis.innerWidth;
    globalThis.innerWidth = 375; // телефон
    try {
        await panel.open();
        panel.show();
        const window_ = findByClass(panel.tree(), 'stme-pm-window');
        const { width } = styleOf(window_);
        assert.ok(parseFloat(width) <= 375 - 32, `width (${width}) must fit the 375px viewport, not the saved 980px`);
    } finally {
        globalThis.innerWidth = previousWidth;
    }
});

// ── Сохранение параметров пресета ────────────────────────────────────────────────────────────────────────────────

const walkAll = (node, match, out = []) => {
    const value = resolve(node);
    if (Array.isArray(value)) { value.forEach(item => walkAll(item, match, out)); return out; }
    if (!value || typeof value !== 'object' || !value.tag) return out;
    if (match(value)) out.push(value);
    (value.children ?? []).forEach(child => walkAll(child, match, out));
    return out;
};
const hasClass = (node, name) => String(resolve(node.props?.class) ?? '').split(/\s+/).includes(name);
const textOfNode = node => { const value = resolve(node); if (Array.isArray(value)) return value.map(textOfNode).join(''); if (value == null || value === false) return ''; if (typeof value !== 'object') return String(value); return (value.children ?? []).map(textOfNode).join(''); };
/** Поле окна по подписи (`Field`): первый `<label class="stme-field">`, чья подпись начинается с текста. */
const fieldByLabel = (root, label) => walkAll(root, node => node.tag === 'label' && hasClass(node, 'stme-field') && textOfNode(node.children[0]).startsWith(label))[0];
const dropdownLabel = field => textOfNode(walkAll(field, node => hasClass(node, 'stme-pm-dropdown-label'))[0]);
const chooseOption = (field, optionText) => walkAll(field, node => hasClass(node, 'stme-pm-dropdown-option') && textOfNode(node) === optionText)[0]?.props['on:click']?.();
const typeInto = (field, value) => { const input = walkAll(field, node => node.tag === 'input' || node.tag === 'textarea')[0]; input.props['on:input']({ target: { value: String(value) } }); };
const tick = (ms = 30) => new Promise(done => setTimeout(done, ms));

const presetWith = params => ({ formatVersion: 1, name: 'P', params, templates: {}, blocks: [], tree: [], orders: [], extensions: {}, opaque: {}, rules: [], cot: null });

async function buildEditor(stored) {
    const engine = createEngine();
    const context = { extensionSettings: {}, saveSettingsDebounced: () => {} };
    registerExtensionSettingsService(engine.buses.services, { getContext: () => context });
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));
    const host = engine.registerCaller('core.ui.promptManager', 'cores', { tier: 'official' });
    const saves = [];
    host.own.register('promptManager.settings', () => ({ enabled: true, activePresetId: 'p1' }));
    host.own.register('promptManager.presets', () => Object.values(stored).map(item => ({ id: item.id, name: item.name })));
    host.own.register('promptManager.preset', params => stored[params?.id] ?? null);
    host.own.register('promptManager.conditionTypes', () => []);
    host.own.register('promptManager.autoPrepare', () => []);
    host.own.register('promptManager.configure', ({ patch }) => ({ enabled: true, ...patch }));
    host.own.register('promptManager.savePreset', ({ record }) => { saves.push(structuredClone(record.preset)); stored[record.id] = structuredClone(record); return record; });
    const panel = createPromptManagerPanelCore(host, { mount: node => ({ settled: async () => {}, getRoot: () => node, unmount() {} }) });
    await panel.open();
    panel.show();
    await tick();
    return { panel, saves, stored };
}
const stored2 = () => ({ p1: { id: 'p1', name: 'One', preset: presetWith({ temperature: 0.7, reasoning_effort: 'high' }) }, p2: { id: 'p2', name: 'Two', preset: presetWith({ reasoning_effort: 'low' }) } });

test('the Reasoning effort list shows what the preset stores, and follows the preset when another one is opened (it used to stay on "auto")', async () => {
    const { panel } = await buildEditor(stored2());
    assert.equal(dropdownLabel(fieldByLabel(panel.tree(), 'Reasoning effort')), 'high');
    await panel.actions.selectPreset('p2');
    await tick();
    assert.equal(dropdownLabel(fieldByLabel(panel.tree(), 'Reasoning effort')), 'low');
});

test('a changed reasoning effort is written into the preset when saved, and is still there after the preset is loaded again', async () => {
    const { panel, saves } = await buildEditor(stored2());
    chooseOption(fieldByLabel(panel.tree(), 'Reasoning effort'), 'medium');
    await panel.actions.save();
    assert.equal(saves.at(-1).params.reasoning_effort, 'medium');
    await panel.refresh();
    await tick();
    assert.equal(dropdownLabel(fieldByLabel(panel.tree(), 'Reasoning effort')), 'medium');
});

test('the parameters Prompt Manager really uses but had no field for can now be edited and saved: candidates, verbosity, names, prefill', async () => {
    const { panel, saves } = await buildEditor(stored2());
    typeInto(fieldByLabel(panel.tree(), 'Candidates'), 3);
    chooseOption(fieldByLabel(panel.tree(), 'Verbosity'), 'high');
    chooseOption(fieldByLabel(panel.tree(), 'Speaker names'), 'name field of the message');
    typeInto(fieldByLabel(panel.tree(), 'Assistant prefill'), 'Understood. ');
    await panel.actions.save();
    const params = saves.at(-1).params;
    assert.deepEqual([params.n, params.verbosity, params.names_behavior, params.assistant_prefill], [3, 'high', 2, 'Understood. ']);
    // "auto" verbosity means "do not send": the key leaves the preset instead of being sent to the provider as "auto".
    chooseOption(fieldByLabel(panel.tree(), 'Verbosity'), 'auto (not sent)');
    typeInto(fieldByLabel(panel.tree(), 'Assistant prefill'), '');
    await panel.actions.save();
    assert.equal('verbosity' in saves.at(-1).params, false);
    assert.equal('assistant_prefill' in saves.at(-1).params, false);
});

test('the save bar appears on any tab as soon as something is unsaved, saves with one click, and goes away', async () => {
    const { panel, saves } = await buildEditor(stored2());
    const bar = () => walkAll(panel.tree(), node => hasClass(node, 'stme-pm-savebar'))[0];
    assert.equal(bar(), undefined, 'nothing to save yet');
    panel.selectTab('settings');
    chooseOption(fieldByLabel(panel.tree(), 'Reasoning effort'), 'min');
    assert.ok(bar(), 'a change made on the Settings tab shows the bar (it used to need the small button on the Order tab)');
    const save = walkAll(bar(), node => hasClass(node, 'stme-pm-savebar-save'))[0];
    await save.props['on:click']();
    assert.equal(saves.at(-1).params.reasoning_effort, 'min');
    assert.equal(bar(), undefined, 'saved: the bar is gone');
});

test('opening the window again does not silently throw away unsaved changes', async () => {
    const { panel, saves } = await buildEditor(stored2());
    chooseOption(fieldByLabel(panel.tree(), 'Reasoning effort'), 'max');
    panel.hide();
    panel.show();
    await tick();
    assert.equal(dropdownLabel(fieldByLabel(panel.tree(), 'Reasoning effort')), 'max', 'the draft is still there');
    await panel.actions.save();
    assert.equal(saves.at(-1).params.reasoning_effort, 'max');
});

test('Discard returns the preset to what is saved, after a confirmation', async () => {
    const { panel } = await buildEditor(stored2());
    chooseOption(fieldByLabel(panel.tree(), 'Reasoning effort'), 'max');
    const original = globalThis.confirm;
    globalThis.confirm = () => true;
    try { await panel.actions.discard(); } finally { globalThis.confirm = original; }
    await tick();
    assert.equal(dropdownLabel(fieldByLabel(panel.tree(), 'Reasoning effort')), 'high');
    assert.equal(walkAll(panel.tree(), node => hasClass(node, 'stme-pm-savebar')).length, 0);
});
