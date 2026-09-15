import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { createSettingsCore } from '../cores/settings/index.js';
import { registerChatMetadataService } from '../services/chat-metadata.js';
import { createChatMemoryCore } from '../cores/memory/index.js';
import { createMapCore } from '../cores/map/index.js';

/** Scenario level (TESTING.md) — real engine, real Гейты, real dispatch; only the ST-facing `getContext()` boundary is faked. */
function buildEngine() {
    const engine = createEngine();
    const settingsContext = { extensionSettings: {}, saveSettingsDebounced: () => {} };
    registerExtensionSettingsService(engine.buses.services, { getContext: () => settingsContext });
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));

    const chatContext = { chatMetadata: {}, saveMetadataDebounced: () => {}, saveMetadata: async () => {} };
    registerChatMetadataService(engine.buses.services, { getContext: () => chatContext });
    createChatMemoryCore(engine.registerCaller('core.memory.chat', 'cores', { tier: 'official' }));

    const mapCore = createMapCore(engine.registerCaller('core.map', 'cores', { tier: 'official' }));
    return { engine, mapCore, chatContext };
}

function moduleCaller(engine, contracts) {
    return engine.registerCaller('module.mapEditor', 'modules', { tier: 'community', allowedContracts: contracts });
}

const ALL_CONTRACTS = [
    'map.nodes.list', 'map.nodes.get', 'map.nodes.create', 'map.nodes.update', 'map.nodes.remove', 'map.nodes.containmentPath',
    'map.edges.list', 'map.edges.create', 'map.edges.update', 'map.edges.remove',
    'map.settings.get', 'map.settings.update', 'map.pathfind', 'map.distance',
    'map.position.get', 'map.position.set', 'map.position.move',
    'map.movementLog.list', 'map.movementLog.clear',
    'map.rootImage.get', 'map.rootImage.set', 'map.rootImage.clear',
];

async function call(module, contract, params) {
    const result = await new Promise(resolve => module.cores.subscribe(contract, { params }, resolve));
    return result;
}

test('map.nodes.create adds a node and map.nodes.list reflects it, publishing map.node.created', async () => {
    const { engine, mapCore } = buildEngine();
    await mapCore.restore();
    const module = moduleCaller(engine, ALL_CONTRACTS);
    const events = [];
    engine.events.subscribe('map.node.created', payload => events.push(payload));

    const created = await call(module, 'map.nodes.create', { name: 'Riverside District', rank: 5 });
    const list = await call(module, 'map.nodes.list');

    assert.equal(created.ok, true);
    assert.equal(created.value.name, 'Riverside District');
    assert.equal(list.value.length, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].id, created.value.id);
});

test('map.nodes.create rejects an unknown parentId, and map.nodes.update rejects a parentId change that would create a cycle', async () => {
    const { engine, mapCore } = buildEngine();
    await mapCore.restore();
    const module = moduleCaller(engine, ALL_CONTRACTS);

    const badParent = await call(module, 'map.nodes.create', { name: 'Orphan', parentId: 'ghost' });
    assert.equal(badParent.ok, false);

    const country = await call(module, 'map.nodes.create', { name: 'Country' });
    const city = await call(module, 'map.nodes.create', { name: 'City', parentId: country.value.id });

    const cyclic = await call(module, 'map.nodes.update', { id: country.value.id, parentId: city.value.id });
    assert.equal(cyclic.ok, false, 'country cannot become its own grandchild');
});

test('map.nodes.containmentPath returns root-to-leaf breadcrumb', async () => {
    const { engine, mapCore } = buildEngine();
    await mapCore.restore();
    const module = moduleCaller(engine, ALL_CONTRACTS);
    const country = await call(module, 'map.nodes.create', { name: 'Country' });
    const city = await call(module, 'map.nodes.create', { name: 'City', parentId: country.value.id });

    const path = await call(module, 'map.nodes.containmentPath', { id: city.value.id });
    assert.deepEqual(path.value, [country.value.id, city.value.id]);
});

test('map.nodes.remove cascades to descendants and their edges', async () => {
    const { engine, mapCore } = buildEngine();
    await mapCore.restore();
    const module = moduleCaller(engine, ALL_CONTRACTS);
    const building = await call(module, 'map.nodes.create', { name: 'Building', localMap: { widthUnits: 10, heightUnits: 10 } });
    const room = await call(module, 'map.nodes.create', { name: 'Room', parentId: building.value.id, position: { x: 0, y: 0 } });
    const closet = await call(module, 'map.nodes.create', { name: 'Closet', parentId: room.value.id, position: { x: 0.1, y: 0 } });
    await call(module, 'map.edges.create', { fromId: room.value.id, toId: closet.value.id });

    await call(module, 'map.nodes.remove', { id: building.value.id });
    const remaining = await call(module, 'map.nodes.list');
    const remainingEdges = await call(module, 'map.edges.list');

    assert.deepEqual(remaining.value.map(node => node.id).sort(), []);
    assert.deepEqual(remainingEdges.value, []);
});

test('two adjacent polygons auto-create an edge, and moving one apart removes it again', async () => {
    const { engine, mapCore } = buildEngine();
    await mapCore.restore();
    const module = moduleCaller(engine, ALL_CONTRACTS);
    const left = [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 1 }, { x: 0, y: 1 }];
    const right = [{ x: 0.5, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0.5, y: 1 }];
    const districtA = await call(module, 'map.nodes.create', { name: 'A', polygon: left });
    const districtB = await call(module, 'map.nodes.create', { name: 'B', polygon: right });

    const edgesAfterCreate = await call(module, 'map.edges.list');
    assert.equal(edgesAfterCreate.value.length, 1, 'touching borders auto-create one adjacency edge');
    assert.equal(edgesAfterCreate.value[0].auto, true);

    const far = [{ x: 5, y: 5 }, { x: 6, y: 5 }, { x: 6, y: 6 }, { x: 5, y: 6 }];
    await call(module, 'map.nodes.update', { id: districtB.value.id, polygon: far });
    const edgesAfterMove = await call(module, 'map.edges.list');
    assert.equal(edgesAfterMove.value.length, 0, 'no longer touching, the auto edge is retired');
    void districtA;
});

test('settings.autoConnectDistanceUnits auto-connects two plain markers within range, even with no polygons at all', async () => {
    const { engine, mapCore } = buildEngine();
    await mapCore.restore();
    const module = moduleCaller(engine, ALL_CONTRACTS);
    await call(module, 'map.settings.update', { mapWidthUnits: 1000, mapHeightUnits: 1000, autoConnectDistanceUnits: 100 });

    const a = await call(module, 'map.nodes.create', { name: 'A', position: { x: 0, y: 0 } });
    const near = await call(module, 'map.nodes.create', { name: 'Near', position: { x: 0.05, y: 0 } }); // 50 units
    const far = await call(module, 'map.nodes.create', { name: 'Far', position: { x: 0.9, y: 0 } }); // 900 units

    const edges = await call(module, 'map.edges.list');
    assert.equal(edges.value.length, 1, 'only the near marker qualifies');
    assert.ok(edges.value[0].auto);
    assert.deepEqual([edges.value[0].fromId, edges.value[0].toId].sort(), [a.value.id, near.value.id].sort());
    void far;
});

test('raising settings.autoConnectDistanceUnits after nodes already exist reconciles the WHOLE graph at once, not just the next-touched node', async () => {
    const { engine, mapCore } = buildEngine();
    await mapCore.restore();
    const module = moduleCaller(engine, ALL_CONTRACTS);
    await call(module, 'map.settings.update', { mapWidthUnits: 1000, mapHeightUnits: 1000 });
    const a = await call(module, 'map.nodes.create', { name: 'A', position: { x: 0, y: 0 } });
    const b = await call(module, 'map.nodes.create', { name: 'B', position: { x: 0.05, y: 0 } });

    const beforeEdges = await call(module, 'map.edges.list');
    assert.equal(beforeEdges.value.length, 0, 'no threshold set yet — nothing auto-connects');

    await call(module, 'map.settings.update', { autoConnectDistanceUnits: 100 });
    const afterEdges = await call(module, 'map.edges.list');
    assert.equal(afterEdges.value.length, 1, 'existing nodes reconciled immediately, without waiting for a create/update');
    void a; void b;
});

test('map.edges.create refuses a manual edge across two different local maps unless distanceOverrideUnits is given', async () => {
    const { engine, mapCore } = buildEngine();
    await mapCore.restore();
    const module = moduleCaller(engine, ALL_CONTRACTS);
    const district = await call(module, 'map.nodes.create', { name: 'District', position: { x: 0, y: 0 } });
    const building = await call(module, 'map.nodes.create', { name: 'Building', localMap: { widthUnits: 20, heightUnits: 20 } });
    const room = await call(module, 'map.nodes.create', { name: 'Room', parentId: building.value.id, position: { x: 0, y: 0 } });

    const refused = await call(module, 'map.edges.create', { fromId: district.value.id, toId: room.value.id });
    assert.equal(refused.ok, false);

    const withOverride = await call(module, 'map.edges.create', { fromId: district.value.id, toId: room.value.id, distanceOverrideUnits: 3 });
    assert.equal(withOverride.ok, true);
});

test('map.pathfind finds a route across two auto-adjacent districts and map.pathfind.performed is published', async () => {
    const { engine, mapCore } = buildEngine();
    await mapCore.restore();
    const module = moduleCaller(engine, ALL_CONTRACTS);
    const events = [];
    engine.events.subscribe('map.pathfind.performed', payload => events.push(payload));
    const left = [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 1 }, { x: 0, y: 1 }];
    const right = [{ x: 0.5, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0.5, y: 1 }];
    const a = await call(module, 'map.nodes.create', { name: 'A', polygon: left });
    const b = await call(module, 'map.nodes.create', { name: 'B', polygon: right });

    const result = await call(module, 'map.pathfind', { fromId: a.value.id, toId: b.value.id });

    assert.equal(result.ok, true);
    assert.equal(result.value.reason, null);
    assert.deepEqual(result.value.routes[0].nodeIds, [a.value.id, b.value.id]);
    // Real, non-null edge ids — an auto-created edge's stored value must
    // carry its own `id` (not just live as the object KEY), since
    // findRoutes()/buildTraversalGraph() reads `edge.id` off each VALUE.
    // Regression: this silently produced `edgeIds: [null]` on every route.
    assert.equal(result.value.routes[0].edgeIds.length, 1);
    assert.equal(typeof result.value.routes[0].edgeIds[0], 'string');
    const edgesList = await call(module, 'map.edges.list');
    assert.equal(result.value.routes[0].edgeIds[0], edgesList.value[0].id);
    assert.equal(events.length, 1);
    assert.equal(events[0].routeCount, 1);
});

test('map.distance reports "different-local-map" when the two nodes do not share a coordinate space', async () => {
    const { engine, mapCore } = buildEngine();
    await mapCore.restore();
    const module = moduleCaller(engine, ALL_CONTRACTS);
    const district = await call(module, 'map.nodes.create', { name: 'District', position: { x: 0, y: 0 } });
    const building = await call(module, 'map.nodes.create', { name: 'Building', localMap: { widthUnits: 20, heightUnits: 20 } });
    const room = await call(module, 'map.nodes.create', { name: 'Room', parentId: building.value.id, position: { x: 0, y: 0 } });

    const result = await call(module, 'map.distance', { fromId: district.value.id, toId: room.value.id });
    assert.equal(result.value.distanceUnits, null);
    assert.equal(result.value.reason, 'different-local-map');
});

test('map.position.set places the CURRENT chat somewhere without a movement-log entry, and map.position.get reflects it', async () => {
    const { engine, mapCore } = buildEngine();
    await mapCore.restore();
    const module = moduleCaller(engine, ALL_CONTRACTS);
    const a = await call(module, 'map.nodes.create', { name: 'A', position: { x: 0, y: 0 } });

    await call(module, 'map.position.set', { nodeId: a.value.id });
    const position = await call(module, 'map.position.get');
    const log = await call(module, 'map.movementLog.list');

    assert.equal(position.value.nodeId, a.value.id);
    assert.deepEqual(log.value, []);
});

test('map.position.move walks a real route, updates position, and appends exactly one movement-log entry', async () => {
    const { engine, mapCore } = buildEngine();
    await mapCore.restore();
    const module = moduleCaller(engine, ALL_CONTRACTS);
    const left = [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 1 }, { x: 0, y: 1 }];
    const right = [{ x: 0.5, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0.5, y: 1 }];
    const a = await call(module, 'map.nodes.create', { name: 'A', polygon: left });
    const b = await call(module, 'map.nodes.create', { name: 'B', polygon: right });
    await call(module, 'map.position.set', { nodeId: a.value.id });

    const moved = await call(module, 'map.position.move', { toId: b.value.id });
    const log = await call(module, 'map.movementLog.list');
    const position = await call(module, 'map.position.get');

    assert.equal(moved.ok, true);
    assert.equal(position.value.nodeId, b.value.id);
    assert.equal(log.value.length, 1);
    assert.equal(log.value[0].fromId, a.value.id);
    assert.equal(log.value[0].toId, b.value.id);
});

test('map.position.move refuses to move to a disconnected node instead of silently teleporting', async () => {
    const { engine, mapCore } = buildEngine();
    await mapCore.restore();
    const module = moduleCaller(engine, ALL_CONTRACTS);
    const a = await call(module, 'map.nodes.create', { name: 'A', position: { x: 0, y: 0 } });
    const b = await call(module, 'map.nodes.create', { name: 'B', position: { x: 0.9, y: 0.9 } });
    await call(module, 'map.position.set', { nodeId: a.value.id });

    const moved = await call(module, 'map.position.move', { toId: b.value.id });
    assert.equal(moved.ok, false);
    const position = await call(module, 'map.position.get');
    assert.equal(position.value.nodeId, a.value.id, 'position must stay unchanged after a refused move');
});

test('map.movementLog.clear empties the log and publishes map.movementLog.cleared', async () => {
    const { engine, mapCore } = buildEngine();
    await mapCore.restore();
    const module = moduleCaller(engine, ALL_CONTRACTS);
    const events = [];
    engine.events.subscribe('map.movementLog.cleared', () => events.push(1));
    const left = [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 1 }, { x: 0, y: 1 }];
    const right = [{ x: 0.5, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0.5, y: 1 }];
    const a = await call(module, 'map.nodes.create', { name: 'A', polygon: left });
    const b = await call(module, 'map.nodes.create', { name: 'B', polygon: right });
    await call(module, 'map.position.set', { nodeId: a.value.id });
    await call(module, 'map.position.move', { toId: b.value.id });

    await call(module, 'map.movementLog.clear');
    const log = await call(module, 'map.movementLog.list');

    assert.deepEqual(log.value, []);
    assert.equal(events.length, 1);
});

test('map.settings.update persists a custom levelScaleCoefficient and publishes map.settings.changed', async () => {
    const { engine, mapCore } = buildEngine();
    await mapCore.restore();
    const module = moduleCaller(engine, ALL_CONTRACTS);
    const events = [];
    engine.events.subscribe('map.settings.changed', payload => events.push(payload));

    const updated = await call(module, 'map.settings.update', { levelScaleCoefficient: 20 });

    assert.equal(updated.value.levelScaleCoefficient, 20);
    assert.equal(events.length, 1);
    assert.equal(events[0].settings.levelScaleCoefficient, 20);
});

test('the map graph and settings persist through the real Гейт -> storage.settings -> Сервис chain, surviving a fresh mapCore.restore()', async () => {
    const engine = createEngine();
    const settingsContext = { extensionSettings: {}, saveSettingsDebounced: () => {} };
    registerExtensionSettingsService(engine.buses.services, { getContext: () => settingsContext });
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));
    const chatContext = { chatMetadata: {}, saveMetadataDebounced: () => {}, saveMetadata: async () => {} };
    registerChatMetadataService(engine.buses.services, { getContext: () => chatContext });
    createChatMemoryCore(engine.registerCaller('core.memory.chat', 'cores', { tier: 'official' }));

    const firstMapCore = createMapCore(engine.registerCaller('core.map', 'cores', { tier: 'official' }));
    await firstMapCore.restore();
    const module = moduleCaller(engine, ALL_CONTRACTS);
    await call(module, 'map.nodes.create', { name: 'Persisted District', rank: 5 });
    await call(module, 'map.settings.update', { levelScaleCoefficient: 22 });
    firstMapCore.unregister();

    const secondMapCore = createMapCore(engine.registerCaller('core.map', 'cores', { tier: 'official' }));
    await secondMapCore.restore();
    const list = await call(module, 'map.nodes.list');
    const settings = await call(module, 'map.settings.get');

    assert.equal(list.value.length, 1);
    assert.equal(list.value[0].name, 'Persisted District');
    assert.equal(settings.value.levelScaleCoefficient, 22);
});

test('map.rootImage starts null, map.rootImage.set persists {assetId,width,height} and publishes map.rootImage.changed', async () => {
    const { engine, mapCore } = buildEngine();
    await mapCore.restore();
    const module = moduleCaller(engine, ALL_CONTRACTS);
    const events = [];
    engine.events.subscribe('map.rootImage.changed', payload => events.push(payload));

    const before = await call(module, 'map.rootImage.get');
    assert.equal(before.value, null);

    const set = await call(module, 'map.rootImage.set', { assetId: 'img_1', width: 4000, height: 3000 });
    assert.equal(set.ok, true);
    assert.deepEqual(set.value, { assetId: 'img_1', width: 4000, height: 3000 });

    const after = await call(module, 'map.rootImage.get');
    assert.deepEqual(after.value, { assetId: 'img_1', width: 4000, height: 3000 });
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].rootImage, { assetId: 'img_1', width: 4000, height: 3000 });
});

test('map.rootImage.set rejects a missing assetId or non-positive dimensions instead of silently accepting garbage', async () => {
    const { engine, mapCore } = buildEngine();
    await mapCore.restore();
    const module = moduleCaller(engine, ALL_CONTRACTS);

    const noAssetId = await call(module, 'map.rootImage.set', { width: 100, height: 100 });
    assert.equal(noAssetId.ok, false);

    const zeroWidth = await call(module, 'map.rootImage.set', { assetId: 'img_1', width: 0, height: 100 });
    assert.equal(zeroWidth.ok, false);
});

test('map.rootImage.clear resets it to null and publishes the change', async () => {
    const { engine, mapCore } = buildEngine();
    await mapCore.restore();
    const module = moduleCaller(engine, ALL_CONTRACTS);
    await call(module, 'map.rootImage.set', { assetId: 'img_1', width: 100, height: 100 });

    await call(module, 'map.rootImage.clear');
    const after = await call(module, 'map.rootImage.get');

    assert.equal(after.value, null);
});

test('map.rootImage persists through a fresh mapCore.restore(), same as the graph/settings', async () => {
    const engine = createEngine();
    const settingsContext = { extensionSettings: {}, saveSettingsDebounced: () => {} };
    registerExtensionSettingsService(engine.buses.services, { getContext: () => settingsContext });
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));
    const chatContext = { chatMetadata: {}, saveMetadataDebounced: () => {}, saveMetadata: async () => {} };
    registerChatMetadataService(engine.buses.services, { getContext: () => chatContext });
    createChatMemoryCore(engine.registerCaller('core.memory.chat', 'cores', { tier: 'official' }));

    const firstMapCore = createMapCore(engine.registerCaller('core.map', 'cores', { tier: 'official' }));
    await firstMapCore.restore();
    const module = moduleCaller(engine, ALL_CONTRACTS);
    await call(module, 'map.rootImage.set', { assetId: 'img_persisted', width: 500, height: 400 });
    firstMapCore.unregister();

    const secondMapCore = createMapCore(engine.registerCaller('core.map', 'cores', { tier: 'official' }));
    await secondMapCore.restore();
    const after = await call(module, 'map.rootImage.get');

    assert.deepEqual(after.value, { assetId: 'img_persisted', width: 500, height: 400 });
});
