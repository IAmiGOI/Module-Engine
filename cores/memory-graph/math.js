/**
 * Чистая математика графа памяти — MEMORY_GRAPH_FIX_PLAN.md, Этап 9 (необязательный, ROADMAP 5.107и): перенесена
 * из верха `cores/memory-graph/index.js` БЕЗ ИЗМЕНЕНИЯ ПОВЕДЕНИЯ (план явно требует "только перенос кода") — файл
 * был огромным (~3500 строк), а эти функции не держат никакого состояния движка, только считают. `index.js`
 * реэкспортирует их отсюда (`export { … } from './math.js'`), чтобы ничьи существующие импорты (в частности —
 * тестов) не пришлось трогать.
 *
 * Состав — регионы дартборда, логиты размещения, decay-веса, объединение почти-дубликатов, маяки+маршрут+шум
 * (Phase 2), каскад размещения новой ноды. Настройки движка (`DEFAULT_SETTINGS`/`clampGraphSettings`) — тоже
 * здесь: почти каждая математическая функция ссылается на них как значение по умолчанию для своих параметров.
 */

import { cosineSimilarity } from '../../libraries/core/embedding.js';
import { pickRegionBySimilarity } from './placement.js';

export const SECTORS = 5;
export const RINGS = 3;

// Тот же набор значений, что REASONING_EFFORTS в internal-engine.js — не
// импортируем оттуда напрямую (Ядра друг друга не знают, только через
// Гейты), просто дублируем закрытый список валидных значений для клэмпа.
const BOOTSTRAP_REASONING_EFFORTS = ['low', 'medium', 'high'];

// Sticky balance ретрива (решено с пользователем явно: "не даём
// настраиваемые параметры для этого напрямую. Просто три значения. Often ->
// Balanced -> Sticky") — три готовые точки вместо одного откручиваемого
// числа, тот же принцип, что SAMPLER_PRESETS/TIME_PRESETS в другом месте
// движка. Во сколько раз свежий набор-кандидат обязан ПРЕВЗОЙТИ
// агрегированный счёт закреплённого набора, чтобы вытеснить его ЦЕЛИКОМ —
// см. shouldReplaceStickySet(). Не откалиброванные протоколом числа, как и
// другие некалиброванные пороги в этом файле (mergeWordOverlapThreshold и
// т.п.) — первый проход, подлежит эмпирической подстройке.
export const RETRIEVAL_STABILITY_LEVELS = ['often', 'balanced', 'sticky'];
export const RETRIEVAL_STABILITY_MARGINS = Object.freeze({ often: 1.02, balanced: 1.15, sticky: 1.4 });

export const DEFAULT_SETTINGS = Object.freeze({
    // Множитель адаптивного порога "сильного изменения" — MEMORY_GRAPH.md:
    // порог НЕ фиксированный, подстраивается под разброс расстояний внутри
    // ОДНОГО графа (бегущее среднее+стандартное отклонение). `k` — то, на
    // сколько стандартных отклонений отличие должно превысить среднее.
    thresholdK: 1.5,
    // `w` в формуле логитов региона (вектор + keyword) — MEMORY_GRAPH.md.
    keywordWeight: 1,
    // Сколько последних сообщений чата (и какой их суммарный хвост в символах) уходит на извлечение фактов —
    // MEMORY_GRAPH_FIX_PLAN.md, Этап 1 (ROADMAP 5.107а). До этого извлечение видело ТОЛЬКО последнее сообщение —
    // на `generation.prepare` это всегда реплика игрока, не ответ модели. 4 сообщения — обычно реплика игрока + ответ
    // модели с запасом на реролл/короткие фразы; 3000 символов — щедро для десятка строк диалога, но не пустит в
    // промпт извлечения содержимое на порядки больше самой сцены.
    extractionContextMessages: 4,
    extractionContextChars: 3000,
    // Пороги размещения по сходству (`cores/memory-graph/placement.js`) — MEMORY_GRAPH_FIX_PLAN.md, Этап 3
    // (ROADMAP 5.107в). СТАРТОВЫЕ числа, не откалиброванные по реальным данным — план явно требует уточнить их
    // позже по журналу решений (Этап 6, пока не реализован); `minSimilarity` — по нижней границе живых чисел E5
    // из самого разбора бага (0.85–0.95 у ВСЕХ регионов разом, не только у похожего), `minMargin` — сознательно
    // маленький: с E5 отрыв между реально разными темами редко бывает большим, лучше ошибиться в сторону "похоже
    // не значит уверенно" (даёт reason:'nearest' вместо 'similarity'), чем никогда не набирать нужный запас.
    placementMinSimilarity: 0.8,
    placementMinMargin: 0.02,
    // Окно забывания фильтра «сильного изменения» (`cores/memory-graph/gate.js`) — MEMORY_GRAPH_FIX_PLAN.md, Этап 4
    // (ROADMAP 5.107г). Старый Уэлфорд копил среднее/σ за ВСЮ историю без забывания — типичные расстояния падают
    // по мере роста графа, а порог держался на старых больших значениях, гейт постепенно замолкал (П5). EWMA с
    // окном ~30 наблюдений забывает выбросы геометрически, не тянет их вечно.
    gateWindow: 30,
    // Страховочное извлечение — сколько СООБЩЕНИЙ (см. clock.js, Этап 2) подряд без единого вызова модели
    // допустимо, прежде чем спросить её принудительно, даже если фильтр молчит (гейт тоже может застояться на
    // ложном "всё привычно" — вторая, независимая от EWMA страховка). `0` — выключено; иначе — не меньше 2.
    forcedExtractionEvery: 12,
    // Каскад накопителя — числа согласованы с пользователем дословно. `stagingRetryTurns`/`stagingMaxTurns`
    // УДВОЕНЫ относительно исходных значений (MEMORY_GRAPH_FIX_PLAN.md, Этап 2, ROADMAP 5.107б): единица "хода"
    // раньше была ГЕНЕРАЦИЕЙ (`turnCounter += 1` на каждый `checkAndPlace()`), теперь — СООБЩЕНИЕМ (длина чата,
    // см. clock.js) — одна генерация это обычно 2 сообщения (реплика игрока + ответ модели), так что то же
    // реальное время теперь считается вдвое большим числом "ходов". `stagingBatchSize` — число НОД, не ходов,
    // единицы не касаются, не трогаем.
    stagingRetryTurns: 10,
    stagingBatchSize: 5,
    stagingMaxTurns: 40,
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
    // постановки в очередь, потом решить. Удвоено вместе с остальными
    // "ходовыми" числами (см. комментарий у stagingRetryTurns выше).
    mergeQueueMaxTurns: 16,
    // Реконсолидация мелких записей (третий, последний механизм переполнения,
    // решено с пользователем): ПЕРЕД вытеснением при переполнении сначала
    // пробуем сжать кластер СЛАБЕЙШИХ незащищённых узлов региона в один,
    // через СВОЮ SideCar-очередь (тот же приём, что у объединения дублей —
    // не блокирует вставку). `reconsolidationMinCluster` — и порог "стоит
    // ли вообще сжимать" (не тратим вызов модели на 1-2 узла), и одновременно
    // размер самого кластера — тот же принцип, что `stagingBatchSize` у
    // накопителя.
    reconsolidationMinCluster: 3,
    // Удвоено вместе с остальными "ходовыми" числами (см. комментарий у stagingRetryTurns выше).
    reconsolidationQueueMaxTurns: 16,
    // Тот же класс бага, что у бутстрапа (см. `bootstrapMaxTokens` ниже) —
    // без явного maxTokens `askSideCarForReconsolidation()` падал на
    // движковый дефолт 1000 (жалоба пользователя). Один компрессированный
    // JSON-факт заметно короче бутстраповской многорегиональной структуры,
    // поэтому потолок скромнее.
    reconsolidationMaxTokens: 2000,
    // Веса decay-формулы. "Время" и "недавность" из MEMORY_GRAPH.md
    // сведены в ОДНУ экспоненциальную кривую по прошедшему времени
    // (gameTime с фолбэком на число сообщений) — это была одна и та же ось,
    // описанная дважды при брейнсторме, не два независимых сигнала. Удвоено
    // вместе с остальными "ходовыми" числами (см. комментарий у
    // stagingRetryTurns выше) — было 20 ГЕНЕРАЦИЙ, теперь 40 СООБЩЕНИЙ, то
    // же самое реальное время.
    decayHalfLifeTurns: 40,
    importanceWeight: 1,
    degreeWeight: 1,
    // Phase 2 — маяки+маршрут (MEMORY_GRAPH.md, решено с пользователем).
    // Изначально было 3 маяка на ход — поднято до 5 (решено с пользователем
    // явно, вторым заходом на ретрив: "как выберем пять нод-маяков"), отбор —
    // релевантность (косинус к контексту) ПЛЮС вес важности
    // (`computeNodeWeight()`, "не менее подцентра региона" — слабый/забытый
    // узел не должен побеждать по одной лишь тематической близости).
    // `beaconWeightFactor` — множитель веса в комбинированном счёте, тот же
    // принцип, что `keywordWeight` у логитов региона.
    beaconCount: 5,
    beaconWeightFactor: 1,
    // Маршрут — цепочка маяк0→маяк1→маяк2→... по СУЩЕСТВУЮЩИМ рёбрам
    // (кратчайший путь, без Steiner-дерева). `routeMaxHops` — защита от
    // патологически длинного пути в разросшемся графе, не эмпирический
    // параметр дизайна, а простой предохранитель.
    routeMaxHops: 6,
    // Шумные ответвления — ВТОРОЙ заход (решено с пользователем явно, тремя
    // уточняющими вопросами): раньше был ОДИН плоский слой соседей маршрута,
    // жадно набираемый по бюджету СИМВОЛОВ. Теперь — МНОГОШАГОВАЯ экспансия
    // (`expandNoiseNodes()`): с каждого узла ТЕКУЩЕГО фронта берём
    // `noiseFanoutPerNode` соседей (гауссов счёт `gaussianRandom()`, лучшие
    // по счёту), они становятся СЛЕДУЮЩИМ фронтом, и так далее — пока общее
    // число узлов (маяки+маршрут+шум) не достигнет `retrievalTargetNodes`
    // (~20) или пока фронт не иссякнет раньше цели (это нормальный исход,
    // не ошибка — граф вокруг маршрута мог оказаться меньше). Бюджет ТЕПЕРЬ
    // чисто по КОЛИЧЕСТВУ узлов, не по символам — решено с пользователем
    // явно: "убрать совсем — только количество нод" (символьный лимит
    // подряд мог давать очень разный по фактическому охвату промпт в
    // зависимости от длины content'а попавшихся узлов).
    retrievalTargetNodes: 24,
    noiseFanoutPerNode: 2,
    // Sticky balance (решено с пользователем явно, прямой запрос: "каждая
    // нода закрепляется с прошлого прогона... новые ноды выдаются только
    // если они подходят СИЛЬНЕЕ... и не по отдельности, а весь блок...
    // чтобы не руинить кэш-хиты"). `injectIntoPrompt()` не пересчитывает
    // маяки+маршрут+шум заново вслепую на каждый ход — весь ПРОШЛЫЙ блок
    // (буквально тот же рендер) переживает ход, пока свежий набор-кандидат
    // не обгонит его агрегированный счёт с запасом RETRIEVAL_STABILITY_MARGINS
    // (см. выше) — иначе кэш провайдера рвался бы от статистического шума
    // на каждом ходу без всякой пользы. `often` — низкий запас, блок
    // меняется охотно; `sticky` — высокий запас, блок держится, пока
    // сцена/тема разговора не изменится реально ощутимо.
    retrievalStability: 'balanced',
    // Закреплённый блок живёт не дольше стольких ходов подряд, даже если сцена почти не менялась (beacons.js).
    retrievalMaxStickyTurns: 12,
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
    // Режим НОВЫХ графов (MEMORY_GRAPH_TYPES_PLAN.md, этап 0): 'legacy' | 'structured'. До конца этапов 1–8 плана — legacy;
    // потом отдельным коммитом станет 'structured'. Существующие чаты не затрагивает: их режим хранится в самом графе (`graphMeta`).
    defaultGraphMode: 'legacy',
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
    // Потолок КОНТЕКСТА (в токенах), который уходит в модель при бутстрапе лорбука (0 — без ограничения). Записи ужимаются пропорционально.
    bootstrapMaxContextTokens: 0,
    // Размер ТЕКСТА записей в одном чанке (токены) для Проходов 1-2 бутстрапа
    // (0 — не чанковать). Лорбук больше этого бюджета режется НА ВЫЗОВЫ, не
    // на текст: каждая запись уходит модели целиком (решено с пользователем:
    // "около 6к за чанк", "без малейших потерь"). Индекс всех меток и промпт
    // едут сверху бюджета. Лорбук, влезающий в один чанк, идёт как раньше.
    bootstrapChunkTokens: 10000,
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
    // Stall-restart + fallback (прямой запрос пользователя, продолжение уже
    // введённого в cores/models/internal-engine.js механизма: "если за 5
    // секунд ничего не пришло — перезапускать, плюс авто-fallback на другие
    // сайдкары"). У Графа памяти самые длинные и самые дорогие звонки во
    // всём движке — Проходы 1-4 бутстрапа шлют ВЕСЬ Lorebook целиком — и до
    // этого шага не имели НИКАКОЙ защиты от зависания посреди стрима, кроме
    // самого факта стриминга (он включён по умолчанию у `model.generate`,
    // но `stallMs`/`fallbackWorkerIds` там осознанно opt-in — Граф их
    // просто никогда не запрашивал).
    // ИСПРАВЛЕНО (реальный баг, жалоба пользователя: "вылезает ошибка по
    // таймауту на первом проходе"): изначально здесь стояло 5000мс — число,
    // взятое прямо из формулировки пользователя для самого МЕХАНИЗМА
    // (`internal-engine.js`, ROADMAP 5.33), но та формулировка была про
    // короткие звонки трекера/саммари, а не про Проходы бутстрапа. Проход
    // 1-4 шлёт ВЕСЬ Lorebook целиком с `reasoningMode: 'enabled'` — модель
    // может думать МНОГО дольше 5 секунд, прежде чем отдать хоть один
    // чанк, и таймер стойки взводится ещё ДО ответа заголовков (см.
    // doc-comment `dispatchStreamingRequest()` в services/http.js: "весь
    // путь одним таймером — от отправки запроса"), так что каждый прогон
    // ложно ловил "stream stalled" на честно работающем, просто небыстром
    // звонке. 60000мс — с большим запасом на реальное время раздумья
    // reasoning-модели над крупным промптом, при этом всё ещё ловит
    // настоящее зависание (сервер не ответил вовсе).
    stallMs: 60000,
    fallbackWorkerIds: [],
});

function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
}

/** Тот же защитный клэмп, что у остальных `DEFAULT_SETTINGS` в движке — ручная правка файла настроек не должна осесть как есть. */
export function clampGraphSettings(values = {}) {
    return {
        defaultGraphMode: values.defaultGraphMode === 'structured' ? 'structured' : 'legacy',
        thresholdK: clampInt(values.thresholdK * 10, 1, 100, DEFAULT_SETTINGS.thresholdK * 10) / 10,
        keywordWeight: clampInt(values.keywordWeight * 10, 0, 100, DEFAULT_SETTINGS.keywordWeight * 10) / 10,
        extractionContextMessages: clampInt(values.extractionContextMessages, 1, 20, DEFAULT_SETTINGS.extractionContextMessages),
        extractionContextChars: clampInt(values.extractionContextChars, 500, 12000, DEFAULT_SETTINGS.extractionContextChars),
        placementMinSimilarity: clampInt(values.placementMinSimilarity * 100, 0, 100, DEFAULT_SETTINGS.placementMinSimilarity * 100) / 100,
        placementMinMargin: clampInt(values.placementMinMargin * 100, 0, 50, DEFAULT_SETTINGS.placementMinMargin * 100) / 100,
        gateWindow: clampInt(values.gateWindow, 5, 500, DEFAULT_SETTINGS.gateWindow),
        // `0` — осознанно допустимое значение ("выключить страховку", тот же приём, что у `stallMs` ниже) —
        // clampInt(..., 2, ...) сам по себе пропустил бы её мимо диапазона, поэтому 0 проверяется явно раньше.
        forcedExtractionEvery: values.forcedExtractionEvery === 0 ? 0 : clampInt(values.forcedExtractionEvery, 2, 200, DEFAULT_SETTINGS.forcedExtractionEvery),
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
        reconsolidationMaxTokens: clampInt(values.reconsolidationMaxTokens, 100, 100000, DEFAULT_SETTINGS.reconsolidationMaxTokens),
        decayHalfLifeTurns: clampInt(values.decayHalfLifeTurns, 1, 2000, DEFAULT_SETTINGS.decayHalfLifeTurns),
        importanceWeight: clampInt(values.importanceWeight * 10, 0, 100, DEFAULT_SETTINGS.importanceWeight * 10) / 10,
        degreeWeight: clampInt(values.degreeWeight * 10, 0, 100, DEFAULT_SETTINGS.degreeWeight * 10) / 10,
        beaconCount: clampInt(values.beaconCount, 1, 20, DEFAULT_SETTINGS.beaconCount),
        beaconWeightFactor: clampInt(values.beaconWeightFactor * 10, 0, 100, DEFAULT_SETTINGS.beaconWeightFactor * 10) / 10,
        routeMaxHops: clampInt(values.routeMaxHops, 1, 50, DEFAULT_SETTINGS.routeMaxHops),
        retrievalTargetNodes: clampInt(values.retrievalTargetNodes, 1, 200, DEFAULT_SETTINGS.retrievalTargetNodes),
        noiseFanoutPerNode: clampInt(values.noiseFanoutPerNode, 1, 20, DEFAULT_SETTINGS.noiseFanoutPerNode),
        retrievalStability: RETRIEVAL_STABILITY_LEVELS.includes(values.retrievalStability) ? values.retrievalStability : DEFAULT_SETTINGS.retrievalStability,
        retrievalMaxStickyTurns: clampInt(values.retrievalMaxStickyTurns, 1, 500, DEFAULT_SETTINGS.retrievalMaxStickyTurns),
        baseRegionNames: Array.isArray(values.baseRegionNames) && values.baseRegionNames.length
            ? values.baseRegionNames.map(name => String(name).trim()).filter(Boolean)
            : DEFAULT_SETTINGS.baseRegionNames,
        entriesPerRegionCenter: clampInt(values.entriesPerRegionCenter, 1, 200, DEFAULT_SETTINGS.entriesPerRegionCenter),
        bootstrapMaxContextTokens: clampInt(values.bootstrapMaxContextTokens, 0, 2000000, DEFAULT_SETTINGS.bootstrapMaxContextTokens),
        bootstrapChunkTokens: clampInt(values.bootstrapChunkTokens, 0, 2000000, DEFAULT_SETTINGS.bootstrapChunkTokens),
        bootstrapMaxTokens: clampInt(values.bootstrapMaxTokens, 100, 200000, DEFAULT_SETTINGS.bootstrapMaxTokens), // потолок ВЫШЕ, чем у clampSamplerSettings() в internal-engine.js (32768) — там граница под обычный чат-сэмплер, бутстрапу реально нужно больше на настоящем лорбуке
        bootstrapTemperature: clampInt(values.bootstrapTemperature * 100, 0, 200, DEFAULT_SETTINGS.bootstrapTemperature * 100) / 100,
        bootstrapReasoningEffort: BOOTSTRAP_REASONING_EFFORTS.includes(values.bootstrapReasoningEffort) ? values.bootstrapReasoningEffort : DEFAULT_SETTINGS.bootstrapReasoningEffort,
        workerId: values.workerId ?? null,
        // 0 — осознанно допустимое значение ("выключить стойку", тот же
        // смысл, что falsy `stallMs` у internal-engine.js: `stallMs ||
        // undefined`) — clampInt(..., 0, ...) уже пропускает 0 как есть.
        stallMs: clampInt(values.stallMs, 0, 120000, DEFAULT_SETTINGS.stallMs),
        fallbackWorkerIds: Array.isArray(values.fallbackWorkerIds)
            ? values.fallbackWorkerIds.map(id => String(id).trim()).filter(Boolean)
            : DEFAULT_SETTINGS.fallbackWorkerIds,
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

/**
 * Расстояние = 1 − максимальный НАСТОЯЩИЙ косинус между эмбедингом и любым из
 * `candidateEmbeddings` (0 — совпадение, 1 — ортогонально; отрицательные
 * косинусы зажаты, чтобы расстояние не выходило за [0,1]). Нет кандидатов —
 * 1 ("полностью неизвестно"). Раньше `checkAndPlace()` считал расстояние по
 * долям softmax по 15 регионам (`vectorProbs`, сумма = 1) — те почти
 * константны и сигнала "что-то изменилось" не несут.
 */
export function nearestEmbeddingDistance(embedding, candidateEmbeddings) {
    let best = -1;
    for (const candidate of candidateEmbeddings) {
        if (!candidate) continue;
        best = Math.max(best, cosineSimilarity(embedding, candidate));
    }
    return best < 0 ? 1 : 1 - Math.min(1, best);
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
 * каждый `{id, importance, degree, protectedNode, createdTurn, lastTouchedTurn}`.
 * `lastTouchedTurn` (Этап 7) — если есть, возраст для decay считается от НЕГО, не от `createdTurn`: недавно
 * прочитанная (попавшая в промпт) нода не должна стареть только потому, что давно создана. Чистая
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
            // MEMORY_GRAPH_FIX_PLAN.md, Этап 7 (ROADMAP 5.107ж) — decay по факту ИСПОЛЬЗОВАНИЯ, не только создания:
            // нода, недавно попавшая в промпт (маяк/маршрут/шум, см. `injectIntoPrompt()`), не должна стареть только
            // потому, что давно СОЗДАНА, если её реально продолжают читать. `?? member.createdTurn` — старые ноды до
            // этого этапа (без `lastTouchedTurn`) ведут себя как раньше, ничего не мигрирует задним числом.
            elapsed: Math.max(0, turnCounter - (member.lastTouchedTurn ?? member.createdTurn ?? turnCounter)),
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
        elapsed: Math.max(0, turnCounter - (node.lastTouchedTurn ?? node.createdTurn ?? turnCounter)), // Этап 7 — см. doc-comment у pickEvictionCandidate()
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

// --- Sticky balance ретрива (MEMORY_GRAPH.md / решено с пользователем
// явно) — не вариация pickBeacons(), а отдельный слой ПОВЕРХ него:
// решает, стоит ли вообще МЕНЯТЬ прошлый набор маяков на свежий, целиком,
// одним да/нет на весь блок сразу. ------------------------------------

/**
 * Агрегированная РЕЛЕВАНТНОСТЬ целого набора маяков текущему контексту —
 * сумма чистого косинуса (сдвинутого в [0,1], тот же приём, что у
 * `scoreBeaconCandidate()`), а НЕ полный `scoreBeaconCandidate()`.
 * Намеренно: важность/защищённость уже сделали своё дело при ПЕРВОНАЧАЛЬНОМ
 * отборе `pickBeacons()` (и для закреплённого, и для свежего набора) — этот
 * счёт отвечает только на вопрос "подходит ли СЦЕНА сильнее", не
 * переоценивает важность заново. Суммировать полный счёт было бы реальным
 * багом: защищённый узел даёт `Infinity`, и стоит ему попасть в ОБА
 * набора (закреплённый и свежий — а он туда почти всегда попадает, раз
 * `pickBeacons()` всегда выбирает защищённые первыми) — сравнение
 * `Infinity > Infinity * margin` вырождается в `false` всегда, набор
 * замерзает НАВСЕГДА независимо от реальной смены темы.
 *
 * `null`, если ХОТЬ ОДНОЙ ноды из набора больше нет в графе (`nodesById` —
 * слияние/эвикшн/ручное удаление сделали ссылку "висячей") — набор
 * невалиден ЦЕЛИКОМ, латать один слот вместо всего блока не имеет смысла
 * (см. `shouldReplaceStickySet()`).
 */
export function scoreBeaconSet(nodeIds, nodesById, contextEmbedding) {
    let total = 0;
    for (const id of nodeIds) {
        const node = nodesById[id];
        if (!node) return null;
        total += (cosineSimilarity(contextEmbedding, node.embedding) + 1) / 2;
    }
    return total;
}

/**
 * Решение "держим закреплённый набор или переключаемся на свежий ЦЕЛИКОМ".
 * `stickyScore` — `null` (первый ход вообще без закреплённого набора, ИЛИ
 * висячая ссылка внутри него, см. `scoreBeaconSet()`) всегда отдаёт
 * свежий немедленно, без всякого сравнения. Иначе — свежий побеждает,
 * ТОЛЬКО если его счёт СТРОГО превосходит закреплённый с запасом
 * `RETRIEVAL_STABILITY_MARGINS[stability]` — "не так же", а именно
 * СИЛЬНЕЕ (решено с пользователем явно: "если весь новый блок ретрива
 * целиком совпадает лучше, а не также. То мы меняем"); равный или почти
 * равный счёт — не повод рвать кэш ради статистического шума.
 */
export function shouldReplaceStickySet({ stickyScore, freshScore, stability = 'balanced' }) {
    if (stickyScore === null || stickyScore === undefined) return true;
    const margin = RETRIEVAL_STABILITY_MARGINS[stability] ?? RETRIEVAL_STABILITY_MARGINS.balanced;
    return freshScore > stickyScore * margin;
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

// --- Шумные ответвления от маршрута — многошаговая экспансия --------------
// ВТОРОЙ заход на ретрив (решено с пользователем явно, три уточняющих
// вопроса): "как выберем пять нод-маяков. Строим маршрут между ними. Затем
// по шуму берём несколько соседних от каждой точки маршрута подключений.
// Потом шум применяем к ним и так далее. Пока не соберётся около 20 нод."
// Раньше был ОДИН плоский слой соседей маршрута, жадно набираемый по
// бюджету СИМВОЛОВ (400). Теперь — ИТЕРАТИВНОЕ расширение фронта: с каждого
// узла ТЕКУЩЕГО фронта берём `noiseFanoutPerNode` соседей (по гауссову
// счёту), они становятся СЛЕДУЮЩИМ фронтом — и так далее, пока не наберётся
// `retrievalTargetNodes` (маяки+маршрут+шум ВМЕСТЕ) или фронт не иссякнет
// раньше цели (нормальный исход — граф вокруг маршрута может быть меньше
// цели, не ошибка). Бюджет ТЕПЕРЬ чисто по КОЛИЧЕСТВУ узлов, символьный
// лимит убран совсем (решено явно пользователем).

/** Box-Muller — стандартная нормальная выборка (mean 0, stddev 1) из инжектированного `random()`, тем же приёмом, что `makeId()` уже использует `random`/`now` для тестируемости. */
export function gaussianRandom(random = Math.random) {
    const u1 = Math.max(random(), Number.EPSILON); // log(0) — недопустим
    const u2 = random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * `routeNodeIds` — узлы, УЖЕ на маршруте (сегменты+standalone) — входят в
 * `targetTotal` с самого начала (не набираются заново) и не набираются как
 * шум повторно. Каждый РАУНД: для каждого узла ТЕКУЩЕГО фронта — кандидаты
 * это соседи ПО РЕБРУ, ведущие НАРУЖУ уже принятого набора; гауссов счёт
 * каждому, берём топ-`fanoutPerNode` ИМЕННО ЭТОГО узла (не глобальный топ-N
 * по всему раунду — иначе один "богатый" узел фронта забрал бы всю квоту
 * раунда, обделив остальных). Принятые в этом раунде узлы становятся
 * фронтом СЛЕДУЮЩЕГО раунда — так шум расходится вглубь графа, а не только
 * на одно ребро от маршрута. Один и тот же узел не берётся дважды, даже
 * достижимый от нескольких разных узлов фронта.
 *
 * Возвращает плоский список рёбер `{from, to, type}` — `from` может быть
 * ЛЮБЫМ уже принятым узлом (маршрутным ИЛИ шумовым из предыдущего раунда),
 * это и есть многошаговость; `renderMemoryPrompt()` уже рендерит рёбра
 * шума общим списком независимо от того, откуда они, правок не потребовалось.
 */
export function expandNoiseNodes(nodesById, routeNodeIds, { targetTotal = DEFAULT_SETTINGS.retrievalTargetNodes, fanoutPerNode = DEFAULT_SETTINGS.noiseFanoutPerNode, random = Math.random } = {}) {
    const included = new Set(routeNodeIds);
    const accepted = [];
    let frontier = [...routeNodeIds];

    while (frontier.length && included.size < targetTotal) {
        const nextFrontier = [];
        for (const id of frontier) {
            if (included.size >= targetTotal) break;
            const candidates = (nodesById[id]?.edges ?? [])
                .filter(edge => !included.has(edge.to) && nodesById[edge.to])
                .map(edge => ({ from: id, to: edge.to, type: edge.type, score: gaussianRandom(random) }))
                .sort((a, b) => b.score - a.score);

            let takenForThisNode = 0;
            for (const candidate of candidates) {
                if (takenForThisNode >= fanoutPerNode || included.size >= targetTotal) break;
                if (included.has(candidate.to)) continue; // уже принят ДРУГИМ узлом этого же раунда
                included.add(candidate.to);
                accepted.push({ from: candidate.from, to: candidate.to, type: candidate.type });
                nextFrontier.push(candidate.to);
                takenForThisNode += 1;
            }
        }
        frontier = nextFrontier;
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
        // Маршрут бывает деревом (buildBeaconTree): новый путь начинается строкой с той ноды, от которой он отходит.
        let chain = null;
        let previousTo = null;
        for (const step of route.segments) {
            if (!chain || step.from !== previousTo) {
                if (chain) lines.push(chain.join(' '));
                chain = [nodesById[step.from]?.label ?? step.from];
            }
            chain.push(`-[${step.type}]-> ${nodesById[step.to]?.label ?? step.to}`);
            previousTo = step.to;
        }
        if (chain) lines.push(chain.join(' '));
    }
    for (const edge of noise) {
        lines.push(`${nodesById[edge.from]?.label ?? edge.from} -[${edge.type}]-> ${nodesById[edge.to]?.label ?? edge.to} (noise)`);
    }
    lines.push(...detailLines);
    return lines.join('\n');
}

// --- Каскад размещения ноды --------------------------------------------
// MEMORY_GRAPH_FIX_PLAN.md, Этап 3 (ROADMAP 5.107в) — переписан порядок:
// маяки (Phase 2, здесь всегда []) → связь по имени → сходство к центру
// региона (уверенно — сразу туда; неуверенно, но центры есть — всё равно
// туда, лучший, помечен низкой уверенностью) → пустой граф — сеять 0:0 →
// накопитель остаётся ТОЛЬКО для ноды без эмбединга вовсе (см. её
// doc-comment ниже). Старый каскад "логиты по всем 15 регионам → накопитель
// при слабом отрыве" (`pickConfidentRegion`/`computeRegionLogits`) отправлял
// в накопитель почти КАЖДУЮ ноду — у реальных эмбедингов (E5) сходство ко
// ВСЕМ регионам разом близко (~0.85–0.95), полуторакратный отрыв почти
// никогда не набирался (П2 плана, живые числа из его разбора).

/** Явный ли отрыв у победителя логит-распределения — оставлена для decideStagingStep()'s настоящего крайнего случая (нода без эмбединга, см. sweepStaging()) и своих тестов; из decideFirstPlacement() больше не зовётся. */
export function pickConfidentRegion(regionProbs, regionCoords, { marginRatio = 1.5 } = {}) {
    if (!regionProbs.length) return null;
    const indexed = regionProbs.map((p, i) => ({ p, coord: regionCoords[i] })).sort((a, b) => b.p - a.p);
    const [best, second] = indexed;
    if (!second || best.p >= (second.p || 1e-12) * marginRatio) return best.coord;
    return null;
}

/**
 * Один шаг каскада для НОВОЙ ноды. Чистая функция — вся математика уже посчитана снаружи (найден ли тёзка по
 * имени, готовы ли анкеры центров), здесь только решение "куда её девать".
 *
 * `beaconRegion` — Phase 2 (маяки), в Phase 1 всегда `null`, шаг пропускается — сигнатура уже готова, чтобы не
 * переделывать функцию позже. `anchors` — регионы С ЦЕНТРОМ (`pickRegionBySimilarity()`'s формат, placement.js);
 * пустой массив — граф без единого центра, буквально НОЛЬ информации (не "слабый сигнал", который стоит защитить
 * от порчи центроида накопителем) — сразу сеять регион 0:0, тот же "временный дом", что уже используется у
 * `escalateToSideCar()`. `embedding` отсутствует ВООБЩЕ (не должно случаться ни у одного сегодняшнего вызывающего
 * `placeNewNode()` — все они получают эмбединг ДО вызова и падают раньше при его отсутствии, задел на будущее) —
 * единственный оставшийся случай `staged`: без вектора нечего сравнивать вовсе, здесь бессилен даже "лучший из
 * плохих".
 */
export function decideFirstPlacement({ beaconRegion = null, nameMatchRegion = null, embedding = null, anchors = [], settings = DEFAULT_SETTINGS }) {
    if (beaconRegion) return { status: 'placed', region: beaconRegion, reason: 'beacon' };
    if (nameMatchRegion) return { status: 'placed', region: nameMatchRegion, reason: 'name-match' };
    if (!embedding) return { status: 'staged', reason: 'no-embedding' };
    if (!anchors.length) return { status: 'placed', region: { sector: 0, ring: 0 }, reason: 'bootstrap-seed' };
    const pick = pickRegionBySimilarity(embedding, anchors, { minSimilarity: settings.placementMinSimilarity, minMargin: settings.placementMinMargin });
    if (pick.confident) return { status: 'placed', region: pick.region, reason: 'similarity', similarity: pick.similarity, margin: pick.margin };
    // Неуверенно, но центры ЕСТЬ — всё равно размещаем в лучший по сходству (П2 плана: накопитель почти никогда не
    // должен быть первой реакцией на "не идеально уверен"), просто помечаем ноду как малоуверенную — видно
    // снаружи (панель/журнал решений Этапа 6), не скрыто молча внутри решения.
    return { status: 'placed', region: pick.region, reason: 'nearest', similarity: pick.similarity, margin: pick.margin, placementConfidence: 'low' };
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

export function makeId(prefix, now, random) {
    return `${prefix}_${now().toString(36)}_${random().toString(36).slice(2, 8)}`;
}

export function extractCharacterNames(text) {
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
