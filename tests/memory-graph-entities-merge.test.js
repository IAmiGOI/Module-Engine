import test from 'node:test';
import assert from 'node:assert/strict';
import { findEntityCandidates } from '../cores/memory-graph/entity-candidates.js';
import { createEntityOps } from '../cores/memory-graph/structured/entity-ops.js';
import { buildStructuredExtractionPrompt } from '../cores/memory-graph/extraction-prompt.js';
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

// --- Лорбук с разметкой: заголовки, пункты, даты, национальности (отзыв бета-тестера) ---------------------

/** Содержимое нод, как у графа, собранного из лорбука: `**заголовки**`, `-пункты`, `Название — Backstory`, даты, языки, термины сюжета. */
function lorebookGraph() {
    const heading = '***Satsuki Saionji — Character Core***\n**Present Relevance**\n**Emotional Instability**\n**Emotional Core**\n';
    const bullets = '-Security in love does NOT depend on words.\n-Similar small likes can be shared.\n-Notable quirks: allergic to cats.\n';
    const prose = [
        'She was born in Spring 2026 in a small town. He speaks English and Japanese. An American student visited in April 2026.',
        'The player can reach the Bad End route if the choices go wrong. A bad day, a bad habit, an end to the story.',
        'They travelled to Kyoto in the autumn and stayed in Kyoto for a week. Later Kyoto appeared in the notes.',
    ];
    const nodes = [];
    prose.forEach((text, i) => nodes.push(node(`prose${i}`, `Satsuki Saionji — Backstory ${i}`, `${heading}${bullets}${text} Another spring. A security guard. Similar cases. The core of it. Role play notes say role plays are fine.`)));
    for (let i = 0; i < 3; i += 1) nodes.push(node(`extra${i}`, `Role Play Memories ${i}`, `${bullets}${prose[i]} The Bad End is rare. Kyoto is far. In Kyoto it rains. English class was fun. Japanese food. American coffee. April rain. Spring flowers.`));
    return Object.fromEntries(nodes.map(item => [item.id, item]));
}

test('findEntityCandidates() ignores headings, bullet items, dates, seasons, nationalities and story terms from a lorebook — only a real name stays', () => {
    const names = findEntityCandidates(lorebookGraph(), { minMentions: 3, maxCandidates: 50 }).map(item => item.name);
    for (const junk of ['Security', 'Similar', 'Notable', 'Relevance', 'Instability', 'Core', 'Bad End', 'Bad', 'Backstory', 'Spring', 'April', 'American', 'English', 'Japanese', 'Role Plays', 'Role Play']) {
        assert.ok(!names.includes(junk), `${junk} must not be a candidate`);
    }
    assert.deepEqual(names, ['Kyoto']);
});

test('findEntityCandidates() ignores labels (titles) — a name only in titles is not a name', () => {
    const graph = Object.fromEntries([1, 2, 3, 4].map(i => [`n${i}`, node(`n${i}`, 'Zorvak Chronicle', `Plain text number ${i} about nothing in particular.`)]));
    assert.deepEqual(findEntityCandidates(graph), []);
});

test('findEntityCandidates() returns short contexts for the model to judge, and skips names already rejected', () => {
    const found = findEntityCandidates(lorebookGraph(), { minMentions: 3, maxCandidates: 5 }).find(item => item.name === 'Kyoto');
    assert.ok(found.contexts.length >= 1 && found.contexts.every(text => text.includes('Kyoto')));
    assert.deepEqual(findEntityCandidates(lorebookGraph(), { minMentions: 3, maxCandidates: 5, ignore: ['kyoto'] }), []);
});

// --- Подсказка извлечению: без отдельного вызова модели ------------------------------------------------------

function buildCtx(nodes = chatGraph()) {
    const persisted = [];
    const removed = [];
    const ctx = {
        nodes, turnCounter: 50, features: { kinds: true }, graphMeta: { mode: 'structured' }, settings: { ...DEFAULT_SETTINGS },
        enqueueWrite: task => task(),
        removeNode: id => { removed.push(id); delete ctx.nodes[id]; },
        persistNodes: async () => persisted.push('nodes'), persistRegions: async () => {}, persistStaging: async () => {}, persistMergeQueue: async () => {}, persistReconsolidationQueue: async () => {},
        persistGraphMeta: async () => persisted.push('meta'),
    };
    return { ctx, persisted, removed };
}

test('recurringNames() hands the repeated name without a node to the extraction prompt — and never creates a node itself', async () => {
    const { ctx } = buildCtx();
    const before = Object.keys(ctx.nodes).length;
    assert.deepEqual(await createEntityOps(ctx).recurringNames(), ['Nyx']);
    assert.equal(Object.keys(ctx.nodes).length, before, 'only the model, through the normal extraction, may create the node');
});

test('recurringNames() offers a name twice; if the model never creates it, the name is rejected (persisted) and not offered again', async () => {
    const { ctx, persisted } = buildCtx();
    const ops = createEntityOps(ctx);
    assert.deepEqual(await ops.recurringNames(), ['Nyx']);
    assert.deepEqual(await ops.recurringNames(), ['Nyx']);
    assert.deepEqual(await ops.recurringNames(), [], 'two hints and no node: enough');
    assert.deepEqual(ctx.graphMeta.entityRejected, ['nyx']);
    assert.ok(persisted.includes('meta'), 'the rejection must survive a reload');
    assert.deepEqual(await ops.recurringNames(), [], 'and it stays rejected');
});

test('recurringNames() stops offering a name as soon as it has a node, and forgets its counter', async () => {
    const { ctx } = buildCtx();
    const ops = createEntityOps(ctx);
    await ops.recurringNames();
    ctx.nodes.nyx = node('nyx', 'Nyx', 'Nyx is a girl.', { kind: 'entity' });
    assert.deepEqual(await ops.recurringNames(), []);
    assert.deepEqual(ctx.graphMeta.entityHinted, {});
    assert.equal(ctx.graphMeta.entityRejected, undefined, 'a name that got its node is not "rejected"');
});

test('recurringNames() on a lorebook-shaped graph offers only the real name, not headings, dates or story terms', async () => {
    const { ctx } = buildCtx(lorebookGraph());
    assert.deepEqual(await createEntityOps(ctx).recurringNames(), ['Kyoto']);
});

test('recurringNames() gives nothing in a legacy graph', async () => {
    const { ctx } = buildCtx();
    ctx.features = { kinds: false };
    assert.deepEqual(await createEntityOps(ctx).recurringNames(), []);
});

test('sweepEntities() makes no model call and creates no node: it only removes the junk stubs of the first version ("Word — mentioned in N records")', async () => {
    const { ctx, removed } = buildCtx();
    ctx.nodes.stub = { id: 'stub', label: 'Bad', content: 'Bad — mentioned in 5 records, e.g. "Role Play Memories".', source: 'mentions', kind: 'entity', edges: [] };
    ctx.nodes.mine = { id: 'mine', label: 'Kyoto', content: 'Kyoto — the old capital.', source: 'mentions', kind: 'entity', edges: [] };
    ctx.nodes.typed = { id: 'typed', label: 'Mention', content: 'Typed by hand: mentioned in the notes.', source: 'chat', kind: 'fact', edges: [] };
    const before = Object.keys(ctx.nodes).length;
    assert.deepEqual(await createEntityOps(ctx).sweepEntities(), { retired: 1 });
    assert.deepEqual(removed, ['stub']);
    assert.equal(Object.keys(ctx.nodes).length, before - 1);
});

test('the extraction prompt carries the recurring names with the rule "create only a real name", and nothing when there are none', () => {
    const prompt = buildStructuredExtractionPrompt({ contextText: 'scene', recurringNames: ['Nyx', 'Kyoto'] });
    assert.match(prompt, /keep coming up in the notes but have no memory of their own yet: Nyx; Kyoto/);
    assert.match(prompt, /Ignore anything that is only a heading, an ordinary word, a date/);
    assert.doesNotMatch(buildStructuredExtractionPrompt({ contextText: 'scene' }), /keep coming up/);
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
