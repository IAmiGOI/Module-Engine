import { request } from '../../libraries/shared/request.js';
import { cosineSimilarity } from '../../libraries/core/embedding.js';
import { buildThematicSkeletonPrompt, buildThematicSkeletonPartPrompt, buildThematicSkeletonReducePrompt, normalizeThematicRegions } from './bootstrap-thematic.js';
import { createCoreOps } from './structured/core-ops.js';
import { createTimelineOps } from './structured/timeline-ops.js';
import { createExtractionOps } from './structured/extraction-ops.js';
import { createModeOps } from './structured/mode-ops.js';
import { createReclassifyOps } from './structured/reclassify-ops.js';
import { addDirectedEdge } from './edges.js';
import { checkEdge, normalizeKind, kindOf, isCore, isEvent } from './kinds.js';
import { featuresFor, normalizeGraphMeta, normalizeMode } from './modes.js';
import { selectBeacons, shouldRefreshSticky, recentQueryText, buildBeaconTree } from './beacons.js';
import { parseModelJson } from '../../libraries/core/parse-model-json.js';
import { packEntriesIntoChunks } from '../../libraries/core/entry-chunker.js';
import { extractRecentText } from './context-text.js';
import { advanceClock, migrateTimestamps } from './clock.js';
import { pickRegionBySimilarity } from './placement.js';
import { updateEwmaStats, isStrongChangeEwma, ewmaStddev } from './gate.js';
import { appendDecision } from './decision-log.js';
import { buildExtractionPrompt, buildStructuredExtractionPrompt, parseExtractionResponse } from './extraction-prompt.js';
import { buildTimelineSection } from './timeline-prompt.js';
import { addAliases } from './subjects.js';
// MEMORY_GRAPH_FIX_PLAN.md, Этап 9 (необязательный, ROADMAP 5.107и) — чистые функции, раньше жившие прямо здесь,
// наверху файла, перенесены в math.js/bootstrap-prompts.js БЕЗ ИЗМЕНЕНИЯ ПОВЕДЕНИЯ (см. их собственный doc-comment
// за тем, что именно куда легло и почему); импортированы здесь как обычно (нужны самому Ядру ниже) и заново
// реэкспортированы (следующие два `export … from`) — план явно требует не трогать существующие импорты (тестов,
// в частности).
import {
    SECTORS, RINGS, DEFAULT_SETTINGS, clampGraphSettings,
    regionKey, allRegionCoords, regionAdjacency, computeRegionLogits,
    updateDistanceStats, isStrongChange, nearestEmbeddingDistance,
    computeNodeWeight, pickEvictionCandidate, wordsOf, findMergeCandidate,
    scoreBeaconCandidate, pickBeacons, scoreBeaconSet, shouldReplaceStickySet, buildBeaconRoute,
    expandNoiseNodes, renderMemoryPrompt, decideFirstPlacement, decideStagingStep,
    makeId, extractCharacterNames, importanceFromLorebookEntry, applyConnectionBonus,
} from './math.js';
import {
    BOOTSTRAP_SYSTEM_PROMPT, assignBootstrapUids, fitEntriesToTokenBudget,
    buildRegionSkeletonPrompt, parseRegionSkeletonResponse,
    buildAdditionalCentersPrompt, parseAdditionalCentersResponse,
    CHUNK_CANDIDATES_SKELETON, CHUNK_CANDIDATES_CENTERS,
    buildSkeletonPartPrompt, buildCentersPartPrompt, parseCandidatesResponse,
    mergeCandidateGroups, trimCandidatesToBudget, buildSkeletonReducePrompt, buildCentersReducePrompt,
    pickNearestRegion, buildRegionEdgesPrompt, parseRegionEdgesResponse, parseRegionKindsResponse,
    buildOrphanConnectionsPrompt, parseOrphanConnectionsResponse,
} from './bootstrap-prompts.js';
export {
    SECTORS, RINGS, RETRIEVAL_STABILITY_LEVELS, RETRIEVAL_STABILITY_MARGINS, DEFAULT_SETTINGS, clampGraphSettings,
    regionKey, allRegionCoords, regionAdjacency, computeRegionLogits,
    updateDistanceStats, stddevOf, isStrongChange, nearestEmbeddingDistance,
    computeNodeWeight, pickEvictionCandidate, wordsOf, jaccardOverlap, findMergeCandidate,
    scoreBeaconCandidate, pickBeacons, scoreBeaconSet, shouldReplaceStickySet, findShortestPath, buildBeaconRoute,
    gaussianRandom, expandNoiseNodes, renderMemoryPrompt, pickConfidentRegion, decideFirstPlacement, decideStagingStep,
    importanceFromLorebookEntry, applyConnectionBonus,
} from './math.js';
export {
    BOOTSTRAP_SYSTEM_PROMPT, assignBootstrapUids, entryTitle, fitEntriesToTokenBudget,
    buildRegionSkeletonPrompt, parseRegionSkeletonResponse,
    buildAdditionalCentersPrompt, parseAdditionalCentersResponse,
    CHUNK_CANDIDATES_SKELETON, CHUNK_CANDIDATES_CENTERS,
    buildSkeletonPartPrompt, buildCentersPartPrompt, parseCandidatesResponse,
    mergeCandidateGroups, trimCandidatesToBudget, buildSkeletonReducePrompt, buildCentersReducePrompt,
    pickNearestRegion, buildRegionEdgesPrompt, parseRegionEdgesResponse, parseRegionKindsResponse,
    buildOrphanConnectionsPrompt, parseOrphanConnectionsResponse,
} from './bootstrap-prompts.js';

const PERSISTENCE_NAMESPACE = 'core.memoryGraph';
const SETTINGS_KEY = 'settings';
const NODES_KEY = 'nodes';
const REGIONS_KEY = 'regions';
const STAGING_KEY = 'staging';
const MERGE_QUEUE_KEY = 'mergeQueue';
const RECONSOLIDATION_QUEUE_KEY = 'reconsolidationQueue';
const STATS_KEY = 'distanceStats';
const STICKY_KEY = 'stickyRetrieval';
const NOVELTY_STATS_KEY = 'noveltyStats';
const CLOCK_KEY = 'clock'; // MEMORY_GRAPH_FIX_PLAN.md, Этап 2 (ROADMAP 5.107б) — { value, version: 1 }; см. doc-comment у `turnCounter`.
const GRAPH_META_KEY = 'graphMeta'; // MEMORY_GRAPH_TYPES_PLAN.md, этап 0 — { mode, version, ... }; нет ключа — legacy (см. modes.js)
const GRAPH_BACKUP_KEY = 'graphBackupBeforeUpgrade'; // временный снимок перед конвертацией в structured (до библиотеки графов, этап 9)
const DECISION_LOG_KEY = 'decisionLog'; // MEMORY_GRAPH_FIX_PLAN.md, Этап 6 (ROADMAP 5.107е) — массив записей decision-log.js, старые молча вытесняются
const DECISION_LOG_LIMIT = 100; // фиксированное число из самого плана, не настройка пользователя (см. decision-log.js)
const PREPARE_PIPELINE = 'generation.prepare';
const BEFORE_SEND_PIPELINE = 'generation.beforeSend';
const CHECK_CONTRACT = 'memoryGraph.check';
const INJECT_CONTRACT = 'memoryGraph.inject';
const INJECT_STAGE_ID = 'memory-graph:inject';
const RP_TIME_TRACKER_ID = 'rp-time'; // константа из modules/time/index.js — не менять без синхронизации

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
    let noveltyStats = null; // Уэлфорд по расстоянию до ближайшей НОДЫ (не центра региона) — см. checkAndPlace()
    let stickyRetrieval = null; // {beaconIds, text} | null — sticky balance, см. injectIntoPrompt()
    // "Ход" — MEMORY_GRAPH_FIX_PLAN.md, Этап 2 (ROADMAP 5.107б): раньше буквально счётчик в памяти страницы
    // (`turnCounter += 1` на каждый `checkAndPlace()`), обнулявшийся на КАЖДОЙ перезагрузке — decay уже
    // существующих нод и сроки накопителя/очередей после этого считались от неверной точки отсчёта. Теперь —
    // длина чата (`advanceClock()`, clock.js): переживает перезагрузку сама (хранится вместе с чатом в ST), не
    // двигается от реролла/свайпа. Имя переменной и её единицы измерения (условный "ход") оставлены прежними
    // ради минимума правок по всему файлу — присваивает ей значение теперь ТОЛЬКО `checkAndPlace()`.
    let graphMeta = normalizeGraphMeta(null);
    let features = featuresFor('legacy');
    let turnCounter = 0;
    // `true`, когда `loadState()` увидел ноды, записанные ДО появления `CLOCK_KEY` (старая версия, счётчик был в
    // памяти) — их `createdTurn`/`lastTouchedTurn`/`queuedTurn`/`firstAttemptTurn` в единицах СТАРОГО счётчика,
    // бессмысленны рядом с новыми, основанными на длине чата часами. Разовая миграция происходит при первом же
    // `checkAndPlace()` (там впервые может быть известна длина чата) — см. её тело.
    let needsClockMigration = false;
    // Часы на момент ПОСЛЕДНЕГО реального вызова модели на извлечение (любой исход — SideCar мог и промолчать
    // {skip:true}) — MEMORY_GRAPH_FIX_PLAN.md, Этап 4 (ROADMAP 5.107г), страховка от того, что сам фильтр может
    // застояться на ложном "всё привычно" и не звать модель очень долго (П5). См. `checkAndPlace()`.
    let lastExtractionClock = 0;
    // Защита от смены чата посреди ожидания модели/эмбединга — MEMORY_GRAPH_FIX_PLAN.md, Этап 5 (ROADMAP 5.107д,
    // П6 плана). Реальный сценарий: `checkAndPlace()` ждёт секунды ответа модели; если за это время переключить
    // чат, хранилище пишет в «ТЕКУЩИЙ» чат (не в тот, ради которого задача стартовала) — граф чата A мог бы
    // записаться в `chatMemory` уже активного чата B. `enqueueWrite()` (см. ниже) упорядочивает НОВЫЕ задачи
    // относительно друг друга, но не прерывает уже ЗАПУЩЕННУЮ — эпоха ловит именно этот случай: растёт СИНХРОННО
    // на каждый `st.chatChanged`, каждая долгая задача запоминает эпоху при старте и сверяет её после КАЖДОГО
    // своего `await` модели/эмбединга, до этого — прерывается.
    let chatEpoch = 0;
    const stillSameChat = epoch => epoch === chatEpoch;
    // Журнал решений — MEMORY_GRAPH_FIX_PLAN.md, Этап 6 (ROADMAP 5.107е). Одна запись на КАЖДЫЙ `checkAndPlace()`,
    // независимо от исхода (гейт молчал / модель отказалась / нода создана) — см. decision-log.js за форматом и
    // самой панелью (секция «Why») за тем, как это читается человеком. Новейшие записи — в конце массива (тот же
    // порядок вставки, что у остальных списков этого Ядра); наружу (`memoryGraph.decisionLog`) отдаются в обратном.
    let decisionLog = [];
    // «Последнее действие» вместо изменения сигнатур `detectMergeCandidate()`/`tryQueueReconsolidation()`/
    // `enforceRegionCapacity()`/`askSideCarForNode()` (П2 Этапа 6 плана: "передай наружу через возвращаемое
    // значение или через переменную «последнее действие», не меняя их логику") — читается ТОЛЬКО `checkAndPlace()`,
    // и только когда сама завела свежий объект перед вызовом `placeNewNode()`/`askSideCarForNode()`; для любого
    // ДРУГОГО пути создания ноды (бутстрап, ручное создание, карточка персонажа) трекер остаётся `null` — эти пути
    // не порождают запись в журнале решений (он только про органический `check`, см. план).
    let capacityTracker = null;
    let lastSideCarOutcome = null; // 'skip' | 'empty' | 'node' — см. askSideCarForNode()
    // История ретривов — MEMORY_GRAPH_UI_PLAN.md, Этап 2 (П3/П6 плана). ТОЛЬКО в памяти, не в `chatMemory` (план
    // явно требует) — как и `stickyRetrieval`'s собственный ТЕКСТ, это производные данные последнего показа,
    // не источник истины графа; обнуляется на `st.chatChanged` вместе с `chatEpoch` (см. подписку в load()).
    // Новые записи — В НАЧАЛО (`memoryGraph.retrievals`/`memoryGraph.lastRetrieval` отдают историю уже готовым
    // порядком, панели не нужно переворачивать самой). `lastRetrieval` — тот же самый объект, что `retrievalHistory[0]`,
    // отдельная переменная только ради его doc-comment у `injectIntoPrompt()`'s sticky-ветки (нечего искать в массиве).
    let lastRetrieval = null;
    let retrievalHistory = [];
    const RETRIEVAL_HISTORY_LIMIT = 20; // число из самого плана, не настройка пользователя (тот же принцип, что DECISION_LOG_LIMIT)
    /** Добавляет запись в историю ретривов (новые в начало) и держит её не длиннее `RETRIEVAL_HISTORY_LIMIT`. */
    /**
     * Почему последний ретрив НЕ состоялся (ROADMAP 5.109б). Раньше каждый ранний выход `injectIntoPrompt` был молчаливым `return` —
     * снаружи «ретрив не дошёл» было неотличимо от «кнопка Pathway сломана» (реальный случай владельца). Теперь причина хранится,
     * публикуется `memoryGraph.retrievalSkipped` и видна в окне графа; `memoryGraph.retrievalStatus` отдаёт её вместе с временем
     * последнего удачного ретрива.
     */
    let lastRetrievalSkip = null;
    function skipRetrieval(reason, detail = '') {
        lastRetrievalSkip = { at: Date.now(), reason, detail: String(detail ?? '').slice(0, 300) };
        publishEvent('memoryGraph.retrievalSkipped', lastRetrievalSkip);
        return true;
    }

    function recordRetrieval(entry) {
        lastRetrieval = entry;
        retrievalHistory = [entry, ...retrievalHistory].slice(0, RETRIEVAL_HISTORY_LIMIT);
    }

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

    /** Режим и его флаги — единственное место, где они пересчитываются (загрузка чата, конвертация, будущее открытие из библиотеки). */
    function applyGraphMeta(raw) {
        graphMeta = normalizeGraphMeta(raw);
        features = featuresFor(graphMeta.mode);
    }
    /**
     * Можно ли создать ребро между двумя нодами: в legacy — всегда (прежнее поведение); в structured — по правилу видов
     * (kinds.js). Автоматические пути (связывание по имени, бэкбон, проходы бутстрапа) просто пропускают запрещённую пару,
     * ручной путь отвечает причиной.
     */
    function edgeAllowed(a, b) {
        // Проверяется только запрошенное направление a → b; хранение пока симметричное, направленные рёбра (`dir`) — этап 2 плана.
        return !features.kinds || checkEdge(a, b).ok;
    }

    /** Поля structured-графа для ноды, которая только что получила роль в регионе: вид (по умолчанию факт), `core` = центр/под-центр/закреплённая. Legacy — не трогает ноду вовсе. */
    function stampStructured(node) {
        if (!features.kinds) return;
        node.kind = kindOf(node);
        node.core = Boolean(node.core || node.protectedNode);
        if (node.core) node.protectedNode = true; // синонимы: существующий код вытеснения/весов/маяков читает protectedNode
    }

    async function persistGraphMeta() { await call('storage.chatMemory.set', { namespace: PERSISTENCE_NAMESPACE, key: GRAPH_META_KEY, value: graphMeta }); }

    async function loadState() {
        const [nodesResult, regionsResult, stagingResult, mergeQueueResult, reconsolidationQueueResult, statsResult, stickyResult, noveltyResult, clockResult, decisionLogResult, metaResult] = await Promise.all([
            call('storage.chatMemory.get', { namespace: PERSISTENCE_NAMESPACE, key: NODES_KEY, fallback: {} }),
            call('storage.chatMemory.get', { namespace: PERSISTENCE_NAMESPACE, key: REGIONS_KEY, fallback: {} }),
            call('storage.chatMemory.get', { namespace: PERSISTENCE_NAMESPACE, key: STAGING_KEY, fallback: {} }),
            call('storage.chatMemory.get', { namespace: PERSISTENCE_NAMESPACE, key: MERGE_QUEUE_KEY, fallback: {} }),
            call('storage.chatMemory.get', { namespace: PERSISTENCE_NAMESPACE, key: RECONSOLIDATION_QUEUE_KEY, fallback: {} }),
            call('storage.chatMemory.get', { namespace: PERSISTENCE_NAMESPACE, key: STATS_KEY, fallback: null }),
            call('storage.chatMemory.get', { namespace: PERSISTENCE_NAMESPACE, key: STICKY_KEY, fallback: null }),
            call('storage.chatMemory.get', { namespace: PERSISTENCE_NAMESPACE, key: NOVELTY_STATS_KEY, fallback: null }),
            call('storage.chatMemory.get', { namespace: PERSISTENCE_NAMESPACE, key: CLOCK_KEY, fallback: null }),
            call('storage.chatMemory.get', { namespace: PERSISTENCE_NAMESPACE, key: DECISION_LOG_KEY, fallback: [] }),
            call('storage.chatMemory.get', { namespace: PERSISTENCE_NAMESPACE, key: GRAPH_META_KEY, fallback: null }),
        ]);
        nodes = nodesResult.ok ? nodesResult.value ?? {} : {};
        regions = regionsResult.ok ? regionsResult.value ?? {} : {};
        staging = stagingResult.ok ? stagingResult.value ?? {} : {};
        mergeQueue = mergeQueueResult.ok ? mergeQueueResult.value ?? {} : {};
        reconsolidationQueue = reconsolidationQueueResult.ok ? reconsolidationQueueResult.value ?? {} : {};
        distanceStats = statsResult.ok ? statsResult.value : null;
        stickyRetrieval = stickyResult.ok ? stickyResult.value : null;
        noveltyStats = noveltyResult.ok ? noveltyResult.value : null;
        decisionLog = decisionLogResult.ok ? decisionLogResult.value ?? [] : [];
        // Режим: сохранённый; у ПУСТОГО графа без метаданных — «новый граф», режим из настройки по умолчанию (этап 0, п. 5). Структурный
        // выбор запоминается сразу: иначе после первой же ноды и перезагрузки граф без метаданных прочитался бы как legacy.
        // Legacy — отсутствие ключа, писать нечего (чаты, где граф не заводили, не получают лишних записей в метаданные).
        const storedMeta = metaResult.ok ? metaResult.value : null;
        const isNewGraph = !storedMeta && !Object.keys(nodes).length;
        applyGraphMeta(isNewGraph ? { mode: settings.defaultGraphMode, createdAt: now() } : storedMeta);
        if (isNewGraph && graphMeta.mode === 'structured') await persistGraphMeta();
        const clock = clockResult.ok ? clockResult.value : null;
        if (clock && typeof clock.value === 'number') {
            turnCounter = clock.value;
            lastExtractionClock = typeof clock.lastExtractionClock === 'number' ? clock.lastExtractionClock : 0;
        } else {
            // Часов ещё нет — либо граф совсем свежий (мигрировать нечего), либо это данные ДО появления часов
            // (старый счётчик-в-памяти) — у него есть ноды, но их временные отметки бессмысленны рядом с новыми.
            turnCounter = 0;
            coreOps.resetClock(); timelineOps.resetClock(); extractionOps.resetPending(); // счётчики структурных прогонов — заново для нового чата
            lastExtractionClock = 0;
            needsClockMigration = Object.keys(nodes).length > 0;
        }
    }

    async function persistNodes() { await call('storage.chatMemory.set', { namespace: PERSISTENCE_NAMESPACE, key: NODES_KEY, value: nodes }); }
    async function persistRegions() { await call('storage.chatMemory.set', { namespace: PERSISTENCE_NAMESPACE, key: REGIONS_KEY, value: regions }); }
    async function persistStaging() { await call('storage.chatMemory.set', { namespace: PERSISTENCE_NAMESPACE, key: STAGING_KEY, value: staging }); }
    async function persistMergeQueue() { await call('storage.chatMemory.set', { namespace: PERSISTENCE_NAMESPACE, key: MERGE_QUEUE_KEY, value: mergeQueue }); }
    async function persistReconsolidationQueue() { await call('storage.chatMemory.set', { namespace: PERSISTENCE_NAMESPACE, key: RECONSOLIDATION_QUEUE_KEY, value: reconsolidationQueue }); }
    async function persistStats() {
        await call('storage.chatMemory.set', { namespace: PERSISTENCE_NAMESPACE, key: STATS_KEY, value: distanceStats });
        await call('storage.chatMemory.set', { namespace: PERSISTENCE_NAMESPACE, key: NOVELTY_STATS_KEY, value: noveltyStats });
    }
    async function persistStickyRetrieval() { await call('storage.chatMemory.set', { namespace: PERSISTENCE_NAMESPACE, key: STICKY_KEY, value: stickyRetrieval }); }
    async function persistDecisionLog() { await call('storage.chatMemory.set', { namespace: PERSISTENCE_NAMESPACE, key: DECISION_LOG_KEY, value: decisionLog }); }
    /** Добавляет запись в журнал решений (кольцевой буфер, decision-log.js) и сразу сохраняет — MEMORY_GRAPH_FIX_PLAN.md, Этап 6, П3: "сохранять вместе со статистикой", здесь — вместе с самим решением, на каждый из его нескольких возможных исходов внутри `checkAndPlace()` (не только один общий момент, что и у `persistStats()`/`persistClock()` — у решения несколько разных точек возврата, не одна). */
    async function recordDecision(entry) {
        decisionLog = appendDecision(decisionLog, entry, DECISION_LOG_LIMIT);
        await persistDecisionLog();
    }
    // Сам факт присутствия ключа в хранилище — маркер "часы существуют, миграция (если требовалась) уже
    // произошла" (см. `needsClockMigration` выше) — `version` на будущее, если формат когда-нибудь поменяется.
    async function persistClock() { await call('storage.chatMemory.set', { namespace: PERSISTENCE_NAMESPACE, key: CLOCK_KEY, value: { value: turnCounter, version: 1, lastExtractionClock } }); }

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
        return Math.max(0, turnCounter - (node.lastTouchedTurn ?? node.createdTurn ?? turnCounter)); // Этап 7 — см. doc-comment у pickEvictionCandidate()
    }

    function regionEntry(sector, ring) {
        const key = regionKey(sector, ring);
        return regions[key] ?? { sector, ring, centerNodeId: null, subCenterIds: [], nodeIds: [], wordProfile: {} };
    }

    /**
     * Регионы для ВНЕШНЕГО потребителя (контракт/панель) — MEMORY_GRAPH_UI_PLAN.md, Этап 2, П2: у `regions` объект
     * (map "ключ региона" → значение), сам ключ ВНУТРИ значения не хранится нигде — панель не могла ни подписать
     * регион, ни адресовать его по `id` обратно в `createNodeManually`/`moveNodeManually`. Добавляет `id` (сам ключ)
     * и `label` (метка центральной ноды региона, иначе — сам ключ, для регионов без центра/семантических до
     * назначения центра) ТОЛЬКО в ОТВЕТ — не трогает хранимые `regions[key]`.
     */
    function regionsForResponse() {
        return Object.entries(regions).map(([id, region]) => ({ ...region, id, label: nodes[region.centerNodeId]?.label ?? id }));
    }

    /**
     * Ноды для ВНЕШНЕГО потребителя (контракт/панель) — MEMORY_GRAPH_UI_PLAN.md, Этап 2, П4. Добавляет ТОЛЬКО в
     * ОТВЕТ (не в хранимые данные, `weightRank`/`ageTurns`/`idleTurns` заново пересчитываются на каждый запрос):
     * `weight` — тот же `computeNodeWeight()`, с тем же `elapsed`, что уже реально решает вытеснение
     * (`pickEvictionCandidate()` → `elapsedTurnsFor()`) — у защищённых нод он `Infinity`, а JSON не умеет
     * `Infinity`, поэтому наружу `null` (сама `protectedNode:true` уже есть на ноде, различать по ней);
     * `weightRank` — МЕСТО ноды по весу среди НЕЗАЩИЩЁННЫХ нод всего графа (не одного региона), нормированное в
     * [0,1] линейно по позиции в отсортированном списке (0 — самая слабая, 1 — самая сильная); у защищённых — `1`
     * (те же ноды, что `pickEvictionCandidate()` никогда не вытеснит, "сильнее" любой обычной по определению);
     * единственная незащищённая нода во всём графе — делить ранг не на что, `1` (та же "нет базы для сравнения",
     * что у бутстрапа гейта, `isStrongChangeEwma()`). `ageTurns`/`idleTurns` — то же самое разделение "создана" vs
     * "давно не использовалась", что уже разделяет Этап 7 `MEMORY_GRAPH_FIX_PLAN.md` (`elapsedTurnsFor()` уже
     * читает `lastTouchedTurn ?? createdTurn` — это и есть `idleTurns`).
     */
    function nodesForResponse() {
        const all = Object.values(nodes);
        const unprotectedByWeight = all
            .filter(node => !node.protectedNode)
            .map(node => ({ id: node.id, weight: computeNodeWeight({ importance: node.importance, degree: node.degree, elapsed: elapsedTurnsFor(node), protectedNode: false, settings }) }))
            .sort((a, b) => a.weight - b.weight);
        const weightById = new Map(unprotectedByWeight.map(entry => [entry.id, entry.weight]));
        const rankById = new Map(unprotectedByWeight.map((entry, index) => [
            entry.id, unprotectedByWeight.length > 1 ? index / (unprotectedByWeight.length - 1) : 1,
        ]));
        return all.map(node => ({
            ...node,
            weight: node.protectedNode ? null : (weightById.get(node.id) ?? null),
            weightRank: node.protectedNode ? 1 : (rankById.get(node.id) ?? 0),
            ageTurns: Math.max(0, turnCounter - (node.createdTurn ?? turnCounter)),
            idleTurns: elapsedTurnsFor(node),
            // Этап 6.1 плана ("source" метрика) — ноды, заведённые ДО этого поля, читаются как 'unknown', не `undefined`.
            source: node.source ?? 'unknown',
        }));
    }

    /**
     * Ключ региона в `regions`. Регионы бутстрапа из лорбука — СЕМАНТИЧЕСКИЕ ("Story"), у них нет `sector`/`ring`, а прежний код
     * описывал регион только парой `{sector, ring}` и собирал ключ `${sector}:${ring}` — для такого региона это "undefined:undefined"
     * или "NaN:undefined": новая органическая нода попадала не в свой регион, а в НОВЫЙ пустой регион-призрак (ROADMAP 5.110).
     */
    function regionKeyOf(region) {
        return Object.keys(regions).find(key => regions[key] === region) ?? regionKey(region.sector, region.ring);
    }

    /** Прикрепляет ноду к региону по описанию решения размещения: по ключу (любой регион) либо по `{sector, ring}` (регион-«дартс»). */
    function attachToRegionDescriptor(node, region) {
        if (region.regionId && regions[region.regionId]) attachToRegionByKey(node, region.regionId);
        else attachToRegion(node, region.sector, region.ring);
    }

    /** Анкеры для `pickRegionBySimilarity()` (placement.js, Этап 3) — только регионы, у которых УЖЕ есть центр с реальным эмбедингом; регион без центра не с чем сравнивать. */
    function collectAnchors() {
        return Object.values(regions)
            .filter(region => region.centerNodeId && nodes[region.centerNodeId]?.embedding)
            .map(region => ({ regionId: regionKeyOf(region), sector: region.sector, ring: region.ring, embedding: nodes[region.centerNodeId].embedding }));
    }

    /**
     * До `count` ближайших к `contextEmbedding` узлов по настоящему косинусу — MEMORY_GRAPH_FIX_PLAN.md, Этап 8
     * (ROADMAP 5.107з, П2 плана): кандидаты на `"op":"update"` для `askSideCarForNode()`, чтобы SideCar видел, что
     * уже записано рядом, и мог уточнить существующий факт вместо почти-дубля. Сравнивает с `node.embedding` —
     * постоянным passage-эмбедингом самой ноды (не query контекста), тот же источник истины, что и у
     * merge-detection/маяков (см. doc-comment у `checkAndPlace()`'s второго `embedding.compute`).
     */
    function findNearestNodes(contextEmbedding, count = 6) {
        return Object.values(nodes)
            .filter(node => node.embedding)
            .map(node => ({ id: node.id, label: node.label, content: node.content, similarity: cosineSimilarity(contextEmbedding, node.embedding) }))
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, count)
            .map(({ id, label, content }) => ({ id, label, content }));
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
            if (owner) {
                const [sector, ring] = owner.regionId.split(':').map(Number);
                return { regionId: owner.regionId, sector, ring }; // sector/ring — только у регионов-«дартса»; у семантических ключ и есть регион
            }
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
        let eligible = members.filter(member => !member.protectedNode && !alreadyQueued.has(member.id));
        // structured: сворачивать можно только ноды ОДНОГО вида (факты с фактами) — берём самую многочисленную группу.
        if (features.kinds) {
            const byKind = Map.groupBy(eligible, member => kindOf(member));
            eligible = [...byKind.values()].sort((a, b) => b.length - a.length)[0] ?? [];
        }
        if (eligible.length < settings.reconsolidationMinCluster) return false;

        const weakest = eligible
            .map(member => ({
                id: member.id,
                weight: computeNodeWeight({
                    importance: member.importance, degree: member.degree,
                    elapsed: Math.max(0, turnCounter - (member.lastTouchedTurn ?? member.createdTurn ?? turnCounter)), // Этап 7 — см. doc-comment у pickEvictionCandidate()
                    protectedNode: false, settings,
                }),
            }))
            .sort((a, b) => a.weight - b.weight)
            .slice(0, settings.reconsolidationMinCluster)
            .map(entry => entry.id);

        const groupKey = [...weakest].sort().join('|');
        reconsolidationQueue[groupKey] = { nodeIds: weakest, regionId: key, queuedTurn: turnCounter };
        if (capacityTracker) capacityTracker.queuedReconsolidation = true; // Этап 6 (наблюдаемость) — см. doc-comment у `capacityTracker`
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
        if (!region) return;
        // structured: события в ёмкость региона не считаются и не вытесняются (их бережёт сворачивание, timeline-compact.js).
        const members = region.nodeIds.map(id => nodes[id]).filter(node => node && !(features.timeline && isEvent(node)));
        if (members.length <= settings.maxNodesPerRegion) return;
        if (tryQueueReconsolidation(key, members)) return;
        const victimId = pickEvictionCandidate(members, { settings, turnCounter });
        if (!victimId) return; // регион целиком из защищённых узлов — вытеснять нечего, задокументированный крайний случай
        removeNodeFromGraph(victimId);
        if (capacityTracker) capacityTracker.evicted.push(victimId); // Этап 6 (наблюдаемость) — см. doc-comment у `capacityTracker`
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
            .filter(member => !features.kinds || kindOf(member) === kindOf(node)) // structured: слияние только внутри одного вида
            .map(member => ({ id: member.id, embedding: member.embedding, words: wordsOf(member.content) }));
        const matchId = findMergeCandidate(newNode, members, {
            wordOverlapThreshold: settings.mergeWordOverlapThreshold,
            similarityThreshold: settings.mergeSimilarityThreshold,
        });
        if (!matchId) return;
        const pairKey = [node.id, matchId].sort().join('|');
        if (mergeQueue[pairKey]) return; // уже в очереди — не дублируем запись
        mergeQueue[pairKey] = { nodeIdA: node.id, nodeIdB: matchId, queuedTurn: turnCounter, regionId: key };
        if (capacityTracker) capacityTracker.queuedMerge = true; // Этап 6 (наблюдаемость) — см. doc-comment у `capacityTracker`
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
        if (features.kinds) {
            // Слияние идёт внутри одного вида; Core не «поглощается»: если он есть в группе, слитая нода — Core (protectedNode выше уже true).
            merged.kind = kindOf(originals[0]);
            const subtype = originals.find(node => node.subtype)?.subtype;
            if (subtype) merged.subtype = subtype;
            merged.core = originals.some(isCore);
            const aliases = [...new Set(originals.flatMap(node => node.aliases ?? []))].slice(0, 8);
            if (aliases.length) merged.aliases = aliases;
        }
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
            // structured: под-центры авто-детекцией по порядку прибытия больше не назначаются — роль достаётся только Core (`promoteToCore`, бутстрап через forceRole).
            : (!features.core && !isFirst && region.subCenterIds.length < settings.subCentersPerRegion);
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
            if (!edgeAllowed(node, owner)) continue;
            node.edges = [...(node.edges ?? []), { to: owner.id, type: 'mentions' }];
            owner.edges = [...(owner.edges ?? []), { to: node.id, type: 'mentions' }];
            node.degree = (node.degree ?? 0) + 1;
            owner.degree = (owner.degree ?? 0) + 1;
        }
        stampStructured(node);
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
        if (!edgeAllowed(a, b)) return;
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
            // stillSameChat() — Этап 5 (ROADMAP 5.107д, П6 плана): вызывается на смене персонажа/чата
            // (см. подписку ниже), сама может ждать эмбединг секунды — тот же сценарий гонки, что у checkAndPlace().
            const epoch = chatEpoch;
            const characterResult = await callService('stCharacter.current');
            if (!characterResult.ok || !characterResult.value) return { ok: false, error: 'No active character.' };
            const character = characterResult.value;
            const label = String(character.name ?? '').trim() || 'Main Character';
            const content = [character.description, character.personality]
                .map(part => String(part ?? '').trim()).filter(Boolean).join('\n\n');
            if (!content) return { ok: false, error: 'Character card has no description/personality to import.' };

            const embeddingResult = await callService('embedding.compute', { text: `${label}: ${content}`, kind: 'passage' });
            if (!stillSameChat(epoch)) return { status: 'chat-changed' }; // чат сменился, пока ждали эмбединг — не мутируем уже ЧУЖОЙ (новый) граф
            if (!embeddingResult.ok) return { ok: false, error: embeddingResult.error.message };
            const result = placeNewNode({ label, content, embedding: embeddingResult.value, importance: MAIN_CHARACTER_IMPORTANCE, kind: 'entity' }, { source: 'card' });
            if (features.core && nodes[result.nodeId]) promoteToCore(result.nodeId, { manual: true }); // главный герой — Core (этап 4 плана типов)
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
    async function createNodeManually({ label, content, importance = 0, sector, ring, regionId, kind, subtype, core } = {}) {
        return enqueueWrite(async () => {
            // `regionId` (MEMORY_GRAPH_UI_PLAN.md, Этап 2, П1) — берёт приоритет над sector/ring: единственный
            // способ положить ноду руками в СЕМАНТИЧЕСКИЙ регион бутстрапа из Lorebook (у него нет "сектор:кольцо"
            // вообще, см. Б2 плана). `sector`/`ring` в этом случае не проверяются вовсе — вызывающий выбрал один
            // способ адресации региона, не оба сразу.
            if (regionId != null) {
                if (!regions[regionId]) return { ok: false, error: `Unknown region "${regionId}".` };
            } else if (!Number.isInteger(sector) || sector < 0 || sector >= SECTORS || !Number.isInteger(ring) || ring < 0 || ring >= RINGS) {
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
                source: 'manual', // Этап 6.1 плана — единственный путь создания ноды, что НЕ идёт через placeNewNode()
            };
            // structured: вид/подвид/Core из формы; в legacy эти поля игнорируются — данные legacy-графа не меняют формы.
            if (features.kinds) {
                Object.assign(node, normalizeKind(kind, subtype), { core: Boolean(core) });
                if (node.core) node.protectedNode = true;
            }
            nodes[node.id] = node;
            // Слияние/переполнение при вставке — как обычно, это уже внутри attachToRegionByKey()/attachToRegion()
            // (detectMergeCandidate()/enforceRegionCapacity()) независимо от того, каким путём выбран регион.
            if (regionId != null) attachToRegionByKey(node, regionId);
            else attachToRegion(node, sector, ring);
            await Promise.all([persistNodes(), persistRegions(), persistStaging(), persistMergeQueue(), persistReconsolidationQueue()]);
            publishEvent('memoryGraph.nodeCreated', { nodeId: node.id, status: 'placed', manual: true });
            return { ok: true, nodeId: node.id };
        });
    }

    /**
     * Общая логика правки узла — ИЗВЛЕЧЕНА из `updateNodeManually()` в Этапе 8 (ROADMAP 5.107з, П4 плана): та же
     * правка нужна теперь и `checkAndPlace()` на факте `"op":"update"` от SideCar, а он уже ВНУТРИ своего
     * `enqueueWrite()` — повторно оборачивать нельзя (тот же `writeTail` ждал бы сам себя). Пересчитывает эмбединг
     * ТОЛЬКО если `label`/`content` реально изменились — иначе он рассинхронизируется с текстом, ломая
     * маяки/merge-detection (оба читают `embedding` как источник истины о содержимом узла). НЕ персистит и не
     * публикует событие сама — оба вызывающих делают это по-своему (один узел сразу vs пачкой в конце `checkAndPlace()`).
     */
    async function applyNodeUpdate({ id, label, content, importance, protectedNode, kind, subtype, core } = {}) {
        const node = nodes[id];
        if (!node) return { ok: false, error: `no such node: ${id}` };
        if (features.kinds && kind !== undefined) {
            // Смена вида не должна нарушить правило рёбер: событию (не Core) нельзя иметь рёбра в не-события — сначала их надо убрать.
            const next = normalizeKind(kind, subtype ?? node.subtype);
            const wouldBreak = next.kind === 'event' && !isCore(node) && !isCore({ core }) && (node.edges ?? []).some(edge => nodes[edge.to] && !checkEdge({ ...node, kind: 'event' }, nodes[edge.to]).ok);
            if (wouldBreak) return { ok: false, error: 'An event can only continue into another event — remove its links to lore first.' };
        }

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
        if (features.kinds) {
            // Core защищены и не разжалуются (решение владельца): `core: false` и `protectedNode: false` для Core игнорируются;
            // `core: true` — ручное закрепление (роль под-центра в регионе назначит этап 4).
            if (kind !== undefined) Object.assign(node, normalizeKind(kind, subtype ?? node.subtype));
            else if (subtype !== undefined && kindOf(node) === 'object') Object.assign(node, normalizeKind('object', subtype));
            if (core === true) promoteToCore(node.id, { manual: true });
            if (protectedNode !== undefined && !isCore(node)) node.protectedNode = Boolean(protectedNode);
            if (isCore(node)) node.protectedNode = true;
        } else if (protectedNode !== undefined) node.protectedNode = Boolean(protectedNode);
        node.lastTouchedTurn = turnCounter;
        return { ok: true };
    }

    /** Ручное редактирование узла (UI-редактор) — тонкая обёртка над `applyNodeUpdate()`: своя очередь, свой персист, своё событие. */
    async function updateNodeManually(params = {}) {
        return enqueueWrite(async () => {
            const result = await applyNodeUpdate(params);
            if (!result.ok) return result;
            await persistNodes();
            publishEvent('memoryGraph.nodeUpdated', { nodeId: params.id });
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
    async function moveNodeManually({ id, sector, ring, regionId } = {}) {
        return enqueueWrite(async () => {
            const node = nodes[id];
            if (!node) return { ok: false, error: `no such node: ${id}` };

            // `regionId` (MEMORY_GRAPH_UI_PLAN.md, Этап 2, П1) — тот же приоритет над sector/ring, что у
            // createNodeManually(): единственный способ перетащить ноду руками в семантический регион.
            let targetKey;
            if (regionId != null) {
                if (!regions[regionId]) return { ok: false, error: `Unknown region "${regionId}".` };
                targetKey = regionId;
            } else {
                if (!Number.isInteger(sector) || sector < 0 || sector >= SECTORS || !Number.isInteger(ring) || ring < 0 || ring >= RINGS) {
                    return { ok: false, error: `sector must be an integer in [0,${SECTORS}), ring in [0,${RINGS}).` };
                }
                targetKey = regionKey(sector, ring);
            }
            // Перенос в тот же регион — ничего не делать (Этап 2, П1 плана); `unchanged: true` — явный флаг для
            // вызывающего (панель, Этап 7 того же плана: "перетащили внутри своего же региона — вернуть на место"),
            // не просто тихий такой же `{ok:true}`, что и у настоящего переноса.
            if (node.regionId === targetKey) return { ok: true, nodeId: id, unchanged: true };

            if (node.regionId && regions[node.regionId]) {
                const oldRegion = regions[node.regionId];
                regions[node.regionId] = {
                    ...oldRegion,
                    nodeIds: oldRegion.nodeIds.filter(otherId => otherId !== id),
                    subCenterIds: oldRegion.subCenterIds.filter(otherId => otherId !== id),
                    centerNodeId: oldRegion.centerNodeId === id ? null : oldRegion.centerNodeId,
                };
            }
            node.regionId = null; // attachToRegion()/attachToRegionByKey() ожидают узел вне региона — та же форма, что у новой ноды
            if (regionId != null) attachToRegionByKey(node, targetKey);
            else attachToRegion(node, sector, ring);

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
            if (!features.directedEvents && (from.edges ?? []).some(edge => edge.to === toId && edge.type === edgeType)) return { ok: true };
            if (!edgeAllowed(from, to)) {
                const verdict = [checkEdge(from, to), checkEdge(to, from)].find(check => !check.ok);
                return { ok: false, error: verdict.reason };
            }

            let writtenType = edgeType;
            if (features.directedEvents) writtenType = addDirectedEdge(from, to, edgeType).type; // structured: с событием — направленно, тип по видам концов
            else {
                from.edges = [...(from.edges ?? []), { to: toId, type: edgeType }];
                to.edges = [...(to.edges ?? []), { to: fromId, type: edgeType }];
                from.degree = (from.degree ?? 0) + 1;
                to.degree = (to.degree ?? 0) + 1;
            }

            await persistNodes();
            publishEvent('memoryGraph.edgeCreated', { fromId, toId, type: writtenType });
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

    /**
     * Полное удаление графа — реальная жалоба пользователя: "граф нельзя
     * удалить". До этого шага единственный способ вернуть чат к пустому
     * графу был удалить каждую ноду по одной через `memoryGraph.nodes.delete`
     * — а `regions`/`mergeQueue`/`reconsolidationQueue`/`stickyRetrieval`
     * при этом всё равно оставались висеть в `chatMemory`, так что "граф",
     * даже с нулём нод, формально не был пустым для остального кода (та же
     * `chatMemory`, что `loadState()` читает целиком). Очищает ВСЕ
     * структуры состояния разом и персистит каждую тем же набором вызовов,
     * что `loadState()` читает — единственный способ гарантировать, что
     * следующий бутстрап реально стартует с чистого листа, а не подхватит
     * осиротевший `region.centerNodeId`, указывающий на уже удалённую ноду.
     */
    async function resetGraph() {
        return enqueueWrite(async () => {
            nodes = {};
            regions = {};
            staging = {};
            mergeQueue = {};
            reconsolidationQueue = {};
            distanceStats = null;
            noveltyStats = null;
            stickyRetrieval = null;
            decisionLog = []; // Этап 6 — тоже часть состояния графа, тот же принцип "очищает ВСЁ", что и у остального выше
            // Пустой граф — «новый»: режим снова из настройки по умолчанию (этап 0, п. 5), а не наследуется от удалённого графа.
            applyGraphMeta({ mode: settings.defaultGraphMode, createdAt: now() });
            await Promise.all([
                persistNodes(), persistRegions(), persistStaging(),
                persistMergeQueue(), persistReconsolidationQueue(),
                persistStats(), persistStickyRetrieval(), persistDecisionLog(), persistGraphMeta(),
            ]);
            publishEvent('memoryGraph.modeChanged', { mode: graphMeta.mode });
            publishEvent('memoryGraph.reset', {});
            return { ok: true };
        });
    }

    /**
     * Тихий вызов SideCar — тот же контракт/приём, что `tracking.poll()`/
     * BasicSummary. Отдаёт ДО 3 фактов (`create`/`update`) за раз — MEMORY_GRAPH_FIX_PLAN.md, Этап 8 (ROADMAP
     * 5.107з, П7 плана): промпт/разбор ответа вынесены в `cores/memory-graph/extraction-prompt.js` (см. его
     * doc-comment за тем, что именно изменилось и почему — почти-дубли из-за отсутствия "обновить существующий
     * факт" вместо "создать новый").
     *
     * Реальная жалоба пользователя (сформулирована после уточняющего
     * вопроса — исходное "чистит слишком много" оказалось СИМПТОМОМ, не
     * причиной): "получение и пополнение фактов работает не на то...
     * мелкие краткосрочные договорённости, а не влияющие вещи. Плюс эти
     * ноды не сортировались сразу". Т.е. проблема выше по потоку, не в
     * реконсолидации — САМ захват узлов не отличал "договорились встретиться
     * у таверны в полдень" (сюжетная механика, забудется через пару ходов)
     * от настоящего долгоживущего факта, и `importance` не отражал эту
     * разницу с самого создания (не "сортировался"), из-за чего вся
     * математика дальше (decay, эвикшн, бэкбон) видела мусорные узлы как
     * равноценные важным. Плюс у промпта не было пути ОТКАЗАТЬСЯ — модель
     * была вынуждена всегда изобрести "факт", даже если `isStrongChange()`
     * сработал на смене темы, а не на чём-то memory-worthy (эмбединг-порог
     * ловит НОВИЗНУ, не ЗНАЧИМОСТЬ — это математика, ей неоткуда знать
     * разницу).
     *
     * Исправлено (Этап 1, ROADMAP 5.106): явное исключение краткосрочных/
     * ситуативных договорённостей текстом промпта, закреплённая шкала
     * importance, явный отказ (раньше `{"skip":true}`, теперь пустой
     * `{"facts":[]}` — тот же смысл, другая обёртка, см. extraction-prompt.js).
     */
    async function askSideCarForNode(contextText, { isFirstNode = false, nearestNodes = [] } = {}) {
        let prompt;
        if (features.structuredExtraction) {
            const characterResult = await callService('stCharacter.current');
            const mainCharacters = characterResult.ok && characterResult.value?.name ? [String(characterResult.value.name)] : [];
            prompt = buildStructuredExtractionPrompt({ contextText, nearestNodes, knownNames: knownSubjectNames(), mainCharacters, isFirstNode });
        } else prompt = buildExtractionPrompt({ contextText, nearestNodes, isFirstNode });
        const result = await call('model.generate', { prompt, workerId: settings.workerId ?? undefined, stallMs: settings.stallMs, fallbackWorkerIds: settings.fallbackWorkerIds });
        if (!result.ok) throw new Error(result.error.message);
        const parsed = parseModelJson(result.value);
        const { facts } = parseExtractionResponse(parsed, nearestNodes.map(node => node.id), { structured: features.structuredExtraction });
        // `lastSideCarOutcome` — Этап 6 (наблюдаемость), тот же приём "последнее действие", что у `capacityTracker`
        // (П2 плана): различает ЧЕСТНЫЙ пустой ответ (валидный JSON-объект, просто `facts:[]`/старый `skip:true`) от
        // малополезного/непарсимого — оба всё равно дают `facts:[]` для самого `checkAndPlace()` (статус
        // `sidecar-empty` в обоих случаях одинаковый, не меняется этим этапом), различие — только для журнала.
        lastSideCarOutcome = facts.length ? 'node' : (parsed && typeof parsed === 'object' ? 'skip' : 'empty');
        return facts;
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
        const result = await call('model.generate', { prompt, workerId: settings.workerId ?? undefined, stallMs: settings.stallMs, fallbackWorkerIds: settings.fallbackWorkerIds });
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
        // Явный maxTokens (жалоба пользователя: "[сайдкар] имеет макс
        // контекст тоже в 1000" — тот же класс бага, что уже нашли и
        // починили у бутстрапа, см. `bootstrapMaxTokens`). Без него падает
        // на `REQUEST_DEFAULTS.maxTokens = 1000` (cores/models/internal-engine.js)
        // — `reconsolidationMinCluster` может доходить до 20 узлов
        // (клэмп 2-20), усечённый посреди JSON-объекта результата
        // `parseModelJson()` тихо отдаёт `undefined`, реконсолидация просто
        // не срабатывает (узлы остаются как были — не потеря данных, но и
        // не то, ради чего очередь вообще заводилась).
        const result = await call('model.generate', { prompt, workerId: settings.workerId ?? undefined, maxTokens: settings.reconsolidationMaxTokens, stallMs: settings.stallMs, fallbackWorkerIds: settings.fallbackWorkerIds });
        if (!result.ok) return null;
        const parsed = parseModelJson(result.value);
        if (!parsed || typeof parsed !== 'object' || !parsed.label || !parsed.content) return null;
        return { label: String(parsed.label), content: String(parsed.content), importance: Number(parsed.importance) || 0 };
    }

    /**
     * Общий хвост каскада — от готового эмбединга ноды до "размещена/в накопителе" + персист. Один и тот же путь
     * для НОВОЙ ноды и от SideCar (`checkAndPlace`), и от карточки персонажа (`createNodeFromCharacterCard`) — это
     * буквально одна и та же задача ("куда положить кусок текста с его эмбедингом"), разница только в ИСТОЧНИКЕ
     * текста, не в математике размещения.
     *
     * `placementEmbedding` (по умолчанию — сам `embedding` ноды) — MEMORY_GRAPH_FIX_PLAN.md, Этап 3: сигнал ДЛЯ
     * РЕШЕНИЯ "в какой регион" может ОТЛИЧАТЬСя от постоянного эмбединга самой ноды — `checkAndPlace()` явно
     * передаёт сюда эмбединг СЦЕНЫ (query), а не факта (passage), по той же причине, что уже описана в её
     * doc-comment у второго вызова `embedding.compute`: сравнение "что навело на мысль" с центрами регионов (тоже
     * passage) — это query-vs-passage, ожидаемое протоколом E5 сопоставление, тогда как самой ноде для БУДУЩИХ
     * сравнений (слияние/маяки/бэкбон) нужен passage-эмбединг её же содержимого, не сцены-триггера.
     */
    function placeNewNode({ label, content, embedding, importance = 0, gameTime = null, createdTurn = turnCounter, kind, subtype }, { placementEmbedding = embedding, source = 'chat', subjectRegion = null } = {}) {
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
            // `source` — MEMORY_GRAPH_UI_PLAN.md, Этап 6.1 (метрика "source" в окне): откуда взялся кусок текста.
            // По умолчанию 'chat' — единственный вызывающий, что не передаёт свой (`checkAndPlace()`), это и есть
            // органическая нода из живого чата; `createNodeFromCharacterCard()` передаёт 'card' явно.
            source,
        };
        if (features.kinds) Object.assign(node, normalizeKind(kind, subtype), { core: false }); // structured: вид от извлечения (по умолчанию факт)
        if (features.timeline && node.kind === 'event') {
            // structured: событие живёт без региона (не в ёмкости региона, не в накопителе) и показывается у якорной ноды — этап 3 плана типов.
            nodes[node.id] = node;
            return { status: 'placed', reason: 'event', region: null, nodeId: node.id };
        }
        const decision = decideFirstPlacement({ subjectRegion, nameMatchRegion: findNameMatchRegion(content), embedding: placementEmbedding, anchors: collectAnchors(), settings });

        nodes[node.id] = node;
        if (decision.status === 'placed') {
            if (decision.placementConfidence === 'low') node.placementConfidence = 'low';
            attachToRegionDescriptor(node, decision.region);
        } else staging[node.id] = { nodeId: node.id, attemptCount: 1, firstAttemptTurn: createdTurn };
        // Весь `decision` (не только `status`) — Этап 6 (наблюдаемость, ROADMAP 5.107е): журналу решений
        // `checkAndPlace()` нужны `reason`/`region`/`similarity`/`margin`, которые каскад уже посчитал внутри
        // `decision`, но раньше терялись здесь же, не покидая эту функцию. Оба сегодняшних вызывающих
        // (checkAndPlace(), createNodeFromCharacterCard()) читали только `.status`/`.nodeId` — лишние поля им не мешают.
        return { ...decision, nodeId: node.id };
    }

    /**
     * Один прогон "сильного изменения": считает эмбединг свежего контекста,
     * сравнивает с бегущей статистикой расстояний, и ТОЛЬКО если порог
     * превышен — зовёт SideCar и проводит новую ноду через каскад
     * размещения. Математика решает, звать ли модель вообще — MEMORY_GRAPH.md.
     */
    async function checkAndPlace(contextText, { chatLength } = {}) {
        return enqueueWrite(async () => {
            // Эпоха запоминается ЗДЕСЬ, первой строкой ВНУТРИ задачи — не до `enqueueWrite()` (задача могла ждать
            // своей очереди сколько угодно, "мутации до первого await допустимы" относится к синхронному началу
            // САМОЙ задачи, когда она реально стартовала, не к моменту её постановки в очередь). MEMORY_GRAPH_FIX_PLAN.md,
            // Этап 5 (ROADMAP 5.107д, П6 плана) — см. doc-comment у `chatEpoch` выше.
            const epoch = chatEpoch;
            // `chatLength` — длина ЖИВОГО чата на момент вызова (обработчик `memoryGraph.check` передаёт
            // `params.chat.length`); без неё (ручной `memoryGraph.checkAndPlace({ text })`, см. регистрацию
            // контракта ниже) часы просто не двигаются — `advanceClock(x, undefined) === x` (MEMORY_GRAPH_FIX_PLAN.md,
            // Этап 2, ROADMAP 5.107б).
            turnCounter = advanceClock(turnCounter, chatLength);
            if (needsClockMigration) {
                // Разовая миграция данных из старого режима (счётчик-в-памяти) — см. doc-comment у
                // `needsClockMigration`/`loadState()` выше. Флаг гасится СРАЗУ, а не после успешной записи:
                // повторный прогон переписал бы уже верно смигрированные отметки поверх настоящего прошедшего
                // времени, стерев разницу в возрасте между старыми нодами и всем, что появилось после первой
                // миграции. `persistClock()` — ЗДЕСЬ, не в общей точке с `persistStats()` ниже: сам факт наличия
                // `CLOCK_KEY` в хранилище — это и есть маркер "миграция сделана", он обязан долететь до диска
                // даже если этот конкретный вызов ниже вернётся с `'skipped'` (пустой текст).
                needsClockMigration = false;
                ({ nodes, staging, mergeQueue, reconsolidationQueue } = migrateTimestamps({ nodes, staging, mergeQueue, reconsolidationQueue }, turnCounter));
                await Promise.all([persistNodes(), persistStaging(), persistMergeQueue(), persistReconsolidationQueue(), persistClock()]);
            }
            if (!contextText || !contextText.trim()) return { status: 'skipped' };

            const embeddingResult = await callService('embedding.compute', { text: contextText, kind: 'query' });
            if (!stillSameChat(epoch)) return { status: 'chat-changed' }; // Этап 5 — чат сменился, пока ждали эмбединг; ничего из этого больше не про АКТИВНЫЙ чат
            if (!embeddingResult.ok) return { status: 'skipped', error: embeddingResult.error.message };
            const contextEmbedding = embeddingResult.value; // ТОЛЬКО сигнал размещения — см. комментарий у passage-эмбединга ниже, почему это не то же самое, что node.embedding.

            // Два независимых сигнала, оба адаптивные (Уэлфорд), достаточно ЛЮБОГО:
            // 1) смена ТЕМЫ — расстояние до ближайшего центра региона;
            // 2) НОВЫЙ ФАКТ внутри знакомой темы — расстояние до ближайшей НОДЫ
            //    (центры регионов этого не видят: факт про уже известную
            //    тему близок к её центру и раньше пропускался как no-change).
            // Оба считаются по настоящему косинусу, не по долям softmax. Статистика — EWMA с забыванием
            // (`gate.js`, MEMORY_GRAPH_FIX_PLAN.md, Этап 4), не Уэлфорд за всю историю: типичные расстояния падают
            // по мере роста графа, а старый Уэлфорд держал порог на старых больших значениях сколь угодно долго —
            // гейт постепенно замолкал (П5). `updateDistanceStats`/`isStrongChange` НЕ удалены (свои тесты) —
            // просто больше не зовутся отсюда.
            const centerEmbeddings = Object.values(regions).map(region => nodes[region.centerNodeId]?.embedding).filter(Boolean);
            const nodeEmbeddings = Object.values(nodes).map(node => node.embedding).filter(Boolean);
            const topicDistance = nearestEmbeddingDistance(contextEmbedding, centerEmbeddings);
            const noveltyDistance = nearestEmbeddingDistance(contextEmbedding, nodeEmbeddings);
            const topicChanged = isStrongChangeEwma(topicDistance, distanceStats, settings.thresholdK);
            const factIsNew = isStrongChangeEwma(noveltyDistance, noveltyStats, settings.thresholdK);
            const wasStrong = topicChanged || factIsNew;
            // Пороги для журнала решений (MEMORY_GRAPH_FIX_PLAN.md, Этап 6, ROADMAP 5.107е) — тем же способом, что
            // внутри самой `isStrongChangeEwma()`, и по статистике ДО ЭТОГО наблюдения (с чем реально сравнивалось
            // только что посчитанное расстояние, не с чем оно станет сравниваться в следующий раз, см. `updateEwmaStats`
            // ниже). `0` — базовой линии ещё нет (граф только что стартовал) — `isStrongChangeEwma()` сама в этом
            // случае бутстрапится на `true` независимо от чисел, см. её doc-comment.
            const topicThreshold = distanceStats ? distanceStats.mean + settings.thresholdK * ewmaStddev(distanceStats) : 0;
            const noveltyThreshold = noveltyStats ? noveltyStats.mean + settings.thresholdK * ewmaStddev(noveltyStats) : 0;
            // "Не с чем сравнивать" (пустой граф) — фиктивное расстояние 1, в
            // базовую линию его класть нельзя: единственный такой выброс
            // раздувает среднее/σ и гейт надолго перестаёт срабатывать.
            if (centerEmbeddings.length) distanceStats = updateEwmaStats(distanceStats, topicDistance, { window: settings.gateWindow });
            if (nodeEmbeddings.length) noveltyStats = updateEwmaStats(noveltyStats, noveltyDistance, { window: settings.gateWindow });
            await persistStats();
            await persistClock(); // тот же момент, что и persistStats() (MEMORY_GRAPH_FIX_PLAN.md, Этап 2) — не на КАЖДОЙ строке функции, но на каждом дошедшем сюда проходе

            // Страховочное извлечение (MEMORY_GRAPH_FIX_PLAN.md, Этап 4) — сам фильтр тоже может застояться на
            // ложном "всё привычно" очень надолго (П5: та же болезнь, от которой лечит EWMA выше, но не гарантия
            // на 100%); если он молчит слишком много СООБЩЕНИЙ подряд без единого реального вызова модели —
            // спрашиваем её принудительно, а не ждём вечно точного совпадения с гейтом.
            const forced = !wasStrong && settings.forcedExtractionEvery > 0 && turnCounter - lastExtractionClock >= settings.forcedExtractionEvery;
            // Журнал решений (Этап 6) — общая для всех исходов "шапка" записи, дополняется ниже по мере того, как
            // становится известно больше (позвана ли модель, что она ответила, куда легла нода).
            const gateInfo = { topicDistance, topicThreshold, noveltyDistance, noveltyThreshold, fired: wasStrong, forced };
            if (!wasStrong && !forced) {
                await recordDecision({ clock: turnCounter, at: now(), gate: gateInfo, extractor: 'not-called' });
                return { status: 'no-change' };
            }

            let facts;
            try {
                facts = await askSideCarForNode(contextText, { isFirstNode: Object.keys(nodes).length === 0, nearestNodes: findNearestNodes(contextEmbedding) });
            } catch (error) {
                // Записываем, только если чат тот же — иначе это уже не про АКТИВНЫЙ чат (тот же принцип, что у
                // остальных `stillSameChat()`-проверок Этапа 5); проброс наверх — БЕЗ ИЗМЕНЕНИЙ, `askSideCarForNode()`
                // как и раньше выбрасывает на сбой модели, эта запись — чистое наблюдение сбоку, не меняет исход.
                if (stillSameChat(epoch)) await recordDecision({ clock: turnCounter, at: now(), gate: gateInfo, extractor: 'error', error: error.message });
                throw error;
            }
            if (!stillSameChat(epoch)) return { status: 'chat-changed' }; // Этап 5 — чат сменился, пока ждали SideCar
            // Часы последнего РЕАЛЬНОГО вызова — двигаются на любой исход (включая честный пустой ответ SideCar'а),
            // не только на успешное создание ноды: "модель спросили" — это и есть то, что защищает страховка.
            lastExtractionClock = turnCounter;
            await persistClock();
            if (!facts.length) {
                // `lastSideCarOutcome` различает честный пустой ответ от непарсимого/неполного — см.
                // doc-comment у `askSideCarForNode()`; `?? 'empty'` — чисто оборонительный край (не должен
                // случаться на практике: функция всегда выставляет его перед пустым массивом).
                await recordDecision({ clock: turnCounter, at: now(), gate: gateInfo, extractor: lastSideCarOutcome ?? 'empty' });
                return { status: 'sidecar-empty' };
            }

            // MEMORY_GRAPH_FIX_PLAN.md, Этап 8 (ROADMAP 5.107з) — до 3 фактов за один check(), каждый независимо
            // `create`/`update`. `contextEmbedding` (query СЦЕНЫ, не факта) по-прежнему используется ТОЛЬКО как
            // сигнал РАЗМЕЩЕНИЯ для новых (`create`) узлов — та же причина, что и раньше (см. doc-comment у
            // `placeNewNode()`'s `placementEmbedding`): сравнение с центрами регионов ожидает query-vs-passage,
            // а собственный passage-эмбединг узла остаётся источником истины для будущих сравнений (слияние/маяки).
            const results = [];
            let sameBatchEvent = null; // событие этого же ответа: созданные после него факты указывают на него
            for (const fact of facts) {
                if (fact.op === 'update') {
                    // `applyNodeUpdate()` — та же логика, что у ручного редактирования (`updateNodeManually()`), без
                    // повторного `enqueueWrite()` — мы уже внутри своего (П4 плана).
                    const updateResult = await applyNodeUpdate({ id: fact.id, content: fact.content, importance: fact.importance });
                    if (!stillSameChat(epoch)) return { status: 'chat-changed' }; // чат сменился, пока ждали эмбединг обновляемого узла — мутация (если случилась) осталась в памяти, но персиста ниже не будет
                    if (updateResult.ok) results.push({ status: 'updated', nodeId: fact.id, label: nodes[fact.id]?.label ?? fact.id });
                    continue; // update не зеркалится в WI — та же граница, что у правки через UI-редактор (см. doc-comment ниже)
                }

                // node.embedding — ЭТО ТОТ ЖЕ passage-эмбединг label+content, что
                // считают createNodeManually()/createNodeFromCharacterCard()/
                // bootstrapFromLorebook() (см. их вызовы `embedding.compute`
                // ниже по файлу): findMergeCandidate()/scoreBeaconCandidate()/
                // enforceBackboneConnectivity() читают `node.embedding` как
                // источник истины о СОДЕРЖИМОМ узла (тот же принцип, что уже
                // явно записан в doc-comment updateNodeManually()).
                const nodeEmbeddingResult = await callService('embedding.compute', { text: `${fact.label}: ${fact.content}`, kind: 'passage' });
                if (!stillSameChat(epoch)) return { status: 'chat-changed' }; // Этап 5 — чат сменился, пока ждали эмбединг ноды; placeNewNode() ниже мутирует nodes/regions/staging
                if (!nodeEmbeddingResult.ok) return { status: 'skipped', error: nodeEmbeddingResult.error.message }; // тот же аварийный выход, что раньше был у единственного факта — остальные факты этого батча теряются, не половинчатый успех

                const gameTime = await readGameTime();
                let structuredInfo = null;
                let subjectLinks = null;
                if (features.structuredExtraction) {
                    subjectLinks = await resolveFactSubjects(fact, { epoch, contextEmbedding });
                    if (!subjectLinks) return { status: 'chat-changed' };
                    if (fact.kind === 'event' && !subjectLinks.subjectIds.length && !subjectLinks.relatedIds.length) {
                        structuredInfo = { kind: 'event', skipped: 'event-without-anchor' }; // событию не к чему «отрастать» — не создаём
                        results.push({ status: 'skipped', nodeId: null, label: fact.label, structured: structuredInfo });
                        continue;
                    }
                }
                // Свежий трекер ПЕРЕД вызовом — Этап 6 (наблюдаемость): `capacityTracker` читают
                // `detectMergeCandidate()`/`tryQueueReconsolidation()`/`enforceRegionCapacity()` изнутри `attachToRegion()`
                // (см. doc-comment у самого трекера выше), но пишет в него только ЭТОТ вызов, не бутстрап/ручное создание/
                // карточка персонажа — остаётся `null` у любого другого вызывающего `placeNewNode()`.
                capacityTracker = { evicted: [], queuedMerge: false, queuedReconsolidation: false };
                const placed = placeNewNode({ label: fact.label, content: fact.content, embedding: nodeEmbeddingResult.value, importance: fact.importance, gameTime, kind: fact.kind, subtype: fact.subtype }, { placementEmbedding: contextEmbedding, subjectRegion: regionDescriptorOf(nodes[subjectLinks?.subjectIds[0]]) });
                if (subjectLinks) {
                    const created = nodes[placed.nodeId];
                    if (fact.time) created.timeText = fact.time;
                    if (fact.coreProposed) created.coreProposed = true; // предложение модели; само Core не делает — решает coreScore
                    const edgeCount = linkStructuredNode(created, subjectLinks, sameBatchEvent);
                    if (kindOf(created) === 'event' && !sameBatchEvent) sameBatchEvent = created;
                    structuredInfo = { kind: kindOf(created), subjects: subjectLinks.subjectIds.map(id => nodes[id]?.label).filter(Boolean), edges: edgeCount };
                }
                const capacityInfo = capacityTracker;
                capacityTracker = null; // не должен пережить этот вызов — иначе следующий ЧУЖОЙ attachToRegion() (сколь угодно позже) тихо дописался бы в уже "закрытую" запись

                // Зеркалим свежую органическую ноду в WI (решено с пользователем:
                // "по идее вся инфраструктура есть" — `lorebook.createEntry()`
                // уже полностью реализован, cores/lorebook/index.js). Область —
                // ТОЛЬКО создание (решено явно уточняющими вопросами, Этап 8 не
                // расширяет её на `update`): ручное создание в UI-редакторе,
                // импорт карточки персонажа и теперь уточнение уже известного
                // факта НЕ зеркалятся — тот контент и так виден пользователю
                // напрямую (форма создания, сама карточка, панель графа) или
                // уже был зеркалирован при СОЗДАНИИ этого узла. `disable: true` —
                // решено явно: граф УЖЕ инжектирует этот факт через
                // beacon+route+noise в `generation.beforeSend`; активная
                // WI-запись рисковала бы задвоить тот же факт в промпте через
                // нативную keyword-активацию ST поверх инъекции графа — запись
                // только видимая/редактируемая, не второй живой канал ретрива.
                // Отказ (нет активного Lorebook вообще, или сбой записи) НЕ
                // блокирует и не откатывает саму ноду — WI-запись лишь
                // зеркало, не источник истины для графа.
                const node = nodes[placed.nodeId];
                // stillSameChat() — Этап 5: между эмбедингом ноды выше и этой точкой был ещё один await (`readGameTime()`);
                // `lorebook.createEntry()` пишет в АКТИВНЫЙ Lorebook без явной привязки к чату — при смене чата ушло бы в
                // Lorebook уже нового чата с содержимым старого.
                if (node && stillSameChat(epoch)) {
                    const wiResult = await call('lorebook.createEntry', { patch: { comment: fact.label, content: fact.content, disable: true } });
                    if (wiResult.ok) { node.wiUid = wiResult.value.uid; node.wiBook = wiResult.value.book; }
                }
                results.push({ ...placed, label: fact.label, capacity: capacityInfo, structured: structuredInfo });
            }
            if (!results.length || results.every(entry => entry.status === 'skipped')) {
                if (results.length) await recordDecision({ clock: turnCounter, at: now(), gate: gateInfo, extractor: 'node', node: { id: null, label: results[0].label }, structured: results[0].structured });
                return { status: 'sidecar-empty' };
            } // все факты были update'ами на уже пропавшие узлы — реально ничего не изменилось

            // Журнал решений (Этап 6) — одна запись на ВЕСЬ check(), не на каждый факт (план просит запись именно
            // "на каждый check"); представляет её ПЕРВЫМ настоящим созданием, если оно было, иначе первым update —
            // тот же формат, что у Этапа 6 (единственный факт — самый частый случай — выглядит ИДЕНТИЧНО прежнему).
            const primary = results.find(entry => entry.status !== 'updated' && entry.status !== 'skipped') ?? results[0];
            // attachToRegion() (внутри placeNewNode) может завести запись в
            // mergeQueue/reconsolidationQueue (detectMergeCandidate/
            // tryQueueReconsolidation) — персистим ВСЕ пять хранилищ, не
            // только nodes/regions/staging, иначе такая запись переживает
            // только до следующей перезагрузки (реальный баг, найден при
            // добавлении ручного создания ноды).
            // Дальше до конца функции — больше НЕТ await модели/эмбединга (только персист уже посчитанного
            // результата и публикация событий), поэтому по букве П6 плана здесь `stillSameChat()` не нужен.
            // Осознанный остаточный пробел (Этап 5, не устранён специально): мутации выше уже СИНХРОННО применены
            // сразу после последней проверки каждого шага — если чат сменился именно в интервале между последним
            // `lorebook.createEntry()`/`applyNodeUpdate()` и этой строкой, персист ниже всё равно запишет данные
            // старого чата. Не устраняется в этом этапе: сам `reloadForActiveChat()` идёт через тот же
            // `enqueueWrite()`, то есть физически не может начать перезапись `nodes`/`regions` раньше, чем текущая
            // задача дойдёт до этой точки и положит свои персисты в очередь — гонка на диске исключена, остаётся
            // только "лишние/устаревшие данные старого чата в новом графе" — не хуже поведения ДО Этапа 5.
            const promotedCores = runCoreSweep(); // проверка после каждого размещения (этап 6 плана типов)
            await recordDecision({
                clock: turnCounter, at: now(), gate: gateInfo, extractor: 'node', node: { id: primary.nodeId, label: primary.label }, promotedCores: promotedCores.length ? promotedCores : undefined,
                structured: primary.structured ?? undefined,
                placement: primary.status === 'updated' ? undefined : { status: primary.status, reason: primary.reason, region: primary.region, similarity: primary.similarity, margin: primary.margin },
                capacity: primary.capacity ?? undefined,
            });
            await Promise.all([persistNodes(), persistRegions(), persistStaging(), persistMergeQueue(), persistReconsolidationQueue()]);
            for (const entry of results) {
                if (entry.status === 'skipped') continue;
                if (entry.status === 'updated') publishEvent('memoryGraph.nodeUpdated', { nodeId: entry.nodeId });
                else publishEvent('memoryGraph.nodeCreated', { nodeId: entry.nodeId, status: entry.status });
            }
            // Один факт (подавляющее большинство ходов, включая КАЖДЫЙ сегодняшний тест до Этапа 8) — форма
            // возврата БУКВАЛЬНО та же, что была до этого этапа (`{status, nodeId, ...}`, просто дополнительно
            // несёт `label`/`capacity` — лишние поля никому не мешают). Несколько фактов — новая форма, никакой
            // существующий вызывающий её сегодня не производит и не ожидает.
            return results.length === 1 ? results[0] : { status: 'placed', results };
        });
    }

    /**
     * Бутстрап пустого графа из УЖЕ АКТИВНОГО Lorebook игрока — LLM-driven
     * семантические регионы (решено с пользователем, MEMORY_GRAPH.md: старый
     * дартборд-бутстрап давал ~80% нод без единой связи). Три прогона
     * SideCar (весь Lorebook целиком видит модель, не по одной записи) +
     * эмбединг-присвоение остальных записей + региональные связи, плюс
     * УСЛОВНЫЙ четвёртый прогон (только если после всего этого + бэкбона
     * реально остались изолированные узлы — см. шаг 7.5 внутри), который
     * обязан связать их ВСЕХ, без права пропустить кого-то. Дартборд
     * (`vectorProbsForAllRegions`/`decideFirstPlacement`/`placeNewNode`) НЕ
     * трогается — он по-прежнему полностью обслуживает `checkAndPlace()`
     * (органический рост во время игры остаётся на нём, решено явно: цена
     * LLM здесь приемлема как разовая, не на каждый ход).
     */
    // Остановка построения по кнопке: флаг проверяется на каждом шаге прогресса и перед каждым вызовом модели (сам уже идущий вызов
    // прервать нельзя — остановка сработает, как только он вернётся). Уже построенное сохраняется (см. автосохранение ниже).
    const BOOTSTRAP_ABORTED = Symbol('memoryGraph.bootstrapAborted');
    let bootstrapAbort = false;
    let bootstrapActive = false;
    const AUTOSAVE_INTERVAL_MS = 4000;

    function persistEverything() {
        return Promise.all([persistNodes(), persistRegions(), persistStaging(), persistMergeQueue(), persistReconsolidationQueue()]);
    }

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
            let totalSteps = totalSummaries * 2 + 2 + estimatedRegions + 1 + 1; // читаем + размещаем по разу на запись, 2 общих LLM-прохода, Проход 3 по региону, условный Проход 4 связности (не больше одного вызова), финализация
            let doneSteps = 0;
            // Автосохранение по ходу построения (владелец: «сохранение в реальном времени без участия пользователя, на случай ошибок»):
            // раньше граф писался на диск только в самом конце, и сбой на середине терял всё уже построенное.
            let lastAutosaveAt = Date.now();
            let autosaving = false;
            const autosave = () => {
                if (autosaving || Date.now() - lastAutosaveAt < AUTOSAVE_INTERVAL_MS) return;
                autosaving = true;
                lastAutosaveAt = Date.now();
                persistEverything().catch(() => {}).finally(() => { autosaving = false; });
            };
            let succeeded = false;
            // Реальная жалоба пользователя: "после первого этапа bootstrap
            // не идут следующие... только один запрос к SideCar" — до этого
            // ЛЮБОЙ из шести `return false` ниже (звонок SideCar не удался,
            // ИЛИ ответ разобрался в пустой список) молча гасил весь
            // бутстрап, и `bootstrapFinished` нёс только `success: false`,
            // без единой зацепки, НА ЧЁМ именно всё остановилось. Теперь
            // причина ловится в `finally` и уходит и в консоль, и в само
            // событие — та же дисциплина, что уже была решена пользователем
            // для прогресса ("нет индикатора... это очень плохо").
            let failureReason = null;
            // `detail` — реальная жалоба пользователя: "прогресс бар довольно
            // мало информативный". Раньше — только имя фазы ("placing"),
            // теперь опциональная человекочитаемая строка с реальным счётом
            // ("computing embeddings (7/40)") — особенно важно ТЕПЕРЬ, когда
            // шаги ниже идут ПАРАЛЛЕЛЬНО (см. Promise.all): без счётчика
            // "сколько из скольких уже готово" пользователь видел бы только
            // "placing" неопределённое время, никак не отличая живой прогон
            // от зависшего.
            function tick(phase, detail = null) {
                if (bootstrapAbort) throw BOOTSTRAP_ABORTED;
                autosave();
                doneSteps = Math.min(doneSteps + 1, totalSteps);
                publishEvent('memoryGraph.bootstrapProgress', { done: doneSteps, total: totalSteps, phase, detail });
            }
            bootstrapAbort = false;
            bootstrapActive = true;
            publishEvent('memoryGraph.bootstrapStarted', { totalEntries: totalSummaries, totalSteps });

            try {
                // 1. Читаем ВСЕ записи целиком, БЕЗ немедленного размещения —
                // Проходу 1 нужен полный текст Lorebook сразу, не по одной
                // штуке. РАСПАРАЛЛЕЛЕНО (реальная жалоба: "построение занимает
                // нереально долго") — раньше каждый `lorebook.get()` ждал
                // предыдущий, хотя чтение ОДНОЙ записи никак не зависит от
                // чтения любой другой. Порядок готовности значения не имеет:
                // `rawEntries`/`entryByUid` строятся ПОСЛЕ, синхронно, каждая
                // строка Прохода 1/2 всё равно подписана СВОИМ `uid`, а не
                // позицией в массиве.
                let readDone = 0;
                const readResults = await Promise.all(summariesResult.value.map(async summary => {
                    const fullResult = await call('lorebook.get', { uid: summary.uid, book: summary.book });
                    readDone += 1;
                    tick('reading', `reading Lorebook (${readDone}/${totalSummaries})`);
                    return { summary, fullResult };
                }));
                // Активных Lorebook может быть несколько (lorebook.find отдаёт записи ВСЕХ источников: глобальные
                // книги, персонажа, чата, персоны) — uid уникален только внутри книги, поэтому номер записи в
                // промптах (`uid` ниже) назначается сквозным при коллизиях (assignBootstrapUids()).
                const readable = [];
                for (const { summary, fullResult } of readResults) {
                    if (!fullResult.ok) continue;
                    const entry = fullResult.value;
                    const content = String(entry.content ?? '').trim();
                    if (!content) continue; // пустая запись — нечего эмбедить и нечего класть в граф
                    readable.push({ summary, entry, content });
                }
                const promptUids = assignBootstrapUids(readable.map(item => item.summary.uid));
                const multipleBooks = new Set(readable.map(item => item.summary.book)).size > 1;
                const rawEntries = [];
                const entryByUid = new Map();
                readable.forEach(({ summary, entry, content }, index) => {
                    const label = String(entry.comment ?? '').trim() || `WI #${entry.uid}`;
                    const record = { uid: promptUids[index], label, content, raw: entry, ...(multipleBooks ? { book: summary.book } : {}) };
                    rawEntries.push(record);
                    entryByUid.set(record.uid, record);
                });
                if (!rawEntries.length) { failureReason = 'no-content: every Lorebook entry was empty or unreadable'; return false; }

                // Помощник для всех вызовов модели в Проходах 1-2 (одинаковый сэмплер/воркеры).
                const generateBootstrap = prompt => call('model.generate', { prompt, workerId: settings.workerId ?? undefined, maxTokens: settings.bootstrapMaxTokens, temperature: settings.bootstrapTemperature, reasoningMode: 'enabled', reasoningEffort: settings.bootstrapReasoningEffort, systemPrompt: BOOTSTRAP_SYSTEM_PROMPT, stallMs: settings.stallMs, fallbackWorkerIds: settings.fallbackWorkerIds });

                // Вызов чанка/сверки: одна повторная попытка на сбой вызова ИЛИ неразобранный JSON (маленькие вызовы
                // дешёвые, а потеря одного чанка = потеря его записей для структуры).
                async function generateJson(prompt) {
                    let lastError = null;
                    for (let attempt = 0; attempt < 2; attempt += 1) {
                        if (bootstrapAbort) throw BOOTSTRAP_ABORTED;
                        const result = await generateBootstrap(prompt);
                        if (!result.ok) { lastError = result.error?.message ?? 'call failed'; continue; }
                        const parsed = parseModelJson(result.value);
                        if (parsed !== undefined) return { ok: true, parsed };
                        lastError = 'reply was not valid JSON';
                    }
                    return { ok: false, error: lastError };
                }

                // 2-3. Проходы 1-2. Лорбук влезает в один чанк — как раньше, двумя вызовами по всему тексту.
                // Больше — чанкованный map-reduce (см. buildSkeletonPartPrompt() выше): ни одна запись не режется.
                const chunks = packEntriesIntoChunks(rawEntries, settings.bootstrapChunkTokens);
                if (chunks.length > 1) totalSteps += chunks.length * 2; // прикидка: по вызову на чанк в каждом из двух проходов

                // structured: пустой список базовых регионов (и не тронутое пользователем значение по умолчанию) — тематический режим:
                // регионы предлагает модель по темам лора (bootstrap-thematic.js). Явно заданные имена — прежний промпт.
                const legacyDefault = DEFAULT_SETTINGS.baseRegionNames;
                const untouched = settings.baseRegionNames.length === legacyDefault.length && settings.baseRegionNames.every((name, i) => name === legacyDefault[i]);
                const thematic = features.thematicBootstrap && (!settings.baseRegionNames.length || untouched);
                const baseNames = thematic ? [] : settings.baseRegionNames;
                const targetRegions = Math.min(settings.maxRegions, Math.max(1, Math.ceil(rawEntries.length / settings.entriesPerRegionCenter)));

                async function runSinglePasses() {
                    // 2. Проход 1 — базовый скелет (Locations/Main Characters/
                    // Factions или свои варианты) + 2 под-центра на каждый.
                    const promptEntries = fitEntriesToTokenBudget(rawEntries, settings.bootstrapMaxContextTokens);
                    const skeletonPrompt = thematic ? buildThematicSkeletonPrompt(promptEntries, targetRegions, settings.maxRegions) : buildRegionSkeletonPrompt(promptEntries, baseNames);
                    const skeletonResult = await call('model.generate', { prompt: skeletonPrompt, workerId: settings.workerId ?? undefined, maxTokens: settings.bootstrapMaxTokens, temperature: settings.bootstrapTemperature, reasoningMode: 'enabled', reasoningEffort: settings.bootstrapReasoningEffort, systemPrompt: BOOTSTRAP_SYSTEM_PROMPT, stallMs: settings.stallMs, fallbackWorkerIds: settings.fallbackWorkerIds });
                    tick('skeleton', `laying out regions from ${rawEntries.length} entries`);
                    if (!skeletonResult.ok) { failureReason = `Проход 1 (skeleton) call failed: ${skeletonResult.error?.message}`; return null; }
                    let skeletonRegions = parseRegionSkeletonResponse(parseModelJson(skeletonResult.value), rawEntries);
                    if (thematic) skeletonRegions = normalizeThematicRegions(skeletonRegions, settings.maxRegions);
                    if (!skeletonRegions.length) {
                        // Звонок УДАЛСЯ (skeletonResult.ok), но разбор дал пустой
                        // список — модель ответила не тем JSON'ом, который ждёт
                        // parseRegionSkeletonResponse() (не массив, нет валидных
                        // subCenterUids, и т.п.). Сырой ответ — в консоль целиком:
                        // единственный способ понять, ЧТО именно модель прислала.
                        failureReason = 'Проход 1 (skeleton) response parsed to zero usable regions';
                        console.warn(`[memoryGraph] bootstrap: ${failureReason}. Raw model reply:`, skeletonResult.value);
                        return null;
                    }

                    // 3. Проход 2 — центр для КАЖДОГО региона из Прохода 1, плюс
                    // новые регионы сверх них, до целевой плотности
                    // (entriesPerRegionCenter). Отказ здесь ТОЖЕ прерывает бутстрап
                    // целиком (решено с пользователем — как и Проход 1, не как
                    // мягкий откат Прохода 3 ниже).
                    const targetTotal = Math.max(skeletonRegions.length, Math.round(rawEntries.length / settings.entriesPerRegionCenter));
                    const centersPrompt = buildAdditionalCentersPrompt(promptEntries, skeletonRegions.map(region => region.name), targetTotal, settings.entriesPerRegionCenter);
                    const centersResult = await call('model.generate', { prompt: centersPrompt, workerId: settings.workerId ?? undefined, maxTokens: settings.bootstrapMaxTokens, temperature: settings.bootstrapTemperature, reasoningMode: 'enabled', reasoningEffort: settings.bootstrapReasoningEffort, systemPrompt: BOOTSTRAP_SYSTEM_PROMPT, stallMs: settings.stallMs, fallbackWorkerIds: settings.fallbackWorkerIds });
                    tick('centers', `targeting ~${targetTotal} region${targetTotal === 1 ? '' : 's'}`);
                    if (!centersResult.ok) { failureReason = `Проход 2 (centers) call failed: ${centersResult.error?.message}`; return null; }
                    const centerAssignments = parseAdditionalCentersResponse(parseModelJson(centersResult.value), rawEntries);
                    if (!centerAssignments.length) {
                        failureReason = 'Проход 2 (centers) response parsed to zero usable center assignments';
                        console.warn(`[memoryGraph] bootstrap: ${failureReason}. Raw model reply:`, centersResult.value);
                        return null;
                    }
                    return { skeletonRegions, centerAssignments };
                }

                async function runChunkedPasses() {
                    const validUids = new Set(rawEntries.map(entry => entry.uid));
                    const density = settings.entriesPerRegionCenter;

                    // Проход 1 — map (параллельно, очередь воркеров сама сериализует при одном воркере).
                    let doneSkeletonParts = 0;
                    const skeletonParts = await Promise.all(chunks.map(async (partEntries, index) => {
                        const outcome = await generateJson(thematic
                            ? buildThematicSkeletonPartPrompt({ partEntries, allEntries: rawEntries, partNumber: index + 1, partCount: chunks.length, targetRegions })
                            : buildSkeletonPartPrompt({ partEntries, allEntries: rawEntries, partNumber: index + 1, partCount: chunks.length, baseRegionNames: baseNames }));
                        doneSkeletonParts += 1;
                        tick('skeleton', `scanning lore, part ${doneSkeletonParts}/${chunks.length}`);
                        return outcome;
                    }));
                    const failedSkeleton = skeletonParts.find(part => !part.ok);
                    if (failedSkeleton) { failureReason = `Проход 1 (skeleton) part call failed: ${failedSkeleton.error}`; return null; }
                    const skeletonGroups = mergeCandidateGroups(
                        skeletonParts.map(part => parseCandidatesResponse(part.parsed, validUids, { allowedRegionNames: thematic ? null : baseNames, maxPerRegion: CHUNK_CANDIDATES_SKELETON })),
                        entryByUid, baseNames,
                    );
                    if (!skeletonGroups.length) { failureReason = 'Проход 1 (skeleton) parts produced zero usable candidates'; return null; }

                    // Проход 1 — reduce.
                    const skeletonReduce = trimCandidatesToBudget(skeletonGroups, settings.bootstrapChunkTokens);
                    if (skeletonReduce.trimmed) console.warn(`[memoryGraph] bootstrap: skeleton reduce trimmed ${skeletonReduce.trimmed} lowest-ranked candidate(s) to fit ${settings.bootstrapChunkTokens} tokens.`);
                    const skeletonOutcome = await generateJson(thematic ? buildThematicSkeletonReducePrompt(skeletonReduce.groups, targetRegions, settings.maxRegions) : buildSkeletonReducePrompt(skeletonReduce.groups, baseNames));
                    tick('skeleton', 'choosing region representatives');
                    if (!skeletonOutcome.ok) { failureReason = `Проход 1 (skeleton) reduce failed: ${skeletonOutcome.error}`; return null; }
                    let skeletonRegions = parseRegionSkeletonResponse(skeletonOutcome.parsed, rawEntries);
                    if (thematic) skeletonRegions = normalizeThematicRegions(skeletonRegions, settings.maxRegions);
                    if (!skeletonRegions.length) { failureReason = 'Проход 1 (skeleton) reduce parsed to zero usable regions'; console.warn(`[memoryGraph] bootstrap: ${failureReason}. Raw reply:`, skeletonOutcome.parsed); return null; }

                    // Проход 2 — map.
                    const existingRegionNames = skeletonRegions.map(region => region.name);
                    const targetTotal = Math.max(skeletonRegions.length, Math.round(rawEntries.length / density));
                    let doneCenterParts = 0;
                    const centerParts = await Promise.all(chunks.map(async (partEntries, index) => {
                        const outcome = await generateJson(buildCentersPartPrompt({ partEntries, allEntries: rawEntries, partNumber: index + 1, partCount: chunks.length, existingRegionNames, targetTotalRegions: targetTotal, entriesPerRegionCenter: density }));
                        doneCenterParts += 1;
                        tick('centers', `scanning lore for centers, part ${doneCenterParts}/${chunks.length}`);
                        return outcome;
                    }));
                    const failedCenter = centerParts.find(part => !part.ok);
                    if (failedCenter) { failureReason = `Проход 2 (centers) part call failed: ${failedCenter.error}`; return null; }
                    const centerGroups = mergeCandidateGroups(
                        centerParts.map(part => parseCandidatesResponse(part.parsed, validUids, { maxPerRegion: CHUNK_CANDIDATES_CENTERS })),
                        entryByUid, existingRegionNames,
                    );
                    if (!centerGroups.length) { failureReason = 'Проход 2 (centers) parts produced zero usable candidates'; return null; }

                    // Проход 2 — reduce (заодно склеивает одинаковые по смыслу новые регионы из разных чанков).
                    const centersReduce = trimCandidatesToBudget(centerGroups, settings.bootstrapChunkTokens);
                    if (centersReduce.trimmed) console.warn(`[memoryGraph] bootstrap: centers reduce trimmed ${centersReduce.trimmed} lowest-ranked candidate(s) to fit ${settings.bootstrapChunkTokens} tokens.`);
                    const centersOutcome = await generateJson(buildCentersReducePrompt(centersReduce.groups, existingRegionNames, targetTotal, density));
                    tick('centers', `targeting ~${targetTotal} region${targetTotal === 1 ? '' : 's'}`);
                    if (!centersOutcome.ok) { failureReason = `Проход 2 (centers) reduce failed: ${centersOutcome.error}`; return null; }
                    const centerAssignments = parseAdditionalCentersResponse(centersOutcome.parsed, rawEntries);
                    if (!centerAssignments.length) { failureReason = 'Проход 2 (centers) reduce parsed to zero usable center assignments'; console.warn(`[memoryGraph] bootstrap: ${failureReason}. Raw reply:`, centersOutcome.parsed); return null; }
                    return { skeletonRegions, centerAssignments };
                }

                const passes = chunks.length > 1 ? await runChunkedPasses() : await runSinglePasses();
                if (!passes) return false;
                const { skeletonRegions, centerAssignments } = passes;

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
                if (!finalRegionPlans.length) { failureReason = 'no region ended up with both a valid skeleton entry AND a valid center assignment — Проход 1/2 disagreed entirely'; return false; }

                function buildNodeFromEmbedding(entry, embedding) {
                    const node = {
                        id: makeId('node', now, random),
                        label: entry.label, content: entry.content, embedding,
                        importance: importanceFromLorebookEntry(entry.raw),
                        degree: 0, createdAt: now(), createdTurn: 0, lastTouchedTurn: turnCounter,
                        protectedNode: false, regionId: null, edges: [], gameTime: null,
                        source: 'lorebook', // Этап 6.1 плана
                    };
                    if (features.kinds) {
                        // structured: ключевые слова записи — псевдонимы ноды (по ним потом разрешаются субъекты); `constant` — сигнал для Core (этап 6).
                        const keys = Array.isArray(entry.raw?.key) ? entry.raw.key : [];
                        addAliases(node, keys.map(key => String(key ?? '').trim()));
                        if (entry.raw?.constant === true) node.constant = true;
                    }
                    return node;
                }

                function placeInRegion(node, regionName, forceRole) {
                    nodes[node.id] = node;
                    attachToRegionByKey(node, regionName, {
                        createRegion: () => ({ name: regionName, centerNodeId: null, subCenterIds: [], nodeIds: [], wordProfile: {} }),
                        forceRole,
                    });
                }

                // Предрешаем, КАКИЕ uid станут центром/под-центром — синхронно,
                // без единого эмбединга — чтобы посчитать эмбединги ВООБЩЕ ВСЕХ
                // участвующих записей (центры/под-центры шага 4 И обычные шага
                // 5) ОДНИМ параллельным батчем, а не по одной записи за раз
                // (реальная жалоба: "построение занимает нереально долго").
                // Порядок РАЗМЕЩЕНИЯ ниже (кто становится чем, в каком порядке
                // попадает в регион — важно для merge-detection/capacity)
                // НЕ меняется: меняется только КОГДА считается эмбединг —
                // заранее, не инлайново по ходу цикла.
                const preselectedUids = new Set();
                for (const region of finalRegionPlans) {
                    if (!preselectedUids.has(region.centerUid)) preselectedUids.add(region.centerUid);
                    for (const subUid of region.subCenterUids) {
                        if (!preselectedUids.has(subUid) && entryByUid.has(subUid)) preselectedUids.add(subUid);
                    }
                }
                const ordinaryEntries = rawEntries.filter(entry => !preselectedUids.has(entry.uid));
                const embedTargets = [...preselectedUids].map(uid => entryByUid.get(uid)).filter(Boolean).concat(ordinaryEntries);

                let embedDone = 0;
                const embeddingByUid = new Map();
                await Promise.all(embedTargets.map(async entry => {
                    const embeddingResult = await callService('embedding.compute', { text: `${entry.label}: ${entry.content}`, kind: 'passage' });
                    embedDone += 1;
                    tick('placing', `computing embeddings (${embedDone}/${embedTargets.length})`);
                    if (embeddingResult.ok) embeddingByUid.set(entry.uid, embeddingResult.value);
                }));

                // 4. Размещаем центры/под-центров — роль ЯВНАЯ (LLM уже решила),
                // не по порядку прибытия. Полностью синхронно теперь (эмбединги
                // уже готовы в `embeddingByUid`) — тот же порядок, что и раньше.
                const usedUids = new Set();
                const bootstrappedIds = [];
                for (const region of finalRegionPlans) {
                    if (usedUids.has(region.centerUid)) continue; // тот же uid уже занят другим регионом — не дублируем ноду
                    usedUids.add(region.centerUid);
                    const centerEmbedding = embeddingByUid.get(region.centerUid);
                    if (centerEmbedding) {
                        const centerNode = buildNodeFromEmbedding(entryByUid.get(region.centerUid), centerEmbedding);
                        placeInRegion(centerNode, region.name, 'center');
                        bootstrappedIds.push(centerNode.id);
                    }

                    for (const subUid of region.subCenterUids) {
                        if (usedUids.has(subUid) || !entryByUid.has(subUid)) continue;
                        usedUids.add(subUid);
                        const subEmbedding = embeddingByUid.get(subUid);
                        if (!subEmbedding) continue;
                        const subNode = buildNodeFromEmbedding(entryByUid.get(subUid), subEmbedding);
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
                    const embedding = embeddingByUid.get(entry.uid);
                    if (!embedding) continue;
                    const node = buildNodeFromEmbedding(entry, embedding);
                    const bestRegionName = pickNearestRegion(node.embedding, regionAnchors);
                    if (!bestRegionName) continue; // якорей нет вовсе (Проход 2 не дал ни одного валидного центра) — запись пропускается
                    placeInRegion(node, bestRegionName, 'ordinary'); // НЕ null — иначе подхватывает авто-детекцию под-центра по порядку вставки (реальный баг, см. attachToRegionByKey()'s doc-comment)
                    bootstrappedIds.push(node.id);
                }

                // 6. Проход 3 — связи ВНУТРИ каждого региона, по одному вызову
                // на регион. РАСПАРАЛЛЕЛЕНО (реальная жалоба: "построение
                // занимает нереально долго" — при десятке регионов это было
                // десять ПОСЛЕДОВАТЕЛЬНЫХ сетевых круговых рейсов подряд,
                // самая дорогая часть всего каскада). Безопасно: каждый регион
                // мутирует ТОЛЬКО рёбра СВОИХ СОБСТВЕННЫХ узлов — регионы по
                // определению не пересекаются по составу, гонки на запись
                // между двумя параллельными ветками нет физически. Отказ
                // здесь НЕ прерывает бутстрап — пропускает связи только для
                // ЭТОГО региона, остальные продолжаются (тот же принцип, что
                // у escalateToSideCar). Межрегиональные связи —
                // extractCharacterNames(), уже отработал внутри
                // attachToRegionByKey() выше, для КАЖДОЙ размещённой ноды.
                //
                // **Реальный потолок этого ускорения — число воркеров, не
                // Promise.all.** `dispatch-queue.js`'s `enqueue()` даёт
                // КАЖДОМУ воркеру исполнять ровно один запрос за раз, очередь
                // поглощает остальное (см. её doc-comment — решение "как в
                // Alpha", не случайность). С ОДНИМ воркером эти вызовы
                // сериализуются САМОЙ очередью независимо от того, что здесь
                // написано Promise.all — выигрыш от этого шага реален только
                // если у Графа настроено НЕСКОЛЬКО воркеров (или общий пул с
                // 2+ воркерами, если `workerId` не запинен на один конкретный).
                // Проверено сравнительным тестом (1 воркер vs 2) в
                // tests/memory-graph-orchestration.test.js.
                let linkDone = 0;
                await Promise.all(finalRegionPlans.map(async region => {
                    const liveRegion = regions[region.name];
                    if (!liveRegion || liveRegion.nodeIds.length < 2) {
                        linkDone += 1;
                        tick('linking', `linking regions (${linkDone}/${finalRegionPlans.length})`);
                        return;
                    }
                    const regionNodes = liveRegion.nodeIds.map(id => nodes[id]).filter(Boolean);
                    const edgesPrompt = buildRegionEdgesPrompt(regionNodes.map(node => ({ id: node.id, label: node.label, content: node.content })), { withKinds: features.kinds });
                    const edgesResult = await call('model.generate', { prompt: edgesPrompt, workerId: settings.workerId ?? undefined, maxTokens: settings.bootstrapMaxTokens, temperature: settings.bootstrapTemperature, reasoningMode: 'enabled', reasoningEffort: settings.bootstrapReasoningEffort, systemPrompt: BOOTSTRAP_SYSTEM_PROMPT, stallMs: settings.stallMs, fallbackWorkerIds: settings.fallbackWorkerIds });
                    linkDone += 1;
                    tick('linking', `linking regions (${linkDone}/${finalRegionPlans.length}) — "${region.name}"`);
                    if (!edgesResult.ok) return;
                    const edgesParsed = parseModelJson(edgesResult.value);
                    if (features.kinds) {
                        // structured: вид (сущность/объект) уточняется тем же вызовом; до рёбер — правило рёбер смотрит на виды.
                        for (const [id, value] of Object.entries(parseRegionKindsResponse(edgesParsed, regionNodes.map(node => ({ id: node.id }))))) {
                            if (nodes[id]) Object.assign(nodes[id], normalizeKind(value.kind, value.subtype));
                        }
                    }
                    const proposedEdges = parseRegionEdgesResponse(edgesParsed, regionNodes.map(node => ({ id: node.id })));
                    for (const edge of proposedEdges) {
                        const from = nodes[edge.from];
                        const to = nodes[edge.to];
                        if (!from || !to) continue;
                        if ((from.edges ?? []).some(existingEdge => existingEdge.to === to.id)) continue; // уже связаны (например, mentions выше)
                        if (!edgeAllowed(from, to)) continue;
                        from.edges = [...(from.edges ?? []), { to: to.id, type: 'related' }];
                        to.edges = [...(to.edges ?? []), { to: from.id, type: 'related' }];
                        from.degree = (from.degree ?? 0) + 1;
                        to.degree = (to.degree ?? 0) + 1;
                    }
                }));

                // 7. Бэкбон — ДО бонуса важности за связи ниже: досозданные
                // `backbone`-рёбра тоже должны учитываться в итоговой degree.
                // Гарантирует минимум связей ТОЛЬКО центрам/под-центрам —
                // обычные узлы им не затронуты вовсе (см. doc-comment
                // enforceBackboneConnectivity()), поэтому именно ПОСЛЕ него
                // проверка на шаге 7.5 ловит только реальный остаток, а не
                // то, что и так закрыл бы бэкбон.
                enforceBackboneConnectivity();

                // 7.5. Проверка связности + условный Проход 4 (жалоба
                // пользователя: Проход 3 выше НАМЕРЕННО необязателен —
                // "not every pair needs one", пустой массив тоже валидный
                // ответ, — а бэкбон только что отработал для
                // центров/под-центров, не для обычных узлов). Кто ОСТАЛСЯ
                // с degree:0 после всего этого — генуинно изолирован, и это
                // именно та "80% нод без единой связи" проблема Alpha, ради
                // которой весь LLM-бутстрап затевался. Один-единственный
                // досоздающий вызов на ВЕСЬ график (не по региону, как
                // Проход 3) — buildOrphanConnectionsPrompt() явно запрещает
                // модели пропустить хоть один запрошенный id, в отличие от
                // любого другого SideCar-промпта файла.
                const orphanIds = bootstrappedIds.filter(id => (nodes[id]?.degree ?? 0) === 0);
                if (orphanIds.length) {
                    const allBootstrappedNodes = bootstrappedIds.map(id => nodes[id]).filter(Boolean);
                    const connectPrompt = buildOrphanConnectionsPrompt(allBootstrappedNodes, orphanIds);
                    const connectResult = await call('model.generate', { prompt: connectPrompt, workerId: settings.workerId ?? undefined, maxTokens: settings.bootstrapMaxTokens, temperature: settings.bootstrapTemperature, reasoningMode: 'enabled', reasoningEffort: settings.bootstrapReasoningEffort, systemPrompt: BOOTSTRAP_SYSTEM_PROMPT, stallMs: settings.stallMs, fallbackWorkerIds: settings.fallbackWorkerIds });
                    tick('connecting');
                    // Отказ здесь НЕ прерывает бутстрап — тот же принцип,
                    // что у Прохода 3: граф уже целиком построен и рабочий
                    // без этого шага, оставшиеся изолированные узлы просто
                    // остаются как есть до следующего повода их тронуть.
                    if (connectResult.ok) {
                        const proposedEdges = parseOrphanConnectionsResponse(parseModelJson(connectResult.value), allBootstrappedNodes, orphanIds);
                        for (const edge of proposedEdges) {
                            const from = nodes[edge.from];
                            const to = nodes[edge.to];
                            if (!from || !to) continue;
                            if ((from.edges ?? []).some(existingEdge => existingEdge.to === to.id)) continue;
                            if (!edgeAllowed(from, to)) continue;
                            from.edges = [...(from.edges ?? []), { to: to.id, type: 'related' }];
                            to.edges = [...(to.edges ?? []), { to: from.id, type: 'related' }];
                            from.degree = (from.degree ?? 0) + 1;
                            to.degree = (to.degree ?? 0) + 1;
                        }
                    }
                } else {
                    tick('connecting'); // ничего звать не пришлось — шаг всё равно "рассмотрен", как и пропущенные регионы Прохода 3
                }

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
                if (features.core) { applyGraphMeta({ ...graphMeta, bootstrapCoreCount: Object.values(nodes).filter(isCore).length }); await persistGraphMeta(); }
                await call('storage.chatMemory.flush');
                publishEvent('memoryGraph.bootstrapped', { source: 'lorebook', nodeCount: Object.keys(nodes).length });
                succeeded = true;
                return true;
            } catch (error) {
                if (error === BOOTSTRAP_ABORTED) { failureReason = 'stopped by user — what was built so far is kept'; return false; }
                throw error;
            } finally {
                bootstrapActive = false;
                // Не дошли до конца (ошибка или остановка) — всё равно записываем, что успели построить.
                if (!succeeded) { try { await persistEverything(); await call('storage.chatMemory.flush'); } catch { /* сохранение — best effort */ } }
                if (!succeeded && failureReason) console.warn(`[memoryGraph] bootstrap stopped: ${failureReason}`);
                publishEvent('memoryGraph.bootstrapFinished', { success: succeeded, nodeCount: Object.keys(nodes).length, reason: failureReason });
            }
        });
    }

    /**
     * Прогон накопителя (MEMORY_GRAPH_FIX_PLAN.md, Этап 3 — ROADMAP 5.107в). Сначала — МИГРАЦИЯ: под новым
     * `decideFirstPlacement()` нода с реальным эмбедингом больше никогда не попадает в `staging` вовсе (см. её
     * doc-comment) — единственная причина видеть здесь запись с эмбедингом это ЗАПИСЬ ИЗ СТАРОЙ ВЕРСИИ графа (до
     * этого обновления), которую оставили висеть логит-доли из 15 регионов. Пробуем разместить её тем же правилом,
     * что и новую ноду — confident или nearest, лишь бы центр вообще был. Старое расписание ретрай/батч/таймаут/
     * эскалация (`decideStagingStep`) остаётся ТОЛЬКО для настоящего крайнего случая — ноды без эмбединга вовсе
     * (сегодня ни один вызывающий `placeNewNode()` до такого не доводит, задел на будущее). Зовётся из того же
     * прохода `generation.prepare`, что и `checkAndPlace`, но независимо от того, была ли эта генерация "сильным
     * изменением".
     */
    async function sweepStaging() {
        return enqueueWrite(async () => {
            // stillSameChat() — Этап 5 (ROADMAP 5.107д, П6 плана): сам цикл ниже синхронный (без await) до
            // возможного `escalateToSideCar()`, гонка возможна только вокруг него — см. проверку после неё.
            const epoch = chatEpoch;
            const entries = Object.values(staging);
            const batchReady = [];
            for (const entry of entries) {
                const node = nodes[entry.nodeId];
                if (!node) { delete staging[entry.nodeId]; continue; }

                const migrated = decideFirstPlacement({ nameMatchRegion: findNameMatchRegion(node.content), embedding: node.embedding, anchors: collectAnchors(), settings });
                if (migrated.status === 'placed') {
                    if (migrated.placementConfidence === 'low') node.placementConfidence = 'low';
                    attachToRegionDescriptor(node, migrated.region);
                    delete staging[entry.nodeId];
                    continue;
                }

                // Настоящее "эмбединга нет вовсе" — старое расписание, без изменений.
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
                    // НЕ удаляем из staging здесь — escalateToSideCar() сама решает её судьбу (Этап 3: ошибка
                    // модели не должна тихо терять ноду, запись обязана пережить неудавшуюся попытку как есть).
                    batchReady.push(entry);
                }
            }
            if (batchReady.length) await escalateToSideCar(batchReady);
            if (!stillSameChat(epoch)) return; // чат сменился внутри escalateToSideCar() — её мутации уже про чужой (новый) граф, не персистим их сюда
            // См. комментарий в checkAndPlace() — тот же attachToRegion() (и
            // выше, и внутри escalateToSideCar()) может завести запись в
            // mergeQueue/reconsolidationQueue.
            await Promise.all([persistNodes(), persistRegions(), persistStaging(), persistMergeQueue(), persistReconsolidationQueue()]);
        });
    }

    /**
     * "Совсем потеряшки" — батч на суждение полноценной LLM разом (MEMORY_GRAPH.md; MEMORY_GRAPH_FIX_PLAN.md,
     * Этап 3). `entries` — ЗАПИСИ накопителя, не голые ноды: при сбое модели их нужно оставить КАК БЫЛИ (раньше
     * ошибка `model.generate` тихо УДАЛЯЛА весь батч целиком, хотя запись к этому моменту уже была убрана из
     * `staging` вызывающим — временный сбой сети/модели не повод терять факт навсегда, он должен просто
     * попробовать снова на следующем `sweepStaging()`).
     */
    async function escalateToSideCar(entries) {
        // stillSameChat() — Этап 5 (ROADMAP 5.107д, П6 плана): эта функция сама по себе может ждать
        // `model.generate` секунды (батч на полноценную LLM), внутри которых чат может смениться.
        const epoch = chatEpoch;
        const batch = entries.map(entry => nodes[entry.nodeId]).filter(Boolean);
        for (const entry of entries) if (!nodes[entry.nodeId]) delete staging[entry.nodeId]; // нода пропала (эвикшен/слияние) между постановкой в батч и этим вызовом — запись устарела сама собой
        if (!batch.length) return;

        const listing = batch.map((node, i) => `${i + 1}. ${node.label}: ${node.content}`).join('\n');
        const prompt = `These ${batch.length} facts could not be automatically placed in the memory graph:\n\n${listing}\n\nFor each, reply with its number and either a short category label it clearly belongs to, or "DISCARD" if it fits nowhere. Format: one line per item, "N: label" or "N: DISCARD".`;
        const result = await call('model.generate', { prompt, workerId: settings.workerId ?? undefined, stallMs: settings.stallMs, fallbackWorkerIds: settings.fallbackWorkerIds });
        if (!stillSameChat(epoch)) return; // чат сменился, пока ждали модель — записи остаются в накопителе как есть, обработает уже НОВЫЙ граф своим прогоном
        // Сбой модели — записи ОСТАЮТСЯ в накопителе как есть (мы их не трогали выше) и попробуют на следующем
        // sweepStaging() — не удаляем (Этап 3, было наоборот: удаляло весь батч).
        if (!result.ok) return;

        // Phase 1: разбор ответа — по строкам "N: ...". "DISCARD" (без учёта регистра) — осознанное решение
        // модели, нода удаляется. Иначе метка сопоставляется с РЕАЛЬНЫМ регионом по сходству (Этап 3: раньше всё
        // безусловно сваливалось в регион 0:0) — эмбединг метки против центров, тот же `pickRegionBySimilarity`,
        // что и у обычного размещения; центров вообще нет или эмбединг не посчитался — тот же временный дом 0:0,
        // что и раньше (полноценный маппинг остаётся самым грубым краем Phase 1, отмечен явно, не скрыт).
        const lines = String(result.value ?? '').split('\n');
        for (const node of batch) {
            const line = lines.find(item => item.trim().startsWith(`${batch.indexOf(node) + 1}:`));
            const verdict = line?.split(':').slice(1).join(':').trim();
            if (!verdict || /^discard$/i.test(verdict)) { delete nodes[node.id]; delete staging[node.id]; continue; }

            const labelEmbeddingResult = await callService('embedding.compute', { text: verdict, kind: 'passage' });
            if (!stillSameChat(epoch)) return; // чат сменился посреди батча — оставшиеся записи (ещё в staging) достаются НОВОМУ графу, не трогаем их из-под старого
            const anchors = collectAnchors();
            const pick = labelEmbeddingResult.ok && anchors.length
                ? pickRegionBySimilarity(labelEmbeddingResult.value, anchors, { minSimilarity: settings.placementMinSimilarity, minMargin: settings.placementMinMargin })
                : null;
            attachToRegionDescriptor(node, pick?.region ?? { sector: 0, ring: 0 });
            delete staging[node.id];
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
            // stillSameChat() — Этап 5 (ROADMAP 5.107д, П6 плана): каждая пара ждёт свой SideCar-вызов и
            // эмбединг по отдельности — чат может смениться между парами или внутри одной.
            const epoch = chatEpoch;
            let changed = false;
            for (const [pairKey, entry] of Object.entries(mergeQueue)) {
                if (turnCounter - entry.queuedTurn < settings.mergeQueueMaxTurns) continue;
                delete mergeQueue[pairKey];
                changed = true;

                const nodeA = nodes[entry.nodeIdA];
                const nodeB = nodes[entry.nodeIdB];
                if (!nodeA || !nodeB) continue; // один уже пропал (эвикшен/другое слияние) — очередь устарела сама собой

                const verdict = await askSideCarForMerge(nodeA, nodeB);
                if (!stillSameChat(epoch)) return; // чат сменился — оставшиеся пары и уже сделанные здесь удаления из очереди не персистим, они про старый граф
                if (!verdict || verdict.distinct) continue; // SideCar не подтвердил — оба узла остаются как были

                const embeddingResult = await callService('embedding.compute', { text: `${verdict.label}: ${verdict.content}`, kind: 'passage' });
                if (!stillSameChat(epoch)) return; // чат сменился, пока ждали эмбединг слитой ноды
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
            // stillSameChat() — Этап 5 (ROADMAP 5.107д, П6 плана): то же самое, что у sweepMergeQueue() — каждый
            // кластер ждёт свой SideCar-вызов и эмбединг по отдельности.
            const epoch = chatEpoch;
            let changed = false;
            for (const [groupKey, entry] of Object.entries(reconsolidationQueue)) {
                if (turnCounter - entry.queuedTurn < settings.reconsolidationQueueMaxTurns) continue;
                delete reconsolidationQueue[groupKey];
                changed = true;

                const nodesToFold = entry.nodeIds.map(id => nodes[id]).filter(Boolean);
                if (nodesToFold.length !== entry.nodeIds.length) continue; // кто-то из кластера уже пропал — очередь устарела

                const verdict = await askSideCarForReconsolidation(nodesToFold);
                if (!stillSameChat(epoch)) return; // чат сменился — оставшиеся кластеры и уже сделанные здесь удаления из очереди не персистим, они про старый граф
                if (!verdict) continue; // SideCar не осилил — узлы остаются как были, не повторяем попытку

                const embeddingResult = await callService('embedding.compute', { text: `${verdict.label}: ${verdict.content}`, kind: 'passage' });
                if (!stillSameChat(epoch)) return; // чат сменился, пока ждали эмбединг свёрнутой ноды
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
     *
     * Реальный вопрос пользователя (после добавления `st.chatChanged` →
     * `reloadForActiveChat()`, п. 19): "регенерация начиналась ещё и сама
     * по себе. Оно не будет пересекаться?" — обоснованно. Изначальный
     * `load()`-бутстрап (при старте страницы) и `st.chatChanged`-бутстрап
     * (при смене чата) — ДВА независимых автоматических триггера, и оба
     * зовут именно эту функцию. Без защиты возможна гонка: оба видят
     * `Object.keys(nodes).length === 0` ДО того, как первый успел
     * положить хоть один узел (оба вызова стартуют, ни один ещё не дошёл
     * до своего первого `await` внутри `bootstrapFromLorebook()`) — и оба
     * реально запускают ПОЛНЫЙ LLM-бутстрап, дублируя весь граф (сама
     * `bootstrapFromLorebook()` НЕ проверяет "уже не пусто ли" внутри —
     * это осознанно: ручной debug-контракт `memoryGraph.bootstrapFromLorebook`
     * должен уметь пересобрать граф ДАЖE непустой, независимо от этой
     * авто-проверки, см. его собственный тест).
     *
     * Простой синхронный флаг, не `enqueueWrite()`: `bootstrapFromLorebook()`
     * САМА уже оборачивает себя в `enqueueWrite()` — вложенный
     * `enqueueWrite(() => ... await enqueueWrite(...) ...)` был бы
     * дедлоком (внешняя задача ждёт промис, который появится в очереди
     * только ПОСЛЕ того, как внешняя задача сама освободит очередь, а
     * освободить её раньше своего конца она не может). Флаг же ставится
     * СИНХРОННО, без единого `await` между проверкой и установкой — в
     * однопоточном JS это гарантированно атомарно относительно ЛЮБОГО
     * другого кода, включая второй параллельный вызов этой же функции.
     */
    let bootstrapInFlight = false;

    async function bootstrapIfEmpty() {
        // ВРЕМЕННО ОТКЛЮЧЕНО (решено с пользователем: "удали все, кроме
        // кнопки"/"не удаляй, просто закоменти") — автозапуск бутстрапа
        // (из `load()` при старте и из `reloadForActiveChat()` на
        // `st.chatChanged`) оказался ненадёжным триггером: расследование
        // показало, что `lorebook.books()` может вернуть непустой список
        // ДАЖЕ когда реальные данные текущего чата ещё не устаканились —
        // `resolveBookNames()` (libraries/core/lorebook-sources.js) кладёт
        // `snapshot.selectedWorldInfo` (ГЛОБАЛЬНО выбранный World Info в
        // настройках ST) в список активных книг БЕЗУСЛОВНО, независимо от
        // того, готов ли `chat_metadata` текущего чата — пользователь сам
        // верно предположил причину: "Может потому что LB выбран в
        // активных?". Расширение грузится по `jQuery(ready)`
        // (`index.js`), без гарантии, что ST уже закончила подгружать
        // РЕАЛЬНЫЙ активный чат к этому моменту — итог живьём: пустое
        // (ещё не прочитанное) `nodes` + глобально активный Lorebook =>
        // ложный "пустой граф, пора бутстрапить" и весь Lorebook улетает
        // в SideCar без спроса.
        //
        // На время расследования точного условия готовности чата —
        // ЕДИНСТВЕННЫЙ путь бутстрапа теперь ручная кнопка
        // ("bootstrapFromLorebook" в дебаг-блоке графового редактора,
        // `memoryGraph.bootstrapFromLorebook` контракт) — она зовёт
        // `bootstrapFromLorebook()` НАПРЯМУЮ, в обход этой функции,
        // так что продолжает работать без изменений.
        return;
        // eslint-disable-next-line no-unreachable
        if (bootstrapInFlight) return; // другой вызов уже решает/бутстрапит — не дублируем
        if (Object.keys(nodes).length > 0) return;
        bootstrapInFlight = true;
        try {
            await bootstrapFromLorebook();
        } finally {
            bootstrapInFlight = false;
        }
    }

    /**
     * Промис ТЕКУЩЕГО (или последнего) фонового бутстрапа/перезагрузки —
     * решено с пользователем: "зависание при bootstrap... вынеси его
     * отдельно". `load()` больше НЕ ждёт `bootstrapIfEmpty()` сама — при
     * большом Lorebook (десятки записей, у каждой свой вызов реальной
     * ONNX-модели эмбеддинга) это реально ДОЛГО, а `load()` до сих пор
     * awaited напрямую в `harness/engine-wiring.js`'s главной цепочке —
     * весь движок (панель, докер запуска) висел за ОДНИМ этим `await`,
     * пока бутстрап не закончится. Экспортируется как `waitForBootstrap()`
     * на возвращаемом объекте Ядра — тестам и любому коду, которому
     * ДЕЙСТВИТЕЛЬНО нужно дождаться результата (а не просто не блокировать
     * остальных), есть явный способ это сделать; `load()` этот промис сама
     * не ждёт.
     *
     * С добавлением `reloadForActiveChat()` (реакция на `st.chatChanged`,
     * см. её doc-comment) этот же промис накрывает и ПЕРЕЗАГРУЗКУ
     * настроек+состояния при смене чата, не только буквальный
     * первоначальный бутстрап — переприсваивается СИНХРОННО в обработчике
     * события (не внутри самой `reloadForActiveChat()`), так что
     * `waitForBootstrap()`, позванный сразу после смены чата, гарантированно
     * видит НОВЫЙ промис, а не устаревший от прошлого чата.
     */
    let bootstrapPromise = Promise.resolve();

    function waitForBootstrap() {
        return bootstrapPromise;
    }

    /**
     * Перечитывает настройки+состояние ТЕКУЩЕГО активного чата и триггерит
     * бутстрап, если он пуст — отдельная функция от `load()`, чтобы её
     * можно было звать ПОВТОРНО на `st.chatChanged`, не трогая
     * одноразовую регистрацию контракта/этапов пайплайна (см. `load()`).
     *
     * Реальный баг, найден живьём (жалоба пользователя): "при перезагрузке
     * и заходе в чат — граф строится заново с LLM, а не подгружается".
     * Причина — `load()` раньше звалась РОВНО ОДИН раз, при старте
     * страницы (`harness/engine-wiring.js`), и `nodes`/`regions`/... в
     * замыкании оставались тем, что было на тот момент, НАВСЕГДА — даже
     * когда пользователь переключался на другой чат уже ПОСЛЕ старта
     * страницы. `chatMetadata` у настоящей ST меняется под капотом на
     * каждый `st.chatChanged` (переключение чата — SPA-навигация, не
     * перезагрузка страницы, проверено по настоящему исходнику
     * `public/script.js`'s `eventSource.emit(event_types.CHAT_CHANGED, ...)`),
     * но БЕЗ этой подписки никто не говорил Ядру графа перечитать её
     * заново — старое состояние (пустое, если старт страницы застал
     * "нет чата"/чужой чат) молча оставалось висеть, и `bootstrapIfEmpty()`
     * при следующем удобном случае доверчиво считал его настоящим пустым
     * графом и перестраивал целиком через LLM, хотя у РЕАЛЬНОГО активного
     * чата persisted-граф мог всё это время спокойно лежать в его
     * `chatMetadata`. Тот же класс проблемы, что `cores/lorebook/index.js`
     * уже решило подпиской на `st.chatChanged` — здесь тот же приём.
     */
    /**
     * `loadSettings()`+`loadState()` идут ЧЕРЕЗ `enqueueWrite()` — та же
     * очередь, что и у `checkAndPlace()`/`bootstrapFromLorebook()`/ручного
     * CRUD. Без этого возможна гонка: `st.chatChanged` может прилететь,
     * пока предыдущий чат ещё дописывает свой ход (`checkAndPlace()` уже
     * стоит в очереди/выполняется) — `loadState()` присваивает
     * `nodes = <свежее из хранилища>` НАПРЯМУЮ, и если это происходит
     * ПОСЕРЕДИНЕ чужой мутации того же объекта, either половина изменений
     * теряется (перезаписана свежим чтением), либо чужая мутация продолжает
     * править уже ОТСОЕДИНЁННый от персиста объект. Через очередь —
     * `loadState()` гарантированно ждёт, пока предыдущая запись полностью
     * не осядет (включая её персист), и только потом читает.
     */
    async function loadStateEnqueued() {
        return enqueueWrite(async () => {
            await loadSettings();
            await loadState();
        });
    }

    async function reloadForActiveChat() {
        await loadStateEnqueued();
        // Граф другого чата загружен — панель графа перечитывает его сама (событие для неё; на `st.chatChanged` она бы опередила загрузку).
        publishEvent('memoryGraph.loaded', { nodeCount: Object.keys(nodes).length });
        await bootstrapIfEmpty().catch(error => {
            console.warn('[memoryGraph] background bootstrap failed:', error);
        });
    }

    let unsubscribeChatChanged = () => {};

    /**
     * Phase 2 — этап `generation.beforeSend`, живая мутация `chat` (тот же
     * приём, что `cores/summary/index.js`'s `injectIntoPrompt`/
     * `modules/tools/notebook.js`). Кандидаты в маяки — ТОЛЬКО размещённые
     * узлы (`regionId` не `null`): нода в накопителе невидима для ретрива
     * (решено в Phase 1). Мягкая деградация на каждом шаге (пустой граф,
     * пустой контекст, недоступный эмбединг, пустой маршрут) — `chat`
     * просто не трогается, генерация никогда не блокируется этим этапом.
     *
     * **Sticky balance** (решено с пользователем явно, прямой запрос: "не
     * руинить кэш-хиты"). Маршрут+шум пересчитывать заново на каждый ход
     * вслепую нельзя — `expandNoiseNodes()` сама по себе недетерминирована
     * (`Math.random()`), так что даже НЕИЗМЕННЫЙ набор маяков давал бы
     * РАЗНЫЙ текст блока каждый ход, рвя кэш провайдера без всякой пользы.
     * Поэтому ЗАКРЕПЛЯЕТСЯ не набор id, а буквально готовый ТЕКСТ прошлого
     * блока целиком — переиспользуется байт в байт, пока свежий
     * набор-кандидат не обгонит закреплённый по агрегированному счёту
     * (`scoreBeaconSet`/`shouldReplaceStickySet`) С ЗАПАСОМ. Обёрнуто в
     * `enqueueWrite` — теперь пишет `stickyRetrieval`, та же дисциплина,
     * что у остальных мутаций состояния этого Ядра.
     */
    async function injectIntoPrompt({ chat } = {}) {
        if (!Array.isArray(chat)) return true;
        return enqueueWrite(async () => {
            // stillSameChat() — Этап 5 (ROADMAP 5.107д, П6 плана, пункт 4): ждём эмбединг сцены ниже; если чат
            // сменился за это время, `stickyRetrieval`/`nodes` дальше — уже про НОВЫЙ чат, писать в них по
            // результатам старого нельзя (в частности перед `persistStickyRetrieval()` ниже).
            const epoch = chatEpoch;
            // Маяки — лор: событие (не Core) в кандидаты не идёт, оно подтягивается через ноды (timeline-prompt.js); Core-событие с регионом — может быть маяком.
            const candidates = Object.values(nodes).filter(node => node.regionId && !(features.eventsInRetrieval && isEvent(node) && !isCore(node)));
            if (!candidates.length) {
                const total = Object.keys(nodes).length;
                return skipRetrieval('no-placed-nodes', total ? `${total} node(s), none placed in a region (all unplaced)` : 'the graph is empty');
            }

            // Запрос — последние несколько сообщений, не одна реплика (beacons.js, ROADMAP 5.109).
            const contextText = recentQueryText(chat, 3) || extractLatestText(chat);
            if (!contextText.trim()) return skipRetrieval('empty-query', 'no message text to search with');
            const embeddingResult = await callService('embedding.compute', { text: contextText, kind: 'query' });
            if (!stillSameChat(epoch)) return skipRetrieval('chat-changed'); // мягкая деградация — просто не трогаем chat/stickyRetrieval этим проходом
            if (!embeddingResult.ok) return skipRetrieval('embedding-failed', embeddingResult.error?.message);
            const contextEmbedding = embeddingResult.value;
            if (!Array.isArray(contextEmbedding) || !contextEmbedding.length) return skipRetrieval('embedding-failed', 'the embedding service returned no vector');
            const withEmbedding = candidates.filter(node => Array.isArray(node.embedding) && node.embedding.length === contextEmbedding.length).length;
            if (!withEmbedding) return skipRetrieval('no-embeddings', `${candidates.length} placed node(s), none has an embedding of the same size (${contextEmbedding.length})`);

            // Маяки второй версии (beacons.js, ROADMAP 5.109): смысл первым, вес и защищённость — ограниченные бонусы, имя из сцены —
            // сильный бонус. Прежний pickBeacons() давал защищённым нодам бесконечный счёт — маяками всегда были первые центры бутстрапа.
            const freshBeaconIds = selectBeacons(candidates, contextEmbedding, {
                count: settings.beaconCount, queryText: contextText,
                weightOf: node => computeNodeWeight({ importance: node.importance, degree: node.degree, elapsed: elapsedTurnsFor(node), protectedNode: false, settings }),
            }).map(beacon => beacon.id);
            if (!freshBeaconIds.length) return skipRetrieval('no-beacons', `no node stood out among ${withEmbedding} candidate(s)`);

            if (!shouldRefreshSticky({
                sticky: stickyRetrieval, freshIds: freshBeaconIds, nodesById: nodes, contextEmbedding,
                stability: settings.retrievalStability, turn: turnCounter, maxAgeTurns: settings.retrievalMaxStickyTurns,
            })) {
                // Закреплённый блок побеждает — переиспользуем ЕГО ТЕКСТ как
                // есть, не трогая маршрут/шум заново (см. doc-comment выше).
                // Decay по факту использования (MEMORY_GRAPH_FIX_PLAN.md, Этап 7, ROADMAP 5.107ж) — sticky-блок
                // ВСЁ РАВНО реально уходит модели каждый ход, его маяки не должны стареть только потому, что сам
                // текст переиспользуется байт-в-байт (см. doc-comment у pickEvictionCandidate()). Только маяки, не
                // весь набор маршрут+шум прошлого прохода — план явно ограничивает это `beaconIds` (текст не
                // перепарсивается ради полного списка), то же поле, что уже хранится в `stickyRetrieval`.
                for (const id of stickyRetrieval.beaconIds) { if (nodes[id]) nodes[id].lastTouchedTurn = turnCounter; }
                await persistNodes();
                // Публикация ретрива (MEMORY_GRAPH_UI_PLAN.md, Этап 2, П3) — маршрута в памяти НЕТ (sticky
                // переиспользует готовый ТЕКСТ прошлого прохода, не пересчитывает route/noise заново), поэтому
                // переиздаём СОХРАНЁННЫЙ `lastRetrieval` с новым `at` и `sticky:true`, план явно просит именно так.
                // Мягкая деградация, если истории ещё нет вовсе (свежий процесс: `stickyRetrieval` пришёл из
                // хранилища и выиграл ДО первого свежего ретрива в этой сессии) — переиздавать нечего, пропускаем.
                if (lastRetrieval) {
                    const republished = { ...lastRetrieval, sticky: true, at: Date.now() };
                    recordRetrieval(republished);
                    publishEvent('memoryGraph.retrieved', republished);
                }
                const plotSticky = plotCoreMessage();
                if (plotSticky) chat.unshift({ is_user: false, is_system: true, name: 'Plot core', mes: plotSticky });
                chat.unshift({ is_user: false, is_system: true, name: 'Memory', mes: stickyRetrieval.text });
                return true;
            }

            // Дерево с неявной связью «входит в регион» (beacons.js, ROADMAP 5.109а) — цепочка по порядку рвалась на нодах без рёбер.
            // structured: маршрут, шум и основной блок — по слою лора (события, не Core, вынесены в секцию таймлайна ниже, чтобы не дублироваться шумом).
            const loreView = features.eventsInRetrieval ? Object.fromEntries(Object.entries(nodes).filter(([, node]) => !(isEvent(node) && !isCore(node)))) : nodes;
            const route = buildBeaconTree(loreView, freshBeaconIds, {
                maxHops: settings.routeMaxHops,
                centerOf: id => { const regionId = nodes[id]?.regionId; return regionId ? regions[regionId]?.centerNodeId ?? null : null; },
            });
            const routeNodeIds = [...new Set([...route.segments.flatMap(step => [step.from, step.to]), ...route.standalone])];
            const noise = expandNoiseNodes(loreView, routeNodeIds, { targetTotal: settings.retrievalTargetNodes, fanoutPerNode: settings.noiseFanoutPerNode, random });
            let text = renderMemoryPrompt({ ...route, noise }, loreView);
            if (!text) return true;
            if (features.eventsInRetrieval && settings.retrievalEventsMax > 0) {
                const involved = [...new Set([...routeNodeIds, ...noise.map(edge => edge.to)])];
                const timeline = buildTimelineSection(nodes, involved, { max: settings.retrievalEventsMax, excludeIds: new Set(involved) });
                if (timeline) text = `${text}\n\n${timeline}`;
            }

            // Decay по факту использования (Этап 7) + счётчики ретрива (MEMORY_GRAPH_UI_PLAN.md, Этап 2, П5) —
            // КАЖДЫЙ узел, реально попавший в готовый блок (маяки, маршрут, шум — тот же набор id, что
            // renderMemoryPrompt() выше уже включил в текст), помечается прочитанным СЕЙЧАС же, одним проходом по
            // уже посчитанным `routeNodeIds`/`noise`, без пересчёта. `retrievedCount`/`lastRetrievedAt` — мягко
            // добавляемые хранимые поля (у старых нод их нет, читаются как 0/null снаружи, см. `memoryGraph.nodes`);
            // `beaconCount` — ТОЛЬКО у самих маяков, отдельным проходом по `freshBeaconIds` (не всему набору).
            // Всё сохраняется ОДНИМ вызовом вместе с `stickyRetrieval` ниже — план прямо просит не заводить
            // отдельное сохранение на каждую ноду.
            const noiseIds = [...new Set(noise.map(edge => edge.to))];
            for (const id of new Set([...routeNodeIds, ...noiseIds])) {
                const node = nodes[id];
                if (!node) continue;
                node.lastTouchedTurn = turnCounter;
                node.retrievedCount = (node.retrievedCount ?? 0) + 1;
                node.lastRetrievedAt = Date.now();
            }
            for (const id of freshBeaconIds) { if (nodes[id]) nodes[id].beaconCount = (nodes[id].beaconCount ?? 0) + 1; }

            stickyRetrieval = { beaconIds: freshBeaconIds, text, turn: turnCounter };
            // Публикация ретрива (Этап 2, П3/П6) — тот же формат, что и в sticky-ветке выше, но с ПОСЧИТАННЫМИ
            // маршрутом/шумом (не переизданием старого). `query` обрезан до 200 символов — план явно ограничивает,
            // это подсказка для панели ("что искали"), не полный текст сцены.
            recordRetrieval({
                at: Date.now(), sticky: false,
                beaconIds: freshBeaconIds,
                segments: route.segments.map(({ from, to }) => ({ from, to })),
                standaloneIds: route.standalone,
                noiseIds,
                query: contextText.slice(0, 200),
            });
            await Promise.all([persistNodes(), persistStickyRetrieval()]);
            publishEvent('memoryGraph.retrieved', lastRetrieval);
            const plotFresh = plotCoreMessage();
            if (plotFresh) chat.unshift({ is_user: false, is_system: true, name: 'Plot core', mes: plotFresh });
            chat.unshift({ is_user: false, is_system: true, name: 'Memory', mes: text });
            return true;
        });
    }

    async function load() {
        await loadStateEnqueued();
        // Регистрация этапов пайплайна — БЫСТРАЯ, идёт ДО бутстрапа (раньше
        // шла после — бутстрап мог задержать даже это). Без неё граф вообще
        // не участвовал бы в генерации, даже с уже загруженными данными.
        await call('pipeline.stages.add', {
            pipelineId: PREPARE_PIPELINE,
            stage: { id: 'memory-graph:place', contract: CHECK_CONTRACT, params: { chat: { $from: '$input.chat' } }, onExhausted: 'flag' },
        });
        // Исключение внутри ретрива тоже видно в окне (ROADMAP 5.109б), а не только как «ретрива не было».
        host.own.register(INJECT_CONTRACT, params => injectIntoPrompt(params).catch(error => skipRetrieval('error', error?.message ?? String(error))));
        await call('pipeline.stages.add', {
            pipelineId: BEFORE_SEND_PIPELINE,
            stage: { id: INJECT_STAGE_ID, contract: INJECT_CONTRACT, params: { chat: { $from: '$input.chat' } }, onExhausted: 'flag' },
        });
        // Подписка на смену активного чата — РОВНО один раз, здесь (не в
        // `reloadForActiveChat()` самой — иначе на каждый `st.chatChanged`
        // заводили бы ЕЩЁ одну подписку поверх старой, они не заменяют друг
        // друга, см. `contract-bus.js`'s `register()`/`subscribe()`).
        // `reloadForActiveChat()`'s doc-comment — реальная жалоба
        // пользователя, которую эта подписка чинит.
        unsubscribeChatChanged = host.events.subscribe('st.chatChanged', () => {
            // ПЕРВОЙ строкой, синхронно (MEMORY_GRAPH_FIX_PLAN.md, Этап 5, ROADMAP 5.107д) — любая задача,
            // запущенная ДО этого события, проверяет `stillSameChat(epoch)` после каждого своего `await` и
            // обязана увидеть смену эпохи сразу, в том же тике, что и само событие, а не только после того, как
            // `reloadForActiveChat()` дойдёт до своего первого await.
            chatEpoch += 1;
            // История ретривов — ТОЛЬКО в памяти (MEMORY_GRAPH_UI_PLAN.md, Этап 2, П3/П6), про СТАРЫЙ чат теряет
            // смысл сразу же: обнуляем тем же синхронным шагом, что и `chatEpoch`, не дожидаясь reload.
            lastRetrieval = null;
            retrievalHistory = [];
            // Присвоено СИНХРОННО (не внутри reloadForActiveChat() самой) —
            // waitForBootstrap() должен увидеть НОВЫЙ промис сразу, в том
            // же тике, что и само событие, а не только после того, как
            // reloadForActiveChat() дойдёт до своего первого await.
            bootstrapPromise = reloadForActiveChat().catch(error => {
                console.warn('[memoryGraph] reload on chat change failed:', error);
            });
        });
        // Бутстрап — ПОСЛЕДНИМ и НЕ awaited здесь (решено с пользователем,
        // см. `waitForBootstrap()`'s doc-comment). Ошибка ловится и
        // логируется явно, не проглатывается молча и не улетает
        // необработанным отказом промиса.
        bootstrapPromise = bootstrapIfEmpty().catch(error => {
            console.warn('[memoryGraph] background bootstrap failed:', error);
        });
    }

    /** Публичный ручной прогон — тот же принцип, что `summary.check`: то же самое, что движок делает сам на каждой генерации, просто по требованию (например для UI/тестов). `chatLength` — см. `checkAndPlace()`. */
    async function manualCheck(contextText, chatLength) {
        const placement = await checkAndPlace(contextText, { chatLength });
        await sweepStaging();
        await sweepMergeQueue();
        await sweepReconsolidationQueue();
        await sweepTimeline();
        await sweepCores();
        return placement;
    }

    // Структурированная часть Ядра (structured/*): модули получают доступ к состоянию через геттеры (значения подменяются при
    // загрузке чата) и лениво вызывают функции Ядра — порядок объявления здесь не важен.
    const structuredCtx = {
        get nodes() { return nodes; }, get regions() { return regions; }, get staging() { return staging; }, get mergeQueue() { return mergeQueue; },
        get reconsolidationQueue() { return reconsolidationQueue; }, get settings() { return settings; }, get features() { return features; },
        get graphMeta() { return graphMeta; }, get turnCounter() { return turnCounter; }, get epoch() { return chatEpoch; },
        namespace: PERSISTENCE_NAMESPACE, backupKey: GRAPH_BACKUP_KEY, now: () => now(),
        setNodes: value => { nodes = value; },
        call: (...args) => call(...args), callService: (...args) => callService(...args), parseModelJson: value => parseModelJson(value),
        publishEvent: (...args) => publishEvent(...args), enqueueWrite: task => enqueueWrite(task), stillSameChat: epoch => stillSameChat(epoch),
        persistNodes: () => persistNodes(), persistRegions: () => persistRegions(), persistGraphMeta: () => persistGraphMeta(),
        applyGraphMeta: raw => applyGraphMeta(raw), collectAnchors: () => collectAnchors(), edgeAllowed: (a, b) => edgeAllowed(a, b),
        placeNewNode: (...args) => placeNewNode(...args), foldNodesInGraph: (...args) => foldNodesInGraph(...args),
    };
    const coreOps = createCoreOps(structuredCtx);
    const timelineOps = createTimelineOps(structuredCtx);
    const extractionOps = createExtractionOps(structuredCtx);
    const { promoteToCore, runCoreSweep, sweepCores, plotCoreMessage, pinNode } = coreOps;
    const { sweepTimeline } = timelineOps;
    const { knownSubjectNames, regionDescriptorOf, resolveFactSubjects, linkStructuredNode } = extractionOps;
    const { setModeForEmptyGraph, convertToStructured } = createModeOps(structuredCtx);
    const { reclassify } = createReclassifyOps(structuredCtx);

    const unregisters = [
        host.own.register('memoryGraph.settings', () => settings),
        host.own.register('memoryGraph.configure', params => configure(params ?? {})),
        host.own.register('memoryGraph.nodes', () => nodesForResponse()),
        host.own.register('memoryGraph.regions', () => regionsForResponse()),
        host.own.register('memoryGraph.mergeQueue', () => Object.values(mergeQueue)),
        host.own.register('memoryGraph.reconsolidationQueue', () => Object.values(reconsolidationQueue)),
        // Узлы, которые каскад НЕ смог уверенно разместить (см. placeNewNode()/
        // decideFirstPlacement()) — раньше были видны только внутри Ядра,
        // никакому UI/тесту нечем было отличить "узел завис в накопителе" от
        // "узел вообще не создался". Тот же принцип, что у mergeQueue/
        // reconsolidationQueue выше — сырой снимок очереди.
        host.own.register('memoryGraph.staging', () => Object.values(staging)),
        // Журнал решений (MEMORY_GRAPH_FIX_PLAN.md, Этап 6, ROADMAP 5.107е) — новейшие ПЕРВЫМИ (обратный порядок
        // вставки): панель/дебаг читают "что случилось только что", не "что случилось раньше всего".
        host.own.register('memoryGraph.decisionLog', () => [...decisionLog].reverse()),
        // История ретривов (MEMORY_GRAPH_UI_PLAN.md, Этап 2, П6) — уже в порядке "новейшие первыми"
        // (`recordRetrieval()` вставляет в начало), панели отдаётся как есть.
        host.own.register('memoryGraph.retrievals', () => retrievalHistory),
        host.own.register('memoryGraph.retrievalStatus', () => ({ lastRetrievalAt: lastRetrieval?.at ?? null, lastSkip: lastRetrievalSkip })),
        host.own.register('memoryGraph.lastRetrieval', () => lastRetrieval),
        host.own.register('memoryGraph.check', params => manualCheck(extractRecentText(params?.chat, { count: settings.extractionContextMessages, maxChars: settings.extractionContextChars }), params?.chat?.length)),
        // Ручное редактирование графа (UI-редактор) — CRUD нод/рёбер.
        host.own.register('memoryGraph.nodes.create', params => createNodeManually(params ?? {})),
        host.own.register('memoryGraph.nodes.createFromCharacterCard', () => createNodeFromCharacterCard()),
        host.own.register('memoryGraph.nodes.update', params => updateNodeManually(params ?? {})),
        host.own.register('memoryGraph.nodes.delete', params => deleteNodeManually(params ?? {})),
        host.own.register('memoryGraph.nodes.move', params => moveNodeManually(params ?? {})),
        host.own.register('memoryGraph.edges.create', params => createEdgeManually(params ?? {})),
        host.own.register('memoryGraph.edges.delete', params => deleteEdgeManually(params ?? {})),
        host.own.register('memoryGraph.reset', () => resetGraph()),
        host.own.register('memoryGraph.mode', () => ({ mode: graphMeta.mode, features, meta: graphMeta })),
        host.own.register('memoryGraph.setMode', params => setModeForEmptyGraph(params?.mode)),
        host.own.register('memoryGraph.convertToStructured', () => convertToStructured()),
        // "Вызов любой функции вручную" (решено с пользователем) — тонкие
        // обёртки над уже существующими оркестрационными операциями.
        host.own.register('memoryGraph.checkAndPlace', params => checkAndPlace(String(params?.text ?? ''))),
        host.own.register('memoryGraph.sweepStaging', () => sweepStaging()),
        host.own.register('memoryGraph.nodes.pin', params => pinNode(params ?? {})),
        host.own.register('memoryGraph.reclassify', () => reclassify()),
        host.own.register('memoryGraph.sweepCores', () => sweepCores()),
        host.own.register('memoryGraph.sweepTimeline', () => sweepTimeline()),
        host.own.register('memoryGraph.sweepMergeQueue', () => sweepMergeQueue()),
        host.own.register('memoryGraph.sweepReconsolidationQueue', () => sweepReconsolidationQueue()),
        host.own.register('memoryGraph.sweepBackbone', () => sweepBackbone()),
        // `includeCard` — после построения из Lorebook добавить ещё и ноду из карточки персонажа (для персонажей, которых нет в Lorebook).
        host.own.register('memoryGraph.bootstrapFromLorebook', async params => {
            const built = await bootstrapFromLorebook();
            if (built && params?.includeCard) await createNodeFromCharacterCard();
            return built;
        }),
        host.own.register('memoryGraph.bootstrapAbort', () => { const running = bootstrapActive; if (running) bootstrapAbort = true; return { ok: true, running }; }),
    ];

    return {
        load, waitForBootstrap,
        checkAndPlace, sweepStaging, sweepMergeQueue, sweepReconsolidationQueue, injectIntoPrompt,
        // Автозапуск бутстрапа временно отключён (см. `bootstrapIfEmpty()`'s
        // doc-comment) — ручной путь (`memoryGraph.bootstrapFromLorebook`
        // контракт, дебаг-кнопка редактора) продолжает работать напрямую,
        // экспортирован и здесь для того же прямого доступа из тестов.
        bootstrapFromLorebook,
        settings: () => settings,
        nodes: () => nodesForResponse(),
        regions: () => regionsForResponse(),
        staging: () => Object.values(staging),
        mergeQueue: () => Object.values(mergeQueue),
        reconsolidationQueue: () => Object.values(reconsolidationQueue),
        decisionLog: () => [...decisionLog].reverse(), // Этап 6 — тот же порядок (новейшие первыми), что у контракта `memoryGraph.decisionLog`
        retrievals: () => retrievalHistory, // MEMORY_GRAPH_UI_PLAN.md, Этап 2 — тот же порядок, что у контракта `memoryGraph.retrievals`
        lastRetrieval: () => lastRetrieval,
        unregister: async () => {
            await call('pipeline.stages.remove', { pipelineId: PREPARE_PIPELINE, stageId: 'memory-graph:place' }).catch(() => {});
            await call('pipeline.stages.remove', { pipelineId: BEFORE_SEND_PIPELINE, stageId: INJECT_STAGE_ID }).catch(() => {});
            unsubscribeChatChanged();
            for (const unregister of unregisters) unregister();
        },
    };
}

/** `injectIntoPrompt()`'s поисковый запрос — намеренно ТОЛЬКО последнее сообщение (MEMORY_GRAPH_FIX_PLAN.md, Этап 1: план явно требует не трогать эту логику). В отличие от извлечения фактов (`extractRecentText()`, context-text.js), здесь текст — ключ для поиска УЖЕ существующих нод по смыслу, а не сырьё для СОЗДАНИЯ новых: то, что игрок только что написал, а не хвост диалога. */
function extractLatestText(chat) {
    if (!Array.isArray(chat) || !chat.length) return '';
    return String(chat[chat.length - 1]?.mes ?? '');
}
