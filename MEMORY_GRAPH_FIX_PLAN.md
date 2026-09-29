# План: почему граф памяти плохо сохраняет новые ноды — и как это починить

Документ для исполнителя. Читай целиком перед началом. Работай **строго по этапам, по порядку**; после каждого этапа — `npm test` зелёный, коммит.
Если что-то в коде не совпадает с описанием ниже (номера строк сдвинулись, функция переименована) — ищи по имени функции, а не по номеру строки.
Если расхождение существенное (функции нет вообще, логика другая) — **остановись и опиши расхождение**, не придумывай.

---

## 0. Контекст

### Где код
- Ядро графа: `cores/memory-graph/index.js` (~3100 строк; внутри `createMemoryGraphCore(host, …)` — всё состояние и логика).
- Чистые функции графа — там же, вверху файла, экспортируются (`isStrongChange`, `computeNodeWeight`, `pickConfidentRegion`, `decideFirstPlacement`, `decideStagingStep`, …).
- Проектный документ: `MEMORY_GRAPH.md` — прочитай разделы про размещение (каскад, накопитель), decay, порог «сильного изменения».
- Тесты: `tests/memory-graph-core.test.js` (чистые функции), `tests/memory-graph-orchestration.test.js` (настоящий движок, Ядро целиком), `tests/memory-graph-panel.test.js` (окно).
  **Перед началом прочитай оба первых файла** — там готовые помощники для сборки движка с фейковой моделью и эмбеддингом; новые тесты пиши по их образцу.

### Как граф растёт сейчас (органический путь)
1. На каждой генерации пайплайн `generation.prepare` зовёт контракт `memoryGraph.check` с `chat` (копия истории ST на момент отправки).
2. Обработчик: `manualCheck(extractLatestText(params.chat))` → `checkAndPlace(text)` → `sweepStaging()` → очереди слияния/реконсолидации.
3. `checkAndPlace`:
   - `turnCounter += 1`;
   - эмбеддинг текста (`embedding.compute`, kind `query`);
   - **фильтр «сильного изменения»**: расстояние до ближайшего центра региона и до ближайшей ноды; `isStrongChange(distance, stats, thresholdK)` = `distance > mean + 1.5·σ`, статистика — Уэлфорд за ВСЮ историю;
   - если фильтр не сработал — выход `no-change`;
   - иначе `askSideCarForNode(text)` → модель отвечает JSON `{label, content, importance}` или `{skip:true}`;
   - эмбеддинг ноды (kind `passage`), `placeNewNode` → `decideFirstPlacement` → `attachToRegion` или **накопитель** (`staging`);
   - зеркалирование в WI (`lorebook.createEntry`), сохранение пяти хранилищ в `storage.chatMemory`.
4. `sweepStaging` повторяет размещение застрявших нод по «ходам»; через `stagingRetryTurns + stagingMaxTurns` или при `stagingBatchSize` нодах — `escalateToSideCar(batch)`.

### Найденные причины (от главной к второстепенной)

**П1. Граф не читает ответы модели.** `extractLatestText(chat)` берёт только `chat[chat.length - 1].mes`. На `generation.prepare` последнее сообщение — это **новая реплика пользователя**; ответ модели (где и появляются факты мира) не попадает в извлечение никогда.

**П2. Уверенного размещения почти не бывает → ноды уходят в накопитель.**
`vectorProbsForAllRegions` берёт сходства `(cos+1)/2` (у E5 это ~0.85–0.95 для всех регионов) и **нормирует делением на сумму**. `computeRegionLogits` делает softmax от `ln(prob)`, что возвращает те же пропорции. `pickConfidentRegion` требует, чтобы лучший регион был в **1.5 раза** вероятнее второго — при сходствах 0.93 против 0.90 соотношение ~1.03. Отрыв может дать только совпадение ключевых слов (`wordProfile`), но у регионов из бутстрапа профиль слов, вероятно, пуст (`bumpWordProfile` зовётся только в `attachToRegion`, бутстрап использует `attachToRegionByKey`). Итог: без совпадения имени нода почти всегда в накопителе — в регионах её нет, в промпт она не идёт, в окне её не видно.

**П3. Из накопителя ноды выходят в мусор.** `escalateToSideCar`: при ошибке модели **удаляет все ноды батча**; при «DISCARD» удаляет; всё остальное кладёт **в один регион 0:0**. Регион 0:0 переполняется (лимит 23) → `enforceRegionCapacity` вытесняет или сворачивает — как раз эти новые ноды.

**П4. Часы сбрасываются при перезагрузке страницы.** `let turnCounter = 0` не сохраняется. Всё, что меряется «ходами», ломается после F5:
- возраст ноды `max(0, turnCounter − createdTurn)` у старых нод (большой `createdTurn`) обнуляется → они с полным весом, а новые ноды этой сессии стареют → **при переполнении вытесняются новые**;
- сроки накопителя (`firstAttemptTurn + 5`, `+20`) и очередей слияния/реконсолидации (`turnCounter − queuedTurn`) не наступают, если сессия короче — ноды висят вечно.

**П5. Фильтр «сильного изменения» закрывается со временем.** Уэлфорд копит среднее и σ за всю историю без забывания. Пока граф маленький, расстояния до ближайшей ноды большие; когда граф вырос (особенно после бутстрапа из лорбука), расстояния заметно меньше, а порог держится на старых больших значениях → модель почти не зовётся.

**П6. Гонка при смене чата.** `checkAndPlace` ждёт модель секунды. Если за это время переключить чат, `persistNodes()` запишет граф чата A в `chatMetadata` уже активного чата B (хранилище пишет в «текущий» чат), а `loadState()` потом прочитает испорченное. WI-зеркало уйдёт в лорбук чата B.

**П7. Промпт извлечения смещён к `skip`**, одна нода за раз, без знания существующих нод — плодит почти-дубли, которые потом надо сливать; ошибки/непарсимый ответ тихо дают `sidecar-empty`.

---

## Правила репозитория (обязательно)
- Комментарии и docstring — **по-русски**, в стиле соседнего кода (объяснять «почему», а не «что»). Тексты интерфейса — **по-английски**.
- **Новые файлы — не длиннее 300 строк.** `cores/memory-graph/index.js` и так огромный — **новую логику выноси в новые файлы** (см. этапы), в `index.js` оставляй только вызовы.
- Имена тестов — полное предложение о поведении (`'a node created before a page reload does not outlive nodes created after it'`), см. существующие тесты.
- Каждое решение — запись в `ROADMAP.md` (последний номер посмотри в конце файла; новый — следующий, формат как у соседних записей: что было, что стало, почему, чем проверено).
- Не трогай бутстрап из лорбука (`bootstrapFromLorebook` и его шаги), извлечение в промпт (`injectIntoPrompt`, маяки, маршрут, шум) — кроме мест, явно указанных ниже.
- Не переформатируй чужой код, не переименовывай ничего без необходимости.
- Коммит на каждый этап, сообщение по-английски, первая строка ≤ 72 символа.
- Проверка: `node --test tests/memory-graph-core.test.js tests/memory-graph-orchestration.test.js tests/memory-graph-panel.test.js`, затем полный `npm test`.

---

## Этап 1. Граф читает ответ модели (П1)

**Цель:** извлечение видит последние несколько сообщений, включая ответ модели.

1. В `cores/memory-graph/index.js` рядом с `extractLatestText` добавь (или вынеси в новый файл `cores/memory-graph/context-text.js`) функцию:
   ```js
   /** Текст для извлечения фактов: последние `count` сообщений «Имя: текст», без HTML, не длиннее `maxChars` с конца. */
   export function extractRecentText(chat, { count = 4, maxChars = 3000 } = {})
   ```
   - берёт последние `count` элементов `chat`, пропускает `is_system === true`;
   - строка на сообщение: `${message.name ?? (message.is_user ? 'User' : 'Character')}: ${текст}`, текст — `message.mes` с вырезанными тегами `/<[^>]+>/g` и схлопнутыми пробелами;
   - склейка через `\n\n`; если длиннее `maxChars` — отрезать **начало**, оставить конец (свежее важнее).
2. Новые настройки в `DEFAULT_SETTINGS` и `clampGraphSettings`: `extractionContextMessages: 4` (1…20), `extractionContextChars: 3000` (500…12000).
3. Обработчик `memoryGraph.check` (регистрация `host.own.register('memoryGraph.check', …)` внизу файла): вместо `extractLatestText(params?.chat)` передавай `extractRecentText(params?.chat, { count: settings.extractionContextMessages, maxChars: settings.extractionContextChars })`.
   **`injectIntoPrompt` не трогай** — там последнее сообщение используется как запрос для поиска, это правильно.
4. Тесты (в `memory-graph-core.test.js` для чистой функции):
   - `extractRecentText` берёт ответ модели и реплику пользователя, в порядке чата, с именами;
   - системные сообщения пропускаются;
   - длинный текст обрезается с начала, конец сохраняется.
5. В orchestration-тесте: `memoryGraph.check` с чатом `[…, {name:'Narrator', mes:'The tower is cursed.'}, {name:'User', is_user:true, mes:'I step back.'}]` — в промпте, ушедшем в фейковую модель, есть «The tower is cursed».

---

## Этап 2. Часы, которые не сбрасываются (П4)

**Что такое «часы»:** вместо счётчика в памяти страницы — номер сообщения в чате. Длина истории чата хранится вместе с чатом, одинакова после перезагрузки, реролл/свайп её не двигает (тот же ответ перегенерирован — время не прошло). Удаление сообщений может уменьшить длину, поэтому часы — **максимум** из сохранённого значения и текущей длины: они никогда не идут назад.

1. Новый файл `cores/memory-graph/clock.js` (чистые функции):
   ```js
   /** Следующее значение часов: не меньше прежнего и не меньше длины чата. */
   export function advanceClock(previous, chatLength)  // Math.max(previous ?? 0, chatLength ?? 0)
   /** Миграция данных, записанных при старом счётчике-в-памяти: все отметки времени приводятся к `now`, чтобы старое не оказалось «из будущего». */
   export function migrateTimestamps({ nodes, staging, mergeQueue, reconsolidationQueue }, now)
   ```
   `migrateTimestamps` выставляет `now` в: `node.createdTurn`, `node.lastTouchedTurn` (у всех нод), `entry.firstAttemptTurn`, `entry.lastAttemptTurn` (накопитель), `entry.queuedTurn` (обе очереди). Возвращает новые объекты (не мутирует входные).
2. В Ядре:
   - новый ключ хранилища `CLOCK_KEY = 'clock'` (рядом с остальными `*_KEY`), значение `{ value: number, version: 1 }`;
   - `loadState()` читает его. **Если записи нет** (данные от старой версии) и в графе есть ноды → `value = 0`, затем при первом `check` (когда известна длина чата) выполни `migrateTimestamps(..., clock)` и сохрани всё; отметь, что миграция сделана (сам факт появления `CLOCK_KEY` = миграция сделана);
   - переименуй `turnCounter` → оставь переменную с тем же именем (меньше правок), но значение теперь — часы;
   - в `checkAndPlace`: **убери** `turnCounter += 1`. Вместо этого `checkAndPlace(contextText, { chatLength })` в начале делает `turnCounter = advanceClock(turnCounter, chatLength)`; обработчик `memoryGraph.check` передаёт `chatLength: params.chat.length`;
   - ручной вызов `memoryGraph.checkAndPlace({ text })` без чата — часы не двигает;
   - сохраняй часы (`persistClock()`) там же, где `persistStats()`.
3. Проверь **каждое** место, где читается `turnCounter` / `createdTurn` / `lastTouchedTurn` / `queuedTurn` / `firstAttemptTurn` (`grep -n "turnCounter\|createdTurn\|lastTouchedTurn\|queuedTurn\|firstAttemptTurn" cores/memory-graph/index.js`) — все теперь в одних единицах (сообщения). Числа в настройках (`decayHalfLifeTurns: 20`, `stagingRetryTurns: 5`, `stagingMaxTurns: 20`, `mergeQueueMaxTurns`, `reconsolidationQueueMaxTurns`) раньше были «генерации», теперь «сообщения» (≈ ×2: реплика пользователя + ответ). **Удвой значения по умолчанию** для `decayHalfLifeTurns`, `stagingRetryTurns`, `stagingMaxTurns`, `mergeQueueMaxTurns`, `reconsolidationQueueMaxTurns` и отметь это в ROADMAP. Сохранённые у пользователя настройки не трогай.
4. Тесты:
   - `advanceClock` не идёт назад при удалении сообщений и равен длине чата при росте;
   - `migrateTimestamps` переводит все отметки на `now`;
   - orchestration: создать ноду A, «перезагрузить» Ядро (новый экземпляр с тем же хранилищем — посмотри, как это делают существующие тесты «после перезагрузки»), создать ноду B на более длинном чате, переполнить регион — **вытесняется A (старая), не B**;
   - orchestration: нода в накопителе, перезагрузка Ядра, чат дорос до срока — нода обработана (размещена или эскалирована), а не висит.

---

## Этап 3. Размещение по настоящему сходству (П2, П3)

**Цель:** новая нода почти всегда сразу попадает в регион; накопитель — только для графа без центров.

1. Новый файл `cores/memory-graph/placement.js` (чистые функции):
   ```js
   /**
    * Регион для новой ноды по НАСТОЯЩЕМУ косинусу к центрам регионов.
    * `anchors` = [{ sector, ring, embedding }] — только регионы с центром.
    * Возвращает { region, similarity, margin, confident } или null (центров нет).
    * confident = similarity >= minSimilarity && margin >= minMargin.
    */
   export function pickRegionBySimilarity(embedding, anchors, { minSimilarity = 0.8, minMargin = 0.02 } = {})
   ```
   Для косинуса используй уже существующую функцию `cosineSimilarity` (найди, откуда её импортирует `index.js`).
2. Настройки: `placementMinSimilarity: 0.8` (0…1), `placementMinMargin: 0.02` (0…0.5). **Числа — стартовые**, в ROADMAP напиши, что их надо откалибровать по журналу решений (этап 6).
3. `decideFirstPlacement` (в `index.js`) — новый порядок каскада:
   1. `beaconRegion` (как было);
   2. совпадение имени `nameMatchRegion` (как было);
   3. `pickRegionBySimilarity` → если `confident` — `placed`, reason `'similarity'`;
   4. если центры есть, но не уверенно — **всё равно `placed` в лучший по сходству регион**, reason `'nearest'`, и пометить ноду `placementConfidence: 'low'` (поле на ноде);
   5. граф без центров — `placed` в `0:0`, reason `'bootstrap-seed'` (как было);
   6. `staged` остаётся только если эмбеддинга нет вовсе.
   Сигнатура `decideFirstPlacement` меняется — обнови вызов в `placeNewNode` (передай `anchors`, собранные из `regions` и `nodes[region.centerNodeId].embedding`) и существующие тесты `decideFirstPlacement` (старое поведение «staged при слабом отрыве» — теперь «nearest»; перепиши эти тесты под новое правило, не удаляй проверку остальных веток).
4. `sweepStaging` — **миграция старого накопителя**: для каждой ноды из `staging` сначала попробуй тот же `pickRegionBySimilarity`; если есть хоть один центр — разместить (confident или nearest), удалить из накопителя. Эскалация к модели остаётся только для нод без эмбеддинга.
5. `escalateToSideCar`:
   - при ошибке модели **не удаляй ноды** — оставь их в накопителе (попробуют в следующий раз);
   - ответ с меткой: сопоставь метку с регионом — посчитай эмбеддинг метки (`embedding.compute`, `passage`) и возьми `pickRegionBySimilarity` по центрам; не клади всё в `0:0`;
   - «DISCARD» — удаление остаётся (это осознанное решение модели).
6. Тесты:
   - `pickRegionBySimilarity`: уверенный случай, неуверенный (маленький отрыв) — `confident:false`, но регион есть; без центров — `null`;
   - `decideFirstPlacement`: при центрах и слабом отрыве → `placed` с reason `'nearest'`, не `staged`;
   - orchestration: две ноды с похожим, но не одинаковым смыслом попадают в регионы сразу (не в `memoryGraph.staging`);
   - orchestration: эскалация с ошибкой модели не удаляет ноды.

---

## Этап 4. Фильтр с забыванием + страховочное извлечение (П5)

1. Новый файл `cores/memory-graph/gate.js` (чистые функции):
   ```js
   /** Экспоненциальное среднее и дисперсия с окном ~`window` наблюдений. Прежний формат {count, mean, m2} принимается и переводится. */
   export function updateEwmaStats(stats, distance, { window = 30 } = {})   // → { count, mean, variance }
   export function ewmaStddev(stats)
   /** То же правило, что isStrongChange, но по EWMA; первые 3 наблюдения — всегда true (нет базовой линии). */
   export function isStrongChangeEwma(distance, stats, k)
   ```
   Формулы: `alpha = 2 / (window + 1)`; `diff = x − mean`; `mean += alpha·diff`; `variance = (1 − alpha)·(variance + alpha·diff²)`.
   Перевод старого формата: `{count, mean, m2}` → `{ count, mean, variance: count > 1 ? m2/(count−1) : 0 }`.
2. Настройки: `gateWindow: 30` (5…500), `forcedExtractionEvery: 12` (0 = выкл, 2…200; в «сообщениях», см. этап 2).
3. В `checkAndPlace` замени `updateDistanceStats`/`isStrongChange` на новые (старые функции **не удаляй** — на них есть тесты и они экспортируются; просто перестань их звать).
4. **Страховочное извлечение:** новое сохраняемое поле `lastExtractionClock` (в том же объекте `CLOCK_KEY`: `{ value, version, lastExtractionClock }`). Если фильтр не сработал, но `forcedExtractionEvery > 0` и `turnCounter − lastExtractionClock ≥ forcedExtractionEvery` — всё равно звать модель (reason `'forced'`). После **любого** вызова модели на извлечение — `lastExtractionClock = turnCounter`.
5. Тесты:
   - `updateEwmaStats` забывает старые большие расстояния: после 100 малых значений порог ниже, чем был после 5 больших;
   - перевод старого формата;
   - orchestration: фильтр молчит (одинаковые тексты), но через `forcedExtractionEvery` сообщений модель всё равно вызвана.

---

## Этап 5. Защита от смены чата (П6)

1. В Ядре: `let chatEpoch = 0;`. В обработчике `st.chatChanged` (внизу файла, `host.events.subscribe('st.chatChanged', …)`) **первой строкой, синхронно**: `chatEpoch += 1;`.
2. Помощник внутри Ядра: `const stillSameChat = epoch => epoch === chatEpoch;`.
3. В `checkAndPlace`, `sweepStaging`, `sweepMergeQueue`, `sweepReconsolidationQueue`, `escalateToSideCar`, `createNodeFromCharacterCard` (везде, где между чтением состояния и записью есть `await` модели или эмбеддинга):
   - в начале задачи `const epoch = chatEpoch;`;
   - **после каждого `await`** вызова модели/эмбеддинга и **перед** любой мутацией `nodes`/`regions`/`staging`/очередей и перед `persist*` — `if (!stillSameChat(epoch)) return { status: 'chat-changed' };`
   - зеркало в WI (`lorebook.createEntry`) — тоже только при `stillSameChat`.
   Мутации до первого `await` допустимы (чат не мог смениться внутри синхронного кода).
4. `injectIntoPrompt` — та же проверка перед `persistStickyRetrieval()`.
5. Тесты (orchestration): фейковая модель отвечает с задержкой; во время ожидания эмитнуть `st.chatChanged` и подменить хранилище «чата» на пустое → после завершения в хранилище нового чата **нет** ноды из старого; статус `'chat-changed'`.

---

## Этап 6. Журнал решений (наблюдаемость)

**Цель:** видно, почему нода появилась или нет. Без этого калибровать числа этапов 3–4 нельзя.

1. Новый файл `cores/memory-graph/decision-log.js`: кольцевой буфер на 100 записей, чистые функции `appendDecision(log, entry, limit)`, `summarizeDecision(entry)` (одна строка по-английски для UI).
2. Запись на каждый `check`:
   ```js
   { clock, at: Date.now(),
     gate: { topicDistance, topicThreshold, noveltyDistance, noveltyThreshold, fired, forced },
     extractor: 'not-called' | 'skip' | 'empty' | 'error' | 'node',
     error?: string,
     node?: { id, label },
     placement?: { status, reason, region, similarity, margin },
     capacity?: { evicted: [ids], queuedMerge: bool, queuedReconsolidation: bool } }
   ```
   `topicThreshold = mean + k·σ` — посчитай тем же способом, что в `isStrongChangeEwma`, и положи число в запись.
   Для `capacity` — `enforceRegionCapacity`/`detectMergeCandidate` уже знают, что делают; передай наружу через возвращаемое значение или через переменную «последнее действие», не меняя их логику.
3. Хранение: в памяти + `storage.chatMemory` ключ `decisionLog` (сохранять вместе со статистикой). Контракт `memoryGraph.decisionLog` → массив записей (новые первыми).
4. Окно графа (`cores/ui/memory-graph-panel.js` — найди, где рисуются вкладки/секции): новая сворачиваемая секция **«Why»** со списком последних 20 `summarizeDecision` строк, например
   `#142 · gate 0.31 > 0.27 · model: node "Kira's heritage" · placed 3:1 (similarity 0.86, margin 0.04)` или `#143 · gate 0.12 ≤ 0.27 · model not called`.
5. Тесты: запись создаётся на каждом из исходов (`not-called`, `skip`, `error`, `node`); буфер не растёт больше лимита; `summarizeDecision` даёт ожидаемую строку.

---

## Этап 7. Затухание по использованию

1. `computeNodeWeight` уже принимает `elapsed`. Все вызовы (в `pickEvictionCandidate`, `scoreBeaconCandidate`, `elapsedTurnsFor` и т.п.) сейчас считают `elapsed` от `createdTurn`. Замени на `lastTouchedTurn ?? createdTurn`.
2. В `injectIntoPrompt`: нодам, попавшим в итоговый блок (маяки, маршрут, шум), выставь `lastTouchedTurn = turnCounter` и сохрани ноды **тем же вызовом**, где сохраняется `stickyRetrieval` (не добавляй отдельное сохранение на каждую ноду). Если сработал «закреплённый» блок (sticky) — обнови `lastTouchedTurn` у его `beaconIds`.
3. Тест: две одинаковые по важности ноды одного возраста; одна используется в промпте — при переполнении вытесняется другая.

---

## Этап 8. Извлечение: несколько фактов, обновление существующих (П7)

Делать только после этапов 1–7.

1. Новый файл `cores/memory-graph/extraction-prompt.js`: `buildExtractionPrompt({ contextText, nearestNodes, isFirstNode })` и `parseExtractionResponse(parsed, nearestNodeIds)`.
2. Перед вызовом модели: найди 6 ближайших нод к эмбеддингу контекста (по `node.embedding`, косинус) и передай их в промпт списком `id: label — content`.
3. Формат ответа модели:
   ```json
   { "facts": [
       { "op": "create", "label": "...", "content": "...", "importance": 0-10 },
       { "op": "update", "id": "<id из списка>", "content": "уточнённый самодостаточный текст", "importance": 0-10 }
   ] }
   ```
   или `{ "facts": [] }`. Максимум 3 факта. Сохрани из старого промпта: калибровочные примеры, требование самодостаточного `content` (имена вместо «он/она/это»), шкалу важности. Смягчи уклон в `skip`: «если в тексте есть новый устойчивый факт о персонаже, месте, отношениях или событии — извлеки его».
4. `create` → существующий путь (эмбеддинг `passage`, `placeNewNode`, WI-зеркало). `update` → обнови `content`/`importance`, пересчитай `node.embedding`, `lastTouchedTurn = turnCounter` (как `updateNodeManually`; можешь вызвать его внутреннюю логику, но **без** повторного `enqueueWrite` — ты уже внутри очереди). `id` не из списка → игнорировать.
5. Обратная совместимость парсера: старый формат `{label, content, importance}` и `{skip:true}` тоже принимается.
6. Тесты: разбор всех форматов; `update` меняет существующую ноду, а не создаёт новую; неизвестный `id` игнорируется; максимум 3 факта.

---

## Этап 9 (необязательный). Разрез `index.js`

Только перенос кода **без изменения поведения**, отдельным коммитом, после всех этапов:
- чистые функции верха файла → `cores/memory-graph/math.js` (регионы, логиты, веса, маяки, маршрут), `cores/memory-graph/bootstrap-prompts.js` (всё про промпты бутстрапа);
- `index.js` реэкспортирует их (`export { … } from './math.js'`), чтобы импорты тестов не менялись.
Все тесты должны пройти без правки.

---

## Как проверить руками (после этапов 1–6)
1. В ST открыть чат, включить граф, сыграть 15–20 ходов с явными новыми фактами в ответах модели.
2. Открыть окно графа → секция **Why**: на ходах с новыми фактами должно быть `model: node …` и `placed … (similarity …)`, а не `staged`.
3. Перезагрузить страницу, сыграть ещё несколько ходов — новые ноды на месте, старые не «молодеют» (в журнале нет вытеснений только что созданных нод).
4. Переключить чат во время генерации — граф второго чата не изменился.
5. По журналу откалибровать `placementMinSimilarity`, `placementMinMargin`, `thresholdK`, `forcedExtractionEvery`; итоговые числа записать в ROADMAP.

## Чего НЕ делать
- Не менять бутстрап из лорбука, формат хранения нод/регионов (кроме новых полей), контракты `memoryGraph.*` (новые — можно, старые — не ломать).
- Не удалять старые экспортируемые функции — на них есть тесты; можно перестать их вызывать.
- Не «чинить» заодно другое, что покажется странным, — запиши в конец отчёта списком.
- Не отключать и не пропускать тесты.
