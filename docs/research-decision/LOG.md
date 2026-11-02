# Журнал исследования: директор и прозаик

Ветка `research/decision`, базовый коммит `d4e8326`. Node `v18.19.1`.
Живых запросов к провайдерам нет; все модели в тестах — фейки.

## d0. Разведка и схема

### Путь одной генерации сейчас

Порядок — по коду, а не по памяти.

1. **ST начинает прогон.** `GENERATION_STARTED` → мост
   [Сервиса событий](../../services/st-events.js) → Ядро событий →
   `st.generationStarted`. Ядро жизненного цикла
   ([cores/generation/index.js](../../cores/generation/index.js)) открывает
   прогон и публикует `generation.beforeSend` с `runId`. Сухие прогоны
   (`dryRun`) сюда не попадают. Сборки вкладов в этот момент ещё нет: у ST
   нет ни `chat`, ни размера контекста.
2. **ST держит генерацию и зовёт перехватчик.**
   `generate_interceptor` из `manifest.json`
   (`stModuleEngineBetaGenerateInterceptor`) → `onIntercept({ chat,
   contextSize, abort, type })`. `chat` — мутируемая копия `coreChat`: правки
   формируют промпт, но не сохранённый чат.
3. **`generation.prepare` (`collect`)** — освежить своё состояние:
   трекеры опрашиваются, саммари сворачиваются, PM сбрасывает вклады.
   Выходы этапов никуда не идут.
4. **`generation.beforeSend` (`collect`)** — вклады в промпт; ST ждёт этот
   пайплайн. Вкладчики правят тот же `chat`: саммари (`summary:inject`),
   Notebook, Secrets, навигация по упоминаниям и т. п. PM
   (`prompt-manager:capture`) запоминает **ссылку** на `chat`, поэтому
   видит вставки соседей позже. Отказ этапа с `onExhausted: 'abort'`
   отменяет генерацию.
5. **ST собирает свой промпт** из уже изменённого `chat` и отправляет
   `POST` на один из пяти путей (`GENERATION_ENDPOINTS` в
   [services/st-generation.js](../../services/st-generation.js)).
6. **Обёртка `fetch`** (`installSendHook`) перехватывает только эти POST'ы.
   Тело обязано быть JSON; иначе запрос проходит нетронутым. Хук зовёт
   `onSend({ endpoint, payload })`; Ядро генерации публикует
   `generation.sending`.
7. **`generation.payload` (`fold`)** — цепочка переписывания тела. Сейчас
   в ней **единственный** этап: `prompt-manager:rewrite` (PM). Он собирает
   запрос по активному пресету и возвращает `{ ...payload, ...body,
   messages }`. Отказ PM (кроме двойного сбоя CoT) не ломает генерацию:
   тело уходит как есть. Двойной сбой шага CoT — отмена отправки.
8. **Отправка.** Хук отдаёт новое тело исходному `fetch`. Ответ идёт в ST
   своим обычным путём, со стримингом; мы его не подменяем.
9. **Конец прогона.** `GENERATION_ENDED` → `generation.completed`
   (`outcome: 'ended'`), `GENERATION_STOPPED` → `generation.completed`
   (`outcome: 'stopped'`). Новый прогон поверх незакрытого закрывает
   старый как `generation.superseded` (не `completed`). Пост-обработка —
   `generation.completed` (`fold`); PM сохраняет запись CoT по номеру
   последнего сообщения.
10. **Отмена перехватчиком.** ST на этой ветке **не** шлёт
    `GENERATION_ENDED`; Ядро генерации само закрывает прогон исходом
    `aborted` и публикует `generation.aborted`.

### Кто и когда трогает тело запроса

| Момент | Кто | Что делает с телом |
|---|---|---|
| `generation.beforeSend` | Саммари, Notebook, Secrets, навигация | Правят **копию `chat`**; до тела запроса доходит через сборку ST/PM |
| `generation.beforeSend` | PM `prompt-manager:capture` | Запоминает ссылку на `chat`, тело не трогает |
| `generation.payload` | PM `prompt-manager:rewrite` | Заменяет `messages` и параметры пресета (если PM включён, есть активный пресет, Chat Completion, не группа) |
| `generation.payload` | **новый этап прозаика (d2)** | Встаёт **после** PM по `needs` и заменяет `messages` / `prompt` контекстом прозаика |

Других этапов на `generation.payload` в коде нет. Это важно: порядок
«PM → прозаик» можно задать зависимостью этапа, не угадывая порядок
регистрации.

### Ответы d0

**Можно ли подменить тело, не ломая PM или ST — да.** Обе точки уже
существуют и уже используются: PM заменяет `messages` на том же `fold`, а
обёртка `fetch` штатно принимает новое тело. Ничего в ST не требует, чтобы
тело осталось тем, что он собрал. Условия, при которых это не ломает
механику:

- этап прозаика объявляет `needs: ['prompt-manager:rewrite']` (если PM
  загружен) и тем самым всегда идёт последним — любой другой этап
  `payload` без зависимости окажется раньше;
- неизвестное тело (нет ни `messages`, ни `prompt`) проходит нетронутым,
  как это уже делает Сервис перехвата;
- отказ прозаика отменяет отправку (`onExhausted: 'abort'`), а не отправляет
  неполный промпт;
- при выключенном ядре этапы не регистрируются вообще.

**Что происходит с вкладами модулей при замене тела.** Они по-прежнему
исполняются на `prepare`/`beforeSend` и по-прежнему публикуют своё
состояние (трекер — на шину и в макросы, время — в бейджи, граф памяти — в
свой контекст). Но в **исходящее тело** они не попадают: прозаик получает
ровно свой состав (блоки о персонаже + 20 сообщений + саммари + решение).
Саммари читаются контрактом `summary.list`, а не из вставок в `chat`, чтобы
не зависеть от гонки вкладчиков и не дублировать их. Это осознанное
следствие решения владельца о составе контекста; если понадобится отдать
директору значения трекера/графа, это отдельное расширение состава, а не
побочный эффект замены.

**Свайп, перегенерация, `continue`, `impersonate`, сухой прогон.**

- `type` приходит в перехватчик и уже используется (PM передаёт его в CoT).
  Наш директор тоже его видит: для `regenerate`/`swipe` действует настройка
  «директор заново / только прозаик» (d3), по умолчанию — заново.
- `continue` и `impersonate` — обычные прогоны: состав прозаика тот же,
  хвост истории сам говорит, что нужно продолжение или реплика от лица
  пользователя. Ничего отдельно подменять не нужно.
- Сухой прогон **не доходит** до перехватчика и не отправляет запрос;
  этапы ядра на нём не срабатывают.
- Свайп/регенерация могут вытеснить незакрытый прогон
  (`generation.superseded`) — его запись директора и правки блоков не
  сохраняются (d3).

### Базовая линия тестов

Команда из брифа `node --test tests/**/*.test.js` на node 18.19.1 **не
работает**: оболочка раскрывает `**` как `*`, подпапок с тестами нет, и
node отвечает `Could not find '.../tests/**/*.test.js'`. У `npm test`
в `package.json` ровно тот же шаблон, поэтому он тоже не находит файлы.

Эквивалентный полный прогон: `node --test tests/*.test.js`.

- тестов: **3376**
- прошло: **3205**
- упало: **167**
- пропущено: **4**
- код выхода: **1**

Падающие файлы (23; в скобках — число упавших тестов):

```
tests/backup-plan.test.js (1)
tests/boot-screen.test.js (1)
tests/card-fingerprint.test.js (7)
tests/cloud-backup-core.test.js (10)
tests/contract-bus.test.js (1)
tests/memory-graph-library.test.js (1)
tests/memory-graph-orchestration.test.js (1)
tests/module-installer.test.js (7)
tests/module-runtime-libs.test.js (1)
tests/request.test.js (2)
tests/runner-core.test.js (4)
tests/st-user-data-service.test.js (1)
tests/sync-cloud.test.js (17)
tests/sync-copy-cleanup.test.js (2)
tests/sync-core-cloud.test.js (6)
tests/sync-core.test.js (31)
tests/sync-github.test.js (6)
tests/sync-interrupted.test.js (6)
tests/sync-oauth.test.js (1)
tests/sync-pack.test.js (17)
tests/sync-plan.test.js (1)
tests/sync-runner.test.js (38)
tests/sync-secrets.test.js (5)
```

Дальше сравниваем только с этой линией: новых падений относительно неё быть
не должно. Падения существуют и без наших правок (node 18: `crypto.subtle`,
`structuredClone`/таймеры и т. п. в перечисленных файлах).

## d1. Ядро и контекст директора

Сделано:

- `cores/decision/index.js` — ядро, по умолчанию выключено. Пока
  `enabled` false, этапы не регистрируются. Включение/выключение на ходу
  добавляет/снимает `decision:decide` (`generation.beforeSend`) и
  `decision:rewrite` (`generation.payload`).
- `cores/decision/store.js` — блоки и записи прогонов в памяти чата, своя
  очередь записи, чтобы два одновременных завершения не затирали друг друга.
- `libraries/core/decision-context.js` — сборка обоих контекстов, выбор
  последних 20 логических единиц (цепочки инструментов не рвутся), порядок
  «стабильное → изменчивое», плоская форма для `anthropic`/`google`.
- `libraries/core/decision-format.js` — разбор ответа директора и правки
  блоков; мусор/неполный JSON/пустой ответ — ошибка, отдельная кривая
  правка — предупреждение, а не падение.
- `libraries/core/decision-settings.js` — настройки и защитные клэмпы.
- `libraries/core/decision-body.js` — замена тела и выключение ризонинга
  (d2 использует; чистая часть готова здесь).
- `libraries/core/decision-reasoning.js` — ризонинг провайдера из
  `model.generate.raw`.
- Проводка: `harness/wiring/data-cores.js` (ядро `core.decision`),
  `harness/wiring/boot.js` (`load()` строго после PM), `engine-wiring.js`
  (возврат наружу).
- Тесты: `tests/decision-context.test.js`, `tests/decision-format.test.js`,
  `tests/decision-body.test.js`, `tests/decision-core.test.js`.

Проверки:

- новый набор тестов: **32/32**;
- полный прогон после d1: **3408** тестов, **3237** прошло, **167** упало,
  **4** пропущено. Падающие — ровно те же 23 файла базовой линии; новых
  падений нет.

Механика порядка подтверждена тестом: `decision:rewrite` получает
`needs: ['prompt-manager:rewrite']`, а если PM появится позже —
перерегистрируется по `pipeline.stagesChanged`. Директор вызывается с
`stream: false` (нужен цельный JSON и ризонинг из тела), `priority:
'pipeline'`.
