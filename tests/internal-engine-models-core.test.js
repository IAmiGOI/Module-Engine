import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerHttpService } from '../services/http.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { createInternalEngineModelsCore } from '../cores/models/internal-engine.js';
import { createSettingsCore } from '../cores/settings/index.js';

/**
 * Scenario level (TESTING.md "Уровень 2") — the real engine, real Гейты,
 * real rights checks, real dispatch-queue/provider-request libraries; only
 * `fetch` itself (the true external boundary) is faked. Proves the whole
 * chain "Модуль -> Шина ядер -> Гейт -> Ядро внутренних моделей -> Шина
 * сети -> Гейт для сети -> Сервис HTTP" actually works end to end, not just
 * its pieces in isolation — and that it's a genuine, working consumer of
 * the network Gate built earlier, not just a Gate nobody uses yet.
 */

function openAiFakeFetch(reply = 'a generated reply') {
    const calls = [];
    return {
        calls,
        fetch: async (url, init) => {
            calls.push({ url, ...init });
            return {
                status: 200, ok: true,
                headers: { entries: () => [] },
                text: async () => JSON.stringify({ choices: [{ message: { content: reply } }] }),
            };
        },
    };
}

function buildEngineWithModelsCore({ networkAccess = true } = {}) {
    const engine = createEngine();
    const { fetch, calls } = openAiFakeFetch();
    registerHttpService(engine.buses.network, { fetch });
    // configureWorkers() now really persists via storage.settings — a
    // Settings Core must be wired for it to have anywhere to write to,
    // same as a real engine (see harness/engine-wiring.js). The context
    // object must be the SAME one on every getContext() call — a fresh
    // `{}` per call would silently discard every write.
    const settingsContext = { extensionSettings: {}, saveSettingsDebounced: () => {} };
    registerExtensionSettingsService(engine.buses.services, { getContext: () => settingsContext });
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));
    const modelsHost = engine.registerCaller('core.models.internal', 'cores', { tier: 'official', networkAccess });
    const modelsCore = createInternalEngineModelsCore(modelsHost);
    return { engine, calls, modelsCore };
}

test('a Module reaches model.generate through the real Director -> Гейт -> Ядро -> Шина сети -> Гейт для сети -> Сервис HTTP chain', async () => {
    const { engine, calls, modelsCore } = buildEngineWithModelsCore();
    modelsCore.configureWorkers([{ id: 'w1', endpoint: 'https://api.example.com/v1', apiKey: 'sk-1', model: 'gpt-test', format: 'openai' }]);

    const module = engine.registerCaller('module.writer', 'modules', { tier: 'community', allowedContracts: ['model.generate'] });
    const result = await new Promise(resolve => module.cores.subscribe('model.generate', { params: { prompt: 'hello' } }, resolve));

    assert.deepEqual(result, { ok: true, value: 'a generated reply' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.example.com/v1/chat/completions');
    assert.match(calls[0].body, /"hello"/);
});

test('two concurrent requests load-balance across two configured workers rather than serializing behind one', async () => {
    const { engine, modelsCore, calls } = buildEngineWithModelsCore();
    modelsCore.configureWorkers([
        { id: 'w1', endpoint: 'https://api.one.example.com', model: 'model-1', format: 'openai' },
        { id: 'w2', endpoint: 'https://api.two.example.com', model: 'model-2', format: 'openai' },
    ]);
    const module = engine.registerCaller('module.writer', 'modules', { tier: 'official' });
    const generate = prompt => new Promise(resolve => module.cores.subscribe('model.generate', { params: { prompt } }, resolve));

    const [r1, r2] = await Promise.all([generate('first'), generate('second')]);

    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.equal(calls.length, 2);
    const urls = calls.map(call => call.url).sort();
    assert.deepEqual(urls, ['https://api.one.example.com/chat/completions', 'https://api.two.example.com/chat/completions'], 'both workers must have received exactly one call each');
});

test('a workerId pins the request to that one worker, even though another one is idle and would otherwise be picked', async () => {
    const { engine, modelsCore, calls } = buildEngineWithModelsCore();
    modelsCore.configureWorkers([
        { id: 'w1', endpoint: 'https://api.one.example.com', model: 'model-1', format: 'openai' },
        { id: 'w2', endpoint: 'https://api.two.example.com', model: 'model-2', format: 'openai' },
    ]);
    const module = engine.registerCaller('module.writer', 'modules', { tier: 'official' });

    const result = await new Promise(resolve => module.cores.subscribe('model.generate', { params: { prompt: 'hi', workerId: 'w2' } }, resolve));

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.two.example.com/chat/completions');
});

test('a workerId naming a worker that isn\'t configured fails the same way as "no worker at all" — never silently falls back to the pool', async () => {
    const { engine, modelsCore, calls } = buildEngineWithModelsCore();
    modelsCore.configureWorkers([{ id: 'w1', endpoint: 'https://api.one.example.com', model: 'model-1', format: 'openai' }]);
    const module = engine.registerCaller('module.writer', 'modules', { tier: 'official' });

    const result = await new Promise(resolve => module.cores.subscribe('model.generate', { params: { prompt: 'hi', workerId: 'does-not-exist' } }, resolve));

    assert.equal(result.ok, false);
    assert.match(result.error.message, /No worker is available/);
    assert.equal(calls.length, 0);
});

test('configureWorkers() with no workers yields a clear "no worker" failure through the normal error envelope, not a hang', async () => {
    const { engine, modelsCore } = buildEngineWithModelsCore();
    modelsCore.configureWorkers([]);

    const module = engine.registerCaller('module.writer', 'modules', { tier: 'official' });
    const result = await new Promise(resolve => module.cores.subscribe('model.generate', { params: { prompt: 'hi' } }, resolve));

    assert.equal(result.ok, false);
    assert.match(result.error.message, /No worker is available/);
});

test('a non-2xx HTTP reply surfaces as a normal model.generate failure, naming the worker and the status', async () => {
    const engine = createEngine();
    registerHttpService(engine.buses.network, {
        fetch: async () => ({ status: 500, ok: false, headers: { entries: () => [] }, text: async () => 'server error' }),
    });
    const settingsContext = { extensionSettings: {}, saveSettingsDebounced: () => {} };
    registerExtensionSettingsService(engine.buses.services, { getContext: () => settingsContext });
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));
    const modelsHost = engine.registerCaller('core.models.internal', 'cores', { tier: 'official', networkAccess: true });
    const modelsCore = createInternalEngineModelsCore(modelsHost);
    modelsCore.configureWorkers([{ id: 'w1', endpoint: 'https://api.example.com', model: 'gpt-test', format: 'openai' }]);

    const module = engine.registerCaller('module.writer', 'modules', { tier: 'official' });
    const result = await new Promise(resolve => module.cores.subscribe('model.generate', { params: { prompt: 'hi' } }, resolve));

    assert.equal(result.ok, false);
    assert.match(result.error.message, /w1/);
    assert.match(result.error.message, /500/);
});

test('registering the Ядро without networkAccess means every model.generate call fails at the network Gate — never reaches fetch at all', async () => {
    const { engine, calls, modelsCore } = buildEngineWithModelsCore({ networkAccess: false });
    modelsCore.configureWorkers([{ id: 'w1', endpoint: 'https://api.example.com', model: 'gpt-test', format: 'openai' }]);

    const module = engine.registerCaller('module.writer', 'modules', { tier: 'official' });
    const result = await new Promise(resolve => module.cores.subscribe('model.generate', { params: { prompt: 'hi' } }, resolve));

    assert.equal(result.ok, false);
    assert.match(result.error.message, /no network access/);
    assert.equal(calls.length, 0, 'fetch must never be reached without networkAccess granted to the Ядро itself');
});

test('a Module without the right to model.generate is refused before the Ядро — and fetch — are ever reached', async () => {
    const { engine, calls, modelsCore } = buildEngineWithModelsCore();
    modelsCore.configureWorkers([{ id: 'w1', endpoint: 'https://api.example.com', model: 'gpt-test', format: 'openai' }]);

    const module = engine.registerCaller('module.untrusted', 'modules', { tier: 'community', allowedContracts: [] });
    const result = await new Promise(resolve => module.cores.subscribe('model.generate', { params: { prompt: 'hi' } }, resolve));

    assert.equal(result.ok, false);
    assert.equal(calls.length, 0);
});

test('worker config really persists via storage.settings — restoreWorkers() on a FRESH Ядро instance recovers what a previous one configured, simulating a reload', async () => {
    const { engine } = buildEngineWithModelsCore();
    const firstInstance = createInternalEngineModelsCore(engine.registerCaller('core.models.internal.first', 'cores', { tier: 'official', networkAccess: true }));
    await firstInstance.configureWorkers([{ id: 'persisted-worker', endpoint: 'https://api.example.com', model: 'gpt-test', format: 'openai' }]);

    // A brand new Ядро instance (a different callerId, standing in for "the
    // engine rebuilt this Ядро fresh on a reload") — nothing hands it the
    // config directly; it only shares the SAME underlying storage.settings.
    const secondInstance = createInternalEngineModelsCore(engine.registerCaller('core.models.internal.second', 'cores', { tier: 'official', networkAccess: true }));
    const restored = await secondInstance.restoreWorkers();

    assert.deepEqual(restored, [{ id: 'persisted-worker', endpoint: 'https://api.example.com', model: 'gpt-test', format: 'openai' }]);
});
