import { request } from '../../libraries/shared/request.js';
import { cosineSimilarity } from '../../libraries/core/embedding.js';
import { parseModelJson } from '../../libraries/core/parse-model-json.js';

const PERSISTENCE_NAMESPACE = 'core.memoryGraph';
const SETTINGS_KEY = 'settings';
const NODES_KEY = 'nodes';
const REGIONS_KEY = 'regions';
const STAGING_KEY = 'staging';
const MERGE_QUEUE_KEY = 'mergeQueue';
const RECONSOLIDATION_QUEUE_KEY = 'reconsolidationQueue';
const STATS_KEY = 'distanceStats';
const PREPARE_PIPELINE = 'generation.prepare';
const BEFORE_SEND_PIPELINE = 'generation.beforeSend';
const CHECK_CONTRACT = 'memoryGraph.check';
const INJECT_CONTRACT = 'memoryGraph.inject';
const INJECT_STAGE_ID = 'memory-graph:inject';
const RP_TIME_TRACKER_ID = 'rp-time'; // константа из modules/time/index.js — не менять без синхронизации

export const SECTORS = 5;
export const RINGS = 3;

// Тот же набор значений, что REASONING_EFFORTS в internal-engine.js — не
// импортируем оттуда напрямую (Ядра друг друга не знают, только через
// Гейты), просто дублируем закрытый список валидных значений для клэмпа.
const BOOTSTRAP_REASONING_EFFORTS = ['low', 'medium', 'high'];

export const DEFAULT_SETTINGS = Object.freeze({
    // Множитель адаптивного порога "сильного изменения" — MEMORY_GRAPH.md:
    // порог НЕ фиксированный, подстраивается под разброс расстояний внутри
    // ОДНОГО графа (бегущее среднее+стандартное отклонение). `k` — то, на
    // сколько стандартных отклонений отличие должно превысить среднее.
    thresholdK: 1.5,
    // `w` в формуле логитов региона (вектор + keyword) — MEMORY_GRAPH.md.
    keywordWeight: 1,
    // Каскад накопителя — числа согласованы с пользователем дословно.
    stagingRetryTurns: 5,
    stagingBatchSize: 5,
    stagingMaxTurns: 20,
    subCentersPerRegion: 2,
    // Ёмкость региона ЦЕЛИКОМ (центр + под-центры + обычные узлы, всё вместе
    // — `region.nodeIds.length`, центр уже часть этого массива). Решено с
    // пользователем: буквально по изначальной формуле — 1 центр + 2
    // под-центра + до 10 узлов у каждого под-центра = 23 (арифметика "12 vs
    // 23" из MEMORY_GRAPH.md закрыта этим числом). Переполнение работает как
    // единый плоский лимит на регион, не различая центр/под-центр/обычный
    // узел.
    maxNodesPerRegion: 23,
    // Ограничения связности по РОЛИ узла (решено с пользователем явно,
    // числами; "под-центры" теперь реальная назначаемая роль — первые
    // `subCentersPerRegion` узлов ПОСЛЕ центра региона, см. attachToRegion(),
    // а не только заведённое, но пустое поле `subCenterIds`, как раньше):
    // обычная ("малая") нода — не больше `ordinaryMaxDegree` связей вообще
    // (мягкий отказ вплетать новое `mentions`-ребро сверх лимита, обеим
    // сторонам сразу — см. attachToRegion()); под-центр — от
    // `subCenterMinDegree` до `subCenterMaxDegree` связей ЛЮБОГО типа
    // (органические `mentions` + добавленные `backbone`); центр — минимум
    // `centerMinBackboneDegree` связей, но ТОЛЬКО к другим центрам/
    // под-центрам (peer-only, без верхнего предела и без ограничения на
    // связи с обычными узлами). Активное досоздание рёбер типа `backbone`
    // (не через SideCar — геометрия и косинус эмбедингов, тот же принцип,
    // что и у остального графа) — `enforceBackboneConnectivity()`, сейчас
    // зовётся только из `bootstrapFromLorebook()` (решено с пользователем:
    // область — бутстрап).
    ordinaryMaxDegree: 3,
    subCenterMinDegree: 10,
    subCenterMaxDegree: 15,
    centerMinBackboneDegree: 4,
    // Объединение почти-дубликатов (второй механизм переполнения, решено с
    // пользователем): дешёвый отбор по словам (Жаккар) → точное
    // подтверждение косинусом эмбедингов → пара уходит в ОЧЕРЕДЬ на
    // SideCar, не сливается сразу. Порог по словам — эвристика "на
    // усмотрение", как и другие некалиброванные константы здесь; порог по
    // эмбедингу (0.92) — по живым числам из MEMORY_GRAPH.md (связанные
    // записи реального WI давали ~0.86, порог должен быть заметно выше).
    mergeWordOverlapThreshold: 0.3,
    mergeSimilarityThreshold: 0.92,
    // Своя очередь, СВОИ числа — пользователь явно отклонил переиспользование
    // stagingBatchSize/stagingMaxTurns у накопителя. Чисто по времени, без
    // гонки "батч ИЛИ таймаут" — просто выдержать N ходов с момента
    // постановки в очередь, потом решить.
    mergeQueueMaxTurns: 8,
    // Реконсолидация мелких записей (третий, последний механизм переполнения,
    // решено с пользователем): ПЕРЕД вытеснением при переполнении сначала
    // пробуем сжать кластер СЛАБЕЙШИХ незащищённых узлов региона в один,
    // через СВОЮ SideCar-очередь (тот же приём, что у объединения дублей —
    // не блокирует вставку). `reconsolidationMinCluster` — и порог "стоит
    // ли вообще сжимать" (не тратим вызов модели на 1-2 узла), и одновременно
    // размер самого кластера — тот же принцип, что `stagingBatchSize` у
    // накопителя.
    reconsolidationMinCluster: 3,
    reconsolidationQueueMaxTurns: 8,
    // Веса decay-формулы. "Время" и "недавность" из MEMORY_GRAPH.md
    // сведены в ОДНУ экспоненциальную кривую по прошедшему времени
    // (gameTime с фолбэком на число сообщений) — это была одна и та же ось,
    // описанная дважды при брейнсторме, не два независимых сигнала.
    decayHalfLifeTurns: 20,
    importanceWeight: 1,
    degreeWeight: 1,
    // Phase 2 — маяки+маршрут (MEMORY_GRAPH.md, решено с пользователем):
    // 3 маяка на ход, отбор — релевантность (косинус к контексту) ПЛЮС вес
    // важности (`computeNodeWeight()`, "не менее подцентра региона" —
    // слабый/забытый узел не должен побеждать по одной лишь тематической
    // близости). `beaconWeightFactor` — множитель веса в комбинированном
    // счёте, тот же принцип, что `keywordWeight` у логитов региона.
    beaconCount: 3,
    beaconWeightFactor: 1,
    // Маршрут — цепочка маяк0→маяк1→маяк2 по СУЩЕСТВУЮЩИМ рёбрам (кратчайший
    // путь, без Steiner-дерева). `routeMaxHops` — защита от патологически
    // длинного пути в разросшемся графе, не эмпирический параметр дизайна,
    // а простой предохранитель.
    routeMaxHops: 6,
    // Шумные ответвления (решено с пользователем): узлы вне маршрута, но
    // на ОДНО ребро от узла НА маршруте — не случайный процент на ребро, а
    // гауссов "счёт" на каждого кандидата (`gaussianRandom()`), отсортировано
    // по счёту убывающе, набирается ЖАДНО, пока не будет исчерпан бюджет —
    // именно СИМВОЛОВ, не число узлов (решено явно пользователем: богатый
    // регион не должен раздувать промпт числом мелких узлов).
    noiseCharBudget: 400,
    // LLM-driven семантические регионы бутстрапа (решено с пользователем,
    // MEMORY_GRAPH.md — "80% нод без связи" на старом дартборд-бутстрапе):
    // `baseRegionNames` — ЕДИНСТВЕННЫЙ источник регионов для Прохода 1
    // (решено с пользователем явно: "за один прогон он и выводит под-центры
    // в регионы и добавляет новые центры" — плохо, разделено на два прогона
    // — Проход 1 больше НЕ может изобретать свои регионы, только раскладывать
    // под-центры по ЭТОМУ списку; новые регионы сверху — исключительно
    // работа Прохода 2, см. buildAdditionalCentersPrompt()).
    // `entriesPerRegionCenter` — цель для Прохода 2: сколько регионов
    // ДОЛЖНО быть всего, примерно по одному центру на N записей Lorebook.
    baseRegionNames: ['Locations', 'Main Characters', 'Factions'],
    entriesPerRegionCenter: 20,
    // Найдено живьём: `model.generate` без явного `maxTokens` в запросе
    // падает на `REQUEST_DEFAULTS.maxTokens = 1000`
    // (cores/models/internal-engine.js) — рассчитан на короткие ответы
    // трекеров/одной ноды, не на структурированный JSON Проходов 1-3
    // (несколько регионов, под-центры, связи целого региона). 4000
    // оказалось МАЛО на реальном лорбуке живьём (пользователь: "он не
    // вывозит") — поднято до 50000. Не экономим на этом: усечённый
    // посреди объекта JSON просто не парсится вообще.
    bootstrapMaxTokens: 50000,
    // Сэмплер для Проходов 1-3 (решено с пользователем явно, числами) —
    // низкая температура и низкий reasoning-эффорт: это структурированная
    // JSON-раскладка по точным правилам, не творческая генерация, ей не
    // нужна вариативность и не нужны долгие раздумья (реальная жалоба:
    // модель "слишком долго размышляет" вместо того, чтобы просто выполнить
    // инструкцию). `reasoningEffort` без `reasoningMode:'enabled'` НИЧЕГО
    // не делает (см. provider-request.js — оба unified-`reasoning`-билдера
    // возвращают `{}`, пока mode не 'enabled'/'disabled' явно) — поэтому в
    // самих вызовах бутстрапа `reasoningMode: 'enabled'` зашит явно (не
    // настройка — это не "выключить ризонинг", а "включить, но по низкому
    // эффорту", отдельная настройка тут не нужна). Эффорт всё ещё реально
    // влияет только у воркеров OpenRouter-формата (см. doc-comment
    // resolveGenerateRequest() в internal-engine.js) — для остальных полей
    // reasoning просто не строится вовсе, безопасно передавать всегда.
    bootstrapTemperature: 0.4,
    bootstrapReasoningEffort: 'low',
    workerId: null,
});

function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
}

/** Тот же защитный клэмп, что у остальных `DEFAULT_SETTINGS` в движке — ручная правка файла настроек не должна осесть как есть. */
export function clampGraphSettings(values = {}) {
    return {
        thresholdK: clampInt(values.thresholdK * 10, 1, 100, DEFAULT_SETTINGS.thresholdK * 10) / 10,
        keywordWeight: clampInt(values.keywordWeight * 10, 0, 100, DEFAULT_SETTINGS.keywordWeight * 10) / 10,
        stagingRetryTurns: clampInt(values.stagingRetryTurns, 1, 200, DEFAULT_SETTINGS.stagingRetryTurns),
        stagingBatchSize: clampInt(values.stagingBatchSize, 1, 50, DEFAULT_SETTINGS.stagingBatchSize),
        stagingMaxTurns: clampInt(values.stagingMaxTurns, 1, 500, DEFAULT_SETTINGS.stagingMaxTurns),
        subCentersPerRegion: clampInt(values.subCentersPerRegion, 0, 10, DEFAULT_SETTINGS.subCentersPerRegion),
        maxNodesPerRegion: clampInt(values.maxNodesPerRegion, 2, 200, DEFAULT_SETTINGS.maxNodesPerRegion),
        ordinaryMaxDegree: clampInt(values.ordinaryMaxDegree, 0, 50, DEFAULT_SETTINGS.ordinaryMaxDegree),
        subCenterMinDegree: clampInt(values.subCenterMinDegree, 0, 100, DEFAULT_SETTINGS.subCenterMinDegree),
        subCenterMaxDegree: clampInt(values.subCenterMaxDegree, 0, 100, DEFAULT_SETTINGS.subCenterMaxDegree),
        centerMinBackboneDegree: clampInt(values.centerMinBackboneDegree, 0, 100, DEFAULT_SETTINGS.centerMinBackboneDegree),
        mergeWordOverlapThreshold: clampInt(values.mergeWordOverlapThreshold * 100, 0, 100, DEFAULT_SETTINGS.mergeWordOverlapThreshold * 100) / 100,
        mergeSimilarityThreshold: clampInt(values.mergeSimilarityThreshold * 100, 0, 100, DEFAULT_SETTINGS.mergeSimilarityThreshold * 100) / 100,
        mergeQueueMaxTurns: clampInt(values.mergeQueueMaxTurns, 1, 200, DEFAULT_SETTINGS.mergeQueueMaxTurns),
        reconsolidationMinCluster: clampInt(values.reconsolidationMinCluster, 2, 20, DEFAULT_SETTINGS.reconsolidationMinCluster),
        reconsolidationQueueMaxTurns: clampInt(values.reconsolidationQueueMaxTurns, 1, 200, DEFAULT_SETTINGS.reconsolidationQueueMaxTurns),
        decayHalfLifeTurns: clampInt(values.decayHalfLifeTurns, 1, 2000, DEFAULT_SETTINGS.decayHalfLifeTurns),
        importanceWeight: clampInt(values.importanceWeight * 10, 0, 100, DEFAULT_SETTINGS.importanceWeight * 10) / 10,
        degreeWeight: clampInt(values.degreeWeight * 10, 0, 100, DEFAULT_SETTINGS.degreeWeight * 10) / 10,
        beaconCount: clampInt(values.beaconCount, 1, 20, DEFAULT_SETTINGS.beaconCount),
        beaconWeightFactor: clampInt(values.beaconWeightFactor * 10, 0, 100, DEFAULT_SETTINGS.beaconWeightFactor * 10) / 10,
        routeMaxHops: clampInt(values.routeMaxHops, 1, 50, DEFAULT_SETTINGS.routeMaxHops),
        noiseCharBudget: clampInt(values.noiseCharBudget, 0, 5000, DEFAULT_SETTINGS.noiseCharBudget),
        baseRegionNames: Array.isArray(values.baseRegionNames) && values.baseRegionNames.length
            ? values.baseRegionNames.map(name => String(name).trim()).filter(Boolean)
            : DEFAULT_SETTINGS.baseRegionNames,
        entriesPerRegionCenter: clampInt(values.entriesPerRegionCenter, 1, 200, DEFAULT_SETTINGS.entriesPerRegionCenter),
        bootstrapMaxTokens: clampInt(values.bootstrapMaxTokens, 100, 200000, DEFAULT_SETTINGS.bootstrapMaxTokens), // потолок ВЫШЕ, чем у clampSamplerSettings() в internal-engine.js (32768) — там граница под обычный чат-сэмплер, бутстрапу реально нужно больше на настоящем лорбуке
        bootstrapTemperature: clampInt(values.bootstrapTemperature * 100, 0, 200, DEFAULT_SETTINGS.bootstrapTemperature * 100) / 100,
        bootstrapReasoningEffort: BOOTSTRAP_REASONING_EFFORTS.includes(values.bootstrapReasoningEffort) ? values.bootstrapReasoningEffort : DEFAULT_SETTINGS.bootstrapReasoningEffort,
        workerId: values.workerId ?? null,
    };
}

// --- Физика регионов: круг → 5 секторов × 3 кольца = 15 регионов ---------
// MEMORY_GRAPH.md: регион соединяется ТОЛЬКО с соседними по сетке —
// геометрия задаёт соседство, не LLM. Соседи: тот же сектор±1 при том же
// кольце (по кругу, сектор 4 соседствует с сектором 0), и то же кольцо±1
// при том же секторе (кольца не заворачиваются — нет "кольца −1").

export function regionKey(sector, ring) {
    return `${sector}:${ring}`;
}

export function allRegionCoords() {
    const coords = [];
    for (let sector = 0; sector < SECTORS; sector += 1) {
        for (let ring = 0; ring < RINGS; ring += 1) coords.push({ sector, ring });
    }
    return coords;
}

/** Соседи ПО ГЕОМЕТРИИ дартса — единственный способ регион может соединиться с другим (MEMORY_GRAPH.md). */
export function regionAdjacency(sector, ring) {
    const neighbors = [
        { sector: (sector + 1) % SECTORS, ring },
        { sector: (sector - 1 + SECTORS) % SECTORS, ring },
    ];
    if (ring > 0) neighbors.push({ sector, ring: ring - 1 });
    if (ring < RINGS - 1) neighbors.push({ sector, ring: ring + 1 });
    return neighbors;
}

// --- Формула отбора региона: логиты вектор+keyword + softmax (как в семплере) ---
// MEMORY_GRAPH.md: `logit_i = ln(vector_prob_i) + w · ln(1 + keyword_matches_i)`,
// `p_i = softmax(logit_i)`. `ln(1+k)`, не голое `k` — ноль совпадений даёт
// логит 0 (нейтрально), не штраф. Численный пример пользователя (v=0.6/0.4/0.1,
// keyword-счёт 5/10/0, w=1 → p≈0.44/0.54/0.01) закреплён тестом.

export function computeRegionLogits(vectorProbs, keywordCounts, w = DEFAULT_SETTINGS.keywordWeight) {
    const logits = vectorProbs.map((v, i) => Math.log(Math.max(v, 1e-12)) + w * Math.log(1 + Math.max(0, keywordCounts?.[i] ?? 0)));
    const max = Math.max(...logits); // числовая стабильность — вычесть максимум перед exp
    const exps = logits.map(logit => Math.exp(logit - max));
    const sum = exps.reduce((a, b) => a + b, 0);
    return exps.map(value => value / sum);
}

// --- Адаптивный порог "сильного изменения" ---------------------------------
// MEMORY_GRAPH.md: порог НЕ фиксированная константа — подстраивается в
// рамках одного графа. Онлайн-алгоритм Уэлфорда — среднее и дисперсия без
// хранения всей истории расстояний (O(1) память, O(1) на обновление).

export function updateDistanceStats(stats, distance) {
    const count = (stats?.count ?? 0) + 1;
    const prevMean = stats?.mean ?? 0;
    const mean = prevMean + (distance - prevMean) / count;
    const m2 = (stats?.m2 ?? 0) + (distance - prevMean) * (distance - mean);
    return { count, mean, m2 };
}

export function stddevOf(stats) {
    if (!stats || stats.count < 2) return 0;
    return Math.sqrt(stats.m2 / (stats.count - 1));
}

/** Первые несколько расстояний (нет ещё базовой линии) — ВСЕГДА "сильное изменение": графу неоткуда взять начальные ноды иначе. */
export function isStrongChange(distance, stats, k = DEFAULT_SETTINGS.thresholdK) {
    if (!stats || stats.count < 2) return true;
    return distance > stats.mean + k * stddevOf(stats);
}

// --- Decay: важность+связность, промодулированные прошедшим временем -------
// "Время" и "недавность" из MEMORY_GRAPH.md — одна ось (сколько прошло с
// момента создания/последнего касания ноды), не два независимых сигнала;
// здесь — одна экспоненциальная кривая. `elapsed` — в ходах игрового
// времени ЕСЛИ доступно (gameTime), иначе в ходах-сообщениях (фолбэк,
// решено с пользователем). Защищённые ноды не деградируют вовсе.

export function computeNodeWeight({ importance = 0, degree = 0, elapsed = 0, protectedNode = false, settings = DEFAULT_SETTINGS }) {
    if (protectedNode) return Infinity;
    const decay = Math.exp(-Math.max(0, elapsed) / Math.max(1, settings.decayHalfLifeTurns));
    return (settings.importanceWeight * importance + settings.degreeWeight * Math.log(1 + Math.max(0, degree))) * decay;
}

// --- Переполнение региона: Memory Decay + вытеснение (первый проход) ------
// Решено с пользователем: срабатывает СРАЗУ при вставке сверх
// `maxNodesPerRegion` (не отдельным периодическим sweep'ом), и в этом
// проходе — ТОЛЬКО decay-вытеснение слабейшего узла; реконсолидация/
// объединение дублей — отдельный, более поздний шаг той же фазы.

/**
 * `members` — узлы ТЕКУЩЕГО региона (после уже добавленного нового),
 * каждый `{id, importance, degree, protectedNode, createdTurn}`. Чистая
 * функция — вес считает уже существующий `computeNodeWeight()`, здесь
 * только выбор минимума. При равенстве весов побеждает ПЕРВЫЙ по порядку
 * (в вызывающем коде — порядок `nodeIds`, то есть порядок вставки: при
 * ничьей вытесняется более СТАРЫЙ узел) — простое, детерминированное
 * правило, а не подразумеваемое поведение `Array.sort`.
 *
 * Возвращает `null`, если ВСЕ узлы региона защищены — тогда вытеснять
 * нечего, регион временно превышает лимит (не решается в этом проходе,
 * задокументированный крайний случай, не скрытый).
 */
export function pickEvictionCandidate(members, { settings = DEFAULT_SETTINGS, turnCounter = 0 } = {}) {
    let worst = null;
    let worstWeight = Infinity;
    for (const member of members) {
        const weight = computeNodeWeight({
            importance: member.importance,
            degree: member.degree,
            elapsed: Math.max(0, turnCounter - (member.createdTurn ?? turnCounter)),
            protectedNode: member.protectedNode,
            settings,
        });
        if (weight < worstWeight) { worstWeight = weight; worst = member.id; }
    }
    return worst;
}

// --- Объединение почти-дубликатов (второй механизм переполнения) ---------
// MEMORY_GRAPH.md, решено с пользователем: дешёвый математический отбор
// "подозреваемых" по словам на КАЖДОЙ вставке в регион, точное
// подтверждение — косинус эмбедингов. Найденная пара НЕ сливается сразу —
// уходит в очередь на SideCar (см. `sweepMergeQueue` в Ядре ниже).

/** Слова текста для дешёвого сравнения — та же токенизация, что и у частотного профиля региона. Вынесена на верхний уровень (не привязана к состоянию Ядра), чтобы `findMergeCandidate()` оставалась чистой и тестируемой без движка. */
export function wordsOf(text) {
    return String(text ?? '').toLowerCase().match(/[a-zа-яё0-9]{3,}/g) ?? [];
}

/** Индекс Жаккара по множествам слов — дешёвый первый фильтр "подозреваемых", без единого обращения к эмбедингу. */
export function jaccardOverlap(wordsA, wordsB) {
    const setA = new Set(wordsA);
    const setB = new Set(wordsB);
    if (!setA.size || !setB.size) return 0;
    let intersection = 0;
    for (const word of setA) if (setB.has(word)) intersection += 1;
    const union = setA.size + setB.size - intersection;
    return union > 0 ? intersection / union : 0;
}

/**
 * `newNode`/`members` — `{id, embedding, words}`. Двухступенчато: сначала
 * дешёвый `jaccardOverlap()` (без него ВСЕ узлы региона гоняли бы через
 * косинус на каждой вставке), затем косинус — реальное подтверждение
 * попадает в дело только для прошедших первый фильтр. Возвращает id
 * ЛУЧШЕГО совпадения (наибольший косинус среди подтверждённых) или `null`.
 */
export function findMergeCandidate(newNode, members, { wordOverlapThreshold = DEFAULT_SETTINGS.mergeWordOverlapThreshold, similarityThreshold = DEFAULT_SETTINGS.mergeSimilarityThreshold } = {}) {
    let bestId = null;
    let bestSimilarity = -Infinity;
    for (const member of members) {
        if (jaccardOverlap(newNode.words, member.words) < wordOverlapThreshold) continue;
        const similarity = cosineSimilarity(newNode.embedding, member.embedding);
        if (similarity >= similarityThreshold && similarity > bestSimilarity) { bestSimilarity = similarity; bestId = member.id; }
    }
    return bestId;
}

// --- Phase 2: отбор маяков и маршрут между ними ---------------------------
// MEMORY_GRAPH.md, решено с пользователем: 3 маяка на ход, отбор —
// релевантность (косинус к текущему контексту) ПЛЮС вес важности
// (`computeNodeWeight()` — "не менее подцентра региона", слабый узел не
// должен побеждать по одной лишь тематической близости). Маршрут — цепочка
// маяк0→маяк1→маяк2 по СУЩЕСТВУЮЩИМ рёбрам, кратчайший путь, БЕЗ
// Steiner-дерева и БЕЗ шумных ответвлений (первый проход, решено явно).
//
// Кандидаты в маяки — ТОЛЬКО размещённые узлы (`regionId` не `null`): нода
// в накопителе НЕВИДИМА для ретрива (MEMORY_GRAPH.md, решено с
// пользователем ещё в Phase 1) — это фильтрует вызывающий код, не эти
// функции.

/** Комбинированный счёт узла-кандидата: релевантность (косинус к контексту, сдвинутый в [0,1], тот же приём, что `vectorProbsForAllRegions`) плюс log-вес важности. Защищённые узлы (`Infinity`) выигрывают почти всегда — так и задумано. */
export function scoreBeaconCandidate(node, contextEmbedding, { weightFactor = DEFAULT_SETTINGS.beaconWeightFactor, settings = DEFAULT_SETTINGS, turnCounter = 0 } = {}) {
    const similarity = (cosineSimilarity(contextEmbedding, node.embedding) + 1) / 2;
    const weight = computeNodeWeight({
        importance: node.importance,
        degree: node.degree,
        elapsed: Math.max(0, turnCounter - (node.createdTurn ?? turnCounter)),
        protectedNode: node.protectedNode,
        settings,
    });
    const weightTerm = Number.isFinite(weight) ? Math.log(1 + Math.max(0, weight)) : Number.POSITIVE_INFINITY;
    return similarity + weightFactor * weightTerm;
}

/** `candidates` — узлы `{id, embedding, importance, degree, protectedNode, createdTurn}`. Возвращает id ТОП-`count` по счёту, лучший первым (порядок важен — маршрут строится по этому порядку). */
export function pickBeacons(candidates, contextEmbedding, { count = DEFAULT_SETTINGS.beaconCount, weightFactor = DEFAULT_SETTINGS.beaconWeightFactor, settings = DEFAULT_SETTINGS, turnCounter = 0 } = {}) {
    return candidates
        .map(node => ({ id: node.id, score: scoreBeaconCandidate(node, contextEmbedding, { weightFactor, settings, turnCounter }) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, count)
        .map(entry => entry.id);
}

/** BFS-кратчайший путь по `.edges` (уже двунаправленные — при связывании обе стороны сами добавляют свою запись, MEMORY_GRAPH.md). Возвращает массив шагов `{from, to, type}` от `startId` до `endId` (пустой массив, если start===end), или `null`, если недостижимо в пределах `maxHops`. */
export function findShortestPath(nodesById, startId, endId, { maxHops = DEFAULT_SETTINGS.routeMaxHops } = {}) {
    if (startId === endId) return [];
    const visited = new Set([startId]);
    const queue = [{ id: startId, path: [] }];
    while (queue.length) {
        const { id, path } = queue.shift();
        if (path.length >= maxHops) continue;
        for (const edge of nodesById[id]?.edges ?? []) {
            if (visited.has(edge.to)) continue;
            const nextPath = [...path, { from: id, to: edge.to, type: edge.type }];
            if (edge.to === endId) return nextPath;
            visited.add(edge.to);
            queue.push({ id: edge.to, path: nextPath });
        }
    }
    return null;
}

/**
 * Маршрут между маяками — цепочка `beaconIds[0]→[1]→[2]→...`, БЕЗ
 * Steiner-дерева (решено явно, первый проход). `standalone` — маяки, не
 * покрытые НИ ОДНИМ успешным сегментом (недостижимы от соседа по цепочке в
 * пределах `maxHops`, или граф просто разрознен) — не пропадают из вывода,
 * перечисляются отдельно, без связи.
 */
export function buildBeaconRoute(nodesById, beaconIds, { maxHops = DEFAULT_SETTINGS.routeMaxHops } = {}) {
    const segments = [];
    for (let i = 0; i < beaconIds.length - 1; i += 1) {
        const path = findShortestPath(nodesById, beaconIds[i], beaconIds[i + 1], { maxHops });
        if (path) segments.push(...path);
    }
    const covered = new Set(segments.flatMap(step => [step.from, step.to]));
    const standalone = beaconIds.filter(id => !covered.has(id));
    return { segments, standalone };
}

// --- Шумные ответвления от маршрута (решено с пользователем) --------------
// Узлы вне маршрута, но на ОДНО ребро от узла НА маршруте — "для
// серендипности/текстуры" (MEMORY_GRAPH.md). НЕ фиксированный процент на
// ребро — гауссов "счёт" на каждого кандидата, отсортировано убывающе,
// набирается ЖАДНО, пока не исчерпан бюджет СИМВОЛОВ (не число узлов —
// решено явно, богатый регион не должен раздувать промпт количеством).

/** Box-Muller — стандартная нормальная выборка (mean 0, stddev 1) из инжектированного `random()`, тем же приёмом, что `makeId()` уже использует `random`/`now` для тестируемости. */
export function gaussianRandom(random = Math.random) {
    const u1 = Math.max(random(), Number.EPSILON); // log(0) — недопустим
    const u2 = random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * `routeNodeIds` — узлы, УЖЕ на маршруте (сегменты+standalone), из них не
 * набираем шум и на них не выходим повторно. Кандидат — любой сосед ПО
 * РЕБРУ любого узла маршрута, ведущий НАРУЖУ. Каждому кандидату — гауссов
 * счёт, сортировка по убыванию, жадный набор по бюджету СИМВОЛОВ
 * (рендер-строка "Label: content", та же формула, что в `renderMemoryPrompt`).
 * `continue`, не `break`, на нехватке места — более короткий кандидат
 * дальше по списку всё ещё может поместиться (не строгий top-N по счёту).
 * Один и тот же узел не берётся дважды, даже если достижим от нескольких
 * якорей на маршруте.
 */
export function pickNoiseNodes(nodesById, routeNodeIds, { charBudget = DEFAULT_SETTINGS.noiseCharBudget, random = Math.random } = {}) {
    const onRoute = new Set(routeNodeIds);
    const candidates = [];
    for (const id of routeNodeIds) {
        for (const edge of nodesById[id]?.edges ?? []) {
            if (onRoute.has(edge.to) || !nodesById[edge.to]) continue;
            candidates.push({ from: id, to: edge.to, type: edge.type, score: gaussianRandom(random) });
        }
    }
    candidates.sort((a, b) => b.score - a.score);

    const accepted = [];
    const seenTo = new Set();
    let usedChars = 0;
    for (const candidate of candidates) {
        if (seenTo.has(candidate.to)) continue;
        const node = nodesById[candidate.to];
        const cost = `${node.label}: ${node.content}`.length;
        if (usedChars + cost > charBudget) continue;
        usedChars += cost;
        seenTo.add(candidate.to);
        accepted.push({ from: candidate.from, to: candidate.to, type: candidate.type });
    }
    return accepted;
}

/**
 * Рендер маршрута в промпт — структурированный список рёбер (решено с
 * пользователем): цепочка "Label -[type]-> Label -[type]-> Label" как
 * компактный "хребет", плюс content каждого ВОВЛЕЧЁННОГО узла — по разу
 * (не дублируется, даже если узел — стык двух сегментов). `standalone`
 * узлы — тоже перечисляются, просто без стрелки (не пропадают из вывода).
 * `route.noise` (опционально) — шумные рёбра от узла маршрута НАРУЖУ,
 * каждое своей строкой с реальным типом ребра, помечено "(noise)" в
 * детальном списке — решено с пользователем: "шум идёт от маршрута, связь
 * будет, её и покажем", не безадресный список. `null`, если рендерить
 * нечего (пустой маршрут) — вызывающий тогда не трогает `chat` вообще.
 */
export function renderMemoryPrompt(route, nodesById) {
    const noise = route.noise ?? [];
    const onMainRoute = new Set(route.segments.flatMap(step => [step.from, step.to]));
    const noiseTargets = new Set(noise.map(edge => edge.to));

    const involvedIds = [...new Set([...onMainRoute, ...route.standalone, ...noiseTargets])];
    const detailLines = involvedIds.map(id => {
        const node = nodesById[id];
        if (!node) return null;
        const suffix = route.standalone.includes(id) ? ' (unconnected)' : noiseTargets.has(id) && !onMainRoute.has(id) ? ' (noise)' : '';
        return `- ${node.label}${suffix}: ${node.content}`;
    }).filter(Boolean);
    if (!detailLines.length) return null;

    const lines = ['Long-term memory — relevant connections:'];
    if (route.segments.length) {
        const chain = [nodesById[route.segments[0].from]?.label ?? route.segments[0].from];
        for (const step of route.segments) chain.push(`-[${step.type}]-> ${nodesById[step.to]?.label ?? step.to}`);
        lines.push(chain.join(' '));
    }
    for (const edge of noise) {
        lines.push(`${nodesById[edge.from]?.label ?? edge.from} -[${edge.type}]-> ${nodesById[edge.to]?.label ?? edge.to} (noise)`);
    }
    lines.push(...detailLines);
    return lines.join('\n');
}

// --- Каскад размещения ноды --------------------------------------------
// MEMORY_GRAPH.md, полностью специфицировано с пользователем:
// маяки (Phase 2, здесь всегда []) → связь по имени → регион по логитам
// (побеждает, если явный отрыв) → накопитель (invisible) → ретрай +5 ходов
// → батч (5 нод ИЛИ +20 ходов) → SideCar → отброс при неудаче.

/** Явный ли отрыв у победителя логит-распределения — иначе результат "неуверенно", кандидат в накопитель. Порог отрыва — фиксированная, простая эвристика (не эмпирический параметр, как остальные): "заметно больше второго места". */
export function pickConfidentRegion(regionProbs, regionCoords, { marginRatio = 1.5 } = {}) {
    if (!regionProbs.length) return null;
    const indexed = regionProbs.map((p, i) => ({ p, coord: regionCoords[i] })).sort((a, b) => b.p - a.p);
    const [best, second] = indexed;
    if (!second || best.p >= (second.p || 1e-12) * marginRatio) return best.coord;
    return null;
}

/**
 * Один шаг каскада для НОВОЙ ноды. Чистая функция — вся математика уже
 * посчитана снаружи (логиты региона, найден ли тёзка по имени), здесь
 * только решение "куда её девать".
 *
 * `beaconRegion` — Phase 2 (маяки), в Phase 1 всегда `null`, шаг
 * пропускается — сигнатура уже готова, чтобы не переделывать функцию
 * позже.
 */
/**
 * `isEmptyGraph` — ни у одного региона ЕЩЁ нет центра (`centerNodeId`).
 * Тогда `regionProbs` не "слабый сигнал" (который стоит защитить от порчи
 * центроида накопителем), а буквально НОЛЬ информации — у каждого региона
 * одинаковая априорная вероятность, отрыва не будет никогда. Не гонять
 * такую ноду через накопитель/эскалацию ради результата, к которому
 * `escalateToSideCar()` и так в итоге приходит по умолчанию — сразу
 * сеять регион 0:0, тот же "временный дом", что уже используется там.
 */
export function decideFirstPlacement({ beaconRegion = null, nameMatchRegion = null, regionProbs, regionCoords, isEmptyGraph = false }) {
    if (beaconRegion) return { status: 'placed', region: beaconRegion, reason: 'beacon' };
    if (nameMatchRegion) return { status: 'placed', region: nameMatchRegion, reason: 'name-match' };
    const confident = pickConfidentRegion(regionProbs, regionCoords);
    if (confident) return { status: 'placed', region: confident, reason: 'region-logit' };
    if (isEmptyGraph) return { status: 'placed', region: { sector: 0, ring: 0 }, reason: 'bootstrap-seed' };
    return { status: 'staged', reason: 'no-confident-region' };
}

/**
 * Решение для НОДЫ УЖЕ В НАКОПИТЕЛЕ (ретрай/эскалация). `turnsWaited` — ходов
 * с ПЕРВОЙ попытки (не с последней) — используется, чтобы понять, это ПЕРВЫЙ
 * ретрай (на +5 ходов) или уже пора думать про батч (+20 от НЕЁ, то есть
 * первая попытка была фактическим "попыткой 1", вторая — ретраем на ходу 5).
 */
export function decideStagingStep({ entry, regionProbs, regionCoords, settings = DEFAULT_SETTINGS, currentTurn, poolSize }) {
    const confident = pickConfidentRegion(regionProbs, regionCoords);
    if (confident) return { status: 'placed', region: confident, reason: 'region-logit-retry' };

    const attempts = entry.attemptCount ?? 1;
    if (attempts < 2) {
        // Попытка 1 уже была (нода создана и застряла). Второй шанс — ровно
        // на +stagingRetryTurns ходов от первой попытки, не раньше.
        const dueAt = entry.firstAttemptTurn + settings.stagingRetryTurns;
        if (currentTurn < dueAt) return { status: 'waiting' };
        return { status: 'retry-now' }; // вызывающий пересчитает попытку 2 отдельно — здесь просто "пора"
    }

    // Попытка 2 тоже не дала победителя — ждём батч ИЛИ таймаут, что раньше.
    const timeoutAt = entry.firstAttemptTurn + settings.stagingRetryTurns + settings.stagingMaxTurns;
    if (poolSize >= settings.stagingBatchSize || currentTurn >= timeoutAt) {
        return { status: 'escalate' };
    }
    return { status: 'waiting' };
}

function makeId(prefix, now, random) {
    return `${prefix}_${now().toString(36)}_${random().toString(36).slice(2, 8)}`;
}

function extractCharacterNames(text) {
    // Грубая, но дешёвая эвристика: слова с заглавной буквы длиной от 2 —
    // связь по имени должна быть точным совпадением (MEMORY_GRAPH.md), не
    // NER-моделью. Ложные срабатывания (начало предложения) отсеиваются на
    // этапе сверки с уже известными именами в графе, не здесь.
    return [...new Set((String(text ?? '').match(/\b[A-ZА-ЯЁ][a-zа-яё]{1,}\b/g) ?? []))];
}

// --- Авто-важность при бутстрапе из Lorebook (решено с пользователем:
// "читаем из LB поля, потом смотрим на количество соединений и проверяем")
// ------------------------------------------------------------------------

/**
 * Стартовый сигнал важности — ИЗ ПОЛЕЙ САМОЙ записи Lorebook, без единого
 * вызова модели (бутстрап намеренно НЕ зовёт SideCar вообще — см.
 * `bootstrapFromLorebook()`). Поля подтверждены по реальному исходнику ST
 * (`public/scripts/world-info.js`):
 * - `constant: true` — курируемая запись, ВСЕГДА активна независимо от
 *   ключевых слов (`aValue = a.disable?2:a.constant?0:1` — константные
 *   идут первыми, выше приоритетом всех остальных) — сильный сигнал:
 *   автор явно счёл её базовой.
 * - `order` — приоритет вставки, ЧЕМ БОЛЬШЕ ЧИСЛО, ТЕМ ВАЖНЕЕ
 *   (`sortFn: (a,b) => b.order - a.order`, реальная сортировка ST),
 *   нейтральное значение по умолчанию — 100 (`DEFAULT_WEIGHT` в исходнике
 *   ST). Отклонение от 100 — намеренная правка автора, переводится в
 *   ±3 шкалы важности.
 * Формула — эвристика ("на усмотрение", как и другие некалиброванные
 * пороги в этом файле — MEMORY_GRAPH.md), не протокол: числа подобраны,
 * чтобы курируемая constant-запись С нейтральным order давала ~6/10, а
 * обычная запись — ~3/10, оставляя пространство для бонуса за связи
 * (см. `applyConnectionBonus()`) до потолка 10.
 */
export function importanceFromLorebookEntry(entry) {
    let score = entry?.constant ? 6 : 3;
    const order = Number(entry?.order);
    if (Number.isFinite(order)) score += Math.max(-3, Math.min(3, Math.round((order - 100) / 25)));
    return Math.max(0, Math.min(10, score));
}

/**
 * Второй проход, ПОСЛЕ размещения всех записей бутстрапа (когда рёбра
 * `mentions` уже разведены `attachToRegion()` по точному совпадению
 * имени — до этого момента `degree` для более ранних записей неполный).
 * "Смотрим на количество соединений и проверяем" — узел, на который
 * реально ссылаются другие записи, явно центральнее по смыслу, чем
 * предполагал один только начальный сигнал из полей WI — добавляем
 * degree к базовой важности (не заменяем), с тем же потолком 10, что и у
 * остальной шкалы важности.
 */
export function applyConnectionBonus(baseImportance, degree) {
    return Math.max(0, Math.min(10, (baseImportance ?? 0) + (degree ?? 0)));
}

// --- LLM-driven семантические регионы бутстрапа (решено с пользователем,
// после живого разбора: старый дартборд-бутстрап давал ~80% нод без единой
// связи — единственный механизм связывания, extractCharacterNames(), ловит
// только дословное упоминание чужого имени, для локаций/фракций почти
// никогда не срабатывает; сама раскладка по 15 абстрактным ячейкам не
// несёт смысла). Три прогона SideCar + эмбединг-присвоение, см.
// MEMORY_GRAPH.md за полным разбором. Органический рост (`checkAndPlace`)
// этого не касается — остаётся на дартборде, решено явно: цена LLM здесь
// приемлема, потому что бутстрап — один раз на Lorebook, не на каждый ход.

/**
 * Общий system-prompt для всех трёх LLM-вызовов бутстрапа (решено с
 * пользователем явно: одного сэмплера/эффорта мало для воркеров не
 * OpenRouter-формата, где `reasoningEffort` не действует вовсе — эта
 * инструкция подкрепляет ту же цель словами). Задача механическая — точная
 * раскладка по заданным правилам, не творчество, поэтому явно запрещаем
 * долгие раздумья и отклонение от инструкции.
 */
export const BOOTSTRAP_SYSTEM_PROMPT = 'Follow the instructions in the user message exactly and literally. Do not add items beyond what is asked, do not skip required ones, do not rename or invent things the instructions did not ask for. This is a mechanical structured-data task, not a creative one — decide quickly without extended reasoning and reply with ONLY the requested JSON, nothing else.';

/**
 * Проход 1 — весь Lorebook целиком, раскладка ТОЛЬКО по `baseRegionNames`
 * (решено с пользователем: Проход 1 больше не может изобретать свои
 * регионы — за один прогон одновременно раскладывать под-центры И
 * добавлять новые центры было ошибкой, разделено на два прогона; изобретение
 * НОВЫХ регионов сверх базового списка — исключительно Проход 2, см.
 * buildAdditionalCentersPrompt()). Просим по 2 записи-под-центра на
 * каждый подходящий регион ИЗ ЭТОГО списка. Чистая функция — составление
 * текста промпта, ответ модели разбирается отдельно
 * (`parseRegionSkeletonResponse`), как и остальные SideCar-промпты в файле.
 */
export function buildRegionSkeletonPrompt(entries, baseRegionNames) {
    const listing = entries.map(entry => `${entry.uid}. ${entry.label}: ${entry.content}`).join('\n');
    return `Here is the FULL World Info / Lorebook for this story (${entries.length} entries, numbered):\n\n${listing}\n\nWe are organizing this into semantic regions of a memory graph. Use ONLY these regions — do NOT invent, rename, merge, or add any others: ${baseRegionNames.join(', ')}.\n\nFor EACH region that genuinely fits this lore, pick exactly 2 entries (by number) that best represent it — the most foundational, representative entries for that region. Skip a region if nothing in the lore fits it.\n\nReply with ONLY a JSON array, using EXACTLY the region names given above: [{"region": "region name", "subCenterUids": [number, number]}, ...]`;
}

/** Разбор ответа Прохода 1 — терпимо к частично неверным полям (регион без валидного uid отбрасывается целиком, не роняет остальные). */
export function parseRegionSkeletonResponse(parsed, entries) {
    if (!Array.isArray(parsed)) return [];
    const validUids = new Set(entries.map(entry => entry.uid));
    const seenUids = new Set();
    const regions = [];
    for (const item of parsed) {
        if (!item || typeof item !== 'object') continue;
        const name = String(item.region ?? '').trim();
        if (!name) continue;
        const uids = Array.isArray(item.subCenterUids)
            ? item.subCenterUids.map(Number).filter(uid => validUids.has(uid) && !seenUids.has(uid))
            : [];
        if (!uids.length) continue; // регион без единого валидного под-центра — не заводим
        for (const uid of uids) seenUids.add(uid);
        regions.push({ name, subCenterUids: uids.slice(0, 2) });
    }
    return regions;
}

/**
 * Проход 2 — центр для КАЖДОГО региона из Прохода 1 (у него пока только
 * под-центры) плюс новые регионы сверх них, чтобы дойти до целевой
 * плотности (`entriesPerRegionCenter` — один центр примерно на N записей).
 */
export function buildAdditionalCentersPrompt(entries, existingRegionNames, targetTotalRegions, entriesPerRegionCenter) {
    const listing = entries.map(entry => `${entry.uid}. ${entry.label}: ${entry.content}`).join('\n');
    return `The same World Info (${entries.length} entries, numbered) is being organized into these regions, each already has 2 representative entries: ${existingRegionNames.join(', ')}.\n\nWe need:\n1. A CENTER entry for EACH of these ${existingRegionNames.length} regions — the single most defining entry for that region (can be one of its own 2 representatives, or a different entry that fits better).\n2. Enough NEW regions (with their own center entry) so the total region count reaches about ${targetTotalRegions} (roughly one region per ${entriesPerRegionCenter} entries is the target density — deviate if the lore genuinely doesn't split that way).\n\nAll entries:\n${listing}\n\nReply with ONLY a JSON array covering ALL regions (the ${existingRegionNames.length} existing ones AND any new ones): [{"region": "region name", "centerUid": number}, ...]`;
}

/** Разбор ответа Прохода 2 — дедуп и по имени региона, и по uid центра (модель могла назначить один и тот же uid двум регионам). */
export function parseAdditionalCentersResponse(parsed, entries) {
    if (!Array.isArray(parsed)) return [];
    const validUids = new Set(entries.map(entry => entry.uid));
    const seenNames = new Set();
    const seenUids = new Set();
    const result = [];
    for (const item of parsed) {
        if (!item || typeof item !== 'object') continue;
        const name = String(item.region ?? '').trim();
        const uid = Number(item.centerUid);
        if (!name || seenNames.has(name) || !validUids.has(uid) || seenUids.has(uid)) continue;
        seenNames.add(name);
        seenUids.add(uid);
        result.push({ name, centerUid: uid });
    }
    return result;
}

/**
 * Присвоение ОСТАЛЬНЫХ записей — argmax косинуса к уже размещённым
 * центрам/под-центрам (не ко всем 15 дартборд-ячейкам — у семантических
 * регионов их просто нет). `anchors` — ноды с известным `regionId`
 * (центры/под-центры). Всегда находит регион, если есть хоть один якорь —
 * нет "накопителя"/неуверенности, как у дартборд-каскада: сравнение с
 * реальными эмбедингами однозначно.
 */
export function pickNearestRegion(embedding, anchors) {
    let bestRegionId = null;
    let bestScore = -Infinity;
    for (const anchor of anchors) {
        if (!anchor?.embedding || !anchor?.regionId) continue;
        const score = cosineSimilarity(embedding, anchor.embedding);
        if (score > bestScore) { bestScore = score; bestRegionId = anchor.regionId; }
    }
    return bestRegionId;
}

/**
 * Проход 3 — по ОДНОМУ вызову на КАЖДЫЙ регион, уже над реальными нодами
 * графа (`id` — id ноды, не lorebook uid: Проход 3 идёт ПОСЛЕ размещения).
 * Межрегиональные связи сюда не относятся — те продолжают ловиться
 * `extractCharacterNames()` внутри `attachToRegionByKey()`, как и раньше
 * (решено с пользователем: "пока оставим старым").
 */
export function buildRegionEdgesPrompt(regionNodes) {
    const listing = regionNodes.map(node => `${node.id}. ${node.label}: ${node.content}`).join('\n');
    return `These entries all belong to the SAME region of a memory graph:\n\n${listing}\n\nPropose meaningful connections BETWEEN these entries — which ones are genuinely related and would benefit from being linked (not every pair needs one). Reply with ONLY a JSON array of pairs, using the exact ids given above: [{"from": "id", "to": "id"}, ...] (empty array if truly nothing connects).`;
}

/** Разбор ответа Прохода 3 — фильтрует к валидным id региона, без петель на себя, без дублей (неориентированная пара). */
export function parseRegionEdgesResponse(parsed, regionNodes) {
    if (!Array.isArray(parsed)) return [];
    const validIds = new Set(regionNodes.map(node => node.id));
    const seen = new Set();
    const edges = [];
    for (const item of parsed) {
        if (!item || typeof item !== 'object') continue;
        const from = String(item.from ?? '');
        const to = String(item.to ?? '');
        if (!validIds.has(from) || !validIds.has(to) || from === to) continue;
        const key = [from, to].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ from, to });
    }
    return edges;
}

/**
 * Ядро графа памяти (MEMORY_GRAPH.md, Phase 1) — "TopTier" долгосрочная
 * память, физически параллельная BasicSummary ("LowTier"); Tier-переключатель
 * и их взаимоисключение — Phase 3, здесь Ядро всегда активно безусловно.
 *
 * Оркестрация читает `storage.chatMemory` (per-chat, неймспейс
 * `core.memoryGraph`): `settings`, `nodes` (map id→нода), `regions`
 * (map "sector:ring"→регион), `staging` (map nodeId→запись накопителя),
 * `distanceStats` (Уэлфорд, для адаптивного порога).
 *
 * **Phase 1 сознательно НЕ включает**: отбор маяков/маршрут+шум в промпт
 * (Phase 2 — у графа пока нет `generation.beforeSend`-вклада вообще, только
 * `generation.prepare` для размещения нод). Импорт существующего Lorebook
 * при бутстрапе РЕАЛИЗОВАН (`bootstrapFromLorebook` ниже) — оказался не
 * отдельной подсистемой, а прямым переиспользованием `placeNewNode()`.
 */
export function createMemoryGraphCore(host, { publish, now = Date.now, random = Math.random } = {}) {
    const publishEvent = publish ?? ((event, payload) => host.events.emit(event, payload));

    let settings = clampGraphSettings(DEFAULT_SETTINGS);
    let nodes = {};
    let regions = {};
    let staging = {};
    let mergeQueue = {};
    let reconsolidationQueue = {};
    let distanceStats = null;
    let turnCounter = 0;

    async function call(contract, params) {
        return request(host.own, contract, { params });
    }

    // `embedding.compute` — настоящий Сервис (services/embedding.js,
    // отдельная шина), не Ядро — как и `stLorebook.*` у cores/lorebook/index.js,
    // достать его можно ТОЛЬКО через `host.services` (Гейт), `host.own`
    // достаёт лишь Шину ядер. Раздельная функция — чтобы не перепутать снова.
    async function callService(contract, params) {
        return request(host.services, contract, { params });
    }

    let writeTail = Promise.resolve();
    function enqueueWrite(task) {
        const run = writeTail.then(task, task);
        writeTail = run.then(() => {}, () => {});
        return run;
    }

    async function loadSettings() {
        const result = await call('storage.settings.get', { namespace: PERSISTENCE_NAMESPACE, key: SETTINGS_KEY, fallback: null });
        if (result.ok && result.value) settings = clampGraphSettings(result.value);
        return settings;
    }

    async function configure(next) {
        settings = clampGraphSettings({ ...settings, ...next });
        await call('storage.settings.set', { namespace: PERSISTENCE_NAMESPACE, key: SETTINGS_KEY, value: settings });
        return settings;
    }

    async function loadState() {
        const [nodesResult, regionsResult, stagingResult, mergeQueueResult, reconsolidationQueueResult, statsResult] = await Promise.all([
            call('storage.chatMemory.get', { namespace: PERSISTENCE_NAMESPACE, key: NODES_KEY, fallback: {} }),
            call('storage.chatMemory.get', { namespace: PERSISTENCE_NAMESPACE, key: REGIONS_KEY, fallback: {} }),
            call('storage.chatMemory.get', { namespace: PERSISTENCE_NAMESPACE, key: STAGING_KEY, fallback: {} }),
            call('storage.chatMemory.get', { namespace: PERSISTENCE_NAMESPACE, key: MERGE_QUEUE_KEY, fallback: {} }),
            call('storage.chatMemory.get', { namespace: PERSISTENCE_NAMESPACE, key: RECONSOLIDATION_QUEUE_KEY, fallback: {} }),
            call('storage.chatMemory.get', { namespace: PERSISTENCE_NAMESPACE, key: STATS_KEY, fallback: null }),
        ]);
        nodes = nodesResult.ok ? nodesResult.value ?? {} : {};
        regions = regionsResult.ok ? regionsResult.value ?? {} : {};
        staging = stagingResult.ok ? stagingResult.value ?? {} : {};
        mergeQueue = mergeQueueResult.ok ? mergeQueueResult.value ?? {} : {};
        reconsolidationQueue = reconsolidationQueueResult.ok ? reconsolidationQueueResult.value ?? {} : {};
        distanceStats = statsResult.ok ? statsResult.value : null;
    }

    async function persistNodes() { await call('storage.chatMemory.set', { namespace: PERSISTENCE_NAMESPACE, key: NODES_KEY, value: nodes }); }
    async function persistRegions() { await call('storage.chatMemory.set', { namespace: PERSISTENCE_NAMESPACE, key: REGIONS_KEY, value: regions }); }
    async function persistStaging() { await call('storage.chatMemory.set', { namespace: PERSISTENCE_NAMESPACE, key: STAGING_KEY, value: staging }); }
    async function persistMergeQueue() { await call('storage.chatMemory.set', { namespace: PERSISTENCE_NAMESPACE, key: MERGE_QUEUE_KEY, value: mergeQueue }); }
    async function persistReconsolidationQueue() { await call('storage.chatMemory.set', { namespace: PERSISTENCE_NAMESPACE, key: RECONSOLIDATION_QUEUE_KEY, value: reconsolidationQueue }); }
    async function persistStats() { await call('storage.chatMemory.set', { namespace: PERSISTENCE_NAMESPACE, key: STATS_KEY, value: distanceStats }); }

    /**
     * Внутриигровые дата/время (обязательное поле ноды, по прямому запросу
     * пользователя). RP Time — опциональный community-Модуль; если не
     * включён, `tracking.fields` придёт `ok:false` (проверено по реальному
     * коду `cores/tracking/index.js`'s `requireTracker()`, бросающему на
     * неизвестном id) — деградирует до `null`, не бросает и не блокирует
     * создание ноды.
     */
    async function readGameTime() {
        const result = await call('tracking.fields', { trackerId: RP_TIME_TRACKER_ID });
        if (!result.ok || !Array.isArray(result.value) || !result.value.length) return null;
        return Object.fromEntries(result.value.map(field => [field.name, field.value]));
    }

    /** Число ходов, движущее decay — игровое время, если доступно, иначе фолбэк на число сообщений (решено с пользователем). Phase 1: `gameTime` хранится как снимок на ноде, а "прошедшее время" считается по `turnCounter` даже когда RP Time активен — настоящий парсинг разницы игровых дат в единый линейный счёт часов/дней остаётся вне Phase 1 (не решено, какой формат RP Time вернёт: пресеты разные — day-counter даёт число, full-date — нет единого "числа хода"). Задокументировано, не скрыто. */
    function elapsedTurnsFor(node) {
        return Math.max(0, turnCounter - (node.createdTurn ?? turnCounter));
    }

    function regionEntry(sector, ring) {
        const key = regionKey(sector, ring);
        return regions[key] ?? { sector, ring, centerNodeId: null, subCenterIds: [], nodeIds: [], wordProfile: {} };
    }

    /**
     * Векторные вероятности региона — косинус к центру региона (не к среднему
     * всех нод, MEMORY_GRAPH.md — против дрейфа центроида), softmax поверх
     * сходств. Регион без центра ещё — НЕЙТРАЛЬНОЕ сходство 0.5 (то же
     * значение, что дал бы РЕАЛЬНЫЙ центр при cos=0, "не похоже и не
     * непохоже"), а не 0. Раньше было 0 — "хуже любого совпадения", а не
     * "неизвестно": из-за этого после самой первой ноды графа единственный
     * уже занятый регион побеждал АБСОЛЮТНО ВСЕГДА (sum>0 берёт только его
     * ненулевой вклад, остальные 14 обнулялись начисто) — ни одна вторая
     * тема никогда не получала свой регион, самоусиливающийся тупик.
     * Найдено живьём: реальный бутстрап из Lorebook (61 запись) свалил
     * буквально всё в регион 0:0. Тест — memory-graph-orchestration.test.js,
     * "a genuinely UNRELATED second entry...".
     */
    function vectorProbsForAllRegions(embedding) {
        const coords = allRegionCoords();
        const sims = coords.map(({ sector, ring }) => {
            const region = regionEntry(sector, ring);
            const center = region.centerNodeId ? nodes[region.centerNodeId] : null;
            return center?.embedding ? (cosineSimilarity(embedding, center.embedding) + 1) / 2 : 0.5; // сдвиг в [0,1] — softmax ниже не любит отрицательные "вероятности"
        });
        const sum = sims.reduce((a, b) => a + b, 0);
        const probs = sum > 0 ? sims.map(s => s / sum) : coords.map(() => 1 / coords.length);
        return { coords, probs };
    }

    function keywordCountsForAllRegions(coords, text) {
        const words = wordsOf(text);
        return coords.map(({ sector, ring }) => {
            const profile = regionEntry(sector, ring).wordProfile;
            return words.reduce((sum, word) => sum + (profile[word] ?? 0), 0);
        });
    }

    function bumpWordProfile(sector, ring, text) {
        const region = regionEntry(sector, ring);
        const profile = { ...region.wordProfile };
        for (const word of wordsOf(text)) profile[word] = (profile[word] ?? 0) + 1;
        regions[regionKey(sector, ring)] = { ...region, sector, ring, wordProfile: profile };
    }

    function findNameMatchRegion(text) {
        for (const name of extractCharacterNames(text)) {
            const owner = Object.values(nodes).find(node => node.label === name && node.regionId);
            if (owner) { const [sector, ring] = owner.regionId.split(':').map(Number); return { sector, ring }; }
        }
        return null;
    }

    /** Убирает узел ОТОВСЮДУ: из своего региона (включая роль центра/под-центра, если была) и из рёбер/degree всех, кто на него ссылался — иначе `nodeEvicted` оставлял бы висячие ссылки. */
    function removeNodeFromGraph(nodeId) {
        const node = nodes[nodeId];
        if (!node) return;
        for (const other of Object.values(nodes)) {
            if (other.id === nodeId || !other.edges?.length) continue;
            const kept = other.edges.filter(edge => edge.to !== nodeId);
            if (kept.length !== other.edges.length) {
                other.degree = Math.max(0, (other.degree ?? 0) - (other.edges.length - kept.length));
                other.edges = kept;
            }
        }
        if (node.regionId && regions[node.regionId]) {
            const region = regions[node.regionId];
            regions[node.regionId] = {
                ...region,
                nodeIds: region.nodeIds.filter(id => id !== nodeId),
                subCenterIds: region.subCenterIds.filter(id => id !== nodeId),
                centerNodeId: region.centerNodeId === nodeId ? null : region.centerNodeId,
            };
        }
        delete nodes[nodeId];
    }

    /**
     * Кластер СЛАБЕЙШИХ незащищённых узлов региона — ставится в очередь на
     * SideCar-сжатие (см. `sweepReconsolidationQueue`) ВМЕСТО немедленного
     * вытеснения, решено с пользователем: реконсолидация сохраняет БОЛЬШЕ
     * информации (сжимает N узлов в один плотный), чем вытеснение (теряет
     * узел целиком) — предпочитаем её, когда кластер вообще набирается.
     * Не хватает `reconsolidationMinCluster` незащищённых кандидатов (не
     * считая уже стоящих в очереди — не дублируем запись) → `false`,
     * вызывающий падает на обычное вытеснение. Регион временно превышает
     * лимит, пока очередь не созреет — тот же принцип, что уже принят для
     * "регион целиком из защищённых".
     */
    function tryQueueReconsolidation(key, members) {
        const alreadyQueued = new Set(Object.values(reconsolidationQueue).flatMap(entry => entry.nodeIds));
        const eligible = members.filter(member => !member.protectedNode && !alreadyQueued.has(member.id));
        if (eligible.length < settings.reconsolidationMinCluster) return false;

        const weakest = eligible
            .map(member => ({
                id: member.id,
                weight: computeNodeWeight({
                    importance: member.importance, degree: member.degree,
                    elapsed: Math.max(0, turnCounter - (member.createdTurn ?? turnCounter)),
                    protectedNode: false, settings,
                }),
            }))
            .sort((a, b) => a.weight - b.weight)
            .slice(0, settings.reconsolidationMinCluster)
            .map(entry => entry.id);

        const groupKey = [...weakest].sort().join('|');
        reconsolidationQueue[groupKey] = { nodeIds: weakest, regionId: key, queuedTurn: turnCounter };
        return true;
    }

    /**
     * Переполнение региона (MEMORY_GRAPH.md, решено с пользователем) — СРАЗУ
     * при вставке сверх `maxNodesPerRegion` (23 = 1 центр + 2 под-центра + до
     * 10 каждый, буквально по формуле), не отдельным sweep'ом. Три рубежа
     * по порядку: объединение дублей (`detectMergeCandidate` выше,
     * срабатывает ДО этой функции на каждой вставке) → реконсолидация
     * кластера слабых (`tryQueueReconsolidation`, предпочитается — сохраняет
     * информацию) → decay-вытеснение слабейшего `computeNodeWeight()`
     * (последний рубеж, только если реконсолидировать нечего).
     */
    function enforceRegionCapacity(key) {
        const region = regions[key];
        if (!region || region.nodeIds.length <= settings.maxNodesPerRegion) return;
        const members = region.nodeIds.map(id => nodes[id]).filter(Boolean);
        if (tryQueueReconsolidation(key, members)) return;
        const victimId = pickEvictionCandidate(members, { settings, turnCounter });
        if (!victimId) return; // регион целиком из защищённых узлов — вытеснять нечего, задокументированный крайний случай
        removeNodeFromGraph(victimId);
        publishEvent('memoryGraph.nodeEvicted', { nodeId: victimId, regionId: key, reason: 'capacity' });
    }

    /**
     * Дешёвый двухступенчатый отбор "подозреваемых" на дубликат (слова →
     * эмбединг, `findMergeCandidate()`), сравнивает ТОЛЬКО внутри региона,
     * куда только что попал новый узел. Найденную пару НЕ сливает сразу —
     * ставит в очередь на SideCar (см. `sweepMergeQueue`), решено с
     * пользователем явно: слияние — не бесплатное решение "на глаз",
     * заслуживает суждения модели, но не блокирует текущую вставку.
     */
    function detectMergeCandidate(node, key) {
        const region = regions[key];
        if (!region) return;
        const newNode = { id: node.id, embedding: node.embedding, words: wordsOf(node.content) };
        const members = region.nodeIds
            .filter(id => id !== node.id)
            .map(id => nodes[id])
            .filter(Boolean)
            .map(member => ({ id: member.id, embedding: member.embedding, words: wordsOf(member.content) }));
        const matchId = findMergeCandidate(newNode, members, {
            wordOverlapThreshold: settings.mergeWordOverlapThreshold,
            similarityThreshold: settings.mergeSimilarityThreshold,
        });
        if (!matchId) return;
        const pairKey = [node.id, matchId].sort().join('|');
        if (mergeQueue[pairKey]) return; // уже в очереди — не дублируем запись
        mergeQueue[pairKey] = { nodeIdA: node.id, nodeIdB: matchId, queuedTurn: turnCounter, regionId: key };
    }

    /** Объединяет рёбра N сливаемых узлов в рёбра ОДНОГО: ребро на любого из партнёров по слиянию отбрасывается (иначе стало бы петлёй на себя), дубликаты по (to,type) схлопываются. Общая для объединения дублей (N=2) и реконсолидации (N=3+). */
    function combineEdges(edgeArrays, mergedAwayIds) {
        const seen = new Set();
        const result = [];
        for (const edges of edgeArrays) {
            for (const edge of edges ?? []) {
                if (mergedAwayIds.includes(edge.to)) continue;
                const dedupeKey = `${edge.to}:${edge.type}`;
                if (seen.has(dedupeKey)) continue;
                seen.add(dedupeKey);
                result.push(edge);
            }
        }
        return result;
    }

    /** Заменяет ВСЕ старые id одним новым во всех ролях региона (центр/под-центр/обычный узел). */
    function replaceInRegion(key, oldIds, newId) {
        const region = regions[key];
        if (!region) return;
        regions[key] = {
            ...region,
            nodeIds: [...region.nodeIds.filter(id => !oldIds.includes(id)), newId],
            subCenterIds: region.subCenterIds.filter(id => !oldIds.includes(id)),
            centerNodeId: oldIds.includes(region.centerNodeId) ? newId : region.centerNodeId,
        };
    }

    /**
     * Реально сливает/сжимает N>=2 узлов в один (вызывается из
     * `sweepMergeQueue`/`sweepReconsolidationQueue` уже ПОСЛЕ подтверждения
     * SideCar) — общая механика для объединения дублей (пара) и
     * реконсолидации (кластер слабых). Защищённость и более старый
     * `createdTurn` наследуются от ЛЮБОГО из оригиналов — слияние не должно
     * СНИЖАТЬ защиту или "омолодить" узел (для реконсолидации это на
     * практике всегда `false`/минимум кластера, поскольку в кластер попадают
     * только незащищённые узлы — см. `tryQueueReconsolidation`). Рёбра
     * других узлов на любой из оригиналов ПЕРЕАДРЕСУЮТСЯ на слитый узел, а
     * не обрываются — это объединение, не вытеснение.
     */
    function foldNodesInGraph(nodeIds, verdict, embedding) {
        const originals = nodeIds.map(id => nodes[id]).filter(Boolean);
        if (originals.length !== nodeIds.length) return null; // кто-то уже пропал (эвикшен/другое слияние) — очередь просто устарела

        const mergedId = makeId('node', now, random);
        const mergedEdges = combineEdges(originals.map(node => node.edges), nodeIds);
        const merged = {
            id: mergedId,
            label: verdict.label,
            content: verdict.content,
            embedding,
            importance: Math.max(verdict.importance ?? 0, ...originals.map(node => node.importance ?? 0)),
            degree: mergedEdges.length,
            createdAt: now(),
            createdTurn: Math.min(...originals.map(node => node.createdTurn ?? turnCounter)),
            lastTouchedTurn: turnCounter,
            protectedNode: originals.some(node => node.protectedNode),
            regionId: originals.find(node => node.regionId)?.regionId ?? null,
            edges: mergedEdges,
            gameTime: originals.find(node => node.gameTime)?.gameTime ?? null,
        };
        nodes[mergedId] = merged;

        for (const other of Object.values(nodes)) {
            if (other.id === mergedId || !other.edges?.length) continue;
            const seen = new Set();
            let changed = false;
            const redirected = [];
            for (const edge of other.edges) {
                const to = nodeIds.includes(edge.to) ? mergedId : edge.to;
                if (to !== edge.to) changed = true;
                const dedupeKey = `${to}:${edge.type}`;
                if (seen.has(dedupeKey)) { changed = true; continue; } // редирект мог создать параллельный дубль ребра
                seen.add(dedupeKey);
                redirected.push(to === edge.to ? edge : { ...edge, to });
            }
            if (changed) { other.edges = redirected; other.degree = redirected.length; }
        }

        const touchedRegions = new Set(originals.map(node => node.regionId).filter(Boolean));
        for (const regionIdKey of touchedRegions) replaceInRegion(regionIdKey, nodeIds, mergedId);

        for (const id of nodeIds) delete nodes[id];
        return mergedId;
    }

    /**
     * Обобщённая версия `attachToRegion()` — по произвольному строковому
     * `key`, не только "sector:ring" (решено с пользователем: семантические
     * регионы бутстрапа из Lorebook, MEMORY_GRAPH.md, "LLM-driven
     * семантические регионы" — у них нет геометрии дартса вообще). Вся
     * реальная логика теперь ЗДЕСЬ; `attachToRegion(node, sector, ring)`
     * ниже — тонкая обёртка (плюс дартборд-специфичный `bumpWordProfile`,
     * который семантическим регионам не нужен — они не участвуют в
     * `vectorProbsForAllRegions`'s keyword-логитах).
     *
     * `forceRole` — ЯВНОЕ назначение роли (`'center'`/`'subCenter'`/
     * `'ordinary'`/`null`), а не по порядку прибытия: у семантического
     * региона роль уже решила LLM (Проход 1/2 бутстрапа), не "кто пришёл
     * первым". `null` (по умолчанию) — старое авто-поведение по порядку
     * вставки, для дартборд-пути не меняется. `'ordinary'` — РЕАЛЬНЫЙ баг,
     * найденный живьём: обычные записи бутстрапа, присвоенные региону через
     * `pickNearestRegion()` (не LLM-роль), шли с `forceRole: null` и
     * ПОДХВАТЫВАЛИ старую авто-детекцию под-центра по порядку вставки —
     * третья запись в свежесозданном семантическом регионе неожиданно
     * становилась под-центром (раз `region.subCenterIds.length < settings.subCentersPerRegion`
     * ещё не исчерпан), затем `enforceBackboneConnectivity()` тянул её в
     * бэкбон. `'ordinary'` — явный отказ от авто-детекции, всегда
     * обычная нода, независимо от `subCentersPerRegion`.
     */
    function attachToRegionByKey(node, key, { createRegion = () => ({ centerNodeId: null, subCenterIds: [], nodeIds: [], wordProfile: {} }), forceRole = null } = {}) {
        const region = regions[key] ?? createRegion();
        // 'ordinary' явно ОТКЛЮЧАЕТ и роль центра (даже если региона ещё
        // технически не было — защитный край, семантический бутстрап
        // никогда не зовёт 'ordinary' раньше центра региона), и авто-детекцию
        // под-центра по порядку вставки.
        const isFirst = forceRole === 'ordinary' ? false : !region.centerNodeId;
        const isSubCenter = forceRole
            ? forceRole === 'subCenter'
            : (!isFirst && region.subCenterIds.length < settings.subCentersPerRegion);
        regions[key] = {
            ...region,
            centerNodeId: region.centerNodeId ?? node.id,
            subCenterIds: isSubCenter ? [...region.subCenterIds, node.id] : region.subCenterIds,
            nodeIds: [...region.nodeIds, node.id],
        };
        node.regionId = key;
        node.protectedNode = node.protectedNode || isFirst || isSubCenter; // центр/под-центр региона — защищены (MEMORY_GRAPH.md)
        for (const name of extractCharacterNames(node.content)) {
            const owner = Object.values(nodes).find(other => other.id !== node.id && other.label === name);
            if (!owner) continue;
            // Потолок связей для ОБЫЧНЫХ ("малых", не protectedNode) нод —
            // решено с пользователем явно, числом: не больше
            // `ordinaryMaxDegree` связей вообще. Центр/под-центр здесь без
            // потолка — их собственные пределы (если есть) обеспечивает
            // ОТДЕЛЬНЫЙ, активный механизм `enforceBackboneConnectivity()`,
            // не органическое связывание по имени.
            if (!node.protectedNode && (node.degree ?? 0) >= settings.ordinaryMaxDegree) continue;
            if (!owner.protectedNode && (owner.degree ?? 0) >= settings.ordinaryMaxDegree) continue;
            node.edges = [...(node.edges ?? []), { to: owner.id, type: 'mentions' }];
            owner.edges = [...(owner.edges ?? []), { to: node.id, type: 'mentions' }];
            node.degree = (node.degree ?? 0) + 1;
            owner.degree = (owner.degree ?? 0) + 1;
        }
        detectMergeCandidate(node, key);
        enforceRegionCapacity(key);
    }

    function attachToRegion(node, sector, ring) {
        bumpWordProfile(sector, ring, node.content);
        attachToRegionByKey(node, regionKey(sector, ring), {
            createRegion: () => ({ sector, ring, centerNodeId: null, subCenterIds: [], nodeIds: [], wordProfile: {} }),
        });
    }

    // --- Бэкбон связности между центрами/под-центрами (решено с
    // пользователем явно, числами: "малая нода — не больше 3 связей,
    // под-центр — 10-15, центр — не менее 4, но только к другим
    // центрам/под-центрам"). АКТИВНОЕ досоздание рёбер — органическое
    // связывание по имени (`attachToRegion()`) физически не может это
    // гарантировать: на 15 регионов даже 4 связи у КАЖДОГО центра —
    // не то, что появится само по себе от случайных упоминаний в 1-2
    // предложениях лорбука. Приоритет кандидатов — СНАЧАЛА соседние по
    // геометрии дартса регионы (`regionAdjacency()`, тот же принцип "не
    // LLM решает соседство"), потом — по убыванию косинуса эмбедингов
    // среди оставшихся. Сейчас зовётся только из `bootstrapFromLorebook()`
    // (решено с пользователем: область действия — бутстрап, не
    // органический рост графа за ходом).

    function isCenterNode(nodeId) {
        return Object.values(regions).some(region => region.centerNodeId === nodeId);
    }

    function isBackboneNode(nodeId) {
        return Object.values(regions).some(region => region.centerNodeId === nodeId || region.subCenterIds.includes(nodeId));
    }

    /** Степень узла, считая ТОЛЬКО связи с другими бэкбон-узлами (центр/под-центр) — то, что реально нужно центру (peer-only минимум), не общая степень. */
    function peerDegree(node) {
        return (node.edges ?? []).filter(edge => isBackboneNode(edge.to)).length;
    }

    function addBackboneEdge(a, b) {
        if ((a.edges ?? []).some(edge => edge.to === b.id)) return; // уже связаны (органически или предыдущим проходом)
        a.edges = [...(a.edges ?? []), { to: b.id, type: 'backbone' }];
        b.edges = [...(b.edges ?? []), { to: a.id, type: 'backbone' }];
        a.degree = (a.degree ?? 0) + 1;
        b.degree = (b.degree ?? 0) + 1;
    }

    function enforceBackboneConnectivity() {
        const backboneIds = Object.values(regions).flatMap(region => [region.centerNodeId, ...region.subCenterIds]).filter(Boolean);
        for (const nodeId of backboneIds) {
            const node = nodes[nodeId];
            if (!node) continue;
            const center = isCenterNode(nodeId);
            // Центр — минимум ТОЛЬКО по peer-связям (могут быть и другие,
            // органические, связи с обычными нодами — они сюда не
            // считаются и не мешают). Под-центр — минимум/максимум по
            // ОБЩЕЙ степени (решено с пользователем — у под-центра
            // ограничение без оговорки "только к центрам").
            const need = center
                ? Math.max(0, settings.centerMinBackboneDegree - peerDegree(node))
                : Math.max(0, settings.subCenterMinDegree - (node.degree ?? 0));
            if (need <= 0) continue;

            const connectedIds = new Set((node.edges ?? []).map(edge => edge.to));
            const [ownSector, ownRing] = node.regionId ? node.regionId.split(':').map(Number) : [null, null];
            const adjacentKeys = node.regionId
                ? new Set(regionAdjacency(ownSector, ownRing).map(({ sector, ring }) => regionKey(sector, ring)))
                : new Set();

            const pool = backboneIds
                .filter(id => id !== nodeId && !connectedIds.has(id) && nodes[id])
                .map(id => ({
                    id,
                    adjacent: adjacentKeys.has(nodes[id].regionId) ? 1 : 0,
                    similarity: cosineSimilarity(node.embedding, nodes[id].embedding),
                }))
                .sort((a, b) => (b.adjacent - a.adjacent) || (b.similarity - a.similarity));

            let added = 0;
            for (const candidate of pool) {
                if (added >= need) break;
                const other = nodes[candidate.id];
                // Под-центр не должен пробить СВОЙ потолок (15), и не
                // должен пробивать потолок соседнего под-центра тоже —
                // центр без верхнего предела вовсе.
                if (!center && (node.degree ?? 0) >= settings.subCenterMaxDegree) break;
                if (!isCenterNode(candidate.id) && (other.degree ?? 0) >= settings.subCenterMaxDegree) continue;
                addBackboneEdge(node, other);
                added += 1;
            }
        }
    }

    // --- Импорт главного персонажа из карточки (решено с пользователем:
    // "если в LB нет ноды главного Char (он полностью в карточке) - надо
    // создавать ноду автоматически"; форма УТОЧНЕНА пользователем позже —
    // не автоматическая эвристика, а явный выбор в UI: "персонаж уже в
    // LB" (ничего не делать) / "только в карточке" (эта функция)) --------

    /** Насколько важен персонаж по умолчанию — не откалиброванный протокол, как и другие эвристики важности в этом файле; главный персонаж по определению не второстепенная деталь. */
    const MAIN_CHARACTER_IMPORTANCE = 7;

    /**
     * Ставит ноду главного персонажа тем же КАСКАДОМ размещения, что и у
     * бутстрапа/SideCar-нод (`placeNewNode()`) — не ручным сектором/кольцом:
     * у пользователя нет оснований выбирать регион для персонажа вручную,
     * эмбединг решает сам, как для любой другой органической записи. Поля
     * карточки — ТОЛЬКО `description`+`personality` (решено с
     * пользователем явно, из нескольких вариантов). Источник данных —
     * `stCharacter.current` (Сервис, `services/st-character.js`,
     * `host.services`, не `host.own` — тот же принцип, что у
     * `embedding.compute`).
     */
    async function createNodeFromCharacterCard() {
        return enqueueWrite(async () => {
            const characterResult = await callService('stCharacter.current');
            if (!characterResult.ok || !characterResult.value) return { ok: false, error: 'No active character.' };
            const character = characterResult.value;
            const label = String(character.name ?? '').trim() || 'Main Character';
            const content = [character.description, character.personality]
                .map(part => String(part ?? '').trim()).filter(Boolean).join('\n\n');
            if (!content) return { ok: false, error: 'Character card has no description/personality to import.' };

            const embeddingResult = await callService('embedding.compute', { text: `${label}: ${content}`, kind: 'passage' });
            if (!embeddingResult.ok) return { ok: false, error: embeddingResult.error.message };
            const { coords, probs: vectorProbs } = vectorProbsForAllRegions(embeddingResult.value);
            const result = placeNewNode({ label, content, embedding: embeddingResult.value, importance: MAIN_CHARACTER_IMPORTANCE }, { coords, vectorProbs });
            // См. комментарий в checkAndPlace() — то же самое: attachToRegion()
            // может тронуть mergeQueue/reconsolidationQueue, не только nodes/regions/staging.
            await Promise.all([persistNodes(), persistRegions(), persistStaging(), persistMergeQueue(), persistReconsolidationQueue()]);
            publishEvent('memoryGraph.nodeCreated', { nodeId: result.nodeId, status: result.status, source: 'characterCard' });
            return { ok: true, nodeId: result.nodeId, status: result.status, label };
        });
    }

    // --- Ручное редактирование графа (UI-редактор, решено с пользователем:
    // "полноценный UI... вызов любой функции вручную, редактирование,
    // создание, перемещение нод и связей") ------------------------------

    /**
     * Ручное создание узла. БЕЗ каскада размещения — сектор/кольцо задаёт
     * сам пользователь явно; `attachToRegion()` переиспользуется напрямую,
     * тем же путём, что и любая другая вставка (word-profile,
     * merge-detection, capacity-enforcement срабатывают "бесплатно", как
     * для органической ноды — создание в переполненный регион МОЖЕТ
     * вызвать вытеснение/реконсолидацию/объединение уже лежащих там узлов).
     */
    async function createNodeManually({ label, content, importance = 0, sector, ring } = {}) {
        return enqueueWrite(async () => {
            if (!Number.isInteger(sector) || sector < 0 || sector >= SECTORS || !Number.isInteger(ring) || ring < 0 || ring >= RINGS) {
                return { ok: false, error: `sector must be an integer in [0,${SECTORS}), ring in [0,${RINGS}).` };
            }
            const cleanLabel = String(label ?? '').trim() || 'Untitled';
            const cleanContent = String(content ?? '').trim();
            if (!cleanContent) return { ok: false, error: 'content is required.' };

            const embeddingResult = await callService('embedding.compute', { text: `${cleanLabel}: ${cleanContent}`, kind: 'passage' });
            if (!embeddingResult.ok) return { ok: false, error: embeddingResult.error.message };

            const node = {
                id: makeId('node', now, random),
                label: cleanLabel, content: cleanContent, embedding: embeddingResult.value,
                importance: Number(importance) || 0,
                degree: 0,
                createdAt: now(),
                createdTurn: turnCounter,
                lastTouchedTurn: turnCounter,
                protectedNode: false,
                regionId: null,
                edges: [],
                gameTime: null,
            };
            nodes[node.id] = node;
            attachToRegion(node, sector, ring);
            await Promise.all([persistNodes(), persistRegions(), persistStaging(), persistMergeQueue(), persistReconsolidationQueue()]);
            publishEvent('memoryGraph.nodeCreated', { nodeId: node.id, status: 'placed', manual: true });
            return { ok: true, nodeId: node.id };
        });
    }

    /**
     * Ручное редактирование узла. Пересчитывает эмбединг ТОЛЬКО если
     * `label`/`content` реально изменились — иначе он рассинхронизируется
     * с текстом, ломая маяки/merge-detection (оба читают `embedding` как
     * источник истины о содержимом узла).
     */
    async function updateNodeManually({ id, label, content, importance, protectedNode } = {}) {
        return enqueueWrite(async () => {
            const node = nodes[id];
            if (!node) return { ok: false, error: `no such node: ${id}` };

            const nextLabel = label === undefined ? node.label : (String(label).trim() || node.label);
            const nextContent = content === undefined ? node.content : String(content).trim();
            if (content !== undefined && !nextContent) return { ok: false, error: 'content cannot be empty.' };
            const contentChanged = nextLabel !== node.label || nextContent !== node.content;

            if (contentChanged) {
                const embeddingResult = await callService('embedding.compute', { text: `${nextLabel}: ${nextContent}`, kind: 'passage' });
                if (!embeddingResult.ok) return { ok: false, error: embeddingResult.error.message };
                node.embedding = embeddingResult.value;
            }
            node.label = nextLabel;
            node.content = nextContent;
            if (importance !== undefined) node.importance = Number(importance) || 0;
            if (protectedNode !== undefined) node.protectedNode = Boolean(protectedNode);
            node.lastTouchedTurn = turnCounter;

            await persistNodes();
            publishEvent('memoryGraph.nodeUpdated', { nodeId: id });
            return { ok: true };
        });
    }

    /** Ручное удаление узла — переиспользует существующий `removeNodeFromGraph()` целиком. */
    async function deleteNodeManually({ id } = {}) {
        return enqueueWrite(async () => {
            if (!nodes[id]) return { ok: false, error: `no such node: ${id}` };
            removeNodeFromGraph(id);
            await Promise.all([persistNodes(), persistRegions()]);
            publishEvent('memoryGraph.nodeDeleted', { nodeId: id });
            return { ok: true };
        });
    }

    /**
     * "Перетаскивание = смена региона" (решено с пользователем явно, не
     * косметика). Убирает узел из старого региона — если он был
     * `centerNodeId` этого региона, регион ОСТАЁТСЯ без центра, автомат
     * переназначения НЕТ (тот же принцип, что "регион целиком из
     * защищённых" у вытеснения — задокументированный крайний случай, не
     * решается здесь; пользователь может перетащить туда другой узел
     * вручную). Затем `attachToRegion()` в новый регион — ТОТ ЖЕ побочный
     * эффект `enforceRegionCapacity()`, что и у органической вставки:
     * перетаскивание в переполненный регион МОЖЕТ вызвать
     * вытеснение/реконсолидацию/объединение уже лежащих там узлов, не
     * только визуальный эффект.
     */
    async function moveNodeManually({ id, sector, ring } = {}) {
        return enqueueWrite(async () => {
            const node = nodes[id];
            if (!node) return { ok: false, error: `no such node: ${id}` };
            if (!Number.isInteger(sector) || sector < 0 || sector >= SECTORS || !Number.isInteger(ring) || ring < 0 || ring >= RINGS) {
                return { ok: false, error: `sector must be an integer in [0,${SECTORS}), ring in [0,${RINGS}).` };
            }
            const targetKey = regionKey(sector, ring);
            if (node.regionId === targetKey) return { ok: true, nodeId: id }; // уже там — не пересчитываем зря

            if (node.regionId && regions[node.regionId]) {
                const oldRegion = regions[node.regionId];
                regions[node.regionId] = {
                    ...oldRegion,
                    nodeIds: oldRegion.nodeIds.filter(otherId => otherId !== id),
                    subCenterIds: oldRegion.subCenterIds.filter(otherId => otherId !== id),
                    centerNodeId: oldRegion.centerNodeId === id ? null : oldRegion.centerNodeId,
                };
            }
            node.regionId = null; // attachToRegion() ожидает узел вне региона — та же форма, что у новой ноды
            attachToRegion(node, sector, ring);

            await Promise.all([persistNodes(), persistRegions(), persistStaging(), persistMergeQueue(), persistReconsolidationQueue()]);
            publishEvent('memoryGraph.nodeMoved', { nodeId: id, regionId: targetKey });
            return { ok: true, nodeId: id };
        });
    }

    /** Ручное создание ребра — двусторонняя запись, тот же приём, что везде в файле (mentions-рёбра, слияние). Повторное создание уже существующей (to,type)-пары — не-операция, не дублирует. */
    async function createEdgeManually({ fromId, toId, type } = {}) {
        return enqueueWrite(async () => {
            const from = nodes[fromId];
            const to = nodes[toId];
            if (!from || !to) return { ok: false, error: 'both fromId and toId must be real nodes.' };
            if (fromId === toId) return { ok: false, error: 'a node cannot have an edge to itself.' };
            const edgeType = String(type ?? '').trim() || 'mentions';
            if ((from.edges ?? []).some(edge => edge.to === toId && edge.type === edgeType)) return { ok: true };

            from.edges = [...(from.edges ?? []), { to: toId, type: edgeType }];
            to.edges = [...(to.edges ?? []), { to: fromId, type: edgeType }];
            from.degree = (from.degree ?? 0) + 1;
            to.degree = (to.degree ?? 0) + 1;

            await persistNodes();
            publishEvent('memoryGraph.edgeCreated', { fromId, toId, type: edgeType });
            return { ok: true };
        });
    }

    /** Ручное удаление ребра — снимает обе стороны, degree--. */
    async function deleteEdgeManually({ fromId, toId, type } = {}) {
        return enqueueWrite(async () => {
            const from = nodes[fromId];
            const to = nodes[toId];
            if (!from || !to) return { ok: false, error: 'both fromId and toId must be real nodes.' };
            const edgeType = String(type ?? '').trim() || 'mentions';

            const fromBefore = from.edges?.length ?? 0;
            from.edges = (from.edges ?? []).filter(edge => !(edge.to === toId && edge.type === edgeType));
            from.degree = Math.max(0, (from.degree ?? 0) - (fromBefore - from.edges.length));

            const toBefore = to.edges?.length ?? 0;
            to.edges = (to.edges ?? []).filter(edge => !(edge.to === fromId && edge.type === edgeType));
            to.degree = Math.max(0, (to.degree ?? 0) - (toBefore - to.edges.length));

            await persistNodes();
            publishEvent('memoryGraph.edgeDeleted', { fromId, toId, type: edgeType });
            return { ok: true };
        });
    }

    /** Тихий вызов SideCar — тот же контракт/приём, что `tracking.poll()`/BasicSummary. Отдаёт JSON `{label, content, importance}` для одной ноды, разбирается через уже существующую parse-model-json.js. */
    async function askSideCarForNode(contextText, { isFirstNode = false } = {}) {
        // Подсказка для бутстрапа "нового мира" (решено с пользователем):
        // ТОЛЬКО на самом первом узле пустого графа, и только подсказка —
        // SideCar сам решает, сколько регионов реально завести и какие,
        // секторы остаются свободными (не жёсткий список).
        const bootstrapHint = isFirstNode
            ? ' This is the very first memory in a fresh graph — consider whether the protagonist, another character, or a location is the most natural starting point, but decide freely.'
            : '';
        const prompt = `Recent story context:\n\n${contextText}\n\nExtract ONE new, distinct, important fact worth remembering long-term (a character detail, a place, an event, a relationship).${bootstrapHint} Reply with ONLY a JSON object: {"label": short name, "content": the fact itself, "importance": 0-10}.`;
        const result = await call('model.generate', { prompt, workerId: settings.workerId ?? undefined });
        if (!result.ok) throw new Error(result.error.message);
        const parsed = parseModelJson(result.value);
        if (!parsed || typeof parsed !== 'object' || !parsed.label || !parsed.content) return null;
        return { label: String(parsed.label), content: String(parsed.content), importance: Number(parsed.importance) || 0 };
    }

    /**
     * Один SideCar-вызов на СОЗРЕВШУЮ пару из очереди объединения — не
     * групповая классификация (в отличие от `escalateToSideCar`, где много
     * коротких потеряшек удобно судить разом): здесь ровно два конкретных
     * текста, и результату (новый объединённый content) нужен настоящий
     * пересказ, не ярлык. `{"distinct": true}` — SideCar не согласен, что
     * это дубликаты; оба узла остаются как есть, очередь просто забывает
     * пару.
     */
    async function askSideCarForMerge(nodeA, nodeB) {
        const prompt = `These two memories may describe the same underlying fact:\n\n1. ${nodeA.label}: ${nodeA.content}\n2. ${nodeB.label}: ${nodeB.content}\n\nIf they are genuinely duplicates or near-duplicates, reply with ONLY a JSON object: {"label": short combined name, "content": one combined fact covering everything both said, "importance": 0-10}. If they actually describe DIFFERENT facts that should stay separate, reply with ONLY: {"distinct": true}.`;
        const result = await call('model.generate', { prompt, workerId: settings.workerId ?? undefined });
        if (!result.ok) return null;
        const parsed = parseModelJson(result.value);
        if (!parsed || typeof parsed !== 'object') return null;
        if (parsed.distinct) return { distinct: true };
        if (!parsed.label || !parsed.content) return null;
        return { label: String(parsed.label), content: String(parsed.content), importance: Number(parsed.importance) || 0 };
    }

    /**
     * Один SideCar-вызов на СОЗРЕВШИЙ кластер реконсолидации — сжимает
     * `reconsolidationMinCluster` слабых записей в ОДНУ более плотную, в
     * духе фолда BasicSummary, но локально внутри региона (MEMORY_GRAPH.md).
     * В отличие от объединения дублей, здесь не бывает "distinct" — кластер
     * заведомо не дубликаты, просто низкоприоритетные записи, которым нужно
     * ужаться, не исчезнуть.
     */
    async function askSideCarForReconsolidation(nodesToFold) {
        const listing = nodesToFold.map((node, i) => `${i + 1}. ${node.label}: ${node.content}`).join('\n');
        const prompt = `These ${nodesToFold.length} low-priority memories are crowding out a region of long-term memory:\n\n${listing}\n\nCompress them into ONE shorter, denser memory that preserves what matters from all of them. Reply with ONLY a JSON object: {"label": short combined name, "content": the compressed fact, "importance": 0-10}.`;
        const result = await call('model.generate', { prompt, workerId: settings.workerId ?? undefined });
        if (!result.ok) return null;
        const parsed = parseModelJson(result.value);
        if (!parsed || typeof parsed !== 'object' || !parsed.label || !parsed.content) return null;
        return { label: String(parsed.label), content: String(parsed.content), importance: Number(parsed.importance) || 0 };
    }

    /**
     * Общий хвост каскада — от готового эмбединга+координат региона до
     * "размещена/в накопителе" + персист. Один и тот же путь для НОВОЙ ноды
     * что от SideCar (`checkAndPlace`), что от импорта Lorebook
     * (`bootstrapFromLorebook`) — это буквально одна и та же задача
     * ("куда положить кусок текста с его эмбедингом"), разница только в
     * ИСТОЧНИКЕ текста, не в математике размещения.
     */
    function placeNewNode({ label, content, embedding, importance = 0, gameTime = null, createdTurn = turnCounter }, { coords, vectorProbs }) {
        const node = {
            id: makeId('node', now, random),
            label, content, embedding, importance,
            degree: 0,
            createdAt: now(),
            createdTurn,
            lastTouchedTurn: turnCounter,
            protectedNode: false,
            regionId: null,
            edges: [],
            gameTime,
        };
        const keywordCounts = keywordCountsForAllRegions(coords, content);
        const regionProbs = computeRegionLogits(vectorProbs, keywordCounts, settings.keywordWeight);
        const isEmptyGraph = !Object.values(regions).some(region => region.centerNodeId);
        const decision = decideFirstPlacement({ nameMatchRegion: findNameMatchRegion(content), regionProbs, regionCoords: coords, isEmptyGraph });

        nodes[node.id] = node;
        if (decision.status === 'placed') attachToRegion(node, decision.region.sector, decision.region.ring);
        else staging[node.id] = { nodeId: node.id, attemptCount: 1, firstAttemptTurn: createdTurn };
        return { status: decision.status, nodeId: node.id };
    }

    /**
     * Один прогон "сильного изменения": считает эмбединг свежего контекста,
     * сравнивает с бегущей статистикой расстояний, и ТОЛЬКО если порог
     * превышен — зовёт SideCar и проводит новую ноду через каскад
     * размещения. Математика решает, звать ли модель вообще — MEMORY_GRAPH.md.
     */
    async function checkAndPlace(contextText) {
        return enqueueWrite(async () => {
            turnCounter += 1;
            if (!contextText || !contextText.trim()) return { status: 'skipped' };

            const embeddingResult = await callService('embedding.compute', { text: contextText, kind: 'query' });
            if (!embeddingResult.ok) return { status: 'skipped', error: embeddingResult.error.message };
            const embedding = embeddingResult.value;

            const { coords, probs: vectorProbs } = vectorProbsForAllRegions(embedding);
            const nearestSimilarity = Math.max(...coords.map((_, i) => vectorProbs[i]), 0);
            const distance = 1 - nearestSimilarity;
            const wasStrong = isStrongChange(distance, distanceStats, settings.thresholdK);
            distanceStats = updateDistanceStats(distanceStats, distance);
            await persistStats();
            if (!wasStrong) return { status: 'no-change' };

            const proposal = await askSideCarForNode(contextText, { isFirstNode: Object.keys(nodes).length === 0 });
            if (!proposal) return { status: 'sidecar-empty' };

            const gameTime = await readGameTime();
            const result = placeNewNode({ ...proposal, embedding, gameTime }, { coords, vectorProbs });
            // attachToRegion() (внутри placeNewNode) может завести запись в
            // mergeQueue/reconsolidationQueue (detectMergeCandidate/
            // tryQueueReconsolidation) — персистим ВСЕ пять хранилищ, не
            // только nodes/regions/staging, иначе такая запись переживает
            // только до следующей перезагрузки (реальный баг, найден при
            // добавлении ручного создания ноды).
            await Promise.all([persistNodes(), persistRegions(), persistStaging(), persistMergeQueue(), persistReconsolidationQueue()]);
            publishEvent('memoryGraph.nodeCreated', { nodeId: result.nodeId, status: result.status });
            return result;
        });
    }

    /**
     * Бутстрап пустого графа из УЖЕ АКТИВНОГО Lorebook игрока — LLM-driven
     * семантические регионы (решено с пользователем, MEMORY_GRAPH.md: старый
     * дартборд-бутстрап давал ~80% нод без единой связи). Три прогона
     * SideCar (весь Lorebook целиком видит модель, не по одной записи) +
     * эмбединг-присвоение остальных записей + региональные связи. Дартборд
     * (`vectorProbsForAllRegions`/`decideFirstPlacement`/`placeNewNode`) НЕ
     * трогается — он по-прежнему полностью обслуживает `checkAndPlace()`
     * (органический рост во время игры остаётся на нём, решено явно: цена
     * LLM здесь приемлема как разовая, не на каждый ход).
     */
    async function bootstrapFromLorebook() {
        // Обёрнуто в enqueueWrite (не было раньше) — решено с пользователем:
        // теперь бутстрап зовётся ИЗ ФОНА, не awaited вызывающим (см.
        // `load()` ниже), поэтому реальная генерация (`checkAndPlace()`,
        // тоже через enqueueWrite) может стартовать, пока бутстрап ещё
        // выполняется — без общей очереди это была бы гонка по `nodes`/
        // `regions` между двумя параллельными мутациями графа.
        return enqueueWrite(async () => {
            const booksResult = await call('lorebook.books');
            if (!booksResult.ok || !booksResult.value?.length) return false;
            const summariesResult = await call('lorebook.find', {});
            if (!summariesResult.ok || !summariesResult.value?.length) return false;

            // Реальная работа подтверждена (непустой Lorebook, дальше пойдут
            // потенциально МЕДЛЕННЫЕ шаги — чтение по одной записи, 2+N
            // LLM-вызовов, эмбединг каждой записи) — решено с пользователем:
            // "нет ивентов начала и конца построения WI... нет индикатора
            // прогресса. Это очень плохо". `totalSteps`/`tick()` — ГРУБАЯ,
            // заранее посчитанная оценка (реальное число регионов Прохода 3
            // узнаётся только после Прохода 2, здесь его ещё нет — берём
            // целевую плотность `entriesPerRegionCenter` как прикидку), не
            // точный процент — прогресс-бар не обязан быть математически
            // безупречным, только не стоять мёртвым нулём и не заезжать за
            // 100% (см. `tick()`'s clamp). `finally` ниже гарантирует
            // `bootstrapFinished` на ЛЮБОМ пути — и успешном, и любом раннем
            // `return false` (тот же принцип "started/finished
            // безусловно", что уже описан в MEMORY_GRAPH.md).
            const totalSummaries = summariesResult.value.length;
            const estimatedRegions = Math.max(1, Math.round(totalSummaries / settings.entriesPerRegionCenter));
            const totalSteps = totalSummaries * 2 + 2 + estimatedRegions + 1; // читаем + размещаем по разу на запись, 2 общих LLM-прохода, Проход 3 по региону, финализация
            let doneSteps = 0;
            let succeeded = false;
            function tick(phase) {
                doneSteps = Math.min(doneSteps + 1, totalSteps);
                publishEvent('memoryGraph.bootstrapProgress', { done: doneSteps, total: totalSteps, phase });
            }
            publishEvent('memoryGraph.bootstrapStarted', { totalEntries: totalSummaries, totalSteps });

            try {
                // 1. Читаем ВСЕ записи целиком, БЕЗ немедленного размещения —
                // Проходу 1 нужен полный текст Lorebook сразу, не по одной штуке.
                const rawEntries = [];
                const entryByUid = new Map();
                for (const summary of summariesResult.value) {
                    const fullResult = await call('lorebook.get', { uid: summary.uid, book: summary.book });
                    tick('reading');
                    if (!fullResult.ok) continue;
                    const entry = fullResult.value;
                    const label = String(entry.comment ?? '').trim() || `WI #${entry.uid}`;
                    const content = String(entry.content ?? '').trim();
                    if (!content) continue; // пустая запись — нечего эмбедить и нечего класть в граф
                    const record = { uid: summary.uid, label, content, raw: entry };
                    rawEntries.push(record);
                    entryByUid.set(summary.uid, record);
                }
                if (!rawEntries.length) return false;

                // 2. Проход 1 — базовый скелет (Locations/Main Characters/
                // Factions или свои варианты) + 2 под-центра на каждый.
                const skeletonPrompt = buildRegionSkeletonPrompt(rawEntries, settings.baseRegionNames);
                const skeletonResult = await call('model.generate', { prompt: skeletonPrompt, workerId: settings.workerId ?? undefined, maxTokens: settings.bootstrapMaxTokens, temperature: settings.bootstrapTemperature, reasoningMode: 'enabled', reasoningEffort: settings.bootstrapReasoningEffort, systemPrompt: BOOTSTRAP_SYSTEM_PROMPT });
                tick('skeleton');
                if (!skeletonResult.ok) return false;
                const skeletonRegions = parseRegionSkeletonResponse(parseModelJson(skeletonResult.value), rawEntries);
                if (!skeletonRegions.length) return false;

                // 3. Проход 2 — центр для КАЖДОГО региона из Прохода 1, плюс
                // новые регионы сверх них, до целевой плотности
                // (entriesPerRegionCenter). Отказ здесь ТОЖЕ прерывает бутстрап
                // целиком (решено с пользователем — как и Проход 1, не как
                // мягкий откат Прохода 3 ниже).
                const targetTotal = Math.max(skeletonRegions.length, Math.round(rawEntries.length / settings.entriesPerRegionCenter));
                const centersPrompt = buildAdditionalCentersPrompt(rawEntries, skeletonRegions.map(region => region.name), targetTotal, settings.entriesPerRegionCenter);
                const centersResult = await call('model.generate', { prompt: centersPrompt, workerId: settings.workerId ?? undefined, maxTokens: settings.bootstrapMaxTokens, temperature: settings.bootstrapTemperature, reasoningMode: 'enabled', reasoningEffort: settings.bootstrapReasoningEffort, systemPrompt: BOOTSTRAP_SYSTEM_PROMPT });
                tick('centers');
                if (!centersResult.ok) return false;
                const centerAssignments = parseAdditionalCentersResponse(parseModelJson(centersResult.value), rawEntries);
                if (!centerAssignments.length) return false;

                // Сшиваем Проход 1 (под-центры) и Проход 2 (центры) по имени
                // региона; регион без реального, валидного центра — не заводим
                // (регион-калека хуже отсутствующего региона).
                const regionPlans = new Map();
                for (const region of skeletonRegions) regionPlans.set(region.name, { name: region.name, subCenterUids: region.subCenterUids, centerUid: null });
                for (const assignment of centerAssignments) {
                    const existing = regionPlans.get(assignment.name);
                    if (existing) existing.centerUid = assignment.centerUid;
                    else regionPlans.set(assignment.name, { name: assignment.name, subCenterUids: [], centerUid: assignment.centerUid });
                }
                const finalRegionPlans = [...regionPlans.values()].filter(region => region.centerUid != null && entryByUid.has(region.centerUid));
                if (!finalRegionPlans.length) return false;

                async function buildNodeFromEntry(entry) {
                    const embeddingResult = await callService('embedding.compute', { text: `${entry.label}: ${entry.content}`, kind: 'passage' });
                    if (!embeddingResult.ok) return null;
                    return {
                        id: makeId('node', now, random),
                        label: entry.label, content: entry.content, embedding: embeddingResult.value,
                        importance: importanceFromLorebookEntry(entry.raw),
                        degree: 0, createdAt: now(), createdTurn: 0, lastTouchedTurn: turnCounter,
                        protectedNode: false, regionId: null, edges: [], gameTime: null,
                    };
                }

                function placeInRegion(node, regionName, forceRole) {
                    nodes[node.id] = node;
                    attachToRegionByKey(node, regionName, {
                        createRegion: () => ({ name: regionName, centerNodeId: null, subCenterIds: [], nodeIds: [], wordProfile: {} }),
                        forceRole,
                    });
                }

                // 4. Размещаем центры/под-центров — роль ЯВНАЯ (LLM уже решила),
                // не по порядку прибытия.
                const usedUids = new Set();
                const bootstrappedIds = [];
                for (const region of finalRegionPlans) {
                    if (usedUids.has(region.centerUid)) continue; // тот же uid уже занят другим регионом — не дублируем ноду
                    usedUids.add(region.centerUid);
                    const centerNode = await buildNodeFromEntry(entryByUid.get(region.centerUid));
                    tick('placing');
                    if (!centerNode) continue;
                    placeInRegion(centerNode, region.name, 'center');
                    bootstrappedIds.push(centerNode.id);

                    for (const subUid of region.subCenterUids) {
                        if (usedUids.has(subUid) || !entryByUid.has(subUid)) continue;
                        usedUids.add(subUid);
                        const subNode = await buildNodeFromEntry(entryByUid.get(subUid));
                        tick('placing');
                        if (!subNode) continue;
                        placeInRegion(subNode, region.name, 'subCenter');
                        bootstrappedIds.push(subNode.id);
                    }
                }

                // 5. Присвоение остальных записей — argmax косинуса к уже
                // размещённым центрам/под-центрам (pickNearestRegion). Всегда
                // находит дом — нет "накопителя" для этого пути.
                const regionAnchors = bootstrappedIds.map(id => nodes[id]).filter(Boolean);
                for (const entry of rawEntries) {
                    if (usedUids.has(entry.uid)) continue;
                    const node = await buildNodeFromEntry(entry);
                    tick('placing');
                    if (!node) continue;
                    const bestRegionName = pickNearestRegion(node.embedding, regionAnchors);
                    if (!bestRegionName) continue; // якорей нет вовсе (Проход 2 не дал ни одного валидного центра) — запись пропускается
                    placeInRegion(node, bestRegionName, 'ordinary'); // НЕ null — иначе подхватывает авто-детекцию под-центра по порядку вставки (реальный баг, см. attachToRegionByKey()'s doc-comment)
                    bootstrappedIds.push(node.id);
                }

                // 6. Проход 3 — связи ВНУТРИ каждого региона, по одному вызову
                // на регион. Отказ здесь НЕ прерывает бутстрап — пропускает
                // связи только для ЭТОГО региона, остальные продолжаются
                // (тот же принцип, что у escalateToSideCar). Межрегиональные
                // связи — старый extractCharacterNames(), уже отработал внутри
                // attachToRegionByKey() выше, для КАЖДОЙ размещённой ноды.
                for (const region of finalRegionPlans) {
                    tick('linking'); // тикаем на КАЖДЫЙ регион, даже пропущенный ниже — это тоже "рассмотренный" шаг оценки
                    const liveRegion = regions[region.name];
                    if (!liveRegion || liveRegion.nodeIds.length < 2) continue;
                    const regionNodes = liveRegion.nodeIds.map(id => nodes[id]).filter(Boolean);
                    const edgesPrompt = buildRegionEdgesPrompt(regionNodes.map(node => ({ id: node.id, label: node.label, content: node.content })));
                    const edgesResult = await call('model.generate', { prompt: edgesPrompt, workerId: settings.workerId ?? undefined, maxTokens: settings.bootstrapMaxTokens, temperature: settings.bootstrapTemperature, reasoningMode: 'enabled', reasoningEffort: settings.bootstrapReasoningEffort, systemPrompt: BOOTSTRAP_SYSTEM_PROMPT });
                    if (!edgesResult.ok) continue;
                    const proposedEdges = parseRegionEdgesResponse(parseModelJson(edgesResult.value), regionNodes.map(node => ({ id: node.id })));
                    for (const edge of proposedEdges) {
                        const from = nodes[edge.from];
                        const to = nodes[edge.to];
                        if (!from || !to) continue;
                        if ((from.edges ?? []).some(existingEdge => existingEdge.to === to.id)) continue; // уже связаны (например, mentions выше)
                        from.edges = [...(from.edges ?? []), { to: to.id, type: 'related' }];
                        to.edges = [...(to.edges ?? []), { to: from.id, type: 'related' }];
                        from.degree = (from.degree ?? 0) + 1;
                        to.degree = (to.degree ?? 0) + 1;
                    }
                }

                // 7. Бэкбон — ДО бонуса важности за связи ниже: досозданные
                // `backbone`-рёбра тоже должны учитываться в итоговой degree.
                enforceBackboneConnectivity();
                for (const nodeId of bootstrappedIds) {
                    const node = nodes[nodeId];
                    if (node) node.importance = applyConnectionBonus(node.importance, node.degree);
                }
                tick('finalizing');
                // См. комментарий в checkAndPlace() — то же самое: attachToRegionByKey()
                // может тронуть mergeQueue/reconsolidationQueue, не только nodes/regions/staging.
                await Promise.all([persistNodes(), persistRegions(), persistStaging(), persistMergeQueue(), persistReconsolidationQueue()]);
                // Реальный баг, найден живьём (жалоба пользователя): обычный
                // `set()` лишь СБРАСЫВАЕТ и заново взводит ST-шный debounce
                // (`saveMetadataDebounced()`, реальный `debounce_timeout.relaxed`
                // = 1000ms — проверено по настоящему исходнику ST,
                // `public/scripts/extensions.js`) — перезагрузка страницы в
                // течение секунды ПОСЛЕ бутстрапа (типичный момент, он ведь
                // ТОЛЬКО что достроился) теряла весь только что построенный
                // граф молча: `bootstrapIfEmpty()` на следующей загрузке видел
                // пустые `nodes` и достраивал ВСЁ заново, воспринималось как
                // "старый граф не подгружается". Явный `flush()` (см.
                // `storage.chatMemory.flush`/`chatMetadata.flush`) форсирует
                // настоящее сохранение ПРЯМО СЕЙЧАС, до публикации события
                // успеха — к моменту, когда пользователь видит 100%/успех,
                // данные уже реально на диске, не только в памяти вкладки.
                await call('storage.chatMemory.flush');
                publishEvent('memoryGraph.bootstrapped', { source: 'lorebook', nodeCount: Object.keys(nodes).length });
                succeeded = true;
                return true;
            } finally {
                publishEvent('memoryGraph.bootstrapFinished', { success: succeeded, nodeCount: Object.keys(nodes).length });
            }
        });
    }

    /** Прогон накопителя — ретраи/эскалация по расписанию (MEMORY_GRAPH.md, числа согласованы с пользователем). Зовётся из того же прохода `generation.prepare`, что и `checkAndPlace`, но независимо от того, была ли эта генерация "сильным изменением". */
    async function sweepStaging() {
        return enqueueWrite(async () => {
            const entries = Object.values(staging);
            const batchReady = [];
            for (const entry of entries) {
                const node = nodes[entry.nodeId];
                if (!node) { delete staging[entry.nodeId]; continue; }
                const { coords, probs: vectorProbs } = vectorProbsForAllRegions(node.embedding);
                const keywordCounts = keywordCountsForAllRegions(coords, node.content);
                const regionProbs = computeRegionLogits(vectorProbs, keywordCounts, settings.keywordWeight);
                const poolSize = entries.filter(other => (other.attemptCount ?? 1) >= 2).length;
                const step = decideStagingStep({ entry, regionProbs, regionCoords: coords, settings, currentTurn: turnCounter, poolSize });

                if (step.status === 'placed') {
                    attachToRegion(node, step.region.sector, step.region.ring);
                    delete staging[entry.nodeId];
                } else if (step.status === 'retry-now') {
                    staging[entry.nodeId] = { ...entry, attemptCount: 2, lastAttemptTurn: turnCounter };
                } else if (step.status === 'escalate') {
                    batchReady.push(node);
                    delete staging[entry.nodeId];
                }
            }
            if (batchReady.length) await escalateToSideCar(batchReady);
            // См. комментарий в checkAndPlace() — тот же attachToRegion() (и
            // выше, и внутри escalateToSideCar()) может завести запись в
            // mergeQueue/reconsolidationQueue.
            await Promise.all([persistNodes(), persistRegions(), persistStaging(), persistMergeQueue(), persistReconsolidationQueue()]);
        });
    }

    /** "Совсем потеряшки" — батч на суждение полноценной LLM разом. Не разместила — нода отбрасывается (решено с пользователем: не портить регион натянутым размещением, не хранить вечно). */
    async function escalateToSideCar(batch) {
        const listing = batch.map((node, i) => `${i + 1}. ${node.label}: ${node.content}`).join('\n');
        const prompt = `These ${batch.length} facts could not be automatically placed in the memory graph:\n\n${listing}\n\nFor each, reply with its number and either a short category label it clearly belongs to, or "DISCARD" if it fits nowhere. Format: one line per item, "N: label" or "N: DISCARD".`;
        const result = await call('model.generate', { prompt, workerId: settings.workerId ?? undefined });
        if (!result.ok) { for (const node of batch) delete nodes[node.id]; return; }
        // Phase 1: разбор ответа — по строкам "N: ..."; "DISCARD" (без учёта
        // регистра) отбрасывает ноду, всё остальное становится её label, и
        // нода уходит в регион 0:0 как временный дом (полноценное сопоставление
        // ответа SideCar обратно в сетку регионов — уточнить в Phase 2, это
        // самый грубый край Phase 1, отмечен явно, не скрыт).
        const lines = String(result.value ?? '').split('\n');
        for (const node of batch) {
            const line = lines.find(item => item.trim().startsWith(`${batch.indexOf(node) + 1}:`));
            const verdict = line?.split(':').slice(1).join(':').trim();
            if (!verdict || /^discard$/i.test(verdict)) { delete nodes[node.id]; continue; }
            attachToRegion(node, 0, 0);
        }
    }

    /**
     * Прогон очереди объединения — решено с пользователем: своя, отдельная
     * от накопителя очередь и свои числа (`mergeQueueMaxTurns`, НЕ
     * `stagingBatchSize`/`stagingMaxTurns`), чисто по времени с момента
     * постановки в очередь, не гонка "батч ИЛИ таймаут". Один SideCar-вызов
     * НА КАЖДУЮ созревшую пару (не групповой батч, как у эскалации
     * накопителя) — объединение двух конкретных текстов не сжимается в
     * общую классификацию так же естественно, как короткие ярлыки потеряшек.
     */
    async function sweepMergeQueue() {
        return enqueueWrite(async () => {
            let changed = false;
            for (const [pairKey, entry] of Object.entries(mergeQueue)) {
                if (turnCounter - entry.queuedTurn < settings.mergeQueueMaxTurns) continue;
                delete mergeQueue[pairKey];
                changed = true;

                const nodeA = nodes[entry.nodeIdA];
                const nodeB = nodes[entry.nodeIdB];
                if (!nodeA || !nodeB) continue; // один уже пропал (эвикшен/другое слияние) — очередь устарела сама собой

                const verdict = await askSideCarForMerge(nodeA, nodeB);
                if (!verdict || verdict.distinct) continue; // SideCar не подтвердил — оба узла остаются как были

                const embeddingResult = await callService('embedding.compute', { text: `${verdict.label}: ${verdict.content}`, kind: 'passage' });
                if (!embeddingResult.ok) continue;

                const mergedId = foldNodesInGraph([entry.nodeIdA, entry.nodeIdB], verdict, embeddingResult.value);
                if (mergedId) publishEvent('memoryGraph.nodesMerged', { mergedId, from: [entry.nodeIdA, entry.nodeIdB] });
            }
            if (changed) await Promise.all([persistNodes(), persistRegions(), persistMergeQueue()]);
        });
    }

    /**
     * Прогон очереди реконсолидации — своя очередь, свои числа
     * (`reconsolidationQueueMaxTurns`), тот же чисто-временной принцип, что
     * у объединения дублей. Один SideCar-вызов НА КЛАСТЕР (не по одному на
     * узел) — сжатие уже само по себе батч-операция над N узлами разом.
     */
    async function sweepReconsolidationQueue() {
        return enqueueWrite(async () => {
            let changed = false;
            for (const [groupKey, entry] of Object.entries(reconsolidationQueue)) {
                if (turnCounter - entry.queuedTurn < settings.reconsolidationQueueMaxTurns) continue;
                delete reconsolidationQueue[groupKey];
                changed = true;

                const nodesToFold = entry.nodeIds.map(id => nodes[id]).filter(Boolean);
                if (nodesToFold.length !== entry.nodeIds.length) continue; // кто-то из кластера уже пропал — очередь устарела

                const verdict = await askSideCarForReconsolidation(nodesToFold);
                if (!verdict) continue; // SideCar не осилил — узлы остаются как были, не повторяем попытку

                const embeddingResult = await callService('embedding.compute', { text: `${verdict.label}: ${verdict.content}`, kind: 'passage' });
                if (!embeddingResult.ok) continue;

                const foldedId = foldNodesInGraph(entry.nodeIds, verdict, embeddingResult.value);
                if (foldedId) publishEvent('memoryGraph.nodesReconsolidated', { foldedId, from: entry.nodeIds });
            }
            if (changed) await Promise.all([persistNodes(), persistRegions(), persistReconsolidationQueue()]);
        });
    }

    /**
     * Ручной перезапуск бэкбон-довязки (решено с пользователем: механизм
     * активный, не только на бутстрапе) — например, после серии РУЧНЫХ
     * созданий нод через UI-редактор (`memoryGraph.nodes.create` сама по
     * себе НЕ зовёт `enforceBackboneConnectivity()`, только бутстрап это
     * делает автоматически).
     */
    async function sweepBackbone() {
        return enqueueWrite(async () => {
            enforceBackboneConnectivity();
            await Promise.all([persistNodes(), persistRegions()]);
        });
    }

    /**
     * Бутстрап пустого графа — MEMORY_GRAPH.md, решено с пользователем:
     * есть Lorebook → перестроить граф из него (`bootstrapFromLorebook()`,
     * реализовано — оказалось не отдельной подсистемой, а тем же
     * `placeNewNode()`, что и у обычных нод, см. его doc-comment); пусто →
     * НИЧЕГО не делает здесь — подсказка SideCar'у про Локации/ГГ/Персонажи
     * (`askSideCarForNode`'s `isFirstNode`) сработает сама на первом же
     * настоящем `checkAndPlace()`, отдельный код бутстрапа для этого пути
     * не нужен вовсе.
     */
    async function bootstrapIfEmpty() {
        if (Object.keys(nodes).length > 0) return;
        await bootstrapFromLorebook();
    }

    /**
     * Промис ТЕКУЩЕГО (или последнего) фонового бутстрапа — решено с
     * пользователем: "зависание при bootstrap... вынеси его отдельно".
     * `load()` больше НЕ ждёт `bootstrapIfEmpty()` сама — при большом
     * Lorebook (десятки записей, у каждой свой вызов реальной ONNX-модели
     * эмбеддинга) это реально ДОЛГО, а `load()` до сих пор awaited напрямую
     * в `harness/engine-wiring.js`'s главной цепочке — весь движок (панель,
     * докер запуска) висел за ОДНИМ этим `await`, пока бутстрап не
     * закончится. Экспортируется как `waitForBootstrap()` на возвращаемом
     * объекте Ядра — тестам и любому коду, которому ДЕЙСТВИТЕЛЬНО нужно
     * дождаться результата (а не просто не блокировать остальных), есть
     * явный способ это сделать; `load()` этот промис сама не ждёт.
     */
    let bootstrapPromise = Promise.resolve();

    function waitForBootstrap() {
        return bootstrapPromise;
    }

    /**
     * Phase 2 — этап `generation.beforeSend`, живая мутация `chat` (тот же
     * приём, что `cores/summary/index.js`'s `injectIntoPrompt`/
     * `modules/notebook/index.js`). Кандидаты в маяки — ТОЛЬКО размещённые
     * узлы (`regionId` не `null`): нода в накопителе невидима для ретрива
     * (решено в Phase 1). Мягкая деградация на каждом шаге (пустой граф,
     * пустой контекст, недоступный эмбединг, пустой маршрут) — `chat`
     * просто не трогается, генерация никогда не блокируется этим этапом.
     */
    async function injectIntoPrompt({ chat } = {}) {
        if (!Array.isArray(chat)) return true;
        const candidates = Object.values(nodes).filter(node => node.regionId);
        if (!candidates.length) return true;

        const contextText = extractLatestText(chat);
        if (!contextText.trim()) return true;
        const embeddingResult = await callService('embedding.compute', { text: contextText, kind: 'query' });
        if (!embeddingResult.ok) return true;

        const beaconIds = pickBeacons(candidates, embeddingResult.value, {
            count: settings.beaconCount, weightFactor: settings.beaconWeightFactor, settings, turnCounter,
        });
        if (!beaconIds.length) return true;

        const route = buildBeaconRoute(nodes, beaconIds, { maxHops: settings.routeMaxHops });
        const routeNodeIds = [...new Set([...route.segments.flatMap(step => [step.from, step.to]), ...route.standalone])];
        const noise = pickNoiseNodes(nodes, routeNodeIds, { charBudget: settings.noiseCharBudget, random });
        const text = renderMemoryPrompt({ ...route, noise }, nodes);
        if (!text) return true;

        chat.unshift({ is_user: false, is_system: true, name: 'Memory', mes: text });
        return true;
    }

    async function load() {
        await loadSettings();
        await loadState();
        // Регистрация этапов пайплайна — БЫСТРАЯ, идёт ДО бутстрапа (раньше
        // шла после — бутстрап мог задержать даже это). Без неё граф вообще
        // не участвовал бы в генерации, даже с уже загруженными данными.
        await call('pipeline.stages.add', {
            pipelineId: PREPARE_PIPELINE,
            stage: { id: 'memory-graph:place', contract: CHECK_CONTRACT, params: { chat: { $from: '$input.chat' } }, onExhausted: 'flag' },
        });
        host.own.register(INJECT_CONTRACT, params => injectIntoPrompt(params));
        await call('pipeline.stages.add', {
            pipelineId: BEFORE_SEND_PIPELINE,
            stage: { id: INJECT_STAGE_ID, contract: INJECT_CONTRACT, params: { chat: { $from: '$input.chat' } }, onExhausted: 'flag' },
        });
        // Бутстрап — ПОСЛЕДНИМ и НЕ awaited здесь (решено с пользователем,
        // см. `waitForBootstrap()`'s doc-comment). Ошибка ловится и
        // логируется явно, не проглатывается молча и не улетает
        // необработанным отказом промиса.
        bootstrapPromise = bootstrapIfEmpty().catch(error => {
            console.warn('[memoryGraph] background bootstrap failed:', error);
        });
    }

    /** Публичный ручной прогон — тот же принцип, что `summary.check`: то же самое, что движок делает сам на каждой генерации, просто по требованию (например для UI/тестов). */
    async function manualCheck(contextText) {
        const placement = await checkAndPlace(contextText);
        await sweepStaging();
        await sweepMergeQueue();
        await sweepReconsolidationQueue();
        return placement;
    }

    const unregisters = [
        host.own.register('memoryGraph.settings', () => settings),
        host.own.register('memoryGraph.configure', params => configure(params ?? {})),
        host.own.register('memoryGraph.nodes', () => Object.values(nodes)),
        host.own.register('memoryGraph.regions', () => Object.values(regions)),
        host.own.register('memoryGraph.mergeQueue', () => Object.values(mergeQueue)),
        host.own.register('memoryGraph.reconsolidationQueue', () => Object.values(reconsolidationQueue)),
        host.own.register('memoryGraph.check', params => manualCheck(extractLatestText(params?.chat))),
        // Ручное редактирование графа (UI-редактор) — CRUD нод/рёбер.
        host.own.register('memoryGraph.nodes.create', params => createNodeManually(params ?? {})),
        host.own.register('memoryGraph.nodes.createFromCharacterCard', () => createNodeFromCharacterCard()),
        host.own.register('memoryGraph.nodes.update', params => updateNodeManually(params ?? {})),
        host.own.register('memoryGraph.nodes.delete', params => deleteNodeManually(params ?? {})),
        host.own.register('memoryGraph.nodes.move', params => moveNodeManually(params ?? {})),
        host.own.register('memoryGraph.edges.create', params => createEdgeManually(params ?? {})),
        host.own.register('memoryGraph.edges.delete', params => deleteEdgeManually(params ?? {})),
        // "Вызов любой функции вручную" (решено с пользователем) — тонкие
        // обёртки над уже существующими оркестрационными операциями.
        host.own.register('memoryGraph.checkAndPlace', params => checkAndPlace(String(params?.text ?? ''))),
        host.own.register('memoryGraph.sweepStaging', () => sweepStaging()),
        host.own.register('memoryGraph.sweepMergeQueue', () => sweepMergeQueue()),
        host.own.register('memoryGraph.sweepReconsolidationQueue', () => sweepReconsolidationQueue()),
        host.own.register('memoryGraph.sweepBackbone', () => sweepBackbone()),
        host.own.register('memoryGraph.bootstrapFromLorebook', () => bootstrapFromLorebook()),
    ];

    return {
        load, waitForBootstrap,
        checkAndPlace, sweepStaging, sweepMergeQueue, sweepReconsolidationQueue, injectIntoPrompt,
        settings: () => settings,
        nodes: () => Object.values(nodes),
        regions: () => Object.values(regions),
        staging: () => Object.values(staging),
        mergeQueue: () => Object.values(mergeQueue),
        reconsolidationQueue: () => Object.values(reconsolidationQueue),
        unregister: async () => {
            await call('pipeline.stages.remove', { pipelineId: PREPARE_PIPELINE, stageId: 'memory-graph:place' }).catch(() => {});
            await call('pipeline.stages.remove', { pipelineId: BEFORE_SEND_PIPELINE, stageId: INJECT_STAGE_ID }).catch(() => {});
            for (const unregister of unregisters) unregister();
        },
    };
}

function extractLatestText(chat) {
    if (!Array.isArray(chat) || !chat.length) return '';
    return String(chat[chat.length - 1]?.mes ?? '');
}
