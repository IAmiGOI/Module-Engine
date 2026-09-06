import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerHttpService } from '../services/http.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { createInternalEngineModelsCore, resolveGenerateRequest, clampSamplerSettings, clampReasoningSettings, SAMPLER_PRESETS, REASONING_MODES, REASONING_EFFORTS, slugifyPresetName, buildCustomPreset } from '../cores/models/internal-engine.js';
import { createSettingsCore } from '../cores/settings/index.js';

// --- Чистые функции: пресеты и защитное чтение сэмплера ---------------------

test('every sampler preset stays inside the same bounds clampSamplerSettings enforces — a preset is a shortcut INTO the valid range, never a way around it', () => {
    for (const preset of SAMPLER_PRESETS) {
        assert.deepEqual(clampSamplerSettings(preset), {
            temperature: preset.temperature, topP: preset.topP, topK: preset.topK, maxTokens: preset.maxTokens,
        }, `preset "${preset.id}" survives clamping unchanged`);
    }
});

test('clampSamplerSettings() keeps garbage on disk from ever reaching a provider as-is', () => {
    assert.deepEqual(clampSamplerSettings({ temperature: -5, topP: 'x', topK: 9999, maxTokens: 0 }),
        { temperature: 0, topP: 1, topK: 200, maxTokens: 1 });
});

test('clampSamplerSettings() with nothing at all falls back to the engine defaults, not to zero', () => {
    assert.deepEqual(clampSamplerSettings(), { temperature: 0.7, topP: 1, topK: 0, maxTokens: 1000 });
});

test('resolveGenerateRequest() uses the WORKER\'s own sampler settings as the default — not one hardcoded value for the whole engine', () => {
    const worker = { temperature: 0.2, topP: 0.9, topK: 5, maxTokens: 256 };

    const resolved = resolveGenerateRequest({ prompt: 'hi' }, worker);

    assert.equal(resolved.temperature, 0.2);
    assert.equal(resolved.topP, 0.9);
    assert.equal(resolved.topK, 5);
    assert.equal(resolved.maxTokens, 256);
});

test('resolveGenerateRequest() still lets an explicit per-call value win over the worker\'s own default — existing pinning behaviour must not regress', () => {
    const worker = { temperature: 0.2 };

    const resolved = resolveGenerateRequest({ prompt: 'hi', temperature: 1.5 }, worker);

    assert.equal(resolved.temperature, 1.5);
});

test('resolveGenerateRequest() falls back to the engine defaults for a worker with no sampler settings of its own yet — a freshly added connection, no preset applied', () => {
    const resolved = resolveGenerateRequest({ prompt: 'hi' }, { id: 'fresh' });

    assert.equal(resolved.temperature, 0.7);
    assert.equal(resolved.maxTokens, 1000);
});

// --- Ризонинг: та же механика, отдельные поля ------------------------------

test('every sampler preset also carries a valid reasoning triple — the preset is one coherent starting point, not sampler-only', () => {
    for (const preset of SAMPLER_PRESETS) {
        assert.ok(REASONING_MODES.includes(preset.reasoningMode), `preset "${preset.id}" has a real reasoningMode`);
        assert.ok(REASONING_EFFORTS.includes(preset.reasoningEffort), `preset "${preset.id}" has a real reasoningEffort`);
        assert.ok(Number.isFinite(preset.reasoningBudget), `preset "${preset.id}" has a real reasoningBudget`);
    }
});

test('the tracker-oriented presets turn reasoning OFF on purpose — a strict-JSON task gains nothing from a reasoning model thinking longer', () => {
    const deterministic = SAMPLER_PRESETS.find(item => item.id === 'deterministic');
    const precise = SAMPLER_PRESETS.find(item => item.id === 'precise');

    assert.equal(deterministic.reasoningMode, 'disabled');
    assert.equal(precise.reasoningMode, 'disabled');
});

test('clampReasoningSettings() rejects an unknown mode/effort instead of passing it through to a provider', () => {
    assert.deepEqual(clampReasoningSettings({ reasoningMode: 'yolo', reasoningEffort: 'extreme', reasoningBudget: -50 }),
        { reasoningMode: 'inherit', reasoningEffort: 'medium', reasoningBudget: 0 });
});

test('clampReasoningSettings() with nothing at all defaults to "inherit" — silence, not an opinion the engine never asked for', () => {
    assert.deepEqual(clampReasoningSettings(), { reasoningMode: 'inherit', reasoningEffort: 'medium', reasoningBudget: 0 });
});

test('resolveGenerateRequest() reads reasoning settings from the WORKER, same as the sampler ones', () => {
    const worker = { reasoningMode: 'enabled', reasoningEffort: 'high', reasoningBudget: 2000 };

    const resolved = resolveGenerateRequest({ prompt: 'hi' }, worker);

    assert.equal(resolved.reasoningMode, 'enabled');
    assert.equal(resolved.reasoningEffort, 'high');
    assert.equal(resolved.reasoningBudget, 2000);
});

test('resolveGenerateRequest() still lets an explicit per-call reasoning override win over the worker\'s own default', () => {
    const worker = { reasoningMode: 'disabled' };

    const resolved = resolveGenerateRequest({ prompt: 'hi', reasoningMode: 'enabled' }, worker);

    assert.equal(resolved.reasoningMode, 'enabled');
});

// --- Свои пресеты: id из имени, форма пресета -------------------------------

test('slugifyPresetName() turns a name into a stable id, prefixed so it can never collide with a built-in preset', () => {
    assert.equal(slugifyPresetName('Strict Tracker JSON'), 'custom:strict-tracker-json');
    assert.equal(slugifyPresetName('  extra   spaces  '), 'custom:extra-spaces');
});

test('slugifyPresetName() with no usable name at all yields no id — nothing to save under', () => {
    assert.equal(slugifyPresetName(''), '');
    assert.equal(slugifyPresetName('   '), '');
    assert.equal(slugifyPresetName(undefined), '');
});

test('the SAME name always slugifies to the SAME id — saving under a name already in use updates that preset instead of duplicating it', () => {
    assert.equal(slugifyPresetName('Precise JSON'), slugifyPresetName('Precise JSON'));
});

test('buildCustomPreset() carries the exact sampler/reasoning values given, clamped the same way a worker\'s would be, and is marked custom', () => {
    const preset = buildCustomPreset('My Preset', { temperature: 0.33, topP: 0.5, topK: 10, maxTokens: 512, reasoningMode: 'enabled', reasoningEffort: 'high', reasoningBudget: 4000 });

    assert.equal(preset.id, 'custom:my-preset');
    assert.equal(preset.name, 'My Preset');
    assert.equal(preset.custom, true);
    assert.equal(preset.temperature, 0.33);
    assert.equal(preset.reasoningMode, 'enabled');
    assert.equal(preset.reasoningBudget, 4000);
});

test('buildCustomPreset() clamps garbage exactly like clampSamplerSettings/clampReasoningSettings would — a custom preset is not a way around the same bounds', () => {
    const preset = buildCustomPreset('Sloppy', { temperature: -5, topK: 9999, reasoningMode: 'yolo' });

    assert.equal(preset.temperature, 0);
    assert.equal(preset.topK, 200);
    assert.equal(preset.reasoningMode, 'inherit');
});

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

test('a worker configured with a sampler preset actually sends THOSE values to the provider, not the engine-wide defaults', async () => {
    const { engine, modelsCore, calls } = buildEngineWithModelsCore();
    const preset = SAMPLER_PRESETS.find(item => item.id === 'creative');
    modelsCore.configureWorkers([{ id: 'w1', endpoint: 'https://api.example.com/v1', model: 'gpt-test', format: 'openai', preset: preset.id, temperature: preset.temperature, topP: preset.topP, topK: preset.topK, maxTokens: preset.maxTokens }]);
    const module = engine.registerCaller('module.writer', 'modules', { tier: 'official' });

    const result = await new Promise(resolve => module.cores.subscribe('model.generate', { params: { prompt: 'hello' } }, resolve));

    assert.equal(result.ok, true);
    const body = JSON.parse(calls[0].body);
    assert.equal(body.temperature, preset.temperature);
    assert.equal(body.top_p, preset.topP);
    assert.equal(body.max_tokens, preset.maxTokens);
});

test('two workers with DIFFERENT presets each keep their own sampler settings — one is not bleeding into the other', async () => {
    const { engine, modelsCore, calls } = buildEngineWithModelsCore();
    const precise = SAMPLER_PRESETS.find(item => item.id === 'precise');
    const creative = SAMPLER_PRESETS.find(item => item.id === 'creative');
    modelsCore.configureWorkers([
        { id: 'w1', endpoint: 'https://api.one.example.com', model: 'm1', format: 'openai', temperature: precise.temperature, topP: precise.topP, topK: precise.topK, maxTokens: precise.maxTokens },
        { id: 'w2', endpoint: 'https://api.two.example.com', model: 'm2', format: 'openai', temperature: creative.temperature, topP: creative.topP, topK: creative.topK, maxTokens: creative.maxTokens },
    ]);
    const module = engine.registerCaller('module.writer', 'modules', { tier: 'official' });
    const generate = workerId => new Promise(resolve => module.cores.subscribe('model.generate', { params: { prompt: 'hi', workerId } }, resolve));

    await generate('w1');
    await generate('w2');

    const byWorker = Object.fromEntries(calls.map(call => [call.url, JSON.parse(call.body).temperature]));
    assert.equal(byWorker['https://api.one.example.com/chat/completions'], precise.temperature);
    assert.equal(byWorker['https://api.two.example.com/chat/completions'], creative.temperature);
});

test('a worker configured with reasoning enabled actually sends it to a REAL OpenRouter endpoint through the full chain', async () => {
    const { engine, modelsCore, calls } = buildEngineWithModelsCore();
    modelsCore.configureWorkers([{
        id: 'w1', endpoint: 'https://openrouter.ai/api/v1', model: 'm1', format: 'openai',
        reasoningMode: 'enabled', reasoningEffort: 'high', reasoningBudget: 2000,
    }]);
    const module = engine.registerCaller('module.writer', 'modules', { tier: 'official' });

    const result = await new Promise(resolve => module.cores.subscribe('model.generate', { params: { prompt: 'hello' } }, resolve));

    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(calls[0].body).reasoning, { enabled: true, effort: 'high', max_tokens: 2000 });
});

// --- Свои пресеты: контракты + событие --------------------------------------

test('model.presets.set saves a custom preset, and model.presets.get reads it straight back through the real Гейт', async () => {
    const { engine, modelsCore } = buildEngineWithModelsCore();
    const module = engine.registerCaller('module.writer', 'modules', { tier: 'community', allowedContracts: ['model.presets.get', 'model.presets.set'] });

    await modelsCore.configurePresets([{ name: 'Strict JSON', temperature: 0.1, maxTokens: 200 }]);
    const result = await new Promise(resolve => module.cores.subscribe('model.presets.get', {}, resolve));

    assert.equal(result.ok, true);
    assert.equal(result.value.length, 1);
    assert.equal(result.value[0].id, 'custom:strict-json');
    assert.equal(result.value[0].name, 'Strict JSON');
    assert.equal(result.value[0].custom, true);
    assert.equal(result.value[0].temperature, 0.1);
});

test('a preset with no name is dropped rather than saved as junk nobody can select', async () => {
    const { engine, modelsCore } = buildEngineWithModelsCore();
    const module = engine.registerCaller('module.writer', 'modules', { tier: 'community', allowedContracts: ['model.presets.get'] });

    await modelsCore.configurePresets([{ name: '   ', temperature: 0.5 }, { name: 'Real One' }]);
    const result = await new Promise(resolve => module.cores.subscribe('model.presets.get', {}, resolve));

    assert.deepEqual(result.value.map(item => item.name), ['Real One']);
});

test('configureWorkers() announces model.workers.changed — a Module\'s worker dropdown can refresh without a page reload', async () => {
    const { engine, modelsCore } = buildEngineWithModelsCore();
    const seen = [];
    engine.events.subscribe('model.workers.changed', payload => seen.push(payload));

    await modelsCore.configureWorkers([{ id: 'w1', endpoint: 'https://api.example.com', model: 'm', format: 'openai' }]);

    assert.deepEqual(seen, [{ count: 1 }]);
});

test('configurePresets() announces model.presets.changed — a sibling screen (the other Module) can refresh without a page reload', async () => {
    const { engine, modelsCore } = buildEngineWithModelsCore();
    const seen = [];
    engine.events.subscribe('model.presets.changed', payload => seen.push(payload));

    await modelsCore.configurePresets([{ name: 'One' }, { name: 'Two' }]);

    assert.deepEqual(seen, [{ count: 2 }]);
});

test('custom presets really persist via storage.settings — restorePresets() on a FRESH Ядро instance recovers what a previous one saved', async () => {
    const { engine } = buildEngineWithModelsCore();
    const firstInstance = createInternalEngineModelsCore(engine.registerCaller('core.models.internal.first', 'cores', { tier: 'official', networkAccess: true }));
    await firstInstance.configurePresets([{ name: 'Persisted Preset', temperature: 0.15 }]);

    const secondInstance = createInternalEngineModelsCore(engine.registerCaller('core.models.internal.second', 'cores', { tier: 'official', networkAccess: true }));
    const restored = await secondInstance.restorePresets();

    assert.equal(restored.length, 1);
    assert.equal(restored[0].id, 'custom:persisted-preset');
    assert.equal(restored[0].temperature, 0.15);
});
