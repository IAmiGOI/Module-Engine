import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { request } from '../libraries/shared/request.js';
import { registerStChatService } from '../services/st-chat.js';
import { registerChatMetadataService } from '../services/chat-metadata.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { createSettingsCore } from '../cores/settings/index.js';
import { createChatMemoryCore } from '../cores/memory/index.js';
import { createChatHistoryCore } from '../cores/chat-history/index.js';
import { createBasicSummaryCore } from '../cores/summary/index.js';
import { createDecisionCore } from '../cores/decision/index.js';

/**
 * e6: Forced Memory на реальном Ядре саммари. Подделан только слой Сервисов
 * и `model.generate` — свёртка, история и очередь саммари настоящие.
 */

function makeChat(count) {
    return Array.from({ length: count }, (_, index) => ({
        is_user: index % 2 === 0, is_system: false, name: index % 2 === 0 ? 'Player' : 'Character',
        mes: `line ${index}`, send_date: `2024-01-01 @${String(index).padStart(2, '0')}h`,
    }));
}

async function buildSummary({ forceReply } = {}) {
    const engine = createEngine();
    const context = { chat: makeChat(6), saveChat: async () => {} };
    registerStChatService(engine.buses.services, { getContext: () => context });
    registerChatMetadataService(engine.buses.services, { getContext: () => context });
    registerExtensionSettingsService(engine.buses.services, { getContext: () => ({ extensionSettings: {}, saveSettingsDebounced: () => {} }) });
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));
    createChatMemoryCore(engine.registerCaller('core.memory.chat', 'cores', { tier: 'official' }));
    createChatHistoryCore(engine.registerCaller('core.chatHistory', 'cores', { tier: 'official' }));
    let index = 0;
    engine.buses.cores.register('model.generate', async () => `summary ${++index}`);
    if (forceReply) engine.buses.cores.register('decision.forcedMemory', async ({ batch }) => ({ keep: forceReply(batch) }));
    const summaryCore = createBasicSummaryCore(engine.registerCaller('core.summary', 'cores', { tier: 'official' }));
    const probe = engine.registerCaller('probe.summary', 'cores', { tier: 'official' });
    await request(probe.own, 'summary.configure', { params: { levels: [{ batchSize: 2 }, { batchSize: 2 }], protectedWindow: 1, structuredFold: false, verifyEnabled: false } });
    return { engine, summaryCore, probe };
}

test('Forced Memory keeps the chosen summary active and folds the rest, then the flag can be released', async () => {
    const { summaryCore, probe } = await buildSummary({ forceReply: batch => [batch[0].id] });
    await summaryCore.checkAndFold();
    const active = summaryCore.list();
    const level1 = active.filter(record => record.level === 1);
    const level2 = active.filter(record => record.level === 2);
    assert.equal(level1.length, 1, 'the kept level-1 summary stays');
    assert.equal(level1[0].forced, true);
    assert.equal(level2.length, 1, 'the other child folded into a level-2 summary');

    const released = await request(probe.own, 'summary.force', { params: { id: level1[0].id, forced: false } });
    assert.equal(released.value.forced, false);
});

test('without the decision contract the fold is exactly as before: both level-1 summaries fold into one', async () => {
    const { summaryCore } = await buildSummary();
    await summaryCore.checkAndFold();
    const active = summaryCore.list();
    assert.equal(active.filter(record => record.level === 1).length, 0);
    assert.equal(active.filter(record => record.level === 2).length, 1);
    assert.equal(active.some(record => record.forced), false);
});

test('the decision core answers forced memory with the director model when on, and with an empty list without a model when off', async () => {
    const engine = createEngine();
    const settings = new Map();
    const memory = new Map();
    const key = (namespace, name) => `${namespace}:${name}`;
    const clone = value => JSON.parse(JSON.stringify(value));
    const calls = [];
    engine.buses.cores.register('storage.settings.get', ({ namespace, key: name, fallback }) => settings.has(key(namespace, name)) ? clone(settings.get(key(namespace, name))) : fallback);
    engine.buses.cores.register('storage.settings.set', ({ namespace, key: name, value }) => { settings.set(key(namespace, name), clone(value)); return true; });
    engine.buses.cores.register('storage.chatMemory.get', ({ namespace, key: name, fallback }) => memory.has(key(namespace, name)) ? clone(memory.get(key(namespace, name))) : fallback);
    engine.buses.cores.register('storage.chatMemory.set', ({ namespace, key: name, value }) => { memory.set(key(namespace, name), clone(value)); return true; });
    engine.buses.cores.register('model.workers.get', () => [{ id: 'director', format: 'openai' }]);
    engine.buses.cores.register('summary.list', () => []);
    engine.buses.cores.register('ui.notify', () => true);
    engine.buses.cores.register('model.generate', async params => { calls.push(params); return JSON.stringify({ keep: ['s1'] }); });
    const core = createDecisionCore(engine.registerCaller('core.decision', 'cores', { tier: 'official' }), { retryDelayMs: 0 });
    await core.load();
    const host = engine.registerCaller('probe.e6', 'cores', { tier: 'official' });
    const off = await request(host.own, 'decision.forcedMemory', { params: { batch: [{ id: 's1', text: 'a' }, { id: 's2', text: 'b' }] } });
    assert.deepEqual(off.value, { keep: [] });
    assert.equal(calls.length, 0, 'the core is off, so no model call');

    await core.configure({ enabled: true, decider: { workerId: 'director' } });
    const on = await request(host.own, 'decision.forcedMemory', { params: { batch: [{ id: 's1', text: 'a' }, { id: 's2', text: 'b' }] } });
    assert.deepEqual(on.value, { keep: ['s1'] });
    assert.equal(calls.length, 1);
    assert.match(calls[0].prompt, /s1/);
});
