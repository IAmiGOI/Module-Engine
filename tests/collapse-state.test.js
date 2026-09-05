import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { createSettingsCore } from '../cores/settings/index.js';
import { createCollapseState } from '../libraries/shared/collapse-state.js';

/** Настоящая персистентность: реальный Сервис настроек поверх стабильного объекта контекста ST. */
function build() {
    const engine = createEngine();
    const settingsContext = { extensionSettings: {}, saveSettingsDebounced: () => {} };
    registerExtensionSettingsService(engine.buses.services, { getContext: () => settingsContext });
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));
    const host = engine.registerCaller('core.ui.panel', 'cores', { tier: 'official' });
    return { engine, settingsContext, host, make: () => createCollapseState(host.own, { namespace: 'core.ui.panel' }) };
}

test('everything starts COLLAPSED — the panel does not fit on one screen, so nothing opens uninvited', () => {
    const { make } = build();

    assert.equal(make().bind('card:engine').open(), false);
});

test('a caller can still ask for one thing to start open', () => {
    const { make } = build();

    assert.equal(make().bind('card:modules', { open: true }).open(), true);
});

test('folding something is remembered, and comes back that way on the next load', async () => {
    const { make } = build();
    const first = make();
    first.bind('card:models', { open: true }).onToggle(false);
    await new Promise(resolve => setTimeout(resolve, 0));

    const second = make();
    await second.restore();

    assert.equal(second.bind('card:models', { open: true }).open(), false, 'the saved state wins over the default');
});

test('state saved BEFORE restore() still lands — a widget built early must not be left on the default', async () => {
    const { make } = build();
    make().bind('card:engine').onToggle(true);
    await new Promise(resolve => setTimeout(resolve, 0));

    const later = make();
    const bound = later.bind('card:engine'); // связались ДО чтения — стоим на умолчании
    assert.equal(bound.open(), false);

    await later.restore();

    assert.equal(bound.open(), true, 'the already-created signal catches up with what was read');
});

test('the same key hands back the very SAME signal object — a re-render must not swap it out from under the DOM', () => {
    const state = build().make();

    const first = state.bind('tracker:a');
    const second = state.bind('tracker:a');

    // Именно тождество, а не совпадение значения: узел уже подписан на первый
    // сигнал, и подсунутый на перерисовке новый оставил бы его глухим.
    assert.equal(second.open, first.open);
    first.onToggle(true);
    assert.equal(second.open(), true);
});

test('an echo of our own write is not saved again — the DOM fires "toggle" when WE set open, too', async () => {
    const { make, settingsContext } = build();
    const state = make();
    const bound = state.bind('card:engine');
    bound.onToggle(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    const afterFirst = JSON.stringify(settingsContext.extensionSettings);

    bound.onToggle(true); // ровно то, что уже установлено

    assert.equal(JSON.stringify(settingsContext.extensionSettings), afterFirst);
});

test('two different keys are remembered independently — folding one must not fold its neighbour', async () => {
    const { make } = build();
    const state = make();
    state.bind('tracker:a', { open: true });
    state.bind('tracker:b', { open: true }).onToggle(false);
    await new Promise(resolve => setTimeout(resolve, 0));

    const reloaded = make();
    await reloaded.restore();

    assert.equal(reloaded.bind('tracker:a').open(), true);
    assert.equal(reloaded.bind('tracker:b').open(), false);
});
