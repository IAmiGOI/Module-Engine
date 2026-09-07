import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerHttpService } from '../services/http.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { registerChatMetadataService } from '../services/chat-metadata.js';
import { createInternalEngineModelsCore } from '../cores/models/internal-engine.js';
import { createSettingsCore } from '../cores/settings/index.js';
import { createChatMemoryCore } from '../cores/memory/index.js';
import { createPipelineCore } from '../cores/pipeline/index.js';
import { createMemoryGraphCore } from '../cores/memory-graph/index.js';
import { createLorebookCore } from '../cores/lorebook/index.js';

/**
 * Scenario level (TESTING.md "Уровень 2") — реальный движок, реальные
 * Гейты. `lorebook.*`/`tracking.*`/`embedding.*` — фейки прямо на Шине ядер
 * (как `macrosHost.own.register(...)` в lorebook-core.test.js): проверяем
 * ОРКЕСТРАЦИЮ Ядра графа памяти, не переизобретаем тесты самих Lorebook/
 * Tracking/эмбединга — у них свои файлы.
 */

function fakeFetchReplying(reply) {
    return async () => ({
        status: 200, ok: true, headers: { entries: () => [] },
        text: async () => JSON.stringify({ choices: [{ message: { content: reply } }] }),
    });
}

/**
 * Как `fakeFetchReplying()`, но РАЗНЫЙ ответ на КАЖДЫЙ последовательный
 * вызов `model.generate` — нужно для нового 3-проходного бутстрапа
 * (Проход 1 → Проход 2 → Проход 3 по одному вызову на регион): единый
 * `fetchReply` для всех вызовов сразу здесь не подходит. Последний элемент
 * массива повторяется для всех вызовов сверх его длины (удобно, когда
 * Проход 3 зовётся по разу на N регионов, но их ответ одинаковый в тесте).
 */
function fakeFetchSequence(replies) {
    let index = 0;
    return async () => {
        const reply = replies[Math.min(index, replies.length - 1)];
        index += 1;
        return {
            status: 200, ok: true, headers: { entries: () => [] },
            text: async () => JSON.stringify({ choices: [{ message: { content: reply } }] }),
        };
    };
}

/** Детерминированный "эмбединг" — хэш первых слов текста в маленький вектор, чтобы РАЗНЫЙ текст давал РАЗНЫЙ (но воспроизводимый) вектор без реальной модели. */
function fakeEmbed(text) {
    const words = String(text).toLowerCase().match(/[a-zа-яё0-9]+/g) ?? [''];
    const vec = [0, 0, 0, 0];
    for (const word of words) {
        let hash = 0;
        for (let i = 0; i < word.length; i += 1) hash = (hash * 31 + word.charCodeAt(i)) % 997;
        vec[hash % 4] += 1;
    }
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
    return vec.map(v => v / norm);
}

function buildEngine({ fetchReply = '{"label":"Test Fact","content":"Something notable happened.","importance":5}', fetchReplies = null, fetchOverride = null, lorebookEntries = null, random, embeddingGate = Promise.resolve(), character = null } = {}) {
    const engine = createEngine();
    const context = {};
    // `fetchOverride` — полный контроль над fetch (нужно, например, чтобы
    // симулировать отказ ОДНОГО конкретного вызова model.generate — обычный
    // fetchReplies всегда отвечает 200 OK, этого недостаточно для теста
    // "один сбой Прохода 3 не блокирует остальные регионы").
    registerHttpService(engine.buses.network, { fetch: fetchOverride ?? (fetchReplies ? fakeFetchSequence(fetchReplies) : fakeFetchReplying(fetchReply)) });
    const settingsContext = { extensionSettings: {}, saveSettingsDebounced: () => {} };
    registerExtensionSettingsService(engine.buses.services, { getContext: () => settingsContext });
    registerChatMetadataService(engine.buses.services, { getContext: () => context });

    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));
    createChatMemoryCore(engine.registerCaller('core.memory.chat', 'cores', { tier: 'official' }));

    const modelsHost = engine.registerCaller('core.models.internal', 'cores', { tier: 'official', networkAccess: true });
    const modelsCore = createInternalEngineModelsCore(modelsHost);
    modelsCore.configureWorkers([{ id: 'fast', endpoint: 'https://fast.example.com', model: 'm1', format: 'openai' }]);

    const pipelineCore = createPipelineCore(engine.registerCaller('core.pipeline', 'cores', { tier: 'official' }), { resolveAs: engine.resolveAs });
    pipelineCore.define({ id: 'generation.prepare', mode: 'collect' });
    pipelineCore.define({ id: 'generation.beforeSend', mode: 'collect' });

    // Фейковый эмбединг — детерминированный, без реальной модели/сети.
    // `embeddingGate` (по умолчанию уже разрешённый промис — НИКАКОГО
    // поведения для существующих тестов) даёт управляемо ЗАДЕРЖАТЬ каждый
    // вызов — единственный способ доказать неблокирующий бутстрап, не
    // полагаясь на хрупкий замер реального времени в тесте.
    const embeddingHost = engine.registerCaller('service.embedding', 'services', { tier: 'official' });
    embeddingHost.own.register('embedding.compute', async params => { await embeddingGate; return fakeEmbed(params?.text); });

    // Фейковый RP Time — по умолчанию "выключен" (как requireTracker() бросает в реальном Ядре трекинга).
    const trackingHost = engine.registerCaller('core.tracking', 'cores', { tier: 'official' });
    trackingHost.own.register('tracking.fields', () => { throw new Error('tracking: unknown tracker "rp-time".'); });

    // Фейковый Lorebook — управляется параметром теста.
    const lorebookHost = engine.registerCaller('core.lorebook', 'cores', { tier: 'official' });
    const books = lorebookEntries ? ['Demo Lore'] : [];
    lorebookHost.own.register('lorebook.books', () => books);
    lorebookHost.own.register('lorebook.find', () => (lorebookEntries ?? []).map(e => ({ uid: e.uid, book: 'Demo Lore', name: e.comment })));
    lorebookHost.own.register('lorebook.get', params => (lorebookEntries ?? []).find(e => e.uid === params?.uid));

    // Фейковая карточка активного персонажа — управляется параметром теста
    // (тем же принципом, что и lorebookEntries выше). `null` — "нет
    // активного персонажа" (реалистично: services/st-character.js's
    // current() тоже отдаёт `null`, если context.characterId не задан).
    const characterHost = engine.registerCaller('service.character', 'services', { tier: 'official' });
    characterHost.own.register('stCharacter.current', () => character);

    const graphCore = createMemoryGraphCore(engine.registerCaller('core.memoryGraph', 'cores', { tier: 'official' }), random ? { random } : {});

    const caller = engine.registerCaller('module.probe', 'modules', {
        tier: 'community',
        allowedContracts: [
            'memoryGraph.settings', 'memoryGraph.configure', 'memoryGraph.nodes', 'memoryGraph.regions', 'memoryGraph.check',
            'memoryGraph.mergeQueue', 'memoryGraph.reconsolidationQueue',
            'memoryGraph.nodes.create', 'memoryGraph.nodes.update', 'memoryGraph.nodes.delete', 'memoryGraph.nodes.move',
            'memoryGraph.nodes.createFromCharacterCard',
            'memoryGraph.edges.create', 'memoryGraph.edges.delete',
            'memoryGraph.checkAndPlace', 'memoryGraph.sweepStaging', 'memoryGraph.sweepMergeQueue', 'memoryGraph.sweepReconsolidationQueue', 'memoryGraph.sweepBackbone', 'memoryGraph.bootstrapFromLorebook',
        ],
    });

    return { engine, graphCore, caller, context, pipelineCore };
}

function call(caller, contract, params) {
    return new Promise(resolve => caller.cores.subscribe(contract, { params }, resolve));
}

// --- Бутстрап из Lorebook -------------------------------------------------

test('load() resolves WITHOUT waiting for a slow bootstrap — the engine must not hang on it (решено с пользователем: "зависание при bootstrap... вынеси его отдельно")', async () => {
    let releaseEmbedding;
    const embeddingGate = new Promise(resolve => { releaseEmbedding = resolve; });
    const entries = [{ uid: 0, comment: 'Slow Entry', content: 'this entry\'s embedding is deliberately held up.' }];
    const { graphCore, caller } = buildEngine({
        lorebookEntries: entries, embeddingGate,
        fetchReplies: ['[{"region":"Test","subCenterUids":[0]}]', '[{"region":"Test","centerUid":0}]'],
    });

    await graphCore.load(); // должно вернуться, ПОКА bootstrapFromLorebook() всё ещё висит на embeddingGate
    const nodesWhileStillBootstrapping = await call(caller, 'memoryGraph.nodes');
    assert.deepEqual(nodesWhileStillBootstrapping.value, [], 'load() must not have waited for the still-blocked embedding call — the entry cannot be placed yet');

    releaseEmbedding();
    await graphCore.waitForBootstrap();
    const nodesAfterBootstrap = await call(caller, 'memoryGraph.nodes');
    assert.equal(nodesAfterBootstrap.value.length, 1, 'once actually awaited, the background bootstrap must still complete correctly');
});

test('bootstrapFromLorebook() does nothing when the player has no active lorebook — leaves the graph empty for the "new world" SideCar-hint path instead', async () => {
    const { graphCore, caller } = buildEngine({ lorebookEntries: null });
    await graphCore.load();
    await graphCore.waitForBootstrap();

    const nodes = await call(caller, 'memoryGraph.nodes');
    assert.deepEqual(nodes.value, []);
});

test('bootstrapFromLorebook() sends an explicit maxTokens override on every Проход — the engine default (1000, cores/models/internal-engine.js) truncates the structured JSON reply for a real-size Lorebook (found live)', async () => {
    const requestBodies = [];
    const fetchOverride = async (url, init) => {
        requestBodies.push(JSON.parse(init.body));
        const replies = ['[{"region":"World","subCenterUids":[0]}]', '[{"region":"World","centerUid":0}]'];
        const reply = replies[Math.min(requestBodies.length - 1, replies.length - 1)];
        return { status: 200, ok: true, headers: { entries: () => [] }, text: async () => JSON.stringify({ choices: [{ message: { content: reply } }] }) };
    };
    const { graphCore } = buildEngine({
        lorebookEntries: [{ uid: 0, comment: 'A', content: 'something worth remembering.' }],
        fetchOverride,
    });
    await graphCore.load();
    await graphCore.waitForBootstrap();

    assert.ok(requestBodies.length >= 2, 'sanity: both Проход 1 and Проход 2 must have actually fired');
    for (const body of requestBodies) {
        assert.equal(body.max_tokens, 4000, `every model.generate call from the bootstrap must override the 1000-token engine default: ${JSON.stringify(body)}`);
    }
});

test('bootstrapFromLorebook() respects a configured bootstrapMaxTokens override, not just its own 4000 default', async () => {
    const requestBodies = [];
    const fetchOverride = async (url, init) => {
        requestBodies.push(JSON.parse(init.body));
        const replies = ['[{"region":"World","subCenterUids":[0]}]', '[{"region":"World","centerUid":0}]'];
        const reply = replies[Math.min(requestBodies.length - 1, replies.length - 1)];
        return { status: 200, ok: true, headers: { entries: () => [] }, text: async () => JSON.stringify({ choices: [{ message: { content: reply } }] }) };
    };
    const { graphCore, caller } = buildEngine({
        lorebookEntries: [{ uid: 0, comment: 'A', content: 'something worth remembering.' }],
        fetchOverride,
    });
    await call(caller, 'memoryGraph.configure', { bootstrapMaxTokens: 8000 });
    await graphCore.load();
    await graphCore.waitForBootstrap();

    assert.ok(requestBodies.length >= 2);
    for (const body of requestBodies) assert.equal(body.max_tokens, 8000);
});

test('bootstrapFromLorebook() aborts entirely (graph stays empty) when Проход 1 (skeleton) produces no usable region at all', async () => {
    const { graphCore, caller } = buildEngine({
        lorebookEntries: [{ uid: 0, comment: 'A', content: 'something worth remembering.' }],
        // Проход 2's ответ намеренно ВАЛИДНЫЙ и реально создал бы ноду,
        // если бы до него дошло — изолирует проверку именно на отказе
        // Прохода 1 (иначе тест прошёл бы и без этой проверки в коде,
        // просто споткнувшись о ту же переиспользованную "not JSON" на
        // Проходе 2 — реальная ловушка, поймана при написании этого теста).
        fetchReplies: ['this is not JSON at all', '[{"region":"World","centerUid":0}]'],
    });
    await graphCore.load();
    await graphCore.waitForBootstrap();
    assert.deepEqual((await call(caller, 'memoryGraph.nodes')).value, [], 'a failed skeleton pass must not leave a half-built graph');
});

test('bootstrapFromLorebook() aborts entirely (graph stays empty) when Проход 2 (additional centers) produces no usable center — a region with only sub-centers and no center is a cripple, not created', async () => {
    const { graphCore, caller } = buildEngine({
        lorebookEntries: [{ uid: 0, comment: 'A', content: 'something worth remembering.' }],
        fetchReplies: ['[{"region":"World","subCenterUids":[0]}]', 'this is not JSON at all'],
    });
    await graphCore.load();
    await graphCore.waitForBootstrap();
    assert.deepEqual((await call(caller, 'memoryGraph.nodes')).value, [], 'a failed centers pass must not leave orphaned sub-center-only nodes');
});

test('bootstrapFromLorebook(): a Проход 3 failure for ONE region does not block completion for OTHER regions or abort the bootstrap — the same "one failure does not block everything" principle as escalateToSideCar()', async () => {
    const entries = [
        { uid: 0, comment: 'A1', content: 'first region anchor.' },
        { uid: 1, comment: 'A2', content: 'first region second entry.' },
        { uid: 2, comment: 'B1', content: 'second region anchor.' },
        { uid: 3, comment: 'B2', content: 'second region second entry.' },
    ];
    // Проход 1/2 успешны (200 OK), Проход 3 региона "RegionA" (первый по
    // порядку в finalRegionPlans, 3-й вызов model.generate целиком) ПАДАЕТ
    // (500). RegionB тоже без связей (пустой ответ) — тест не про успех
    // Прохода 3, только про то, что один отказ не роняет весь бутстрап.
    let callIndex = 0;
    const fetchOverride = async () => {
        const index = callIndex;
        callIndex += 1;
        if (index === 2) return { status: 500, ok: false, headers: { entries: () => [] }, text: async () => 'boom' };
        const replies = [
            '[{"region":"RegionA","subCenterUids":[1]},{"region":"RegionB","subCenterUids":[3]}]',
            '[{"region":"RegionA","centerUid":0},{"region":"RegionB","centerUid":2}]',
            null, // index 2 — never reached, handled above (500)
            '[]',
        ];
        return { status: 200, ok: true, headers: { entries: () => [] }, text: async () => JSON.stringify({ choices: [{ message: { content: replies[index] } }] }) };
    };
    const { graphCore, caller } = buildEngine({ lorebookEntries: entries, fetchOverride });
    // Центр/под-центр минимумы бэкбона обнулены — иначе enforceBackboneConnectivity()
    // сама досоздаёт МЕЖрегиональные `backbone`-рёбра между A1/A2 и B1/B2
    // (обе пары — реальные центр+под-центр), заглушая то, что тест
    // проверяет (отсутствие ИМЕННО `related`-рёбер Прохода 3 в RegionA).
    await call(caller, 'memoryGraph.configure', { centerMinBackboneDegree: 0, subCenterMinDegree: 0 });

    await graphCore.load();
    await graphCore.waitForBootstrap();

    const nodes = (await call(caller, 'memoryGraph.nodes')).value;
    assert.equal(nodes.length, 4, 'the failed Проход 3 call must not have aborted the whole bootstrap — all 4 entries still become nodes');
    const a1 = nodes.find(n => n.label === 'A1');
    const a2 = nodes.find(n => n.label === 'A2');
    assert.equal(a1.degree + a2.degree, 0, 'RegionA got no "related" edges — its Проход 3 call failed');
});

test('bootstrapFromLorebook(): a SUCCESSFUL Проход 3 response creates a real "related" edge between two region members that never mention each other by name', async () => {
    const entries = [
        { uid: 0, comment: 'Anchor', content: 'the first entry of this region.' },
        { uid: 1, comment: 'Second', content: 'a second, thematically linked entry with no name overlap.' },
    ];
    let graphCoreRef;
    // Проход 3's ответ должен ссылаться на РЕАЛЬНЫЕ id нод графа (строки,
    // не lorebook uid) — они известны только ПОСЛЕ размещения Прохода 1/2,
    // поэтому fetch здесь читает текущее состояние графа налету через
    // замыкание на graphCoreRef, а не статичный текст.
    let callIndex = 0;
    const fetchOverride = async () => {
        const index = callIndex;
        callIndex += 1;
        if (index === 0) return { status: 200, ok: true, headers: { entries: () => [] }, text: async () => JSON.stringify({ choices: [{ message: { content: '[{"region":"Region","subCenterUids":[1]}]' } }] }) };
        if (index === 1) return { status: 200, ok: true, headers: { entries: () => [] }, text: async () => JSON.stringify({ choices: [{ message: { content: '[{"region":"Region","centerUid":0}]' } }] }) };
        const anchor = graphCoreRef.nodes().find(n => n.label === 'Anchor');
        const second = graphCoreRef.nodes().find(n => n.label === 'Second');
        const reply = JSON.stringify([{ from: anchor.id, to: second.id }]);
        return { status: 200, ok: true, headers: { entries: () => [] }, text: async () => JSON.stringify({ choices: [{ message: { content: reply } }] }) };
    };
    const { graphCore, caller } = buildEngine({ lorebookEntries: entries, fetchOverride });
    graphCoreRef = graphCore;

    await graphCore.load();
    await graphCore.waitForBootstrap();

    const nodes = (await call(caller, 'memoryGraph.nodes')).value;
    const anchor = nodes.find(n => n.label === 'Anchor');
    const second = nodes.find(n => n.label === 'Second');
    assert.equal(anchor.degree, 1, 'Проход 3 must have wired a real edge, even though neither entry mentions the other by name');
    assert.equal(anchor.edges[0].type, 'related', 'the edge type must distinguish it from organic "mentions"/active "backbone"');
    assert.equal(second.edges[0].to, anchor.id);
});

test('bootstrapFromLorebook() imports every lorebook entry as a graph node — anchors placed explicitly by the LLM passes, the rest via nearest-region embedding assignment', async () => {
    const { graphCore, caller } = buildEngine({
        lorebookEntries: [
            { uid: 0, comment: 'The Continent', content: 'A vast land split into three subcontinents.' },
            { uid: 1, comment: 'Giadian Empire', content: 'A technologically superior power east of the Republic.' },
            { uid: 2, comment: 'Revolution Festival', content: 'A yearly celebration with fireworks in the capital.' },
        ],
        // Проход 1: регион "World" с под-центрами 0 и 1. Проход 2: центр
        // региона — 0 (переиспользован, дедуп в attachToRegionByKey не даёт
        // вставить его дважды). Запись 2 не назначена ни тем, ни другим —
        // попадает через argmax-присвоение (pickNearestRegion), единственный
        // существующий регион.
        fetchReplies: ['[{"region":"World","subCenterUids":[0,1]}]', '[{"region":"World","centerUid":0}]'],
    });
    await graphCore.load();
    await graphCore.waitForBootstrap();

    const nodes = await call(caller, 'memoryGraph.nodes');
    assert.equal(nodes.value.length, 3, 'all three lorebook entries must become graph nodes');
    assert.ok(nodes.value.every(node => node.embedding && node.embedding.length === 4), 'every imported node must carry a real embedding');
    assert.deepEqual(nodes.value.map(n => n.label).sort(), ['Giadian Empire', 'Revolution Festival', 'The Continent']);
});

test('bootstrapFromLorebook() gives a curated ("constant": true) entry a higher auto-importance than an ordinary one — read straight from the WI entry, no SideCar call (решено с пользователем: "читаем из LB поля")', async () => {
    const { graphCore, caller } = buildEngine({
        lorebookEntries: [
            { uid: 0, comment: 'Core Fact', content: 'the foundational rule of this world.', constant: true, order: 100 },
            { uid: 1, comment: 'Minor Fact', content: 'a small unrelated detail nobody cares about.', constant: false, order: 100 },
        ],
        fetchReplies: ['[{"region":"Facts","subCenterUids":[0,1]}]', '[{"region":"Facts","centerUid":0}]'],
    });
    await graphCore.load();
    await graphCore.waitForBootstrap();
    const nodes = (await call(caller, 'memoryGraph.nodes')).value;
    const core = nodes.find(n => n.label === 'Core Fact');
    const minor = nodes.find(n => n.label === 'Minor Fact');
    assert.ok(core.importance > minor.importance, `constant entry (${core.importance}) must outscore a non-constant one (${minor.importance})`);
});

test('bootstrapFromLorebook() boosts importance for a node other entries actually mention, on top of its base WI-field score (решено с пользователем: "смотрим на количество соединений и проверяем")', async () => {
    const { graphCore, caller } = buildEngine({
        lorebookEntries: [
            { uid: 0, comment: 'Alice', content: 'Alice is the hero of this land.' },
            { uid: 1, comment: 'Lonely', content: 'a quiet corner nobody talks about.' },
            { uid: 2, comment: 'Bob', content: 'Bob talks to Alice every day in the market.' },
        ],
        // Alice = центр, Bob = под-центр (вставлен ПОСЛЕ Alice — mentions
        // "Alice" сработает внутри attachToRegionByKey). Lonely не назначен
        // ни тем, ни другим — попадёт через argmax, единственный регион.
        fetchReplies: ['[{"region":"People","subCenterUids":[2]}]', '[{"region":"People","centerUid":0}]'],
    });
    await graphCore.load();
    await graphCore.waitForBootstrap();
    const nodes = (await call(caller, 'memoryGraph.nodes')).value;
    const alice = nodes.find(n => n.label === 'Alice');
    const lonely = nodes.find(n => n.label === 'Lonely');
    assert.ok(alice.degree > 0, "Alice must actually end up mentioned by Bob's entry — otherwise this test proves nothing");
    assert.ok(alice.importance > lonely.importance, `a mentioned node (${alice.importance}) must outscore an unconnected one (${lonely.importance}), same base WI fields on both`);
});

test('bootstrapFromLorebook() places a region\'s designated center as a protected node — role comes from the LLM pass, not arrival order', async () => {
    const { graphCore, caller } = buildEngine({
        lorebookEntries: [{ uid: 0, comment: 'The Continent', content: 'A vast land split into three subcontinents, teeming with leviathans.' }],
        fetchReplies: ['[{"region":"World","subCenterUids":[0]}]', '[{"region":"World","centerUid":0}]'],
    });
    await graphCore.load();
    await graphCore.waitForBootstrap();

    const nodes = await call(caller, 'memoryGraph.nodes');
    assert.equal(nodes.value.length, 1);
    assert.equal(nodes.value[0].protectedNode, true, 'the very first node of a region is its center, and centers are protected (MEMORY_GRAPH.md)');
    assert.ok(nodes.value[0].regionId, 'must actually be attached to a region, not left staged');
});

test('checkAndPlace(): a genuinely UNRELATED second node can seed its OWN dartboard region instead of being forced into the first — a region with no center yet must be a NEUTRAL candidate, not a permanently-losing one', async () => {
    // Перенесено с бутстрапа на checkAndPlace() — LLM-driven семантический
    // бутстрап (MEMORY_GRAPH.md) больше не ходит через дартборд-каскад
    // (vectorProbsForAllRegions/decideFirstPlacement) вообще, только
    // checkAndPlace() (органический рост) всё ещё на нём — решено с
    // пользователем явно. Регрессия, которую этот тест доказывает, теперь
    // актуальна только здесь.
    //
    // Слова подобраны так, чтобы fakeEmbed() дал ЧИСТЫЕ ортогональные векторы
    // (ни одного общего слова, каждый набор целиком хэшируется в своё
    // измерение из 4) — реальный, а не притянутый пример "совсем другой
    // темы": cosineSimilarity=0, сдвинутый сходство ровно 0.5, СТОЛЬКО ЖЕ,
    // сколько нейтральная базовая линия у любого пустого региона после
    // фикса. Это прямой тест на self-reinforcing баг: до фикса пустой
    // регион имел сходство 0 (хуже любого совпадения, а не "неизвестно"),
    // поэтому единственный уже занятый регион побеждал АБСОЛЮТНО ВСЕГДА —
    // ни одна вторая тема никогда не получала свой регион.
    const { graphCore } = buildEngine({
        fetchReplies: [
            '{"label":"Topic Alpha","content":"alpha bravo charlie delta echo hotel juliet mike","importance":5}',
            '{"label":"Topic Beta","content":"golf lima oscar quebec sierra yankee","importance":5}',
        ],
    });
    await graphCore.load();
    await graphCore.waitForBootstrap(); // пустой Lorebook -> нет-оп

    // Первые ДВА вызова гарантированно "сильное изменение" (нет базовой
    // линии distanceStats, count<2) — isStrongChange() всегда true.
    // ВАЖНО: эмбединг для РАЗМЕЩЕНИЯ считается из АРГУМЕНТА checkAndPlace()
    // (контекст, не content ответа модели) — те же ортогональные слова
    // нужны ЗДЕСЬ, не в fetchReplies выше (реальная ловушка при переносе
    // теста: с обычным текстом контекста оба вызова считали ПОХОЖИЙ
    // эмбединг, и регрессия просто не воспроизводилась).
    await graphCore.checkAndPlace('alpha bravo charlie delta echo hotel juliet mike');
    await graphCore.checkAndPlace('golf lima oscar quebec sierra yankee');

    const nodes = graphCore.nodes();
    const first = nodes.find(n => n.label === 'Topic Alpha');
    const second = nodes.find(n => n.label === 'Topic Beta');
    assert.equal(first.regionId, '0:0', 'first node still seeds the bootstrap region 0:0, unchanged');
    assert.notEqual(second.regionId, '0:0', 'an unrelated second topic must NOT be dragged into the first region just because it is the only one with a center yet');
});

test('a region past capacity (23) queues its weakest CLUSTER for reconsolidation instead of evicting immediately — reconsolidation is preferred, it preserves more information than outright deletion', async () => {
    const entries = Array.from({ length: 24 }, (_, i) => ({ uid: i, comment: `Entry ${i}`, content: `Distinct lore fact number ${i} about the world, unrelated to the others.` }));
    const { graphCore, caller } = buildEngine({
        lorebookEntries: entries,
        // Один регион "Big": центр = Entry 0, под-центры = Entry 1/2 (те же
        // 3 защищённых узла, что и раньше). Остальные 21 (Entry 3..23) не
        // назначены ни тем, ни другим — попадают через argmax, единственный
        // существующий регион, в том же порядке (uid по возрастанию),
        // сохраняя "старейшие непротестированные" ту же семантику.
        fetchReplies: ['[{"region":"Big","subCenterUids":[1,2]}]', '[{"region":"Big","centerUid":0}]', '[]'],
    });

    await graphCore.load();
    await graphCore.waitForBootstrap();

    const nodes = (await call(caller, 'memoryGraph.nodes')).value;
    assert.equal(nodes.length, 24, 'reconsolidation QUEUES instead of evicting immediately — the region temporarily exceeds capacity, same principle already accepted for the "all protected" edge case');

    const queue = graphCore.reconsolidationQueue();
    assert.equal(queue.length, 1);
    assert.equal(queue[0].nodeIds.length, 3, 'reconsolidationMinCluster (3) weakest non-protected nodes must be queued together');

    const center = nodes.find(n => n.protectedNode);
    assert.ok(!queue[0].nodeIds.includes(center.id), 'the protected center must never be queued for reconsolidation');

    const queuedLabels = nodes.filter(n => queue[0].nodeIds.includes(n.id)).map(n => n.label).sort();
    // Entry 1/2 — под-центры по умолчанию (subCentersPerRegion:2), защищены
    // как и центр (Entry 0) — первые незащищённые кандидаты теперь Entry 3-5.
    assert.deepEqual(queuedLabels, ['Entry 3', 'Entry 4', 'Entry 5'], 'all bootstrap nodes tie at weight 0, so the OLDEST 3 UNPROTECTED (stable sort, after the center + 2 sub-centers) must be the ones queued');
});

test('sweeping a matured reconsolidation queue folds the weak cluster into ONE denser node, shrinking the region back down', async () => {
    const entries = Array.from({ length: 24 }, (_, i) => ({ uid: i, comment: `Entry ${i}`, content: `Distinct lore fact number ${i} about the world, unrelated to the others.` }));
    const { graphCore } = buildEngine({
        lorebookEntries: entries,
        // 3 ответа бутстрапа (Проход 1/2/3), 4-й — на ПОЗДНИЙ вызов
        // askSideCarForReconsolidation() из sweepReconsolidationQueue() ниже.
        fetchReplies: [
            '[{"region":"Big","subCenterUids":[1,2]}]',
            '[{"region":"Big","centerUid":0}]',
            '[]',
            '{"label":"Folded Entries","content":"A compressed summary of several minor facts.","importance":2}',
        ],
    });

    await graphCore.load();
    await graphCore.waitForBootstrap();
    assert.equal(graphCore.nodes().length, 24);

    for (let i = 0; i < 8; i += 1) await graphCore.checkAndPlace('   '); // advance turnCounter past reconsolidationQueueMaxTurns without touching SideCar
    await graphCore.sweepReconsolidationQueue();

    const nodes = graphCore.nodes();
    assert.equal(nodes.length, 22, '3 weak nodes folded into 1 -> net -2 (24 -> 22)');
    assert.ok(nodes.some(n => n.label === 'Folded Entries'), "the reconsolidated node must carry SideCar's compressed content");
    assert.equal(graphCore.reconsolidationQueue().length, 0, 'the matured entry must be consumed');
});

test('enforceRegionCapacity() falls back to plain eviction when fewer than reconsolidationMinCluster candidates are eligible', async () => {
    const entries = [
        { uid: 0, comment: 'Center', content: 'a shared lore fact about this tiny region, entry zero.' },
        { uid: 1, comment: 'Second', content: 'a shared lore fact about this tiny region, entry one.' },
        { uid: 2, comment: 'Third', content: 'a shared lore fact about this tiny region, entry two.' },
    ];
    const { graphCore, caller } = buildEngine({
        lorebookEntries: entries,
        // Только Entry 0 получает роль (центр, через Проход 1+2 — uid
        // переиспользован, дедуп в attachToRegionByKey не вставляет
        // дважды). Entry 1/2 падают через argmax как ОБЫЧНЫЕ ноды.
        fetchReplies: ['[{"region":"Tiny","subCenterUids":[0]}]', '[{"region":"Tiny","centerUid":0}]', '[]'],
    });
    // Tight custom cap, set BEFORE load()/bootstrap: the 3rd entry alone
    // overflows a region that only ever had 2 non-protected candidates —
    // below reconsolidationMinCluster (3), so it can never queue.
    // `subCentersPerRegion: 0` — без него Entry 1 (первая ОБЫЧНАЯ вставка
    // через argmax, forceRole=null) авто-назначилась бы под-центром по
    // порядку прибытия (дефолт subCentersPerRegion:2) и стала бы защищённой
    // — не то, что тестируется здесь. Явные роли (forceRole) из Прохода 1/2
    // ЭТУ настройку не используют вовсе — Entry 0 остаётся центром
    // независимо от неё.
    await call(caller, 'memoryGraph.configure', { maxNodesPerRegion: 2, subCentersPerRegion: 0 });
    await graphCore.load();
    await graphCore.waitForBootstrap();

    const nodes = graphCore.nodes();
    assert.equal(nodes.length, 2, 'below reconsolidationMinCluster -> must fall back to plain eviction, not stay over capacity waiting on a queue that will never trigger');
    assert.equal(graphCore.reconsolidationQueue().length, 0);
    assert.ok(nodes.some(n => n.protectedNode), 'the protected center must survive either way');
});

// --- Бэкбон-связность по роли узла (решено с пользователем, числами:
// "малая нода - не более 3 связей, под-центр - 10-15, центр - не менее 4
// [к другим центрам/под-центрам]") ------------------------------------

test('the 2nd and 3rd nodes to arrive in a region become its protected sub-centers (subCentersPerRegion: 2 by default) — a 4th stays ordinary', async () => {
    // Ручное создание, не бутстрап — это тест дартборд-каскада (attachToRegion(),
    // авто-роль по порядку прибытия). Семантический бутстрап роль назначает
    // ЯВНО (forceRole из LLM-прохода), не по порядку — эта регрессия больше
    // не применима к bootstrapFromLorebook() (решено с пользователем).
    const { caller } = buildEngine();
    await call(caller, 'memoryGraph.nodes.create', { label: 'Center', content: 'the anchor of this region.', sector: 0, ring: 0 });
    await call(caller, 'memoryGraph.nodes.create', { label: 'SubOne', content: 'a second, unrelated node in the same region.', sector: 0, ring: 0 });
    await call(caller, 'memoryGraph.nodes.create', { label: 'SubTwo', content: 'a third, unrelated node in the same region.', sector: 0, ring: 0 });
    await call(caller, 'memoryGraph.nodes.create', { label: 'Plain', content: 'a fourth, unrelated node in the same region.', sector: 0, ring: 0 });

    const nodes = (await call(caller, 'memoryGraph.nodes')).value;
    const regions = (await call(caller, 'memoryGraph.regions')).value;
    const center = nodes.find(n => n.label === 'Center');
    const subOne = nodes.find(n => n.label === 'SubOne');
    const subTwo = nodes.find(n => n.label === 'SubTwo');
    const plain = nodes.find(n => n.label === 'Plain');

    const region = regions.find(r => r.centerNodeId === center.id);
    assert.deepEqual([...region.subCenterIds].sort(), [subOne.id, subTwo.id].sort(), 'exactly the 2nd and 3rd arrivals must be recorded as this region\'s sub-centers');
    assert.equal(subOne.protectedNode, true, 'a sub-center is protected, same as a center');
    assert.equal(subTwo.protectedNode, true);
    assert.equal(plain.protectedNode, false, 'the 4th arrival is past subCentersPerRegion (2) — must stay an ordinary node');
});

test('an ordinary node never exceeds ordinaryMaxDegree (3) connections, even when many other entries mention it by name', async () => {
    const { caller } = buildEngine();
    await call(caller, 'memoryGraph.configure', { subCentersPerRegion: 0 });
    // "Seed" claims region 0:0's center slot so "Bob" (created right after,
    // same region) is a genuinely ORDINARY node, not a center himself.
    await call(caller, 'memoryGraph.nodes.create', { label: 'Seed', content: 'the anchor of this region, unrelated to Bob.', sector: 0, ring: 0 });
    await call(caller, 'memoryGraph.nodes.create', { label: 'Bob', content: 'an ordinary resident of this region.', sector: 0, ring: 0 });
    // Five DIFFERENT mentioners, each its own region's center (so the cap
    // under test is Bob's own, not weakened by the mentioner also being ordinary).
    for (let i = 0; i < 5; i += 1) {
        await call(caller, 'memoryGraph.nodes.create', { label: `Mentioner${i}`, content: `Mentioner${i} often talks to Bob about the weather.`, sector: (i + 1) % 5, ring: 0 });
    }

    const nodes = (await call(caller, 'memoryGraph.nodes')).value;
    const bob = nodes.find(n => n.label === 'Bob');
    assert.equal(bob.protectedNode, false, 'sanity: Bob must actually be ordinary for this cap to mean anything');
    assert.equal(bob.degree, 3, 'five entries mentioned Bob by name, but an ordinary node must cap at 3');
});

test('sweepBackbone()/enforceBackboneConnectivity() gives each center at least centerMinBackboneDegree PEER connections to other centers/sub-centers', async () => {
    const { caller } = buildEngine();
    await call(caller, 'memoryGraph.configure', { subCentersPerRegion: 0 });
    const created = [];
    for (let sector = 0; sector < 5; sector += 1) {
        const result = await call(caller, 'memoryGraph.nodes.create', { label: `Center${sector}`, content: `unique unrelated lore about place ${sector}.`, sector, ring: 0 });
        created.push(result.value.nodeId);
    }
    const swept = await call(caller, 'memoryGraph.sweepBackbone');
    assert.ok(swept.ok);

    const nodes = (await call(caller, 'memoryGraph.nodes')).value;
    for (const id of created) {
        const node = nodes.find(n => n.id === id);
        const peerEdges = node.edges.filter(edge => created.includes(edge.to));
        assert.ok(peerEdges.length >= 4, `center "${node.label}" only has ${peerEdges.length} peer connections (need >= centerMinBackboneDegree=4) — with 5 centers total, 4 is literally "connect to everyone else"`);
        assert.ok(peerEdges.every(edge => edge.type === 'backbone'), 'organic mentions never fired here (unrelated content) — every peer edge must be the actively-created backbone type');
    }
});

test('sweepBackbone() fills a sub-center up to subCenterMinDegree from other backbone nodes (any role, not peer-restricted like a center)', async () => {
    const { caller } = buildEngine();
    await call(caller, 'memoryGraph.configure', { subCentersPerRegion: 1, subCenterMinDegree: 5, subCenterMaxDegree: 6, centerMinBackboneDegree: 0 });
    const subIds = [];
    for (let sector = 0; sector < 4; sector += 1) {
        await call(caller, 'memoryGraph.nodes.create', { label: `C${sector}`, content: `unrelated center lore ${sector}.`, sector, ring: 0 });
        const sub = await call(caller, 'memoryGraph.nodes.create', { label: `S${sector}`, content: `unrelated sub lore ${sector}.`, sector, ring: 0 });
        subIds.push(sub.value.nodeId);
    }
    await call(caller, 'memoryGraph.sweepBackbone');

    const nodes = (await call(caller, 'memoryGraph.nodes')).value;
    for (const id of subIds) {
        const node = nodes.find(n => n.id === id);
        assert.ok(node.degree >= 5, `sub-center "${node.label}" has degree ${node.degree}, below subCenterMinDegree (5)`);
    }
});

test('sweepBackbone() never pushes a sub-center past subCenterMaxDegree, even when its minimum demands more than that', async () => {
    const { caller } = buildEngine();
    // Min (20) deliberately unreachable — far more than both the max (5)
    // AND the number of other backbone nodes actually available (7)  —
    // proves the ceiling wins over an impossible-to-satisfy minimum.
    await call(caller, 'memoryGraph.configure', { subCentersPerRegion: 1, subCenterMinDegree: 20, subCenterMaxDegree: 5, centerMinBackboneDegree: 0 });
    const subIds = [];
    for (let sector = 0; sector < 4; sector += 1) {
        await call(caller, 'memoryGraph.nodes.create', { label: `C${sector}`, content: `unrelated center lore ${sector}.`, sector, ring: 0 });
        const sub = await call(caller, 'memoryGraph.nodes.create', { label: `S${sector}`, content: `unrelated sub lore ${sector}.`, sector, ring: 0 });
        subIds.push(sub.value.nodeId);
    }
    await call(caller, 'memoryGraph.sweepBackbone');

    const nodes = (await call(caller, 'memoryGraph.nodes')).value;
    for (const id of subIds) {
        const node = nodes.find(n => n.id === id);
        assert.ok(node.degree <= 5, `sub-center "${node.label}" has degree ${node.degree}, past subCenterMaxDegree (5)`);
    }
});

test('a manually-created node does NOT get backbone-filled automatically — sweepBackbone() must be triggered, same as any other sweep', async () => {
    const { caller } = buildEngine();
    await call(caller, 'memoryGraph.configure', { subCentersPerRegion: 0 });
    for (let sector = 0; sector < 5; sector += 1) {
        await call(caller, 'memoryGraph.nodes.create', { label: `Center${sector}`, content: `unrelated lore ${sector}.`, sector, ring: 0 });
    }
    const nodes = (await call(caller, 'memoryGraph.nodes')).value;
    assert.ok(nodes.every(n => (n.degree ?? 0) === 0), 'manual creation alone must not invoke enforceBackboneConnectivity()');
});

test('a near-duplicate pair detected on insertion is queued for SideCar merge, NOT merged immediately — matures after mergeQueueMaxTurns and combines into one node', async () => {
    const entries = [
        { uid: 0, comment: 'Tavern Door', content: 'The old tavern door creaks in the evening light.' },
        { uid: 1, comment: 'Tavern Door Again', content: 'The old tavern door creaks loudly in the evening light.' },
    ];
    const { graphCore } = buildEngine({
        lorebookEntries: entries,
        // Проход 1/2/3 (бутстрап, 2 записи в одном регионе — под-центр
        // ловит near-duplicate против центра внутри attachToRegionByKey()),
        // 4-й ответ — ПОЗДНИЙ вызов askSideCarForMerge() из sweepMergeQueue() ниже.
        fetchReplies: [
            '[{"region":"Door","subCenterUids":[1]}]',
            '[{"region":"Door","centerUid":0}]',
            '[]',
            '{"label":"Tavern Door","content":"An old tavern door that creaks, sometimes loudly, in the evening light.","importance":3}',
        ],
    });

    await graphCore.load();
    await graphCore.waitForBootstrap();

    assert.equal(graphCore.nodes().length, 2, 'both near-duplicate entries exist independently right after bootstrap');
    assert.equal(graphCore.mergeQueue().length, 1, 'the near-duplicate pair must be QUEUED, not merged immediately (decided with the user explicitly)');

    // Advance turnCounter past mergeQueueMaxTurns (8) with blank context —
    // checkAndPlace() increments turnCounter unconditionally even when it
    // returns 'skipped', so this never touches SideCar or embeddings.
    for (let i = 0; i < 8; i += 1) await graphCore.checkAndPlace('   ');
    await graphCore.sweepMergeQueue();

    const nodes = graphCore.nodes();
    assert.equal(nodes.length, 1, 'the confirmed duplicate pair must be merged into exactly ONE node');
    assert.equal(nodes[0].label, 'Tavern Door', "the merged node carries SideCar's combined content, not either original's");
    assert.equal(nodes[0].protectedNode, true, 'the first entry was the region\'s protected center — merging must not lose that protection');
    assert.equal(graphCore.mergeQueue().length, 0, 'the matured queue entry must be consumed either way');
});

test('a merge candidate queued as a side effect of bootstrapFromLorebook() is persisted immediately — it must survive a reload, not only the next sweep', async () => {
    const entries = [
        { uid: 0, comment: 'Tavern Door', content: 'The old tavern door creaks in the evening light.' },
        { uid: 1, comment: 'Tavern Door Again', content: 'The old tavern door creaks loudly in the evening light.' },
    ];
    const { engine, graphCore } = buildEngine({
        lorebookEntries: entries,
        fetchReplies: ['[{"region":"Door","subCenterUids":[1]}]', '[{"region":"Door","centerUid":0}]', '[]'],
    });

    await graphCore.load();
    await graphCore.waitForBootstrap();
    assert.equal(graphCore.mergeQueue().length, 1, 'sanity: bootstrap really queued a candidate in-memory');

    // Simulate a reload: a SECOND Core instance reading the SAME persisted
    // storage (namespace is a fixed string, not tied to the caller id) —
    // no sweep has run yet, so this only proves whether attachToRegion()'s
    // side effect was actually WRITTEN to storage, not just held in memory.
    const reloadedGraphCore = createMemoryGraphCore(engine.registerCaller('core.memoryGraph.reloaded', 'cores', { tier: 'official' }));
    await reloadedGraphCore.load();
    await reloadedGraphCore.waitForBootstrap();

    assert.equal(reloadedGraphCore.mergeQueue().length, 1, 'the queued merge candidate must have been persisted by bootstrapFromLorebook() itself, not lost until the next sweep');
});

test('sweepMergeQueue() does NOT touch a queued pair before mergeQueueMaxTurns (8) have actually elapsed — it is a real timer, not immediate on next sweep', async () => {
    const entries = [
        { uid: 0, comment: 'Tavern Door', content: 'The old tavern door creaks in the evening light.' },
        { uid: 1, comment: 'Tavern Door Again', content: 'The old tavern door creaks loudly in the evening light.' },
    ];
    const { graphCore } = buildEngine({
        lorebookEntries: entries,
        // Ход не созревает до mergeQueueMaxTurns (8) в этом тесте вообще —
        // askSideCarForMerge() не зовётся ни разу, 4-й ответ ниже не
        // расходуется, оставлен для симметрии с соседними тестами.
        fetchReplies: [
            '[{"region":"Door","subCenterUids":[1]}]',
            '[{"region":"Door","centerUid":0}]',
            '[]',
            '{"label":"Tavern Door","content":"Combined.","importance":3}',
        ],
    });

    await graphCore.load();
    await graphCore.waitForBootstrap();
    assert.equal(graphCore.mergeQueue().length, 1);

    // Sweep immediately, and again after only 3 of the required 8 turns —
    // neither must resolve the pair yet.
    await graphCore.sweepMergeQueue();
    assert.equal(graphCore.nodes().length, 2, 'sweeping right away must not merge — the pair has not aged at all yet');
    for (let i = 0; i < 3; i += 1) await graphCore.checkAndPlace('   ');
    await graphCore.sweepMergeQueue();
    assert.equal(graphCore.nodes().length, 2, 'only 3 of the required 8 turns have passed — still too early');
    assert.equal(graphCore.mergeQueue().length, 1, 'the entry must still be sitting in the queue, untouched');
});

test('merging redirects a THIRD node\'s edge to the survivor instead of dropping it — this is a merge, not an eviction', async () => {
    const entries = [
        { uid: 0, comment: 'Alpha', content: 'a tavern doorway of old wood with rusted brass hinges, worn smooth over the years.' },
        { uid: 1, comment: 'Alpha Two', content: 'a tavern doorway of old wood with rusted brass hinges, worn smooth across the years.' }, // near-duplicate of Alpha
        { uid: 2, comment: 'Witness', content: 'Alpha stands quietly nearby, watching the doorway every night.' }, // mentions "Alpha" by name -> gets an edge to it
    ];
    const { graphCore, caller } = buildEngine({
        lorebookEntries: entries,
        // Alpha = центр (Проход 1+2), Alpha Two = под-центр (Проход 1) —
        // near-duplicate детектируется против центра при вставке. Witness
        // падает через argmax (forceRole:'ordinary' — не авто-подцентр,
        // см. attachToRegionByKey()'s doc-comment) и мимоходом упоминает
        // "Alpha" по имени. 4-й ответ — ПОЗДНИЙ askSideCarForMerge().
        fetchReplies: [
            '[{"region":"Door","subCenterUids":[1]}]',
            '[{"region":"Door","centerUid":0}]',
            '[]',
            '{"label":"Alpha Merged","content":"Combined.","importance":3}',
        ],
    });
    // Это тест на merge/переадресацию рёбер, не на бэкбон-фичу — без этого
    // Witness (argmax, 'ordinary') всё равно ОСТАЛСЯ бы обычным (фикс
    // forceRole:'ordinary' это гарантирует независимо от настройки), но
    // subCentersPerRegion:0 оставлен на всякий случай для симметрии со
    // старой версией теста — enforceBackboneConnectivity() не должен
    // досоздать Witness↔"Alpha Two" ребро сверх органического Witness→Alpha.
    await call(caller, 'memoryGraph.configure', { subCentersPerRegion: 0 });
    await graphCore.load();
    await graphCore.waitForBootstrap();
    const witnessBefore = graphCore.nodes().find(n => n.label === 'Witness');
    assert.equal(witnessBefore.degree, 1, 'Witness must have gotten a real "mentions" edge to Alpha at insertion time');
    assert.equal(graphCore.mergeQueue().length, 1, 'Alpha and Alpha Two must be queued as a near-duplicate pair');

    for (let i = 0; i < 8; i += 1) await graphCore.checkAndPlace('   ');
    await graphCore.sweepMergeQueue();

    const nodes = graphCore.nodes();
    assert.equal(nodes.length, 2, 'Alpha + Alpha Two merged into one, Witness stays separate');
    const merged = nodes.find(n => n.label === 'Alpha Merged');
    const witnessAfter = nodes.find(n => n.label === 'Witness');
    assert.ok(merged, 'the merged node must exist under SideCar\'s combined label');
    assert.equal(witnessAfter.degree, 1, 'Witness must still show exactly one edge — REDIRECTED, not dropped');
    assert.equal(witnessAfter.edges[0].to, merged.id, "Witness's edge must now point at the MERGED node, not a dangling old id");
});

test('sweepMergeQueue() leaves both nodes untouched when SideCar judges them genuinely distinct', async () => {
    const entries = [
        { uid: 0, comment: 'Tavern Door', content: 'The old tavern door creaks in the evening light.' },
        { uid: 1, comment: 'Tavern Door Again', content: 'The old tavern door creaks loudly in the evening light.' },
    ];
    const { graphCore } = buildEngine({
        lorebookEntries: entries,
        fetchReplies: ['[{"region":"Door","subCenterUids":[1]}]', '[{"region":"Door","centerUid":0}]', '[]', '{"distinct":true}'],
    });

    await graphCore.load();
    await graphCore.waitForBootstrap();
    assert.equal(graphCore.mergeQueue().length, 1);

    for (let i = 0; i < 8; i += 1) await graphCore.checkAndPlace('   ');
    await graphCore.sweepMergeQueue();

    assert.equal(graphCore.nodes().length, 2, 'SideCar declined the merge — both original nodes must survive untouched');
    assert.equal(graphCore.mergeQueue().length, 0, 'the queue entry is still consumed either way — it does not retry forever');
});

test('bootstrapFromLorebook() skips entries with empty content — nothing to embed or place', async () => {
    const { graphCore, caller } = buildEngine({
        lorebookEntries: [
            { uid: 0, comment: 'Real entry', content: 'Something with real content in it.' },
            { uid: 1, comment: 'Empty entry', content: '' },
        ],
        // Пустая запись отфильтровывается ДО Прохода 1 (rawEntries) — модель
        // её вообще не увидит, остаётся ровно одна валидная запись (uid 0).
        fetchReplies: ['[{"region":"World","subCenterUids":[0]}]', '[{"region":"World","centerUid":0}]'],
    });
    await graphCore.load();
    await graphCore.waitForBootstrap();

    const nodes = await call(caller, 'memoryGraph.nodes');
    assert.equal(nodes.value.length, 1);
    assert.equal(nodes.value[0].label, 'Real entry');
});

test('an already-populated graph does NOT re-run the lorebook bootstrap on load() — bootstrap is a one-time, empty-graph-only operation', async () => {
    const { graphCore: firstGraph, caller: firstCaller, engine } = buildEngine({
        lorebookEntries: [{ uid: 0, comment: 'Seed', content: 'The founding fact of this world.' }],
        fetchReplies: ['[{"region":"World","subCenterUids":[0]}]', '[{"region":"World","centerUid":0}]'],
    });
    await firstGraph.load();
    await firstGraph.waitForBootstrap();
    const afterFirstLoad = await call(firstCaller, 'memoryGraph.nodes');
    assert.equal(afterFirstLoad.value.length, 1);

    // A second load() call on the SAME already-populated core must not duplicate the import.
    await firstGraph.load();
    await firstGraph.waitForBootstrap();
    const afterSecondLoad = await call(firstCaller, 'memoryGraph.nodes');
    assert.equal(afterSecondLoad.value.length, 1, 'load() must be idempotent — it must not re-import into an already-populated graph');
});

// --- checkAndPlace() end-to-end -------------------------------------------

test('checkAndPlace() creates a node via SideCar on the very first call (no baseline yet, always "strong")', async () => {
    const { graphCore, caller } = buildEngine();
    await graphCore.load();
    await graphCore.waitForBootstrap();

    const result = await graphCore.checkAndPlace('The player enters a dark cave and finds an old sword.');

    assert.equal(result.status, 'placed');
    const nodes = await call(caller, 'memoryGraph.nodes');
    assert.equal(nodes.value.length, 1);
    assert.equal(nodes.value[0].label, 'Test Fact');
    assert.equal(nodes.value[0].gameTime, null, 'RP Time is "disabled" in this test setup — gameTime must degrade to null, not throw');
});

test('checkAndPlace() with blank context text is skipped — nothing to embed', async () => {
    const { graphCore, caller } = buildEngine();
    await graphCore.load();
    await graphCore.waitForBootstrap();

    const result = await graphCore.checkAndPlace('   ');

    assert.equal(result.status, 'skipped');
    assert.deepEqual((await call(caller, 'memoryGraph.nodes')).value, []);
});

// --- Real Lorebook Core integration (not the synchronous fake above) -----
// Found live in the browser harness: `harness/engine-wiring.js` used to run
// `lorebookCore.scan()` and `memoryGraphCore.load()` in the SAME
// `Promise.all([...])`. The fake `lorebook.*` registered earlier in this
// file is a synchronous closure, so it could never reproduce this — the
// real `cores/lorebook/index.js`'s `scan()` does genuine awaited I/O
// (`stLorebook.rawState` then one `stLorebook.load` per book) BEFORE it
// assigns `books`/`summaries`, so racing the two let the graph's read win
// sometimes and see an empty book list — the graph bootstrapped from
// nothing even though a real, non-empty Lorebook existed. Confirmed
// deterministic (5/5 runs) with a throwaway repro script before fixing
// `engine-wiring.js` to await `scan()` to completion first.

function fakeStLorebookAsync(entries) {
    return {
        rawState: async () => { await new Promise(r => setTimeout(r, 5)); return { selectedWorldInfo: ['Global'] }; },
        load: async () => { await new Promise(r => setTimeout(r, 5)); return { entries }; },
        save: async () => {},
    };
}

function buildRealLorebookAndGraph(entries, { fetchReplies = [] } = {}) {
    const engine = createEngine();
    const context = {};
    const fakeSt = fakeStLorebookAsync(entries);
    const stLorebookHost = engine.registerCaller('service.stLorebook', 'services', { tier: 'official' });
    stLorebookHost.own.register('stLorebook.rawState', fakeSt.rawState);
    stLorebookHost.own.register('stLorebook.load', fakeSt.load);
    stLorebookHost.own.register('stLorebook.save', fakeSt.save);

    const macrosHost = engine.registerCaller('core.macros', 'cores', { tier: 'official' });
    macrosHost.own.register('macros.setValue', () => {});
    macrosHost.own.register('macros.clearValue', () => {});

    const embeddingHost = engine.registerCaller('service.embedding', 'services', { tier: 'official' });
    embeddingHost.own.register('embedding.compute', params => fakeEmbed(params?.text));

    const trackingHost = engine.registerCaller('core.tracking', 'cores', { tier: 'official' });
    trackingHost.own.register('tracking.fields', () => { throw new Error('tracking: unknown tracker "rp-time".'); });

    // Семантический бутстрап зовёт model.generate (3 прохода) — этому
    // хелперу раньше это было не нужно (старый бутстрап SideCar не звал
    // вовсе). Тот же набор сервисов, что и в buildEngine() выше —
    // `storage.settings.*` (через Settings Core) нужен даже
    // `modelsCore.configureWorkers()`, не только самому бутстрапу.
    const settingsContext = { extensionSettings: {}, saveSettingsDebounced: () => {} };
    registerExtensionSettingsService(engine.buses.services, { getContext: () => settingsContext });
    registerChatMetadataService(engine.buses.services, { getContext: () => context });
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));
    registerHttpService(engine.buses.network, { fetch: fakeFetchSequence(fetchReplies) });
    const modelsHost = engine.registerCaller('core.models.internal', 'cores', { tier: 'official', networkAccess: true });
    const modelsCore = createInternalEngineModelsCore(modelsHost);
    modelsCore.configureWorkers([{ id: 'fast', endpoint: 'https://fast.example.com', model: 'm1', format: 'openai' }]);

    const lorebookCore = createLorebookCore(engine.registerCaller('core.lorebook', 'cores', { tier: 'official' }));
    const graphCore = createMemoryGraphCore(engine.registerCaller('core.memoryGraph', 'cores', { tier: 'official' }));
    return { lorebookCore, graphCore };
}

test('memoryGraphCore.load() bootstraps from a REAL (async) Lorebook Core once scan() has genuinely finished — the exact sequencing harness/engine-wiring.js relies on', async () => {
    const entries = { 0: { uid: 0, comment: 'Seed', content: 'The founding fact of this world.', key: [] } };
    const { lorebookCore, graphCore } = buildRealLorebookAndGraph(entries, {
        fetchReplies: ['[{"region":"World","subCenterUids":[0]}]', '[{"region":"World","centerUid":0}]'],
    });

    await lorebookCore.scan();
    await graphCore.load();
    await graphCore.waitForBootstrap();

    assert.equal(graphCore.nodes().length, 1, 'the real, already-scanned Lorebook entry must have been imported');
});

// --- Phase 2: маяки+маршрут через реальный generation.beforeSend ----------

test('the beforeSend stage injects a Memory message built from the graph\'s own beacons+route into outgoing chat', async () => {
    const entries = [
        { uid: 0, comment: 'Marcus', content: 'Marcus runs the old tavern near the market square.' },
        { uid: 1, comment: 'Elena', content: 'Elena often visits Marcus to trade rare herbs.' }, // mentions Marcus -> edge
        { uid: 2, comment: 'Ruins', content: 'Elena explores Ruins searching for lost artifacts.' }, // mentions Elena -> edge
    ];
    const { graphCore, pipelineCore } = buildEngine({
        lorebookEntries: entries,
        // Marcus = центр, Elena = под-центр (упоминает "Marcus" при
        // вставке). Ruins падает через argmax ('ordinary') и упоминает
        // "Elena" — та же цепочка рёбер, что и раньше.
        fetchReplies: ['[{"region":"Story","subCenterUids":[1]}]', '[{"region":"Story","centerUid":0}]', '[]'],
    });
    await graphCore.load();
    await graphCore.waitForBootstrap();

    const outgoing = [{ mes: 'Tell me more about Marcus and his tavern near the market.' }];
    const result = await pipelineCore.run({ pipelineId: 'generation.beforeSend', input: { chat: outgoing } });

    assert.equal(result.ok, true);
    assert.equal(outgoing.length, 2, 'exactly one Memory message must have been unshifted ahead of the real outgoing message');
    assert.equal(outgoing[0].is_system, true);
    assert.equal(outgoing[0].name, 'Memory');
    assert.ok(outgoing[0].mes.includes('Marcus'), 'the injected text must mention the graph\'s own nodes');
    assert.ok(outgoing[0].mes.includes('runs the old tavern near the market square.'), 'and their actual content, not just labels');
    assert.equal(outgoing[1].mes, 'Tell me more about Marcus and his tavern near the market.', 'the real outgoing message must stay in place, right after the injected memory');
});

test('the beforeSend stage contributes nothing when the graph has no placed nodes yet', async () => {
    const { graphCore, pipelineCore } = buildEngine(); // no lorebookEntries -> empty graph
    await graphCore.load();
    await graphCore.waitForBootstrap();

    const outgoing = [{ mes: 'hello' }];
    await pipelineCore.run({ pipelineId: 'generation.beforeSend', input: { chat: outgoing } });

    assert.deepEqual(outgoing, [{ mes: 'hello' }]);
});

test('a node off the beacon route, but one edge from it, gets pulled in as noise — with a seeded random for reproducibility', async () => {
    const entries = [
        { uid: 0, comment: 'Marcus', content: 'Marcus runs the old tavern near the market square.' },
        { uid: 1, comment: 'Elena', content: 'Elena often visits Marcus to trade rare herbs.' }, // edge to Marcus
        { uid: 2, comment: 'Ruins', content: 'Elena explores Ruins searching for lost artifacts.' }, // edge to Elena — off the eventual beacon route
        { uid: 3, comment: 'Whiskers', content: 'Marcus keeps a cat named Whiskers who naps by the door.' }, // edge to Marcus
    ];
    // A simple deterministic LCG — same seed always produces the same
    // beacon-tiebreak/noise-score sequence, so this test's exact expected
    // text is reproducible, not a snapshot of real Math.random() luck.
    let seed = 1;
    const seededRandom = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };

    const { graphCore, pipelineCore, caller } = buildEngine({
        lorebookEntries: entries, random: seededRandom,
        // Marcus = центр, Elena = под-центр. Ruins/Whiskers падают через
        // argmax ('ordinary') — с фиксом forceRole:'ordinary' они НЕ могут
        // случайно стать под-центрами по порядку прибытия (реальный баг,
        // найденный при переводе этого самого теста на новый бутстрап —
        // см. attachToRegionByKey()'s doc-comment), так что
        // subCentersPerRegion:0 ниже здесь уже подстраховка, не строгая
        // необходимость.
        fetchReplies: ['[{"region":"Story","subCenterUids":[1]}]', '[{"region":"Story","centerUid":0}]', '[]'],
    });
    // Это тест на отбор маяков/шума, не на бэкбон-фичу — без этого Elena И
    // Ruins стали бы под-центрами (subCentersPerRegion: 2 по умолчанию) и
    // получили бы бесконечный вес в scoreBeaconCandidate() наравне с
    // Marcus, что тривиально проталкивало бы ВСЕХ троих в маяки и ломало
    // саму предпосылку теста ("Ruins не выбран маяком").
    await call(caller, 'memoryGraph.configure', { subCentersPerRegion: 0 });
    await graphCore.load();
    await graphCore.waitForBootstrap();

    const outgoing = [{ mes: 'Tell me more about Marcus and his tavern near the market.' }];
    await pipelineCore.run({ pipelineId: 'generation.beforeSend', input: { chat: outgoing } });

    const text = outgoing[0].mes;
    assert.ok(text.includes('Ruins (noise)'), 'Ruins was never selected as a beacon (only 3 slots, 4 candidates) but sits one edge off the route via Elena, so it must surface as noise');
    assert.ok(text.includes('- Ruins (noise): Elena explores Ruins searching for lost artifacts.'), 'its real content must be visible, not just its label');
});

// --- Ручное редактирование графа (UI-редактор): CRUD нод/рёбер -----------

test('memoryGraph.nodes.create places a node directly into the specified region with a real embedding — no cascade, no SideCar', async () => {
    const { caller } = buildEngine();

    const result = await call(caller, 'memoryGraph.nodes.create', { label: 'Hand-placed', content: 'a fact typed in by hand.', importance: 4, sector: 2, ring: 1 });

    assert.equal(result.value.ok, true);
    const nodes = (await call(caller, 'memoryGraph.nodes')).value;
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].label, 'Hand-placed');
    assert.equal(nodes[0].regionId, '2:1');
    assert.ok(Array.isArray(nodes[0].embedding) && nodes[0].embedding.length === 4, 'a real embedding must have been computed, not left null');
    assert.equal(nodes[0].protectedNode, true, 'the first node of a region is its center, manual creation included');
});

test('memoryGraph.nodes.create rejects an out-of-range sector/ring instead of silently clamping or crashing', async () => {
    const { caller } = buildEngine();
    const result = await call(caller, 'memoryGraph.nodes.create', { label: 'Bad', content: 'x', sector: 99, ring: 0 });
    assert.equal(result.value.ok, false);
    assert.equal((await call(caller, 'memoryGraph.nodes')).value.length, 0, 'nothing must have been created on a rejected request');
});

test('memoryGraph.nodes.create rejects empty content', async () => {
    const { caller } = buildEngine();
    const result = await call(caller, 'memoryGraph.nodes.create', { label: 'Empty', content: '   ', sector: 0, ring: 0 });
    assert.equal(result.value.ok, false);
});

// --- Импорт главного персонажа из карточки (решено с пользователем) -------

test('memoryGraph.nodes.createFromCharacterCard combines description+personality into the node content, with a high default importance', async () => {
    const { caller } = buildEngine({
        character: { name: 'Aria', description: 'A wandering healer with a quiet past.', personality: 'Calm, patient, quick to forgive.' },
    });
    const result = await call(caller, 'memoryGraph.nodes.createFromCharacterCard');
    assert.equal(result.value.ok, true);

    const nodes = (await call(caller, 'memoryGraph.nodes')).value;
    assert.equal(nodes.length, 1);
    const node = nodes[0];
    assert.equal(node.label, 'Aria');
    assert.ok(node.content.includes('A wandering healer with a quiet past.'));
    assert.ok(node.content.includes('Calm, patient, quick to forgive.'), 'personality must be included, not just description');
    assert.ok(node.importance >= 7, 'a main character should not default to a throwaway importance');
    assert.ok(node.regionId, 'must actually be placed, not left staged, for a solo/first entry');
});

test('memoryGraph.nodes.createFromCharacterCard fails cleanly when there is no active character', async () => {
    const { caller } = buildEngine({ character: null });
    const result = await call(caller, 'memoryGraph.nodes.createFromCharacterCard');
    assert.equal(result.value.ok, false);
    assert.equal((await call(caller, 'memoryGraph.nodes')).value.length, 0);
});

test('memoryGraph.nodes.createFromCharacterCard fails cleanly when the card has neither description nor personality', async () => {
    const { caller } = buildEngine({ character: { name: 'Blank', description: '', personality: '   ' } });
    const result = await call(caller, 'memoryGraph.nodes.createFromCharacterCard');
    assert.equal(result.value.ok, false);
    assert.equal((await call(caller, 'memoryGraph.nodes')).value.length, 0);
});

test('memoryGraph.nodes.update recomputes the embedding ONLY when label/content actually changed', async () => {
    // `memoryGraph.nodes` returns LIVE node objects, not copies — every
    // snapshot must be cloned, or "before" silently mutates into "after"
    // through the shared reference (caught the hard way while writing this).
    const { caller } = buildEngine();
    await call(caller, 'memoryGraph.nodes.create', { label: 'Original', content: 'the original fact.', sector: 0, ring: 0 });
    const before = structuredClone((await call(caller, 'memoryGraph.nodes')).value[0]);

    await call(caller, 'memoryGraph.nodes.update', { id: before.id, importance: 9 });
    const afterImportanceOnly = structuredClone((await call(caller, 'memoryGraph.nodes')).value[0]);
    assert.deepEqual(afterImportanceOnly.embedding, before.embedding, 'changing importance alone must not touch the embedding');
    assert.equal(afterImportanceOnly.importance, 9);

    await call(caller, 'memoryGraph.nodes.update', { id: before.id, content: 'a completely different fact now.' });
    const afterContentChange = structuredClone((await call(caller, 'memoryGraph.nodes')).value[0]);
    assert.notDeepEqual(afterContentChange.embedding, before.embedding, 'changing content MUST recompute the embedding — otherwise it silently drifts out of sync with the text');
});

test('memoryGraph.nodes.update rejects clearing content to empty', async () => {
    const { caller } = buildEngine();
    await call(caller, 'memoryGraph.nodes.create', { label: 'A', content: 'has content.', sector: 0, ring: 0 });
    const node = (await call(caller, 'memoryGraph.nodes')).value[0];
    const result = await call(caller, 'memoryGraph.nodes.update', { id: node.id, content: '   ' });
    assert.equal(result.value.ok, false);
});

test('memoryGraph.nodes.delete reuses removeNodeFromGraph() — the node and its region membership are both gone', async () => {
    const { caller } = buildEngine();
    await call(caller, 'memoryGraph.nodes.create', { label: 'A', content: 'first.', sector: 0, ring: 0 });
    await call(caller, 'memoryGraph.nodes.create', { label: 'B', content: 'second, unrelated content entirely.', sector: 1, ring: 0 });
    const [a] = (await call(caller, 'memoryGraph.nodes')).value;

    const result = await call(caller, 'memoryGraph.nodes.delete', { id: a.id });

    assert.equal(result.value.ok, true);
    const remaining = (await call(caller, 'memoryGraph.nodes')).value;
    assert.equal(remaining.length, 1);
    const region = (await call(caller, 'memoryGraph.regions')).value.find(r => r.sector === 0 && r.ring === 0);
    assert.ok(!region.nodeIds.includes(a.id));
});

test('memoryGraph.nodes.move actually changes regionId — dragging IS a real region reassignment, not cosmetic', async () => {
    const { caller } = buildEngine();
    await call(caller, 'memoryGraph.nodes.create', { label: 'Mover', content: 'a node about to be dragged elsewhere.', sector: 0, ring: 0 });
    const node = (await call(caller, 'memoryGraph.nodes')).value[0];

    const result = await call(caller, 'memoryGraph.nodes.move', { id: node.id, sector: 3, ring: 2 });

    assert.equal(result.value.ok, true);
    const moved = (await call(caller, 'memoryGraph.nodes')).value[0];
    assert.equal(moved.regionId, '3:2');
    const regions = (await call(caller, 'memoryGraph.regions')).value;
    assert.ok(!regions.find(r => r.sector === 0 && r.ring === 0)?.nodeIds.includes(node.id), 'must be gone from the OLD region');
    assert.ok(regions.find(r => r.sector === 3 && r.ring === 2)?.nodeIds.includes(node.id), 'must be present in the NEW region');
});

test('memoryGraph.nodes.move clears the OLD region\'s center when the moved node WAS its center — no automatic reassignment', async () => {
    const { caller } = buildEngine();
    await call(caller, 'memoryGraph.nodes.create', { label: 'Center', content: 'the first and only node here, so it becomes the center.', sector: 0, ring: 0 });
    const center = (await call(caller, 'memoryGraph.nodes')).value[0];
    assert.equal(center.protectedNode, true, 'sanity: it really is the center');

    await call(caller, 'memoryGraph.nodes.move', { id: center.id, sector: 4, ring: 2 });

    const oldRegion = (await call(caller, 'memoryGraph.regions')).value.find(r => r.sector === 0 && r.ring === 0);
    assert.equal(oldRegion.centerNodeId, null, 'the old region must be left centerless, not silently reassigned to someone else');
    const movedNode = (await call(caller, 'memoryGraph.nodes')).value[0];
    assert.equal(movedNode.protectedNode, true, 'the moved node keeps its OWN protection — moving does not strip it');
});

test('memoryGraph.nodes.move leaves the OLD region\'s center UNCHANGED when the moved node was NOT the center', async () => {
    const { caller } = buildEngine();
    // `subCentersPerRegion: 0` — this test wants an ordinary (unprotected)
    // second node; by default the 2nd arrival in a region becomes a
    // protected sub-center (backbone feature), which is not what's under
    // test here.
    await call(caller, 'memoryGraph.configure', { subCentersPerRegion: 0 });
    await call(caller, 'memoryGraph.nodes.create', { label: 'Center', content: 'stays put, the anchor of this region.', sector: 0, ring: 0 });
    await call(caller, 'memoryGraph.nodes.create', { label: 'Sidekick', content: 'a second, unrelated node in the same region.', sector: 0, ring: 0 });
    const nodes = (await call(caller, 'memoryGraph.nodes')).value;
    const center = nodes.find(n => n.protectedNode);
    const sidekick = nodes.find(n => !n.protectedNode);

    await call(caller, 'memoryGraph.nodes.move', { id: sidekick.id, sector: 1, ring: 0 });

    const oldRegion = (await call(caller, 'memoryGraph.regions')).value.find(r => r.sector === 0 && r.ring === 0);
    assert.equal(oldRegion.centerNodeId, center.id, 'the center must be untouched — only the sidekick moved');
});

test('memoryGraph.nodes.move into an already-full region triggers the same capacity enforcement as any organic insertion', async () => {
    const { caller } = buildEngine();
    // Fill region 0:0 to capacity (23) with distinct, unrelated content.
    for (let i = 0; i < 23; i += 1) {
        await call(caller, 'memoryGraph.nodes.create', { label: `Filler ${i}`, content: `distinct unrelated filler fact number ${i} about this world.`, sector: 0, ring: 0 });
    }
    await call(caller, 'memoryGraph.nodes.create', { label: 'Mover', content: 'a completely separate, unrelated node parked in its own region.', sector: 4, ring: 2 });
    const mover = (await call(caller, 'memoryGraph.nodes')).value.find(n => n.label === 'Mover');
    const beforeCount = (await call(caller, 'memoryGraph.nodes')).value.length;
    assert.equal(beforeCount, 24, 'sanity: 23 filling the region + 1 mover elsewhere');

    await call(caller, 'memoryGraph.nodes.move', { id: mover.id, sector: 0, ring: 0 });

    // Same behavior already established for organic overflow: reconsolidation
    // is PREFERRED over immediate eviction (reconsolidationMinCluster=3
    // eligible candidates exist here), so the region is queued for a
    // cluster-fold, not shrunk on the spot — the region legitimately stays
    // temporarily over capacity, exactly like the purely-organic case.
    assert.equal((await call(caller, 'memoryGraph.reconsolidationQueue')).value.length, 1, 'moving into a full region must trigger the SAME capacity enforcement as an organic insertion — a reconsolidation cluster must get queued, not silently ignored');
});

test('memoryGraph.edges.create/delete are symmetric and keep degree consistent on both ends; repeat create does not duplicate', async () => {
    const { caller } = buildEngine();
    await call(caller, 'memoryGraph.nodes.create', { label: 'A', content: 'first node, no relation yet.', sector: 0, ring: 0 });
    await call(caller, 'memoryGraph.nodes.create', { label: 'B', content: 'second node, unrelated content, own region.', sector: 1, ring: 0 });
    const [a, b] = (await call(caller, 'memoryGraph.nodes')).value;

    await call(caller, 'memoryGraph.edges.create', { fromId: a.id, toId: b.id, type: 'knows' });
    await call(caller, 'memoryGraph.edges.create', { fromId: a.id, toId: b.id, type: 'knows' }); // repeat — must not duplicate

    const freshA = (await call(caller, 'memoryGraph.nodes')).value.find(n => n.id === a.id);
    const freshB = (await call(caller, 'memoryGraph.nodes')).value.find(n => n.id === b.id);
    assert.equal(freshA.degree, 1);
    assert.equal(freshB.degree, 1);
    assert.deepEqual(freshA.edges, [{ to: b.id, type: 'knows' }]);
    assert.deepEqual(freshB.edges, [{ to: a.id, type: 'knows' }]);

    await call(caller, 'memoryGraph.edges.delete', { fromId: a.id, toId: b.id, type: 'knows' });
    const clearedA = (await call(caller, 'memoryGraph.nodes')).value.find(n => n.id === a.id);
    const clearedB = (await call(caller, 'memoryGraph.nodes')).value.find(n => n.id === b.id);
    assert.equal(clearedA.degree, 0);
    assert.equal(clearedB.degree, 0);
    assert.deepEqual(clearedA.edges, []);
    assert.deepEqual(clearedB.edges, []);
});

// --- "Вызов любой функции вручную" — 5 дебаг-контрактов --------------------

test('memoryGraph.checkAndPlace contract runs a real checkAndPlace() and creates a node via SideCar', async () => {
    const { caller } = buildEngine();
    const result = await call(caller, 'memoryGraph.checkAndPlace', { text: 'the player enters a dark cave.' });
    assert.equal(result.value.status, 'placed');
    assert.equal((await call(caller, 'memoryGraph.nodes')).value.length, 1);
});

test('memoryGraph.sweepStaging/sweepMergeQueue/sweepReconsolidationQueue contracts run without error on an empty graph', async () => {
    const { caller } = buildEngine();
    for (const contract of ['memoryGraph.sweepStaging', 'memoryGraph.sweepMergeQueue', 'memoryGraph.sweepReconsolidationQueue']) {
        const result = await call(caller, contract);
        assert.equal(result.ok, true, `${contract} must not error on an empty graph`);
    }
});

test('memoryGraph.bootstrapFromLorebook contract can be triggered manually, independent of the empty-graph auto-bootstrap', async () => {
    const entries = [{ uid: 0, comment: 'Manual Import', content: 'a fact only pulled in by pressing the debug button.' }];
    const { caller } = buildEngine({
        lorebookEntries: entries,
        fetchReplies: ['[{"region":"World","subCenterUids":[0]}]', '[{"region":"World","centerUid":0}]'],
    });
    // No graphCore.load() here — nothing has auto-bootstrapped yet.
    const result = await call(caller, 'memoryGraph.bootstrapFromLorebook');
    assert.equal(result.value, true);
    assert.equal((await call(caller, 'memoryGraph.nodes')).value.length, 1);
});
