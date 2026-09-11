import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { createSettingsCore } from '../cores/settings/index.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { createFirstLoadCore, FIRST_LAUNCH_EVENT } from '../cores/first-load/index.js';

/**
 * Настоящие Шины + настоящее Ядро сохранения + настоящий Сервис
 * extension-settings (с фейковым `getContext`) — счётчик проверяем по
 * ВСЕМУ пути записи, а не подменой хранилища.
 *
 * Хранилище (`raw`) живёт ВНЕ setup(): один и тот же объект переживает
 * новое ядро — это и есть имитация перезагрузки страницы (диск один,
 * движок новый). Каждый `setup(raw)` — отдельная «сессия».
 */
function setup(raw = {}) {
    const engine = createEngine();
    // `raw` — САМ namespaced-слой: сервис кладёт его под ключом
    // `stme_settings` внутри extensionSettings (проверено тестом
    // extension-settings-service.test.js: `context.extensionSettings.stme_settings`).
    registerExtensionSettingsService(engine.buses.services, { getContext: () => ({ extensionSettings: { stme_settings: raw } }) });
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));
    const host = engine.registerCaller('core.firstLoad', 'cores', { tier: 'official' });
    const published = [];
    const core = createFirstLoadCore(host, {
        publish: (event, payload) => published.push({ event, payload }),
    });
    return { engine, core, published, raw };
}

test('status() is null before load; reading alone never increments', async () => {
    const { core, raw } = setup();
    assert.equal(core.status(), null);

    await core.load();
    assert.equal(core.status(), 1);
    assert.deepEqual(JSON.parse(JSON.stringify(raw)), { 'core.firstLoad': { launchCount: 1 } });
});

test('repeated load() in the SAME session is idempotent: no re-count, no re-publish', async () => {
    const { core, published, raw } = setup();
    await core.load();
    await core.load();
    await core.load();
    assert.equal(core.status(), 1);
    assert.equal(published.length, 1, 'firstLaunch event exactly once per session');
    assert.deepEqual(JSON.parse(JSON.stringify(raw)), { 'core.firstLoad': { launchCount: 1 } });
});

test('page reload: new core over the SAME storage counts to 2 and publishes nothing', async () => {
    const raw = {};
    const first = setup(raw);
    await first.core.load();
    assert.equal(first.published.length, 1);

    // «Перезагрузка»: то же хранилище, свежий движок и ядро.
    const second = setup(raw);
    const result = await second.core.load();
    assert.deepEqual(result, { count: 2, firstLaunch: false });
    assert.equal(second.published.length, 0, 'second launch is not a first launch');
});

test('first launch: counter 0 -> 1, firstLaunch true, event payload {count:1}', async () => {
    const { core, published } = setup();
    const result = await core.load();
    assert.deepEqual(result, { count: 1, firstLaunch: true });
    assert.equal(published.length, 1);
    assert.equal(published[0].event, FIRST_LAUNCH_EVENT);
    assert.deepEqual(published[0].payload, { count: 1 });
});

test('non-first launch (pre-existing count): firstLaunch false, no event', async () => {
    // Предзапись «были запуски» — через setup() с уже заселённым хранилищем:
    // та же форма { 'core.firstLoad': { launchCount: N } }, которую Ядро
    // сохранения пишет на диске.
    const { core, published, engine } = setup({ 'core.firstLoad': { launchCount: 3 } });
    void engine;

    const result = await core.load();
    assert.deepEqual(result, { count: 4, firstLaunch: false });
    assert.equal(published.length, 0, 'no event on a regular launch');
});

test('garbage on disk (string, NaN) is treated as 0 — safe side, onboarding replays', async () => {
    const { core, published } = setup({ 'core.firstLoad': { launchCount: 'banana' } });
    const result = await core.load();
    assert.deepEqual(result, { count: 1, firstLaunch: true });
    assert.equal(published.length, 1);
});

test('resetForTests() zeroes the counter; next load() is a first launch again', async () => {
    const raw = {};
    const first = setup(raw);
    await first.core.load();
    await first.core.resetForTests();
    assert.equal(first.core.status(), null);

    const second = setup(raw);
    const result = await second.core.load();
    assert.deepEqual(result, { count: 1, firstLaunch: true });
});