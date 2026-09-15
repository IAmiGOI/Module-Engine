import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { registerChatMetadataService } from '../services/chat-metadata.js';
import { registerStChatService } from '../services/st-chat.js';
import { createSettingsCore } from '../cores/settings/index.js';
import { createChatMemoryCore } from '../cores/memory/index.js';
import { createChatHistoryCore } from '../cores/chat-history/index.js';
import { createPipelineCore } from '../cores/pipeline/index.js';
import { createMapCore } from '../cores/map/index.js';
import { createMapNarrationCore } from '../cores/map-narration/index.js';

const BEFORE_SEND_PIPELINE = 'generation.beforeSend';

/** Scenario level (TESTING.md) — real engine/Гейты/pipeline; only ST-facing `getContext()` is faked. */
function buildEngine() {
    const engine = createEngine();
    const settingsContext = {
        extensionSettings: {}, chatMetadata: {}, saveSettingsDebounced: () => {}, saveMetadataDebounced: () => {}, chat: [],
    };
    registerExtensionSettingsService(engine.buses.services, { getContext: () => settingsContext });
    registerChatMetadataService(engine.buses.services, { getContext: () => settingsContext });
    registerStChatService(engine.buses.services, { getContext: () => settingsContext });
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));
    createChatMemoryCore(engine.registerCaller('core.memory.chat', 'cores', { tier: 'official' }));
    createChatHistoryCore(engine.registerCaller('core.chatHistory', 'cores', { tier: 'official' }));

    const mapCore = createMapCore(engine.registerCaller('core.map', 'cores', { tier: 'official' }));

    const pipelineCore = createPipelineCore(engine.registerCaller('core.pipeline', 'cores', { tier: 'official' }), { resolveAs: engine.resolveAs });
    pipelineCore.define({ id: BEFORE_SEND_PIPELINE, mode: 'collect' });

    const narrationCore = createMapNarrationCore(engine.registerCaller('core.mapNarration', 'cores', { tier: 'official' }));

    const moduleHost = engine.registerCaller('test.direct', 'modules', {
        tier: 'community',
        allowedContracts: ['map.nodes.create', 'map.edges.create', 'map.position.set', 'map.settings.update'],
    });
    const call = (contract, params) => new Promise(resolve => moduleHost.cores.subscribe(contract, { params }, resolve));

    /**
     * `chatHistory.messages` (read by `injectRoute()`) reads `settingsContext.chat`
     * — a DIFFERENT array from whatever local `chat` a test hands directly to
     * `injectRoute({chat})`/`pipelineCore.run({input:{chat}})`. `seedChat()`
     * builds one raw-ST-shaped array and installs it as BOTH at once, so the
     * Core's own read and the test's own mutation target are the same array.
     */
    function seedChat(...texts) {
        const chat = texts.map(text => ({ is_user: false, is_system: false, mes: text }));
        settingsContext.chat = chat;
        return chat;
    }

    return { engine, settingsContext, mapCore, pipelineCore, narrationCore, call, seedChat };
}

/** Two touching polygons — the same "auto-adjacent" recipe map-core.test.js already uses, guaranteeing a real, pathfindable edge. */
async function seedTwoAdjacentLocations(call) {
    const left = [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 1 }, { x: 0, y: 1 }];
    const right = [{ x: 0.5, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0.5, y: 1 }];
    const a = await call('map.nodes.create', { name: 'Tavern', polygon: left });
    const b = await call('map.nodes.create', { name: 'Market Square', polygon: right });
    return { a: a.value, b: b.value };
}

test('injectRoute() does nothing when no position is tracked — nothing to route FROM', async () => {
    const { mapCore, narrationCore, call, seedChat } = buildEngine();
    await mapCore.restore();
    await narrationCore.load();
    await seedTwoAdjacentLocations(call);
    const chat = seedChat('We should head to the Market Square.');

    await narrationCore.injectRoute({ chat });

    assert.equal(chat.length, 1);
});

test('injectRoute() does nothing when no known location is mentioned in the recent messages', async () => {
    const { mapCore, narrationCore, call, seedChat } = buildEngine();
    await mapCore.restore();
    await narrationCore.load();
    const { a } = await seedTwoAdjacentLocations(call);
    await call('map.position.set', { nodeId: a.id });
    const chat = seedChat('A bird sings somewhere.');

    await narrationCore.injectRoute({ chat });

    assert.equal(chat.length, 1);
});

test('injectRoute() does nothing when the mentioned location IS the current position — already there', async () => {
    const { mapCore, narrationCore, call, seedChat } = buildEngine();
    await mapCore.restore();
    await narrationCore.load();
    const { a } = await seedTwoAdjacentLocations(call);
    await call('map.position.set', { nodeId: a.id });
    const chat = seedChat('You are standing in the Tavern.');

    await narrationCore.injectRoute({ chat });

    assert.equal(chat.length, 1);
});

test('injectRoute() does nothing when the mentioned location has no real route from the current position', async () => {
    const { mapCore, narrationCore, call, seedChat } = buildEngine();
    await mapCore.restore();
    await narrationCore.load();
    const start = await call('map.nodes.create', { name: 'Tavern', position: { x: 0, y: 0 } });
    await call('map.nodes.create', { name: 'Distant Ruin', position: { x: 0.9, y: 0.9 } }); // no edge, no auto-connect settings
    await call('map.position.set', { nodeId: start.value.id });
    const chat = seedChat('Legends speak of the Distant Ruin.');

    await narrationCore.injectRoute({ chat });

    assert.equal(chat.length, 1);
});

test('injectRoute() injects a real route when a known, reachable location is mentioned', async () => {
    const { mapCore, narrationCore, call, seedChat } = buildEngine();
    await mapCore.restore();
    await narrationCore.load();
    const { a } = await seedTwoAdjacentLocations(call);
    await call('map.position.set', { nodeId: a.id });
    const chat = seedChat('Let\'s go to the Market Square.');

    await narrationCore.injectRoute({ chat });

    assert.equal(chat.length, 2);
    const injected = chat.find(message => message.is_system);
    assert.ok(injected, 'a real system message was added');
    assert.match(injected.mes, /Tavern.*Market Square|Market Square.*Tavern/);
    assert.match(injected.mes, /World data/i, 'must be framed as world data, not a fact any character necessarily knows');
});

test('injectRoute() lands the injected message at the @4 depth, same computeInsertIndex convention as Notebook/Secrets/Summary', async () => {
    const { mapCore, narrationCore, call, seedChat } = buildEngine();
    await mapCore.restore();
    await narrationCore.load();
    const { a } = await seedTwoAdjacentLocations(call);
    await call('map.position.set', { nodeId: a.id });
    // 6 plain messages, mention on the last one.
    const chat = seedChat('one', 'two', 'three', 'four', 'five', 'Head to the Market Square now.');

    await narrationCore.injectRoute({ chat });

    assert.equal(chat.length, 7);
    // computeInsertIndex(6, 4) === 2 — right after "two", before "three".
    assert.equal(chat[2].is_system, true);
    assert.equal(chat[1].mes, 'two');
    assert.equal(chat[3].mes, 'three');
});

test('injectRoute() only scans the last 4 messages — an older mention outside that window is ignored', async () => {
    const { mapCore, narrationCore, call, seedChat } = buildEngine();
    await mapCore.restore();
    await narrationCore.load();
    const { a } = await seedTwoAdjacentLocations(call);
    await call('map.position.set', { nodeId: a.id });
    const chat = seedChat('Market Square was mentioned here, long ago.', 'two', 'three', 'four', 'five');

    await narrationCore.injectRoute({ chat });

    assert.equal(chat.length, 5, 'the mention is 5 messages back — outside the 4-message scan window');
});

test('the Core registers ITS OWN contract for the pipeline stage, under its own identity', async () => {
    const { narrationCore, pipelineCore } = buildEngine();
    await narrationCore.load();

    const stages = pipelineCore.stages(BEFORE_SEND_PIPELINE);

    assert.equal(stages.length, 1);
    assert.equal(stages[0].owner, 'core.mapNarration');
});

test('running the REAL beforeSend pipeline actually inserts the route — not just injectRoute() called directly', async () => {
    const { mapCore, narrationCore, pipelineCore, call, seedChat } = buildEngine();
    await mapCore.restore();
    await narrationCore.load();
    const { a } = await seedTwoAdjacentLocations(call);
    await call('map.position.set', { nodeId: a.id });
    const chat = seedChat('Time to visit the Market Square.');

    const result = await pipelineCore.run({ pipelineId: BEFORE_SEND_PIPELINE, input: { chat } });

    assert.equal(result.ok, true);
    assert.equal(chat.length, 2);
});

test('unregister() removes the pipeline stage — a torn-down Core leaves no trail', async () => {
    const { narrationCore, pipelineCore } = buildEngine();
    await narrationCore.load();
    assert.equal(pipelineCore.stages(BEFORE_SEND_PIPELINE).length, 1);

    await narrationCore.unregister();

    assert.equal(pipelineCore.stages(BEFORE_SEND_PIPELINE).length, 0);
});
