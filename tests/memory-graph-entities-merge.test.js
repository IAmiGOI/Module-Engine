import test from 'node:test';
import assert from 'node:assert/strict';
import { findEntityCandidates } from '../cores/memory-graph/entity-candidates.js';
import { createEntityOps } from '../cores/memory-graph/structured/entity-ops.js';
import { adaptiveMergeThresholds, findMergeCandidate, DEFAULT_SETTINGS } from '../cores/memory-graph/math.js';

// --- Обнаружение сущностей ------------------------------------------------------

const node = (id, label, content, extra = {}) => ({ id, label, content, kind: 'fact', edges: [], ...extra });
/** Граф, как у живого чата: герой с нодой, а «Nyx» повторяется в содержимом, но своей ноды нет. */
function chatGraph() {
    return Object.fromEntries([
        node('hero', 'Echidna', 'Echidna is the witch of greed.', { kind: 'entity' }),
        node('a', 'Girl has white hair', 'The girl (Nyx) has long white hair. She was made in a dream.'),
        node('b', 'Nyx has memories', 'Nyx has half of the memories. She does not know pain. This matters.'),
        node('c', 'Knowledge and experience', 'Echidna and Nyx are separate. The tea is gone. When she wakes, she forgets.'),
        node('d', 'Evening', 'She sat down. The room was quiet. This was the end of it. He said — She left, and then — This ends, and so — The room is dark; she knew the end, this much, when the night came.'),
    ].map(item => [item.id, item]));
}

test('findEntityCandidates() finds a name that repeats across nodes but has no node of its own', () => {
    const found = findEntityCandidates(chatGraph());
    assert.deepEqual(found.map(item => item.name), ['Nyx']);
    assert.equal(found[0].nodeIds.length, 3);
});

test('findEntityCandidates() ignores ordinary capitalized words — "She", "The", "This" are also written in lowercase in the same text', () => {
    const names = findEntityCandidates(chatGraph(), { minMentions: 2, maxCandidates: 20 }).map(item => item.name);
    for (const word of ['She', 'The', 'This', 'When']) assert.ok(!names.includes(word), `${word} must not become an entity`);
});

test('findEntityCandidates() skips names that already resolve to a node (label, alias or a word of a label)', () => {
    const graph = chatGraph();
    graph.hero.aliases = ['Nyx'];
    assert.deepEqual(findEntityCandidates(graph), []);
});

test('findEntityCandidates() needs the name in enough DIFFERENT nodes, not just many times in one', () => {
    const graph = chatGraph();
    delete graph.b;
    delete graph.c;
    graph.a.content += ' Nyx Nyx Nyx Nyx.';
    assert.deepEqual(findEntityCandidates(graph), []);
});

test('findEntityCandidates() reads a multi-word proper name as one name', () => {
    const graph = Object.fromEntries([1, 2, 3].map(i => [`n${i}`, node(`n${i}`, `Rule ${i}`, `Everyone at the Tea Party obeys rule ${i}. The Tea Party never ends.`)]));
    assert.deepEqual(findEntityCandidates(graph).map(item => item.name), ['Tea Party']);
});

// --- Создание ноды сущности ------------------------------------------------------

function buildCtx() {
    const nodes = chatGraph();
    for (const item of Object.values(nodes)) item.regionId = 'main';
    const regions = { main: { centerNodeId: 'hero', subCenterIds: [], nodeIds: Object.keys(nodes), wordProfile: {} } };
    const events = [];
    const ctx = {
        nodes, regions, turnCounter: 50, epoch: 1, features: { kinds: true },
        settings: { ...DEFAULT_SETTINGS },
        enqueueWrite: task => task(),
        stillSameChat: () => true,
        callService: async () => ({ ok: true, value: [1, 0, 0] }),
        publishEvent: (name, payload) => events.push([name, payload]),
        edgeAllowed: () => true,
        placeNewNode(spec, options) {
            const id = `new_${Object.keys(nodes).length}`;
            nodes[id] = { id, ...spec, edges: [], degree: 0, regionId: options.subjectRegion?.regionId ?? null };
            regions[options.subjectRegion.regionId].nodeIds.push(id);
            return { status: 'placed', nodeId: id };
        },
        persistNodes: async () => {}, persistRegions: async () => {}, persistStaging: async () => {}, persistMergeQueue: async () => {}, persistReconsolidationQueue: async () => {},
    };
    return { ctx, events };
}

test('sweepEntities() creates a node for the repeated name in the region where its records live, linked to every record that mentions it', async () => {
    const { ctx, events } = buildCtx();
    const { created } = await createEntityOps(ctx).sweepEntities();
    assert.equal(created.length, 1);
    const entity = ctx.nodes[created[0].nodeId];
    assert.equal(entity.label, 'Nyx');
    assert.equal(entity.kind, 'entity');
    assert.equal(entity.regionId, 'main');
    assert.deepEqual(entity.edges.map(edge => edge.to).sort(), ['a', 'b', 'c']);
    assert.equal(created[0].links, 3);
    assert.ok(events.some(([name, payload]) => name === 'memoryGraph.nodeCreated' && payload.source === 'mentions'));
});

test('sweepEntities() makes a multi-word name an object (group), and does not create the same entity twice', async () => {
    const { ctx } = buildCtx();
    for (const i of [1, 2, 3]) ctx.nodes[`t${i}`] = node(`t${i}`, `Rule ${i}`, `Everyone at the Tea Party obeys rule ${i}. The Tea Party never ends.`, { regionId: 'main' });
    const ops = createEntityOps(ctx);
    const { created } = await ops.sweepEntities();
    const tea = created.find(item => item.name === 'Tea Party');
    assert.equal(ctx.nodes[tea.nodeId].kind, 'object');
    assert.equal(ctx.nodes[tea.nodeId].subtype, 'group');
    ctx.turnCounter += 100;
    assert.deepEqual((await ops.sweepEntities()).created, [], 'the names now resolve to nodes — nothing to create');
});

test('sweepEntities() respects the sweep period and the structured feature flag', async () => {
    const { ctx } = buildCtx();
    const ops = createEntityOps(ctx);
    assert.equal((await ops.sweepEntities()).created.length, 1);
    ctx.nodes.x = node('x', 'Other', 'Zorp is here. Zorp laughed.', { regionId: 'main' });
    ctx.nodes.y = node('y', 'Other 2', 'Zorp left. Zorp cried.', { regionId: 'main' });
    ctx.nodes.z = node('z', 'Other 3', 'Zorp said so.', { regionId: 'main' });
    ctx.turnCounter += 1;
    assert.deepEqual((await ops.sweepEntities()).created, [], 'within entitySweepEveryTurns nothing is re-run');
    const legacy = buildCtx();
    legacy.ctx.features = { kinds: false };
    assert.deepEqual((await createEntityOps(legacy.ctx).sweepEntities()).created, []);
});

// --- Слияние дублей по порогу графа ----------------------------------------------

const DIM = 12;
const vec = (topic, jitter) => Array.from({ length: DIM }, (_, i) => 1 + (i === topic ? 0.9 : 0) + (i === 6 + (jitter % 5) ? 0.04 * (1 + jitter % 3) : 0));
const embeddings = () => [...[0, 1, 2, 3].map(topic => vec(topic, topic)), ...[0, 1, 2].map(jitter => vec(4, jitter)), ...[0, 1].map(jitter => vec(5, jitter))];

test('adaptiveMergeThresholds() derives the threshold from the graph, never above the old absolute one and never below the floor', () => {
    const result = adaptiveMergeThresholds(embeddings(), { ceiling: 0.99, floor: 0.5 });
    assert.ok(result && result.similarity > result.mean && result.strong >= result.similarity);
    assert.equal(adaptiveMergeThresholds(embeddings(), { ceiling: 0.6, floor: 0.5 }).similarity, 0.6, 'the old threshold is a ceiling');
    assert.equal(adaptiveMergeThresholds(embeddings(), { ceiling: 0.99, floor: 0.99 }).similarity, 0.99, 'the floor holds');
});

test('adaptiveMergeThresholds() has no statistics for a tiny group or for identical vectors', () => {
    assert.equal(adaptiveMergeThresholds(embeddings().slice(0, 3), { minNodes: 6 }), null);
    assert.equal(adaptiveMergeThresholds(Array.from({ length: 8 }, () => [1, 2, 3]), { minNodes: 6 }), null);
});

test('findMergeCandidate() lets a statistically exceptional similarity override the word filter (a paraphrase shares almost no words)', () => {
    const newNode = { id: 'n', embedding: vec(4, 0), words: ['sasha', 'desires', 'wife'] };
    const paraphrase = { id: 'p', embedding: vec(4, 1), words: ['his', 'core', 'longing', 'companionship'] };
    assert.equal(findMergeCandidate(newNode, [paraphrase], { similarityThreshold: 0.9 }), null, 'default: the word filter rejects it');
    assert.equal(findMergeCandidate(newNode, [paraphrase], { similarityThreshold: 0.9, strongSimilarity: 0.95 }), 'p');
});

test('findMergeCandidate() still rejects a merely similar pair without shared words when the similarity is not exceptional', () => {
    const newNode = { id: 'n', embedding: vec(4, 0), words: ['a', 'b'] };
    const other = { id: 'o', embedding: vec(5, 0), words: ['c', 'd'] };
    assert.equal(findMergeCandidate(newNode, [other], { similarityThreshold: 0.5, strongSimilarity: 0.999 }), null);
});
