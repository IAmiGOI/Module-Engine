import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { request } from '../libraries/shared/request.js';
import { registerHttpService } from '../services/http.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { createSettingsCore } from '../cores/settings/index.js';
import { createInternalEngineModelsCore } from '../cores/models/internal-engine.js';

/** `replies[host]` — статус ответа для этого хоста (200 по умолчанию); `calls` — все запросы по порядку. */
function build({ replies = {}, settingsContext = { extensionSettings: {}, saveSettingsDebounced: () => {} }, now = () => Date.now(), timers, services } = {}) {
    const engine = createEngine();
    const calls = [];
    registerHttpService(engine.buses.network, {
        fetch: async (url, init) => {
            calls.push({ url, ...init });
            const status = replies[new URL(url).host] ?? 200;
            if (status === 'hang') return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
            return { status, ok: status < 400, headers: { entries: () => [] }, text: async () => JSON.stringify({ choices: [{ message: { content: `reply ${status}` } }] }) };
        },
    });
    registerExtensionSettingsService(engine.buses.services, { getContext: () => settingsContext });
    services?.(engine.buses.services);
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));
    const events = [];
    const host = engine.registerCaller('core.models.internal', 'cores', { tier: 'official', networkAccess: true });
    const core = createInternalEngineModelsCore(host, { workerWaitMs: 0, now, timers, publish: (event, payload) => events.push({ event, payload }) });
    const module = engine.registerCaller('module.writer', 'modules', { tier: 'official' });
    const call = (contract, params) => request(module.cores, contract, { params });
    return { core, calls, events, call, settingsContext };
}

const worker = (id, extra = {}) => ({ id, endpoint: `https://${id}.example.com/v1`, model: 'm', format: 'openai', ...extra });
const statusOf = async (call, id) => (await call('model.workers.status')).value.find(entry => entry.workerId === id);

test('a 503 from a worker is counted as unavailability in model.workers.status and announced as a status change', async () => {
    const { core, call, events } = build({ replies: { 'bad.example.com': 503 } });
    await core.configureWorkers([worker('bad')]);

    const result = await call('model.generate', { prompt: 'x', stream: false });

    assert.equal(result.ok, false);
    const status = await statusOf(call, 'bad');
    assert.equal(status.totals.unavailable, 1);
    assert.match(status.lastError.message, /HTTP 503/);
    assert.ok(events.some(item => item.event === 'model.workers.status.changed'));
});

test('once a worker is down, unpinned requests go to the healthy worker instead', async () => {
    const { core, call, calls } = build({ replies: { 'bad.example.com': 500 } });
    await core.configureWorkers([worker('bad'), worker('good')]);
    for (let index = 0; index < 3; index += 1) await call('model.generate', { prompt: 'x', stream: false, workerId: 'bad' });
    calls.length = 0;

    for (let index = 0; index < 4; index += 1) assert.equal((await call('model.generate', { prompt: 'x', stream: false })).ok, true);

    assert.equal((await statusOf(call, 'bad')).state, 'down');
    assert.ok(calls.every(item => item.url.includes('good.example.com')));
});

test('an attempt that runs past stallMs is aborted and counted as the worker being unavailable', async () => {
    const { core, call, calls } = build({ replies: { 'slow.example.com': 'hang' } });
    await core.configureWorkers([worker('slow')]);

    const result = await call('model.generate', { prompt: 'x', stream: false, stallMs: 20, restartOnStall: false });

    assert.equal(result.ok, false);
    assert.equal(calls[0].signal.aborted, true, 'the HTTP request itself was cancelled, not left running');
    assert.equal((await statusOf(call, 'slow')).totals.unavailable, 1);
});

test('model.workers.probe sends one small non-streaming request and records when the worker was checked', async () => {
    let clock = 1000;
    const { core, call, calls } = build({ now: () => clock });
    await core.configureWorkers([worker('w')]);

    const result = await call('model.workers.probe', { workerId: 'w' });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].body);
    assert.notEqual(body.stream, true);
    assert.ok(body.max_tokens <= 16);
    assert.equal(result.value[0].state, 'up');
    assert.equal(result.value[0].lastProbeAt, 1000);
});

test('the ten-minute check probes only workers with no traffic in that interval', async () => {
    let clock = 0;
    let tick = null;
    const timers = { setInterval: fn => { tick = fn; return 1; }, clearInterval: () => {}, setTimeout: () => 2, clearTimeout: () => {} };
    const { core, call, calls } = build({ now: () => clock, timers });
    await core.configureWorkers([worker('busy'), worker('idle')]);
    core.startMonitoring();
    clock = 9 * 60 * 1000;
    await call('model.generate', { prompt: 'x', stream: false, workerId: 'busy' });
    calls.length = 0;

    clock = 11 * 60 * 1000;
    await tick();

    assert.deepEqual(calls.map(item => new URL(item.url).host), ['idle.example.com']);
    core.unregister();
});

test('worker statistics are saved and come back after a reload', async () => {
    const settingsContext = { extensionSettings: {}, saveSettingsDebounced: () => {} };
    let flushSave = null;
    const timers = { setInterval: () => 1, clearInterval: () => {}, setTimeout: fn => { flushSave = fn; return 2; }, clearTimeout: () => {} };
    const first = build({ replies: { 'bad.example.com': 502 }, settingsContext, timers });
    await first.core.configureWorkers([worker('bad')]);
    await first.call('model.generate', { prompt: 'x', stream: false });
    await flushSave();

    const second = build({ settingsContext });
    await second.core.restoreWorkers();

    assert.equal((await statusOf(second.call, 'bad')).totals.unavailable, 1);
});

test('a SillyTavern main connection worker is served by ST\'s own backend through stGeneration.direct, not by HTTP to an endpoint', async () => {
    const seen = [];
    const { core, call, calls } = build({
        services: bus => bus.register('stGeneration.direct', params => { seen.push(params); return { ok: true, status: 200, text: 'from ST' }; }),
    });
    await core.configureWorkers([{ id: 'st-main', format: 'sillytavern' }]);

    const result = await call('model.generate', { prompt: 'hi', systemPrompt: 'sys', maxTokens: 12 });

    assert.deepEqual(result, { ok: true, value: 'from ST' });
    assert.equal(calls.length, 0);
    assert.equal(seen[0].prompt, 'hi');
    assert.equal(seen[0].maxTokens, 12);
});
