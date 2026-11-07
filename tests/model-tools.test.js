import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerHttpService } from '../services/http.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { createSettingsCore } from '../cores/settings/index.js';
import { createInternalEngineModelsCore } from '../cores/models/internal-engine.js';

/**
 * e0: `tools`/`tool_calls` в `model.generate` — opt-in и не ломает нынешних
 * вызывающих. Доказывает весь путь до фейкового HTTP: тело с инструментами,
 * разбор `tool_calls` из ответа и прежнюю строку для тех, кто флага не просил.
 */

function buildEngineWithModelsCore(reply) {
    const engine = createEngine();
    const calls = [];
    const fetch = async (url, init) => {
        calls.push({ url, ...init });
        return { status: 200, ok: true, headers: { entries: () => [] }, text: async () => JSON.stringify(reply) };
    };
    registerHttpService(engine.buses.network, { fetch });
    const settingsContext = { extensionSettings: {}, saveSettingsDebounced: () => {} };
    registerExtensionSettingsService(engine.buses.services, { getContext: () => settingsContext });
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));
    const modelsCore = createInternalEngineModelsCore(engine.registerCaller('core.models.internal', 'cores', { tier: 'official', networkAccess: true }), { workerWaitMs: 0 });
    return { engine, calls, modelsCore };
}

const WORKER = { id: 'w1', endpoint: 'https://api.example.com/v1', apiKey: 'sk-1', model: 'gpt-test', format: 'openai' };

test('model.generate with returnMessage and tools sends the tools and gives back parsed tool_calls', async () => {
    const { engine, calls, modelsCore } = buildEngineWithModelsCore({
        choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'inscribe', arguments: '{"scene":{"minutes":5}}' } }] } }],
    });
    modelsCore.configureWorkers([WORKER]);
    const host = engine.registerCaller('core.decision', 'cores', { tier: 'official' });

    const result = await new Promise(resolve => host.own.subscribe('model.generate', {
        params: {
            workerId: 'w1', stream: false, returnMessage: true,
            messages: [{ role: 'user', content: 'decide' }],
            tools: [{ name: 'inscribe', description: 'Submit the form', parameters: { type: 'object', properties: {} } }],
            toolChoice: 'auto',
        },
    }, resolve));

    assert.equal(result.ok, true);
    assert.deepEqual(result.value.toolCalls, [{ id: 'call_1', name: 'inscribe', arguments: { scene: { minutes: 5 } }, rawArguments: '{"scene":{"minutes":5}}' }]);
    const body = JSON.parse(calls[0].body);
    assert.equal(body.tools[0].function.name, 'inscribe');
    assert.equal(body.tool_choice, 'auto');
});

test('model.generate without returnMessage still returns a plain string and sends no tools key', async () => {
    const { engine, calls, modelsCore } = buildEngineWithModelsCore({ choices: [{ message: { content: 'a plain reply' } }] });
    modelsCore.configureWorkers([WORKER]);
    const host = engine.registerCaller('core.decision', 'cores', { tier: 'official' });

    const result = await new Promise(resolve => host.own.subscribe('model.generate', { params: { workerId: 'w1', stream: false, prompt: 'hi' } }, resolve));

    assert.deepEqual(result, { ok: true, value: 'a plain reply' });
    assert.equal('tools' in JSON.parse(calls[0].body), false);
});
