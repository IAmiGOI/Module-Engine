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
