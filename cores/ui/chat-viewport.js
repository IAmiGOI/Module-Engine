import { request } from '../../libraries/shared/request.js';
import { computeVisibleRange, reconcileMeasuredHeight, computeGlyphs } from '../../libraries/shared/chat-viewport-math.js';
import { createUiMountRegistry } from '../../libraries/shared/ui-mount-registry.js';
import { h } from './tree.js';
import { signal, computed } from './reactive.js';
import { MessageHeader, MessageActionsRow, ReasoningBlock, TextArea, Button, Row, Avatar, GenStripe } from '../../libraries/shared/widgets.js';

/**
 * Ядро Chat Viewport — гибридный рендер истории чата поверх ST (см. план
 * `chat-viewport`): тело каждого видимого сообщения растеризуется из
 * настоящего HTML ST (`stChat.formatMessage`) в WebGL-текстуру
 * (`services/html-rasterizer.js` → `services/webgl-renderer.js`), а не
 * рисуется своим text-layout движком. `context.chat` остаётся ЕДИНСТВЕННЫМ
 * источником истины — это Ядро только читает его через `services/st-chat.js`
 * и точечно пишет туда же (`deleteMessage`/`swipe`/`regenerate`/`setText`),
 * теми же контрактами, что уже существуют.
 *
 * **Невидимое DOM-зеркало — не просто ради выделения текста/Ctrl+F,
 * оно ЕЩЁ и единственный надёжный источник реальной высоты строки.**
 * Открытие в процессе реализации: пытаться заранее угадать высоту
 * растеризованной текстуры (а не измерить), а затем растеризовать ПОД эту
 * оценку — обратный порядок причины и следствия: настоящая высота известна
 * только после того, как HTML реально положили в документ и браузер сделал
 * layout. Зеркало (`dom.setInnerHtml` в скрытый узел, класс которого держит
 * его вне потока документа, но не `display:none` — иначе `getBoundingClientRect`
 * вернул бы ноль) даёт эту высоту через `dom.measureRect` БЕСПЛАТНО, тем же
 * проходом, что уже нужен для доступности/выделения — а не гадает её и не
 * подгоняет задним числом.
 *
 * **Три рубежа защиты от "перерисовки, о которой никто не сообщил"** — тот
 * же принцип, что у [message-footer.js](message-footer.js): (1) события ST
 * (`REDRAW_EVENTS` ниже, плюс `st.streamTokenReceived` — специально
 * размостированное для этого Ядра явно, см. wiring), (2) `render()`
 * идемпотентен — вызвать его повторно вхолостую безопасно, (3) `attach()`/
 * `render()` не предполагают, что предыдущий вызов вообще случился.
 *
 * **`getContext().deleteMessage` требует, чтобы нативный `.mes[mesid]`
 * СУЩЕСТВОВАЛ в DOM** (подтверждено чтением реального исходника ST, см. doc-
 * comment `services/st-chat.js`'s `deleteMessage`) — поэтому подавление
 * нативного `#chat` (`setEnabled`) обязано быть CSS-скрытием, а не удалением
 * узла из документа. Это Ядро само `#chat` не создаёт и не удаляет — только
 * переключает класс на уже существующем контейнере.
 *
 * **Хром (аватарка/шапка/действия/рассуждения, widgets.js) — обычный
 * DOM-дерево `h()`, смонтированное ПОВЕРХ канваса**, не WebGL: тот же
 * `uiMountRegistry`, что у [message-footer.js](message-footer.js), один
 * независимый Final UI на `mesid`. Позиционирование — ЕДИНСТВЕННОЕ, что
 * меняется на каждый скролл, поэтому оно в СВОЁМ, отдельном от контента
 * сигнале (`state.position`): скролл не должен пересобирать дерево
 * шапки/кнопок, только сдвигать `transform: translateY(...)` — то самое,
 * что делает синхронизацию со скроллом дешёвой и не требующей layout (см.
 * [[feedback-no-animated-effects-reflow]]).
 */

/**
 * События ST, после которых видимое содержимое сообщения могло измениться.
 * `st.streamTokenReceived` сюда НЕ входит — он вообще никогда не долетел бы
 * через `host.events` (см. `STREAM_TOKEN_ST_EVENT` ниже, doc-comment
 * объясняет почему), поэтому больше не значится здесь как "ещё одно
 * событие общей шины".
 */
const REDRAW_EVENTS = Object.freeze([
    'st.messageSwiped',
    'st.messageEdited',
    'st.messageUpdated',
    'st.messageDeleted',
    'st.characterMessageRendered',
    'st.userMessageRendered',
]);
/**
 * НАЙДЕНО ЖИВЬЁМ: `REDRAW_EVENTS` выше идут через `host.events` — общую
 * Шину событий движка, куда попадает только то, что `core.events`'s
 * `bridge()` реально смостил из ST. А `STREAM_TOKEN_RECEIVED`/
 * `SMOOTH_STREAM_TOKEN_RECEIVED` — ОБА в `DEFAULT_EXCLUDED_ST`
 * (`cores/events/index.js`) НАВСЕГДА, намеренно: стриминг стреляет на
 * КАЖДЫЙ токен генерации — смостить это на общую шину означало бы сотни
 * эмитов на один ответ, долетающих до ВСЕХ подписчиков движка, не только
 * Chat Viewport. Раньше `st.streamTokenReceived` числился в `REDRAW_EVENTS`
 * (с пометкой "специально размостированное для этого Ядра явно, см.
 * wiring") — но реальная проводка (`harness/engine-wiring.js`) так и не
 * сделала этого исключения, `bridge()` продолжал безусловно отфильтровывать
 * оба ключа, и подписка была мёртвым кодом: `host.events` никогда не
 * получал это событие, стриминг текста/рассуждений/ToolCall в Chat Viewport
 * не обновлялся вообще. Правильный фикс — НЕ трогать общую шину/исключения
 * (это разрушило бы весь смысл исключения для остального движка), а
 * подписаться НАПРЯМУЮ на сырое ST-событие через `stEvents.subscribe`
 * (`attach()` ниже) — тот же сервис, что `core.events`'s `bridge()`
 * использует сам, только здесь подписка не идёт дальше этого Ядра.
 */
const STREAM_TOKEN_ST_EVENT = 'STREAM_TOKEN_RECEIVED';

const SUPPRESS_CLASS = 'stme-chat-viewport-suppress-native';
const MIRROR_CLASS = 'stme-chat-viewport-mirror';
const DEFAULT_ROW_HEIGHT = 96;
const DEFAULT_OVERSCAN = 3;
/** Зазор МЕЖДУ глифами (owner: "между ними нет спейса") — px, логические. Добавляется к высоте ПЕРВОГО сообщения нового глифа (см. `render()`), не отдельной сущностью — так виртуализация (`computeVisibleRange`) видит его в своей сумме высот "бесплатно", без отдельного учёта зазоров. */
const GLYPH_GAP = 10;
/**
 * Горизонтальный отступ ТЕЛА сообщения от левого/правого края глифа —
 * owner: "Глиф все-еще слишком близко к левой и правой границе текста, без
 * спейсинга". НАЙДЕНО ЖИВЬЁМ: зеркало/растр/квад рисовались на всю ширину
 * `viewportWidth`, вплотную к границе фона глифа — у ХРОМА (аватар/имя/
 * кнопки) отступ УЖЕ был (`.stme-chat-viewport-row`'s `padding: 6px 10px`),
 * а у WebGL-текста тела — нет, никакого padding у канваса в принципе не
 * бывает. Тот же отступ (10px), что у хрома — для визуального совпадения
 * левого края текста и левого края аватарки/имени над ним.
 */
const TEXT_PADDING = 10;
const SKELETON_POOL_MAX = 14;
const MEASURE_BATCH_MS = 3; // окно сбора измерений в одну пачку
const EDIT_MIN_HEIGHT = 96; // минимальная высота тела в режиме правки, px
/** Сколько мс после последнего скролла считаем, что пользователь ещё листает (рисуем только видимое). */
const QUICK_SCROLL_MS = 150;
/** На сколько мс вперёд по ходу прокрутки предзагружаем (скорость × это время). */
const PREFETCH_HORIZON_MS = 1500;
/** Высота канваса последнего сообщения растёт ступенями (ресайз очищает канвас — на каждый токен нельзя). */
const LAST_CANVAS_STEP = 512;
const MAX_CANVAS_CSS = 8000;

/** Быстрый нестойкий хеш строки (cyrb53) — ключ постоянного кэша растров. */
function hashString(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i += 1) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
/** Сколько тел строк окна растеризуем одновременно. */
const PRELAUNCH_CONCURRENCY = 10;
/**
 * owner: "Оно должно быть СПРАВА от аватарки. Блоки ризонинга тоже. И
 * только после заполнения той зоны спускаться вниз." Настоящая аватарка —
 * `float:left` (см. `buildRowTree()`). Нужно измерить, сколько высоты
 * РЕАЛЬНО занял имя+дата+ризонинг+ToolCall САМИ ПО СЕБЕ, независимо от
 * аватарки — см. `avatarRemainder` в `render()`. НАЙДЕНО ЖИВЬЁМ: измерять
 * для этого нужно НЕ `root` строки (`.stme-chat-viewport-row`) — у него
 * `position: absolute` (нужен виртуализации), а это САМО ПО СЕБЕ заводит
 * block formatting context независимо от `overflow`/clearfix, из-за чего
 * `root` всё равно растягивался под высоту float-аватарки. Вместо этого
 * измеряется `.stme-chat-viewport-content-col` — отдельный блочный
 * сиблинг float-аватарки (без своего `position`/`overflow`/BFC), чья
 * СОБСТВЕННАЯ высота float-сосед не трогает, но чьи СТРОКИ ТЕКСТА внутри
 * всё равно обтекают его как обычно (см. `ensureRowChrome()`). Тело
 * сообщения — WebGL-текстура,
 * не настоящий DOM, обтекать чужой float само не умеет; для НЕГО заведена
 * своя отдельная заглушка (`avatarSpacerHtml()`) высотой РОВНО В ОСТАТОК
 * аватарки, что не занял хром — ноль, если хром (имя+ризонинг+ToolCall)
 * уже сам дотянулся до низа аватарки или ниже.
 */
const AVATAR_WIDTH = 102;
const AVATAR_HEIGHT = 136;
const GEN_STRIPE_WIDTH = 6;
// БЕЗ `+ TEXT_PADDING` — НАЙДЕНО ЖИВЬЁМ: квад тела УЖЕ рисуется со сдвигом
// `x: TEXT_PADDING * devicePixelRatio` на экране (см. `render()` ниже) —
// локальный x=0 РАСТЕРИЗОВАННОГО содержимого сам по себе соответствует
// экранному x=TEXT_PADDING, не x=0. Добавление ещё одного `TEXT_PADDING`
// поверх ширины аватарки+полоски сдвигало бы обтекаемый текст ПРАВЕЕ
// настоящего края аватарки (авaтарка кончается на экране на x=108, а
// заглушка с `+TEXT_PADDING` тянулась бы до экранного x=128) — первая
// попытка задала именно так и текст откровенно "не долетал" до аватарки,
// со странным зазором. Ширина заглушки в ЛОКАЛЬНЫХ координатах должна
// довести текст РОВНО до экранного `avatarColWidth + margin` — раз margin
// (см. `.stme-chat-viewport-avatar-col` в panel.css) СОВПАДАЕТ по
// величине с `TEXT_PADDING`, он взаимно гасится с оффсетом квада, и
// остаётся просто ширина самой колонки аватарки.
// Ширина колонки аватарки целиком, как её рисует хром: аватарка + gap 6 +
// полоска + margin-right 10 (panel.css `.stme-chat-viewport-avatar-col`).
const AVATAR_SPACER_WIDTH = AVATAR_WIDTH + 6 + GEN_STRIPE_WIDTH + 10;
// Вертикальные отступы строки хрома (panel.css `.stme-chat-viewport-row`).
const ROW_PAD = 6;
// Низ аватарки в координатах глифа (сверху вниз): верхний padding + высота.
const AVATAR_WRAP = ROW_PAD + AVATAR_HEIGHT;
// Минимальная высота глифа целиком — аватарка + оба padding.
const GLYPH_MIN_HEIGHT = AVATAR_HEIGHT + 2 * ROW_PAD;

export function createChatViewportCore(host, {
    publish, rowHeight = DEFAULT_ROW_HEIGHT, overscan = DEFAULT_OVERSCAN, prerenderFactor = 1,
    // Бюджет памяти под растеризованные тела вне экрана (null — вытеснять сразу за окном, как раньше) и
    // дальность фоновой предрастеризации в высотах экрана (0 — выключена).
    textureBudgetBytes = null, prefetchScreens = 0, prefetchConcurrency = 3, persistentCache = false,
    getDevicePixelRatio = () => globalThis.devicePixelRatio || 1,
    createFinalUi,
} = {}) {
    const publishEvent = publish ?? ((event, payload) => host.events.emit(event, payload));
    const chromeMounts = createFinalUi ? createUiMountRegistry(createFinalUi) : null;

    // --- состояние (одно Ядро = один активный чат-вьюпорт; несколько
    // одновременных вьюпортов вне сегодняшнего плана) ---
    let canvas = null;
    let mirrorContainer = null;
    let chromeContainer = null;
    // Заглушки строк, которые ещё грузятся при быстрой прокрутке: пул <div> со «строчками текста» вместо пустого экрана.
    const skeletonPool = [];
    async function applySkeletons(specs) {
        if (!chromeContainer) return;
        while (skeletonPool.length < specs.length && skeletonPool.length < SKELETON_POOL_MAX) {
            const node = await serviceOrNull('dom.createElement', { tag: 'div' });
            if (!node) break;
            await serviceOrNull('dom.setProp', { el: node, key: 'class', value: 'stme-chat-viewport-skeleton' });
            await serviceOrNull('dom.append', { parent: chromeContainer, child: node });
            skeletonPool.push(node);
        }
        for (let i = 0; i < skeletonPool.length; i += 1) {
            const spec = specs[i];
            await serviceOrNull('dom.setProp', {
                el: skeletonPool[i], key: 'style',
                value: spec
                    ? { display: 'block', transform: `translateY(${Math.round(spec.top)}px)`, height: `${Math.round(spec.height)}px`, width: `${viewportWidth}px` }
                    : { display: 'none' },
            });
        }
    }
    async function clearSkeletons() {
        for (const node of skeletonPool.splice(0)) await serviceOrNull('dom.remove', { node });
    }
    let css = '';
    // ВСЁ, что касается layout/скролла/измерений (viewportWidth/Height,
    // scrollTop, heights) — ЛОГИЧЕСКИЕ CSS-пиксели, ровно то, что и так
    // естественно возвращают `dom.measureRect`/скролл браузера. `devicePixelRatio`
    // умножает их ТОЛЬКО в двух местах ниже (backing store канваса и цель
    // растеризации) — без этого текст на любом экране с DPR > 1 (или просто
    // при масштабе браузера не 100%) растеризуется в меньшем разрешении, чем
    // экран реально может показать, и выглядит пиксельным при апскейле GPU.
    let viewportWidth = 0;
    let viewportHeight = 0;
    // scrollTop, по которому построен ПОСЛЕДНИЙ закоммиченный кадр — панель сдвигает слой на разницу с живым scrollTop, пока не пришёл следующий кадр.
    let renderedScrollTop = 0;
    const canvasHeight = () => Math.round(viewportHeight * prerenderFactor);
    const canvasPad = () => Math.round(viewportHeight * (prerenderFactor - 1) / 2);
    let devicePixelRatio = 1;
    let scrollTop = 0;
    let enabled = true;
    let attached = false;
    let rendering = false;
    let renderQueued = false;
    let lastScrollAt = 0;
    let fullPassTimer = null;
    let pendingFresh = false;
    let snapshot = null;
    let settlePasses = 0;
    // Перерисовка вызвана ручным раскрытием/сворачиванием блока — рост высоты от неё НЕ повод автопрокручивать вниз.
    let toggleRender = false;

    const heights = new Map();          // mesid -> измеренная высота (px)
    const rasterizedText = new Map();   // mesid -> текст, на котором построена ТЕКУЩАЯ текстура/зеркало
    // mesid -> {width, height} — РЕАЛЬНЫЙ физический размер ТЕКСТУРЫ,
    // возвращённый `htmlRasterizer.rasterize()` (уже округлённый ВНУТРИ
    // сервиса, см. `services/html-rasterizer.js`). НАЙДЕНО ЖИВЬЁМ — owner:
    // "Текст будто светится и свечение делает его размытым": квад раньше
    // считал свой физический размер САМ, заново, как `contentWidth() *
    // devicePixelRatio` — та же формула по смыслу, что рвнутри рас-
    // теризатора, но БЕЗ его `Math.round()`. При дробном `devicePixelRatio`
    // (типично — 1.25) это давало дробный физический размер квада (напр.
    // 606.25px), а сама текстура была ЦЕЛЫМ числом (606px, округлено) —
    // квад запрашивал у GPU растянуть текстуру чуть БОЛЬШЕ её реального
    // размера, и `TEXTURE_MIN/MAG_FILTER: LINEAR` честно интерполировал этот
    // раздутый край — visually неотличимо от лёгкого блюра/ореола вокруг
    // текста. Кешируя ТОЧНО то число, что реально ушло в текстуру, а не
    // пересчитывая его заново с другим округлением, устраняем саму
    // возможность расхождения.
    const physicalTextureSize = new Map();
    // mesid -> HTML, которым ПОСЛЕДНИЙ РАЗ реально заполнили
    // `.stme-toolcall-body` (owner: "ToolCall не открывается", после
    // фикса capture-фазы — НАЙДЕНО ЖИВЬЁМ, самозамкнутый цикл: без этого
    // кеша `ensureRowChrome()` безусловно переinject'ил тот же HTML НА
    // КАЖДЫЙ `render()`, включая тот самый рендер, который вызывал сам
    // `toggle`-обработчик — раскрытый `<details>` тут же перезаписывался
    // заново распарсенным (по умолчанию закрытым) узлом, и открытие
    // молча сбрасывалось назад долю секунды спустя. Тот же приём, что
    // `rasterizedText` уже даёт телу сообщения.
    const toolCallHtmlWritten = new Map();
    const mirrors = new Map();          // mesid -> DOM-узел зеркала
    const rowStates = new Map();        // mesid -> { position, content, editing, draft } — сигналы хрома
    const chromeRoots = new Map();      // mesid -> реальный корневой DOM-узел хрома (для forgetRowChrome)
    const glyphHeadOf = new Map();      // mesid -> mesid заголовка его глифа (обновляется в render())
    const bodyImages = new Map();       // mesid -> [{ src, x, y, width, height }] — картинки тела, показываются настоящим DOM поверх канваса
    const imageLayers = new Map();      // mesid -> { layer, root, key } — DOM-слой с этими картинками внутри хрома строки
    const footerSlots = new Map();     // mesid -> заглушка `.stme-chat-viewport-footer-slot` (для ui.messageFooter.setHostResolver)
    const contentCols = new Map();      // mesid -> `.stme-chat-viewport-content-col` (измеряется вместо `root` — см. ensureRowChrome())
    // mesid -> 'working'|'success'|'error' — полоска-светофор генерации
    // (owner: "фиксирует свой последний цвет после завершения генерации").
    // НАВСЕГДА, не по таймеру, В ОТЛИЧИЕ от общего Activity Light
    // (cores/ui/activity-light.js), у которого те же события гаснут в idle
    // через HOLD_MS — здесь запись остаётся, пока жив этот экземпляр Ядра
    // (вкладка/сессия), ничего её не стирает. mesid для событий генерации
    // не приходит В САМОМ payload (см. cores/generation/index.js — там
    // только `runId`) — берётся ТЕМ ЖЕ приёмом, что уже использует RP Time
    // для своих отметок (`ui.messageFooter.liveMesid`, message-footer.js):
    // "последнее отрисованное сообщение ПРЯМО СЕЙЧАС", в момент события.
    const genStatus = new Map();
    const glyphBgApplied = new Map();   // headerMesid -> последний применённый стиль фона (top|width|height)
    const rowPositionApplied = new Map(); // mesid -> последняя применённая позиция строки хрома (y|width)
    const glyphBgRoots = new Map();     // headerMesid -> DOM-узел фона глифа (owner: "Глифы должны иметь отдельный бэкграунд")
    const bodyUse = new Map();          // mesid -> порядок последнего использования тела (LRU: первый ключ — самый давний)
    const syncInflight = new Map();     // mesid -> { key, promise } — не растеризовать одно и то же дважды параллельно
    const lastChromeHeight = new Map(); // mesid -> последняя измеренная высота хрома (для оценки заглушки при предрастеризации)
    let lastFrame = null;               // данные последнего кадра для фонового префетча
    let prefetchGen = 0;
    let prefetchRunning = false;
    let lastQuadsKey = null;
    let dirtyMain = true;               // на основном канвасе появилась новая текстура — кадр надо нарисовать даже при тех же квадах
    // Уровень 3: отдельный маленький канвас под тело ПОСЛЕДНЕГО сообщения — стрим перерисовывает только его.
    let lastCanvas = null;
    let lastCanvasSize = { w: 0, h: 0 };
    let lastQuadKeyL3 = null;
    let lastTransformL3 = null;
    let dirtyLast = true;
    let lastBodyMesid = null;
    const textureHome = new Map();      // mesid -> канвас, на чей GL-контекст загружена текстура строки
    let scrollVelocity = 0;             // px/мс, со знаком (EMA) — направление и скорость прокрутки для упреждающей предзагрузки
    let lastVelAt = 0;
    // mesid -> { sig, height }: измеренная высота хрома строки. Меряется ТОЛЬКО когда изменилось содержимое/ширина/раскрытие —
    // раньше каждая видимая строка мерилась на КАЖДОМ кадре, и принудительная раскладка (getBoundingClientRect) съедала ~46% главного потока при прокрутке.
    // Подвалы (`ui.messageFooter.attach`) раскладываются по слотам ВСЕХ строк за вызов — раньше звали на каждую новую строку
    // (замер: 86 вызовов, ~1,8 с за прокрутку). Теперь одна отложенная пачка на кадр.
    let footerAttachTimer = null;
    let footerAttachDirty = false;
    function scheduleFooterAttach() {
        // Первый вызов — сразу (новая строка получает подвал без ожидания), остальные в течение 60 мс схлопываются в один хвостовой.
        if (footerAttachTimer !== null) { footerAttachDirty = true; return; }
        coreOrNull('ui.messageFooter.attach', {});
        footerAttachTimer = setTimeout(() => {
            footerAttachTimer = null;
            if (footerAttachDirty) { footerAttachDirty = false; scheduleFooterAttach(); }
        }, 60);
    }
    const chromeHeightCache = new Map();
    // Измерения зеркал копятся и выполняются пачкой (`dom.measureRects`): при параллельной подготовке нескольких строк
    // (прелаунч окна, камера предзагрузки) браузер делает ОДНУ принудительную раскладку на пачку вместо одной на строку.
    let measureQueue = [];
    let measureTimer = null;
    function measureBatched(el) {
        return new Promise((resolve, reject) => {
            measureQueue.push({ el, resolve, reject });
            if (!measureTimer) measureTimer = setTimeout(flushMeasure, MEASURE_BATCH_MS);
        });
    }
    async function flushMeasure() {
        const queue = measureQueue;
        measureQueue = [];
        measureTimer = null;
        try {
            let rects = await serviceOrNull('dom.measureRects', { els: queue.map(item => item.el) });
            if (!rects) rects = await Promise.all(queue.map(item => serviceOrThrow('dom.measureRect', { el: item.el })));
            queue.forEach((item, i) => item.resolve(rects[i]));
        } catch (error) {
            queue.forEach(item => item.reject(error));
        }
    }
    const bodyHeights = new Map();      // mesid -> последняя измеренная высота тела (нужна, когда тело пришло из постоянного кэша без зеркала)
    let cssHashCache = { css: null, hash: '' };
    let lastNeeded = new Set();         // mesid'ы, для которых были загружены текстура+зеркало на ПРЕДЫДУЩЕМ render()
    let lastNeededGlyphs = new Set();   // headerMesid'ы глифов, чей фон был на экране на ПРЕДЫДУЩЕМ render()
    let lastTotalHeight = 0;            // сумма высот ВСЕХ сообщений — для родного скроллбара обёртки в UI движка

    const subscriptions = [];

    async function serviceOrThrow(contract, params) {
        const result = await request(host.services, contract, { params });
        if (!result.ok) throw new Error(result.error.message);
        return result.value;
    }

    async function serviceOrNull(contract, params) {
        const result = await request(host.services, contract, { params });
        return result.ok ? result.value : null;
    }

    /**
     * `ui.messageFooter.*` — НАЙДЕНО ЖИВЬЁМ, дважды подряд. Во-первых, эти
     * контракты зарегистрированы `message-footer.js` на шине 'cores' (тем
     * же `host.own.register`), а не 'services' — вызов через `serviceOrNull`
     * (который ходит в `host.services`) молча проваливался («ok: false» →
     * `null`, контракта там просто нет). Во-вторых, `host.cores` для
     * САМОГО этого Ядра (оно и есть Ядро, домашняя шина уже 'cores') не
     * существует вовсе — `engine.js`'s `registerCaller()` заводит по
     * гейтовому accessor'у ТОЛЬКО на ДРУГИЕ домены (`gates['cores'] =
     * {services, modules, network}`), а Ядро↔Ядро НЕ пересекает границу
     * домена — оба сидят на ОДНОЙ И ТОЙ ЖЕ шине 'cores', обмен идёт через
     * `host.own` (её же используют регистрации ЭТОГО САМОГО Ядра чуть выше)
     * без всякого Гейта. `modules/time/index.js`'s `call()` зовёт те же
     * контракты через `host.cores` НЕ случайно — Модуль↔Ядро ДЕЙСТВИТЕЛЬНО
     * пересекает домен, гейт там есть; у Ядра-вызывающего этой же цели
     * нужен другой accessor.
     */
    async function coreOrNull(contract, params) {
        const result = await request(host.own, contract, { params });
        return result.ok ? result.value : null;
    }

    /** HTML тела сообщения, уже раскрашенный по говорящим (Ядро говорящего, `speaker.paintHtml`), если оно есть и есть что красить. */
    async function paintedBodyHtml(message) {
        const formatted = await serviceOrThrow('stChat.formatMessage', { mesid: message.mesid });
        const painted = await coreOrNull('speaker.paintHtml', { html: formatted, mesid: message.mesid, defaultSpeakerName: message.name });
        return typeof painted === 'string' ? painted : formatted;
    }

    /** Ширина, доступная САМОМУ телу сообщения — `viewportWidth` за вычетом `TEXT_PADDING` с обеих сторон. Вычисляется по требованию (не кешируется), чтобы `setViewport()`'s изменение `viewportWidth` подхватывалось следующим же `render()` без отдельной синхронизации. */
    function contentWidth() {
        return Math.max(1, viewportWidth - TEXT_PADDING * 2);
    }

    // `includeSystem: true` — НАЙДЕНО ЖИВЬЁМ: `stChat.messages` по умолчанию
    // (`includeSystem: false`) выкидывает ВСЕ `is_system`-сообщения — это
    // подходящий дефолт для потребителей вроде памяти/макросов, которым
    // системный шум не нужен, но НЕ для Chat Viewport, чья задача —
    // показывать то же самое, что видит пользователь в родном чате. Реальная
    // ST `is_system` НЕ прячет: `style.css` лишь чуть иначе стилизует такие
    // сообщения (`grayscale` на аватарке и т.п.), сам текст остаётся видимым
    // в `#chat`. Из-за этого пропадали, например, системные уведомления о
    // вызове инструмента (`<details><summary>Tool calls: ...`) — целое
    // сообщение молча не долетало до рендера.
    async function readOrderedMessages() {
        return (await serviceOrNull('stChat.messages', { limit: Number.MAX_SAFE_INTEGER, includeSystem: true })) ?? [];
    }

    /** Зеркало создаётся один раз на `mesid`, дальше только обновляется — пересоздание сорвало бы `ResizeObserver`/фокус выделения без нужды. */
    async function ensureMirror(mesid) {
        let mirror = mirrors.get(mesid);
        if (mirror) return mirror;
        mirror = await serviceOrThrow('dom.createElement', { tag: 'div' });
        await serviceOrThrow('dom.setProp', { el: mirror, key: 'class', value: MIRROR_CLASS });
        await serviceOrThrow('dom.setProp', { el: mirror, key: 'style', value: { width: `${contentWidth()}px` } });
        await serviceOrThrow('dom.append', { parent: mirrorContainer, child: mirror });
        mirrors.set(mesid, mirror);
        return mirror;
    }

    /**
     * Дерево ОДНОЙ строки хрома — построено РОВНО ОДИН РАЗ на `mesid`
     * (см. `ensureRowChrome`), дальше живёт только через свои сигналы.
     * Позиция (`state.position`) и контент (`state.content`) — РАЗНЫЕ
     * `computed()`, каждый в своей реактивной области diff.js: скролл
     * трогает только позицию, не пересобирая шапку/кнопки.
     */
    function buildRowTree(mesid, state) {
        return h('div', {
            class: 'stme-chat-viewport-row',
            style: computed(() => ({
                position: 'absolute', top: '0px', left: '0px',
                transform: `translateY(${state.position().y}px)`,
                width: `${state.position().width}px`,
                paddingTop: `${state.content().padTop ?? ROW_PAD}px`,
                paddingBottom: `${state.content().padBottom ?? ROW_PAD}px`,
                // ВЫСОТА НЕ ставится явно — намеренно. Первая версия ставила
                // сюда `state.position().height`, а `ensureRowChrome()` тут же
                // измерял ЭТОТ ЖЕ узел через `dom.measureRect` — циклическая
                // зависимость: на первом кадре высота ещё 0 (значение по
                // умолчанию), измерение получало почти 0 вместо настоящих
                // ~56px, и весь расчёт строки съезжал (поймано живьём в
                // харнессе: шапка/тело реально накладывались друг на друга).
                // Без явной высоты узел сам принимает высоту своего контента
                // (аватар+имя+бейджи/кнопки) — то самое число, что и нужно
                // измерить.
            })),
        }, computed(() => {
            const c = state.content();
            // Правка ПРЯМО В СООБЩЕНИИ: пока `editing`, картинка тела (WebGL-квад) не рисуется (см. `render()`), а на её место
            // встаёт настоящий <textarea> ровно по границам тела; хром (аватар, имя, кнопки) остаётся на месте.
            const rect = state.editing() ? state.editRect() : null;
            const finishEdit = async save => {
                if (save) await editMessage({ mesid, text: state.draft() });
                state.editing.set(false);
                state.editRect.set(null);
                await render({ fresh: false });
            };
            const editOverlay = rect ? h('div', {
                class: 'stme-chat-viewport-edit-inline',
                style: { position: 'absolute', left: `${TEXT_PADDING}px`, top: `${rect.top}px`, width: `${contentWidth()}px`, height: `${rect.height}px` },
            },
                h('textarea', {
                    class: 'text_pole stme-chat-viewport-edit-area',
                    value: state.draft,
                    'on:input': event => state.draft.set(event.target.value),
                    'on:keydown': event => {
                        if (event.key === 'Escape') { event.preventDefault(); finishEdit(false); }
                        else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); finishEdit(true); }
                    },
                }),
                h('div', { class: 'stme-chat-viewport-edit-buttons' },
                    Button('Save', () => finishEdit(true)),
                    Button('Cancel', () => finishEdit(false)),
                ),
            ) : null;
            // Кнопки — В ТОМ ЖЕ ряду, что имя (не отдельной строкой
            // ниже) и показываются только при наведении на строку
            // целиком — оба решения владельца, реализованы CSS'ом
            // (`.stme-message-header-name-row:hover .stme-message-
            // actions`), а не логикой здесь.
            // `c.isLast` гейтит свайп/реролл — см. doc-comment у
            // `isLast` в `render()`: сама ST функционально способна
            // свайпать/регенерировать ТОЛЬКО последнее сообщение
            // чата, показывать эти кнопки на остальных — предлагать
            // действие, которое либо молча ничего не сделает
            // (свайп), либо неожиданно удалит и перегенерирует
            // СОВСЕМ ДРУГОЕ сообщение (реролл).
            const actions = MessageActionsRow({
                onEdit: async () => { state.draft.set(c.text); state.editing.set(true); await render({ fresh: false }); setTimeout(() => serviceOrNull('dom.focusSelector', { el: chromeRoots.get(mesid), selector: '.stme-chat-viewport-edit-area' }), 250); },
                onDelete: () => deleteMessage({ mesid }),
                onSwipeLeft: (c.isLast && c.swipeCount > 1) ? () => swipe({ mesid, direction: 'left' }) : null,
                onSwipeRight: (c.isLast && c.swipeCount > 1) ? () => swipe({ mesid, direction: 'right' }) : null,
                onRegenerate: (c.isLast && !c.isUser) ? () => regenerate() : null,
                swipeIndex: c.swipeIndex, swipeCount: c.swipeCount,
            });
            // `c.isGlyphStart` — owner: "Картинка и название и номер
            // привязывается только к началу глифа" — аватар/имя/бейджи
            // рисуются ТОЛЬКО у первого сообщения цепочки (`computeGlyphs()`,
            // `render()` ниже); продолжение цепочки получает только строку
            // действий, но в ТОМ ЖЕ по классу "именном" ряду
            // (`.stme-message-header-name-row`) — исключительно чтобы
            // сохранить тот же hover-reveal CSS, действия должны так же
            // прятаться/появляться по наведению у каждого блока внутри
            // глифа, не только у первого.
            return h('div', {},
                // `.stme-chat-viewport-avatar-col` — owner: "Оно должно быть
                // СПРАВА от аватарки. Блоки ризонинга тоже. И только после
                // заполнения той зоны спускаться вниз." НАСТОЯЩИЙ CSS
                // `float: left` (panel.css), а не `flex`-ребёнок внутри
                // шапки — floats в CSS обтекаются ЛЮБЫМ следующим блочным
                // содержимым в том же контексте форматирования, не только
                // непосредственным соседом: поставив аватарку ПЕРЕД
                // `.stme-chat-viewport-row-top`, `ReasoningBlock` И
                // `.stme-toolcall-body` (все — дальнейшие сиблинги здесь),
                // все они САМИ обтекают её, без единой строчки кода под
                // каждый из них отдельно. Намеренно БЕЗ `overflow`/
                // clearfix на этом узле или его предках (см. doc-comment
                // `AVATAR_HEIGHT` выше) — `dom.measureRect()` в
                // `ensureRowChrome()` должен видеть ТОЛЬКО высоту
                // реального содержимого (имя+дата+ризонинг+ToolCall), а не
                // раздутую до высоты аватарки: `render()` ниже сам решает,
                // остался ли ещё "зазор" под аватаркой, который должно
                // занять уже тело сообщения (WebGL-текстура, обтекать
                // умеет только через свою отдельную заглушку — не через
                // этот float).
                c.isGlyphStart ? h('div', { class: 'stme-chat-viewport-avatar-col' }, Avatar(c.avatarUrl, { name: c.name }), GenStripe(c.genStatus)) : null,
                // `.stme-chat-viewport-content-col` — НАЙДЕНО ЖИВЬЁМ: `root`
                // (сам `.stme-chat-viewport-row`) — `position: absolute`
                // (см. его inline-стиль выше, нужен виртуализации), а
                // `position: absolute` САМ ПО СЕБЕ безусловно заводит новый
                // block formatting context независимо от `overflow` — док-
                // комментарий у `AVATAR_HEIGHT` ошибочно предполагал, что
                // БЕЗ `overflow`/clearfix на `root` `dom.measureRect(root)`
                // не увидит высоту float-аватарки; на деле именно `position:
                // absolute` эту BFC и завёл, и `chromeHeight` ВСЕГДА
                // получался >= `AVATAR_HEIGHT` (родительский `root` ИЗ-ЗА
                // BFC растягивается под float) — `avatarRemainder` выходил
                // 0 для КАЖДОЙ строки, спейсер никогда не добавлялся, тело
                // обтекания не видело. Обёртка здесь — обычный блочный
                // сиблинг float-аватарки (сама БЕЗ `position`/`overflow`,
                // никакого своего BFC) — её СОБСТВЕННАЯ высота считается
                // только по ЕЁ ЖЕ содержимому (имя+дата+ризонинг+ToolCall),
                // float-сосед на высоту сиблинга не влияет (влияет только на
                // высоту СВОЕГО родителя, если тот без BFC, и на строки
                // ВНУТРИ сиблинга — что и нужно, обтекание ниже продолжает
                // работать как раньше). `ensureRowChrome()` теперь измеряет
                // ИМЕННО этот узел, не `root`.
                // Продолжение глифа: аватарки в этой строке нет, но она может
                // лежать в зоне аватарки первой строки — невидимый float
                // высотой в остаток зоны, чтобы хром обтекал её так же.
                (!c.isGlyphStart && c.avatarFloatHeight > 0)
                    ? h('div', { class: 'stme-chat-viewport-avatar-float', style: { height: `${c.avatarFloatHeight}px` } })
                    : null,
                h('div', { class: `stme-chat-viewport-content-col${c.tight ? ' stme-chat-viewport-content-col-tight' : ''}` },
                // `.stme-chat-viewport-row-top` — owner: "Компановка должна
                // быть такая: Красный прямоугольник - имя... Синий -
                // виджеты (RP Time)" — то есть РЯДОМ, на одной строке, а не
                // одно НАД другим (как эта же пара стояла в прошлой
                // версии). Шапка (или её компактная замена у продолжения
                // глифа) и заглушка подвала (`.stme-chat-viewport-footer-
                // slot`) — просто два flex-ребёнка этой строки;
                // `justify-content: space-between` (panel.css) разводит их
                // по краям сам, шапка не растягивается на всю ширину (нет
                // своего `flex`), так что место под правый (синий) виджет
                // остаётся свободным без явного расчёта его ширины здесь.
                // Сам этот `.stme-chat-viewport-row-top` — обычный блочный
                // элемент, идущий ПОСЛЕ float-аватарки (см. выше) — значит
                // он САМ обтекает её как любой другой блок, отдельно
                // ничего задавать не нужно.
                h('div', { class: `stme-chat-viewport-row-top${c.isGlyphStart ? '' : ' stme-chat-viewport-row-top-compact'}` },
                    c.isGlyphStart
                        ? MessageHeader({
                            name: c.name, turnIndex: c.turnIndex,
                            genDurationMs: c.genDurationMs, timestampText: c.sendDate, isUser: c.isUser,
                            actions,
                        })
                        : h('div', { class: 'stme-message-header stme-message-header-compact' },
                            h('div', { class: 'stme-message-header-name-row' }, actions),
                        ),
                    // `.stme-chat-viewport-footer-slot` — owner: "RP Time и
                    // прочие штуки не отображаются корректно", позже "RP
                    // Time не вверху". Заглушка того же рода, что
                    // `.stme-toolcall-body` ниже, но пуста НАВСЕГДА со
                    // стороны `h()`/diff.js: содержимое сюда кладёт НЕ это
                    // Ядро, а `message-footer.js` — своим собственным
                    // `ensureFooter()`, через `ui.messageFooter.
                    // setHostResolver` (см. `attach()` ниже), напрямую
                    // вызовом `host.append()` мимо диффинга. `message-
                    // footer.js` по умолчанию крепит подвал (бейджи вроде
                    // RP Time) в НАСТОЯЩИЙ `.mes` — а тот скрыт вместе со
                    // всем `#chat` (`display:none`), пока включён Chat
                    // Viewport; резолвер перенаправляет ЕГО ЖЕ узел подвала
                    // сюда вместо невидимого родного DOM. НЕ `stme-message-
                    // footer-slot` — тот класс уже занят `message-footer.js`'s
                    // СОБСТВЕННЫМИ внутренними ячейками (`left`/`center`/
                    // `right`), это другая, внешняя обёртка.
                    h('div', { class: 'stme-chat-viewport-footer-slot' }),
                ),
                // `onToggle: render` — НАЙДЕНО ЖИВЬЁМ: раскрытие/сворачивание
                // рассуждений меняет реальную высоту этой строки, но это
                // чисто браузерное действие (`<details>`), никакое ST-событие
                // из `REDRAW_EVENTS` тут не срабатывает — без явного вызова
                // все строки НИЖЕ оставались на старой позиции и
                // накладывались на выросшую строку. `render()` уже
                // идемпотентен и безопасен звать когда угодно (см.
                // doc-comment самой функции) — просто пересчитывает все
                // позиции заново, тем же путём, что скролл/правка/свайп.
                ReasoningBlock(c.reasoningText, { onToggle: () => { toggleRender = true; chromeHeightCache.clear(); render({ fresh: false }); } }),
                // `.stme-toolcall-body` — owner: "ToolCall не открывается".
                // Пустая ЗАГЛУШКА здесь, `h()`/`diff.js` не умеют вставлять
                // сырой HTML декларативно — реальный HTML вставляется
                // ИМПЕРАТИВНО, `dom.setInnerHtml`, сразу после монтирования
                // (`ensureRowChrome()` ниже, через `dom.querySelector` по
                // этому классу). Только для ToolCall-сообщений: у ОБЫЧНОГО
                // тела `.mes` есть основания растеризоваться в WebGL-текстуру
                // (длинный текст, часто стримится по токену) — но
                // ToolCall-сообщение приходит целиком СРАЗУ и несёт СОБСТВЕННЫЙ
                // `<details><summary>Tool calls: ...` внутри своего же `mes`.
                // Растеризованный в текстуру `<details>` — просто картинка,
                // клик по ней ничего не переключает; настоящий `<details>`
                // в реальном DOM работает бесплатно, тем же браузерным
                // механизмом, что и наш собственный `ReasoningBlock`.
                c.isToolCall ? h('div', { class: 'stme-toolcall-body' }) : null,
                editOverlay,
                ),
            );
        }));
    }

    /**
     * Хром создаётся один раз на `mesid` (как зеркало) — обновляется через
     * сигналы `state`, никогда не пересобирается целиком. Возвращает РЕАЛЬНУЮ
     * измеренную высоту хрома (0, если `createFinalUi` не дан Ядру — хром
     * опционален, тело сообщения рисуется и без него): шапка/действия — тоже
     * настоящий DOM НАД телом сообщения, и место под них нужно закладывать в
     * общую высоту строки/позицию квада тем же способом, что и высота тела
     * (измерить, а не угадать фиксированной константой) — иначе хром и текст
     * WebGL накладываются друг на друга (найдено живьём в харнессе).
     */
    async function ensureRowChrome(mesid, content) {
        if (!chromeMounts) return 0;
        let state = rowStates.get(mesid);
        if (!state) {
            state = { position: signal({ y: 0, width: viewportWidth }), content: signal(content), editing: signal(false), draft: signal(''), editRect: signal(null) };
            rowStates.set(mesid, state);
            const finalUi = chromeMounts.mount(mesid, buildRowTree(mesid, state));
            await chromeMounts.settled(mesid);
            const root = finalUi.getRoot();
            if (root) {
                chromeRoots.set(mesid, root);
                if (chromeContainer) await serviceOrNull('dom.append', { parent: chromeContainer, child: root });
            }
        } else {
            state.content.set(content);
            await chromeMounts.settled(mesid);
        }
        const root = chromeRoots.get(mesid);
        if (!root) return 0;
        // Заглушка подвала (`.stme-chat-viewport-footer-slot`, см. `buildRowTree()`)
        // — узел статичный, диффинг его не трогает и не пересоздаёт между
        // рендерами, поэтому ищем его ОДИН раз на `mesid`, как и `root`
        // самой строки. Сразу зовём `ui.messageFooter.attach()` — НАЙДЕНО
        // ЖИВЬЁМ у самого `message-footer.js` (см. его `claim()`'s doc-
        // comment: "Модуль «RP Time» занимал слот и оставался невидимым"):
        // без немедленного вызова подвал появился бы только на СЛЕДУЮЩЕЕ
        // стороннее ST-событие, а не как только у строки появилось место
        // его принять — виртуализация вносит новые строки чаще, чем летят
        // такие события.
        if (!footerSlots.has(mesid)) {
            const footerSlot = await serviceOrNull('dom.querySelector', { el: root, selector: '.stme-chat-viewport-footer-slot' });
            if (footerSlot) {
                footerSlots.set(mesid, footerSlot);
                scheduleFooterAttach();
            }
        }
        // Не кешируется: diff пересоздаёт обёртку при смене формы строки (float
        // аватарки появляется/исчезает) — старый узел оказывается отсоединён и
        // измеряется как 0x0 (найдено живьём: строки после раскрытого ризонинга
        // получали высоту 0 и налезали друг на друга).
        const contentCol = await serviceOrNull('dom.querySelector', { el: root, selector: '.stme-chat-viewport-content-col' });
        if (contentCol) contentCols.set(mesid, contentCol);
        // ToolCall — реальный HTML вставляется ИМПЕРАТИВНО в заглушку
        // (`.stme-toolcall-body`, `buildRowTree()` выше), ДО измерения
        // высоты ниже — иначе измеренная высота хрома не учла бы только что
        // вставленный контент (тот же порядок, что `syncMesid()` уже
        // соблюдает для зеркала: сначала `setInnerHtml`, потом `measureRect`).
        // `toolCallHtmlWritten` — НАЙДЕНО ЖИВЬЁМ: без сравнения "не
        // изменился — не трогаем" (тот же приём, что `rasterizedText` для
        // тела сообщения) HTML переinject'ился бы БЕЗУСЛОВНО на каждый
        // `render()` — включая тот самый рендер, который вызывает наш же
        // `toggle`-обработчик ниже. Свежераспарсенный из строки `<details>`
        // по умолчанию ЗАКРЫТ — открытие пользователем сбрасывалось бы
        // обратно долей секунды спустя, самозамкнутый цикл.
        // Кеш хранит И узел-заглушку: если её пересоздали (гонка перерисовок,
        // ремонт хрома) — сравнение по одному HTML пропустило бы запись, и
        // ToolCall оставался бы пустым (найдено живьём: строка высотой 0).
        const toolCallPlaceholder = (content.isToolCall && content.toolCallHtml)
            ? await serviceOrNull('dom.querySelector', { el: root, selector: '.stme-toolcall-body' })
            : null;
        const writtenToolCall = toolCallHtmlWritten.get(mesid);
        if (toolCallPlaceholder && (writtenToolCall?.el !== toolCallPlaceholder || writtenToolCall?.html !== content.toolCallHtml)) {
            const placeholder = toolCallPlaceholder;
            {
                await serviceOrNull('dom.setInnerHtml', { el: placeholder, html: content.toolCallHtml });
                toolCallHtmlWritten.set(mesid, { el: placeholder, html: content.toolCallHtml });
                // Тот же баг, что раньше был у `ReasoningBlock` (см. его
                // `onToggle` doc-comment) — раскрытие СОБСТВЕННОГО
                // `<details>` ToolCall-сообщения (вставлен сырым HTML,
                // никакого `h()`-дерева/`on:toggle` у него в принципе нет)
                // точно так же меняет реальную высоту строки, а `render()`
                // сам по себе не узнаёт. `'toggle'` слушается на КОНТЕЙНЕРЕ
                // (делегирование — их может быть НЕСКОЛЬКО `<details>` на
                // одно ToolCall-сообщение, навешивать на каждый по
                // отдельности нечем) — ставится ЗДЕСЬ же, только когда HTML
                // реально только что обновился (сам placeholder-узел не
                // пересоздаётся между обновлениями, слушатель остаётся
                // валиден и без повторной установки). `:capture` — НАЙДЕНО
                // ЖИВЬЁМ: обычное всплытие (`on:toggle`) НЕ срабатывало на
                // реальный клик —
                // `toggle` в этом браузере не всплывает (`bubbles: false`),
                // хотя синтетический `bubbles:true`-эвент в тесте ложно
                // создавал впечатление, что делегирование работает. Фаза
                // capture ловит событие на пути вниз независимо от
                // всплытия — см. doc-comment `services/dom.js`'s `setProp()`.
                await serviceOrNull('dom.setProp', { el: placeholder, key: 'on:toggle:capture', value: () => { toggleRender = true; chromeHeightCache.clear(); render({ fresh: false }); } });
            }
        }
        // `contentCols.get(mesid) ?? root` — НАЙДЕНО ЖИВЬЁМ: измерять надо
        // `.stme-chat-viewport-content-col` (имя+дата+ризонинг+ToolCall,
        // БЕЗ аватарки — см. её doc-comment в `buildRowTree()`), не сам
        // `root` — `root` имеет `position: absolute` (виртуализация), а это
        // САМО ПО СЕБЕ заводит BFC независимо от `overflow`, из-за чего
        // `dom.measureRect(root)` всегда включал полную высоту float-
        // аватарки. Фолбэк на `root` — строки без `c.isGlyphStart` (нет
        // аватарки вовсе, `.stme-chat-viewport-content-col` не оборачивает
        // ничего специально, но `root`'s auto-height тогда и так корректна
        // — обёртка есть у ВСЕХ строк, см. `buildRowTree()`, так что этот
        // фолбэк практически не нужен, только на случай сбоя querySelector.
        const { text: _omitted, ...chromeContent } = content;
        const sig = `${viewportWidth}|${hashString(JSON.stringify(chromeContent))}`;
        const cached = chromeHeightCache.get(mesid);
        if (cached && cached.sig === sig) return cached.height;
        const measureTarget = contentCols.get(mesid) ?? root;
        const rect = await serviceOrNull('dom.measureRect', { el: measureTarget });
        // Padding строки (`root`) в измеряемую обёртку не входит — добавляем.
        const measured = (content.padTop ?? ROW_PAD) + (content.padBottom ?? ROW_PAD) + Math.max(0, Math.round(rect?.height ?? 0));
        chromeHeightCache.set(mesid, { sig, height: measured });
        return measured;
    }

    /** `chromeMounts.unmount()` только останавливает диффинг — сам корневой узел из документа не убирает (см. ui-mount-registry.js), поэтому `dom.remove` вызывается здесь явно, тем же приёмом, что `message-footer.js`'s `forget()`. */
    async function forgetRowChrome(mesid) {
        if (!chromeMounts) return;
        chromeMounts.unmount(mesid);
        rowStates.delete(mesid);
        chromeHeightCache.delete(mesid);
        rowPositionApplied.delete(mesid);
        toolCallHtmlWritten.delete(mesid);
        footerSlots.delete(mesid);
        contentCols.delete(mesid);
        imageLayers.delete(mesid);
        const root = chromeRoots.get(mesid);
        if (root) {
            await serviceOrNull('dom.remove', { node: root });
            chromeRoots.delete(mesid);
        }
    }

    /**
     * Фон одного глифа (owner: "Глифы должны иметь отдельный бэкграунд, в
     * стиле всего движка") — обычный статичный `<div>`, не через `h()`/
     * реактивность: ему нечего диффить, только позиция/высота меняются
     * каждый `render()`, а это дешевле выставить напрямую через `dom.setProp`
     * (тот же приём, что канвас/хром-контейнер уже используют для СВОИХ
     * позиций в `cores/ui/engine-panel.js`).
     *
     * Добавляется в `canvas.parentElement` (тот же `stickyLayer`, что несёт
     * канвас и хром), а не в `chromeContainer` — фон обязан быть ПОД
     * WebGL-текстом, иначе непрозрачный фон перекрыл бы тело сообщения,
     * нарисованное на канвасе. `z-index: -1` — фон соседствует с канвасом/
     * хромом в ОДНОМ общем родителе без явного `z-index` у них (оба —
     * `auto`, эффективно `0`), поэтому `-1` гарантированно кладёт фон НИЖЕ
     * обоих независимо от порядка добавления в DOM — не нужен свой
     * `dom.insertBefore` (которого у Сервиса и нет).
     */
    async function ensureGlyphBg(headerMesid) {
        let bg = glyphBgRoots.get(headerMesid);
        if (!bg) {
            const parent = canvas ? await serviceOrNull('dom.parentElement', { el: canvas }) : null;
            if (!parent) return null;
            bg = await serviceOrThrow('dom.createElement', { tag: 'div' });
            await serviceOrThrow('dom.setProp', { el: bg, key: 'class', value: 'stme-chat-viewport-glyph-bg' });
            await serviceOrThrow('dom.setProp', { el: bg, key: 'style', value: { position: 'absolute', left: '0px', top: '0px', zIndex: -1 } });
            await serviceOrThrow('dom.append', { parent, child: bg });
            glyphBgRoots.set(headerMesid, bg);
        }
        return bg;
    }

    async function forgetGlyphBg(headerMesid) {
        const bg = glyphBgRoots.get(headerMesid);
        if (bg) {
            await serviceOrNull('dom.remove', { node: bg });
            glyphBgRoots.delete(headerMesid);
            glyphBgApplied.delete(headerMesid);
        }
    }

    async function forgetBody(mesid) {
        const mirror = mirrors.get(mesid);
        if (mirror) {
            await serviceOrNull('dom.remove', { node: mirror });
            mirrors.delete(mesid);
        }
        await serviceOrNull('webglChat.releaseTexture', { canvas: textureHome.get(mesid) ?? canvas, textureId: mesid });
        textureHome.delete(mesid);
        rasterizedText.delete(mesid);
        physicalTextureSize.delete(mesid);
        bodyUse.delete(mesid);
        bodyImages.delete(mesid);
        bodyHeights.delete(mesid);
    }

    async function forgetMesid(mesid) {
        await forgetBody(mesid);
        await forgetRowChrome(mesid);
    }

    function textureBytes() {
        let total = 0;
        for (const size of physicalTextureSize.values()) total += size.width * size.height * 4;
        return total;
    }

    /** Вытесняет самые давние тела вне окна, пока не влезем в бюджет. */
    async function enforceBudget(protectedSet) {
        if (textureBudgetBytes == null) return;
        for (const mesid of [...bodyUse.keys()]) {
            if (textureBytes() <= textureBudgetBytes) break;
            if (protectedSet.has(mesid)) continue;
            await forgetBody(mesid);
        }
    }

    /**
     * Заглушка-обтекание для ОСТАВШЕЙСЯ высоты аватарки — owner: "И только
     * после заполнения той зоны спускаться вниз". `avatarRemainder`
     * (считает `render()`: `AVATAR_HEIGHT - chromeHeight`, где
     * `chromeHeight` — измеренная высота ТОЛЬКО реального контента шапки/
     * ризонинга/ToolCall, БЕЗ аватарки, см. её doc-comment) — сколько
     * высоты аватарки хром САМ не занял и должно занять тело. `0` — хром
     * (имя+дата+ризонинг+ToolCall) уже сам дотянулся до низа аватарки или
     * ниже, обтекать больше нечего, спейсер не нужен вовсе (и не
     * добавляется — иначе именно он и раздувал бы короткие сообщения
     * пустым хвостом, как в первой попытке этой же фичи). Настоящий
     * `float:left` браузера ВНУТРИ того же `foreignObject`, что и так уже
     * рисует тело (не угаданный отступ) — реальный текст сам обтекает эту
     * невидимую (`visibility:hidden`, не `display:none` — тот убрал бы
     * элемент из потока, обтекание не сработало бы) коробку.
     */
    function avatarSpacerHtml(avatarRemainder) {
        if (!(avatarRemainder > 0)) return '';
        return `<div style="float:left;width:${AVATAR_SPACER_WIDTH}px;height:${avatarRemainder}px;visibility:hidden;" aria-hidden="true"></div>`;
    }

    /**
     * Приводит зеркало+текстуру ОДНОГО сообщения в соответствие с его
     * текущим текстом. Не делает ничего, если текст с прошлого прохода не
     * изменился (`rasterizedText` — тот же приём кеша, что у остального
     * движка: сравнить с тем, что писали МЫ, а не гадать по побочным
     * признакам). `avatarRemainder` ВХОДИТ в ключ кеша — НАЙДЕНО ЖИВЬЁМ:
     * тот же текст МОЖЕТ потребовать другую заглушку, если СОСЕДНЕЕ
     * сообщение изменилось (реролл/правка/тоггл ризонинга) настолько, что
     * поменялась измеренная высота ХРОМА этого же сообщения — сам текст
     * при этом не тронут, кеш по одному только `text` решил бы "ничего не
     * изменилось". Возвращает измеренную высоту строки (для `heights`).
     */
    async function syncMesid(message, avatarRemainder = 0) {
        const { mesid } = message;
        const key = `${avatarRemainder}::${message.text}`;
        const inflight = syncInflight.get(mesid);
        if (inflight) {
            if (inflight.key === key) return inflight.promise;
            await inflight.promise.catch(() => {});
        }
        const promise = syncMesidRun(message, avatarRemainder);
        syncInflight.set(mesid, { key, promise });
        try { return await promise; } finally { if (syncInflight.get(mesid)?.promise === promise) syncInflight.delete(mesid); }
    }

    async function syncMesidRun(message, avatarRemainder = 0) {
        const { mesid, text } = message;
        const html = avatarSpacerHtml(avatarRemainder) + await paintedBodyHtml(message);

        // Сравнение с тем, что записали МЫ прошлый раз — тот же приём, что
        // `dom.js`'s `lastWritten`: без него растеризация/загрузка текстуры
        // повторялась бы на КАЖДЫЙ render(), а не только когда текст реально
        // изменился (стриминг зовёт render() на каждый токен ДРУГОГО
        // сообщения тоже — это не повод перерисовывать текущее).
        const cacheKey = `${avatarRemainder}::${text}`;
        const home = (lastCanvas && mesid === lastBodyMesid) ? lastCanvas : canvas;
        const oldHome = textureHome.get(mesid);
        const homeMoved = oldHome !== undefined && oldHome !== home;
        if (homeMoved) {
            // Сообщение стало (или перестало быть) последним — текстуру надо перенести на другой канвас.
            await serviceOrNull('webglChat.releaseTexture', { canvas: oldHome, textureId: mesid });
            textureHome.delete(mesid);
            rasterizedText.delete(mesid);
        }
        const changed = rasterizedText.get(mesid) !== cacheKey;
        if (!changed && !mirrors.has(mesid) && bodyHeights.has(mesid)) return bodyHeights.get(mesid);

        // Постоянный кэш (IndexedDB): готовая строка + измеренная высота + позиции картинок — без зеркала и растеризации.
        let diskKey = null;
        if (changed && persistentCache) {
            if (cssHashCache.css !== css) cssHashCache = { css, hash: hashString(css) };
            diskKey = `${hashString(html)}.${html.length}.${cssHashCache.hash}.${contentWidth()}.${devicePixelRatio}`;
            const hit = await serviceOrNull('rasterCache.get', { key: diskKey });
            if (hit?.image) {
                await serviceOrThrow('webglChat.uploadTexture', { canvas: home, textureId: mesid, image: hit.image });
                textureHome.set(mesid, home);
                if (home === lastCanvas) dirtyLast = true; else dirtyMain = true;
                rasterizedText.set(mesid, cacheKey);
                physicalTextureSize.set(mesid, { width: hit.width, height: hit.physHeight });
                if (hit.images?.length) bodyImages.set(mesid, hit.images); else bodyImages.delete(mesid);
                bodyHeights.set(mesid, hit.height);
                return hit.height;
            }
        }

        const mirror = await ensureMirror(mesid);
        let rasterHtml = html;
        if (changed) {
            await serviceOrThrow('dom.setInnerHtml', { el: mirror, html });
            // Картинки: дождаться загрузки (иначе высота зеркала замерится без них), снять позиции, подменить пустышками.
            const prepared = await serviceOrNull('dom.prepareImages', { el: mirror });
            if (prepared?.images?.length) { bodyImages.set(mesid, prepared.images); rasterHtml = prepared.html; }
            else bodyImages.delete(mesid);
        }

        // `Number.isFinite(...) ? ... : rowHeight`, НЕ `Math.round(...) ||
        // rowHeight` — НАЙДЕНО ЖИВЬЁМ, owner: "Пустые блоки... не должны
        // иметь этот спейс". `||` считает `0` ЛОЖНЫМ значением в JS — у
        // ГЕНУИННО пустого сообщения (`mes: ""`, реальный случай: модель
        // "подумала", но ничего не ответила) зеркало корректно измеряет
        // `rect.height === 0`, но `0 || rowHeight` отбрасывало этот
        // ПРАВИЛЬНЫЙ нулевой результат и подставляло `rowHeight` (96px по
        // умолчанию) — пустое сообщение получало пустой блок ВЫСОТОЙ В ЦЕЛУЮ
        // СТРОКУ вместо честного "почти ничего". `rowHeight`-фолбэк должен
        // срабатывать ТОЛЬКО когда измерение вообще не удалось (не число),
        // а не когда оно честно вернуло ноль.
        const rect = await measureBatched(mirror);
        const height = Math.max(1, Number.isFinite(rect.height) ? Math.round(rect.height) : rowHeight);

        if (changed) {
            // `width`/`height` здесь ЛОГИЧЕСКИЕ (совпадают с тем, что измерило
            // зеркало) — физическое разрешение растра задаёт `scale`, а не эти
            // два числа: без этого на экране с devicePixelRatio > 1 текстура
            // растеризовалась бы В РАЗРЕШЕНИИ ЭКРАНА БЕЗ УЧЁТА DPR и потом
            // растягивалась GPU при отрисовке квада большего физического
            // размера — то самое "текст слишком пиксельный".
            const rasterized = await serviceOrThrow('htmlRasterizer.rasterize', { html: rasterHtml, width: contentWidth(), height, css, scale: devicePixelRatio });
            await serviceOrThrow('webglChat.uploadTexture', { canvas: home, textureId: mesid, image: rasterized.image });
            textureHome.set(mesid, home);
            if (home === lastCanvas) dirtyLast = true; else dirtyMain = true;
            rasterizedText.set(mesid, cacheKey);
            physicalTextureSize.set(mesid, { width: rasterized.width, height: rasterized.height });
            if (diskKey) {
                serviceOrNull('rasterCache.put', {
                    key: diskKey, image: rasterized.image, height, width: rasterized.width, physHeight: rasterized.height, images: bodyImages.get(mesid) ?? [],
                }).catch(() => {});
            }
        }

        bodyHeights.set(mesid, height);
        return height;
    }

    function escapeAttr(value) {
        return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    }

    /** Картинки тела — настоящий DOM в хроме строки, под тем же смещением, что и квад тела (`TEXT_PADDING`, `chromeHeight`). */
    async function syncBodyImages(mesid, chromeHeight) {
        const root = chromeRoots.get(mesid);
        if (!root) return;
        const images = bodyImages.get(mesid) ?? [];
        let entry = imageLayers.get(mesid);
        if (entry && (entry.root !== root || images.length === 0)) {
            await serviceOrNull('dom.remove', { node: entry.layer });
            imageLayers.delete(mesid);
            entry = null;
        }
        if (images.length === 0) return;
        if (!entry) {
            const layer = await serviceOrThrow('dom.createElement', { tag: 'div' });
            await serviceOrThrow('dom.setProp', { el: layer, key: 'class', value: 'stme-chat-viewport-body-images' });
            await serviceOrThrow('dom.setProp', { el: layer, key: 'style', value: { position: 'absolute', left: `${TEXT_PADDING}px`, top: `${chromeHeight}px`, width: '0px', height: '0px', pointerEvents: 'none', contain: 'layout style' } });
            await serviceOrThrow('dom.append', { parent: root, child: layer });
            entry = { layer, root, key: null };
            imageLayers.set(mesid, entry);
        }
        const key = JSON.stringify(images.map(i => [i.src, i.x, i.y, i.width, i.height]));
        if (entry.key !== key) {
            const html = images.map(i => `<img src="${escapeAttr(i.src)}" alt="" style="position:absolute;left:${i.x}px;top:${i.y}px;width:${i.width}px;height:${i.height}px;">`).join('');
            await serviceOrThrow('dom.setInnerHtml', { el: entry.layer, html });
            entry.key = key;
        }
        await serviceOrThrow('dom.setProp', { el: entry.layer, key: 'style', value: { top: `${chromeHeight}px` } });
    }

    /** Оценка заглушки под аватарку для строки, которой ещё не было на экране. */
    function guessRemainder(frame, idx) {
        const { order, byMesid, glyphHeaderByMesid } = frame;
        const mesid = order[idx];
        const message = byMesid.get(mesid);
        if (!chromeMounts || message.isToolCall) return 0;
        const head = glyphHeaderByMesid.get(mesid) ?? mesid;
        let offset = 0;
        for (let i = frame.indexByMesid.get(head) ?? -1; i >= 0 && i < idx; i++) {
            offset += (heights.get(order[i]) ?? rowHeight) - (order[i] === head && head !== order[0] ? GLYPH_GAP : 0);
        }
        let chrome = lastChromeHeight.get(mesid);
        if (chrome === undefined) {
            if (mesid === head) {
                const next = byMesid.get(order[idx + 1]);
                const cot = m => !!(m && (m.isToolCall || m.reasoningText));
                const nextTight = next && glyphHeaderByMesid.get(order[idx + 1]) === head && cot(next);
                chrome = ROW_PAD + ((cot(message) || nextTight) ? 0 : ROW_PAD) + 43 + (message.reasoningText ? 29 : 0);
            } else chrome = 15;
        }
        return Math.max(0, AVATAR_WRAP - (offset + chrome));
    }

    /** Уровень 3: канвас под тело последнего сообщения — своя позиция (transform), свой размер ступенями, своя перерисовка. */
    async function drawLastCanvas(placement) {
        if (!placement) {
            if (lastTransformL3 !== 'hidden') {
                await serviceOrNull('dom.setProp', { el: lastCanvas, key: 'style', value: { display: 'none' } });
                lastTransformL3 = 'hidden';
            }
            return;
        }
        const { physicalSize, cssX, cssY } = placement;
        const wantW = Math.min(MAX_CANVAS_CSS, Math.ceil(physicalSize.width / devicePixelRatio));
        const needH = Math.ceil(physicalSize.height / devicePixelRatio);
        const stepped = Math.min(MAX_CANVAS_CSS, Math.ceil(needH / LAST_CANVAS_STEP) * LAST_CANVAS_STEP);
        if (wantW !== lastCanvasSize.w || needH > lastCanvasSize.h || stepped < lastCanvasSize.h - 2 * LAST_CANVAS_STEP) {
            lastCanvasSize = { w: wantW, h: stepped };
            await serviceOrThrow('webglChat.resize', { canvas: lastCanvas, width: Math.round(wantW * devicePixelRatio), height: Math.round(stepped * devicePixelRatio) });
            await serviceOrThrow('dom.setProp', { el: lastCanvas, key: 'style', value: { width: `${wantW}px`, height: `${stepped}px` } });
            dirtyLast = true;
        }
        const transform = `translate(${cssX}px, ${Math.round(cssY * 100) / 100}px)`;
        if (transform !== lastTransformL3) {
            await serviceOrNull('dom.setProp', { el: lastCanvas, key: 'style', value: { display: 'block', transform } });
            lastTransformL3 = transform;
        }
        const quad = { textureId: placement.mesid, x: 0, y: 0, width: physicalSize.width, height: physicalSize.height };
        const key = JSON.stringify(quad);
        if (dirtyLast || key !== lastQuadKeyL3) {
            await serviceOrNull('webglChat.drawFrame', { canvas: lastCanvas, quads: [quad] });
            lastQuadKeyL3 = key;
            dirtyLast = false;
        }
    }

    function schedulePrefetch() {
        if (!(prefetchScreens > 0) || !lastFrame || prefetchRunning) return;
        prefetchRunning = true;
        setTimeout(() => { pumpPrefetch().catch(() => {}).finally(() => { prefetchRunning = false; }); }, 20);
    }

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    /**
     * Фоновый прогрев кэша ВСЕГО чата: в простое, по одной строке, от текущего места наружу (вперёд и назад по очереди).
     * Строки, которых нет на диске, растеризуются и пишутся в постоянный кэш (`rasterCache`, переживает перезагрузку), а
     * текстура тут же освобождается — GPU держит только окно у экрана. Останавливается при прокрутке/рендере и при смене чата.
     */
    let warmRunning = false;
    async function warmChat() {
        if (!persistentCache || warmRunning) return;
        warmRunning = true;
        const gen = prefetchGen;
        try {
            const frame = lastFrame;
            if (!frame) return;
            const { order, byMesid, needed } = frame;
            const center = Math.max(0, order.findIndex(m => needed.has(m)));
            for (let d = 1; d < order.length; d += 1) {
                for (const i of [center + d, center - d]) {
                    if (i < 0 || i >= order.length) continue;
                    while (rendering || (performance.now() - lastScrollAt) < 600) {
                        await sleep(250);
                        if (gen !== prefetchGen || !attached || !enabled) return;
                    }
                    if (gen !== prefetchGen || !attached || !enabled) return;
                    const message = byMesid.get(order[i]);
                    if (!message || message.isToolCall || lastNeeded?.has(message.mesid)) continue;
                    const remainder = guessRemainder(frame, i);
                    const html = avatarSpacerHtml(remainder) + await paintedBodyHtml(message);
                    if (cssHashCache.css !== css) cssHashCache = { css, hash: hashString(css) };
                    const diskKey = `${hashString(html)}.${html.length}.${cssHashCache.hash}.${contentWidth()}.${devicePixelRatio}`;
                    if (await serviceOrNull('rasterCache.has', { key: diskKey })) continue;
                    await syncMesid(message, remainder);
                    if (!lastNeeded?.has(message.mesid)) await forgetBody(message.mesid);
                    await sleep(120);
                }
            }
        } catch { /* прогрев — best effort */ } finally { warmRunning = false; }
    }

    /**
     * Фоновая растеризация тел вокруг окна. Окно смещено ВПЕРЁД по ходу прокрутки: чем быстрее листаем, тем дальше
     * вперёд (скорость × PREFETCH_HORIZON_MS), назад — только полэкрана. Ближайшие по ходу движения строки первыми,
     * `prefetchConcurrency` параллельно. Цикл один и не сбрасывается новым кадром — каждый проход берёт свежий
     * `lastFrame`, поэтому предзагрузка идёт и во время прокрутки, а не только после остановки.
     */
    async function pumpPrefetch() {
        for (let pass = 0; pass < 600; pass += 1) {
            const frame = lastFrame;
            if (!frame || !attached || !enabled) return;
            if (rendering) { await sleep(16); continue; }
            if (textureBudgetBytes != null && textureBytes() > textureBudgetBytes * 0.9) return;
            const { order, byMesid, needed, frameScrollTop } = frame;
            const velocity = (performance.now() - lastVelAt) < 300 ? scrollVelocity : 0;
            const moving = Math.abs(velocity) > 0.05;
            const base = viewportHeight * prefetchScreens;
            const ahead = moving ? Math.min(viewportHeight * 30, base + Math.abs(velocity) * PREFETCH_HORIZON_MS) : base;
            const behind = moving ? viewportHeight * 0.5 : base;
            const down = velocity >= 0;
            const above = down ? behind : ahead;
            const below = down ? ahead : behind;
            const range = computeVisibleRange({
                order, heights, scrollTop: Math.max(0, frameScrollTop - above), viewportHeight: viewportHeight + above + below,
                estimatedHeight: rowHeight, overscan: 0,
            });
            const anchorFirst = order.findIndex(m => needed.has(m));
            const anchorLast = anchorFirst < 0 ? -1 : anchorFirst + needed.size - 1;
            const candidates = [];
            for (let i = range.startIndex; i < range.endIndex; i += 1) {
                const m = byMesid.get(order[i]);
                if (!m || m.isToolCall || needed.has(m.mesid)) continue;
                if (rasterizedText.get(m.mesid) === `${guessRemainder(frame, i)}::${m.text}`) continue;
                const forward = down ? i > anchorLast : i < anchorFirst;
                const distance = down ? Math.abs(i - anchorLast) : Math.abs(i - anchorFirst);
                candidates.push({ i, rank: (moving && !forward ? 100000 : 0) + distance });
            }
            if (!candidates.length) { warmChat(); return; }
            candidates.sort((x, y) => x.rank - y.rank);
            await Promise.all(candidates.slice(0, prefetchConcurrency).map(async ({ i }) => {
                const m = byMesid.get(order[i]);
                await syncMesid(m, guessRemainder(frame, i));
                bodyUse.delete(m.mesid); bodyUse.set(m.mesid, true);
            }).map(task => task.catch(() => {})));
            await sleep(0);
        }
    }

    /**
     * Идемпотентный проход: читает актуальный чат, решает окно видимости,
     * приводит зеркала/текстуры видимых сообщений в соответствие, отпускает
     * то, что вышло из окна, и рисует кадр. Безопасно звать сколько угодно
     * раз подряд — повторный вызов, пока предыдущий ещё не закончился,
     * ставится в очередь РОВНО ОДИН РАЗ (`renderQueued`), а не копится.
     */
    async function render({ fresh = true } = {}) {
        if (!attached || !enabled) return false;
        if (rendering) { renderQueued = true; if (fresh) pendingFresh = true; return false; }
        rendering = true;
        publishEvent('ui.chatViewport.render.started', {});
        try {
            // Снимок чата (сообщения, порядок, глифы) пересобирается только по событиям
            // изменения чата; обычный скролл использует прошлый — иначе каждый кадр
            // скролла заново мапил бы ВСЕ тысячи сообщений (на слабом ноутбуке это и был тормоз).
            if (fresh || !snapshot) {
                const freshMessages = await readOrderedMessages();
                const freshOrder = freshMessages.map(m => m.mesid);
                const freshGlyphHeaders = new Map();
                for (const glyph of computeGlyphs(freshMessages)) for (const id of glyph.mesids) freshGlyphHeaders.set(id, glyph.headerMesid);
                snapshot = {
                    order: freshOrder,
                    byMesid: new Map(freshMessages.map(m => [m.mesid, m])),
                    glyphHeaderByMesid: freshGlyphHeaders,
                    indexByMesid: new Map(freshOrder.map((id, i) => [id, i])),
                };
                glyphHeadOf.clear();
                for (const [id, head] of freshGlyphHeaders) glyphHeadOf.set(id, head);
            }
            const { order, byMesid, glyphHeaderByMesid, indexByMesid } = snapshot;
            {
                const tail = byMesid.get(order[order.length - 1]);
                lastBodyMesid = (lastCanvas && tail && !tail.isToolCall) ? tail.mesid : null;
            }

            // Глифы (owner: "Глиф - одна цепочка сообщений от одного
            // пользователя подряд") — считаются по ВСЕМУ чату (`messages`,
            // не только видимому окну), иначе первое видимое сообщение
            // цепочки, чей реальный заголовок остался выше окна прокрутки,
            // ошибочно решило бы, что оно само — начало глифа.

            // scrollTop фиксируется на весь проход: setViewport() может поменять его посреди await-ов, и строки одного кадра разъехались бы.
            const frameScrollTop = scrollTop;
            // Окно предрендера вдвое выше видимого (по половине высоты экрана
            // сверху и снизу): быстрый скролл иначе показывает строки, которые
            // ещё не успели растеризоваться (owner: "подгружаются прямо на экране").
            // Пока пользователь скроллит, считаем ТОЛЬКО видимые строки (быстрый кадр);
            // полное окно предрендера — отдельным проходом, когда скролл притих.
            const visibleOnly = prerenderFactor > 1 && (performance.now() - lastScrollAt) < QUICK_SCROLL_MS;
            const retainRange = computeVisibleRange({
                order, heights, scrollTop: Math.max(0, frameScrollTop - viewportHeight * (prerenderFactor - 1) / 2), viewportHeight: viewportHeight * prerenderFactor,
                estimatedHeight: rowHeight, overscan,
            });
            const range = visibleOnly
                ? computeVisibleRange({ order, heights, scrollTop: frameScrollTop, viewportHeight, estimatedHeight: rowHeight, overscan: 1 })
                : retainRange;
            const needed = new Set(order.slice(range.startIndex, range.endIndex));
            const retained = visibleOnly ? new Set(order.slice(retainRange.startIndex, retainRange.endIndex)) : needed;

            for (const mesid of lastNeeded) {
                if (retained.has(mesid)) continue;
                if (textureBudgetBytes == null) await forgetMesid(mesid);
                else await forgetRowChrome(mesid);
            }

            // Первый проход — только асинхронная работа (измерения/растеризация/
            // монтирование хрома), БЕЗ единой видимой правки DOM или канваса.
            // `positions` копится локально, а не пишется в `rowStates` сразу —
            // найдено живьём: запись `position.set()` ВНУТРИ этого цикла
            // (реактивный сигнал патчит DOM конкретной строки немедленно)
            // вперемешку с `await` на каждой итерации давала браузеру шанс
            // отрисовать кадр МЕЖДУ тем, как хром уже сдвинулся, а канвас
            // (единственный `drawFrame()` в самом конце) — ещё нет. Визуально
            // это и есть "иконки и текст едут на разных уровнях" при скролле.
            // Второй проход ниже применяет ВСЕ позиции хрома и вызывает
            // `drawFrame()` подряд, синхронно, одним куском — без `await`
            // между ними браузер не может вклиниться со своим кадром.
            let heightsChanged = false;
            let lastPlacement = null;
            let y = range.offsetTop;
            const quads = [];
            const positions = [];
            const glyphSpans = [];     // [{headerMesid, top, height}] — фон каждого глифа, В ПОРЯДКЕ появления
            const skeletonSpecs = [];  // строки, что ещё грузятся: [{ top, height }]
            const neededGlyphs = new Set();
            let glyphOffset = 0;
            {
                const first = order[range.startIndex];
                const head = glyphHeaderByMesid.get(first) ?? first;
                if (first !== undefined && head !== first) {
                    const headIndex = indexByMesid.get(head) ?? -1;
                    for (let i = headIndex; i >= 0 && i < range.startIndex; i++) {
                        glyphOffset += (heights.get(order[i]) ?? rowHeight) - (i === headIndex && head !== order[0] ? GLYPH_GAP : 0);
                    }
                }
            }
            // Растеризация тел строк окна запускается ПАРАЛЛЕЛЬНО заранее (по оценке заглушки под аватарку), а цикл
            // ниже — со своим точным значением — подхватывает уже идущую работу (`syncInflight`) или кэш. Узкое место
            // здесь — не CPU, а цепочка последовательных ожиданий (декодирование картинки и т.п.).
            {
                const frameLike = { order, byMesid, glyphHeaderByMesid, indexByMesid };
                let running = 0;
                const waiting = [];
                const runLimited = task => new Promise(resolve => {
                    const start = () => { running += 1; task().catch(() => {}).finally(() => { running -= 1; resolve(); const next = waiting.shift(); if (next) next(); }); };
                    if (running < PRELAUNCH_CONCURRENCY) start(); else waiting.push(start);
                });
                for (let idx = range.startIndex; idx < range.endIndex; idx++) {
                    const message = byMesid.get(order[idx]);
                    if (!message || message.isToolCall) continue;
                    const remainder = guessRemainder(frameLike, idx);
                    if (rasterizedText.get(message.mesid) === `${remainder}::${message.text}`) continue;
                    runLimited(() => syncMesid(message, remainder));
                }
            }
            const isCot = m => !!(m && (m.isToolCall || m.reasoningText));
            for (let idx = range.startIndex; idx < range.endIndex; idx++) {
                if (!visibleOnly && scrollTop !== frameScrollTop) return false; // пришёл новый скролл — этот кадр устарел, следующий уже в очереди
                const mesid = order[idx];
                const message = byMesid.get(mesid);
                // Быстрая прокрутка: строка, которой ещё нет ни в кэше, ни в текстурах, не показывается вовсе (место держит оценка высоты) —
                // она появляется ЦЕЛИКОМ (шапка + текст + фон) на полном проходе после остановки или когда её подготовит камера предзагрузки.
                // Раньше кадр ждал подготовки каждой такой строки по очереди, и части появлялись вразнобой.
                if (visibleOnly && !message.isToolCall && !rasterizedText.has(mesid) && !bodyHeights.has(mesid)) {
                    const estimate = (heights.get(mesid) ?? rowHeight) + ((glyphHeaderByMesid.get(mesid) === mesid && mesid !== order[0]) ? GLYPH_GAP : 0);
                    const startsGlyph = glyphHeaderByMesid.get(mesid) === mesid && mesid !== order[0];
                    skeletonSpecs.push({ top: (y + (startsGlyph ? GLYPH_GAP : 0)) - frameScrollTop, height: estimate - (startsGlyph ? GLYPH_GAP : 0) });
                    y += estimate;
                    glyphOffset += estimate;
                    continue;
                }

                // `isLast` — НАЙДЕНО ЖИВЬЁМ в реальном исходнике ST: свайп и
                // регенерация жёстко работают ТОЛЬКО с последним сообщением
                // всего чата (`isMessageSwipeable()` требует `messageId ==
                // chat.length - 1`; `Generate('regenerate')` безусловно
                // удаляет `chat[chat.length - 1]` перед генерацией новой
                // реплики — не то, с чьей кнопки был вызов). Раньше кнопки
                // свайпа/реролла показывались на КАЖДОМ сообщении — свайп на
                // не-последнем молча ничего не делал (ST её тихо отклоняет),
                // а реролл на любом сообщении всё равно удалял и
                // перегенерировал ПОСЛЕДНЕЕ, что в коротком чате легко
                // спутать с "первым". `order` — это ВЕСЬ чат (не только
                // видимое окно), поэтому `order[order.length - 1]` — реальный
                // последний mesid, а не последний из отрендеренных.
                const isLast = mesid === order[order.length - 1];
                // `isGlyphStart` — owner: "Картинка и название и номер
                // привязывается только к началу глифа" — см. `buildRowTree()`
                // выше: только начало глифа рисует `MessageHeader` целиком
                // (аватар/имя/бейджи), продолжение — только строку действий.
                const glyphHeaderMesid = glyphHeaderByMesid.get(mesid) ?? mesid;
                const isGlyphStart = glyphHeaderMesid === mesid;
                // Зазор МЕЖДУ глифами (owner: "между ними нет спейса") —
                // добавляется ДО измерения позиции этой строки, если она
                // открывает НОВЫЙ глиф — кроме самого первого сообщения
                // чата целиком (`order[0]`): зазора НЕ должно быть перед
                // первой же строкой списка, иначе прокрутка начиналась бы
                // с пустого отступа сверху.
                const gap = (isGlyphStart && mesid !== order[0]) ? GLYPH_GAP : 0;
                const topPx = (y + gap) - frameScrollTop;

                // Хром (шапка/действия) — реальный DOM НАД телом сообщения, не
                // рядом с ним: тело начинается ПОСЛЕ хрома, а не с той же `y`
                // (найдено живьём в харнессе — без сдвига WebGL-текст и хром
                // рисовались друг НА друге). `chromeHeight` — измеренная РЕАЛЬНАЯ
                // высота (тем же приёмом, что высота тела через зеркало), не
                // угаданная константа, поэтому строки с разной длиной имени/
                // рассуждений не расходятся с реальной раскладкой.
                // ToolCall — НЕ растеризуется в WebGL вообще (owner: "ToolCall
                // не открывается"): своё тело несёт СОБСТВЕННЫЙ
                // `<details><summary>Tool calls: ...` внутри `mes`, а
                // растеризованный в текстуру `<details>` — просто картинка,
                // не кликается. Вместо канваса тело идёт в реальный DOM
                // хрома (`.stme-toolcall-body`, `buildRowTree()`/
                // `ensureRowChrome()` выше) — `bodyHeight` тогда 0 (место под
                // тело уже посчитано В хроме), и квад ниже для этого mesid не
                // создаётся вовсе.
                // `chromeHeight` СЧИТАЕТСЯ ПЕРВЫМ, ДО тела — owner: "Оно
                // должно быть СПРАВА от аватарки... И только после
                // заполнения той зоны спускаться вниз". Хром (шапка/
                // ризонинг/ToolCall) намеренно измеряется БЕЗ учёта
                // аватарки (float в `buildRowTree()` без clearfix — см. её
                // doc-comment) — эта высота и есть "сколько реального
                // контента уже обтекло аватарку сверху", остаток
                // (`avatarRemainder` ниже) достаётся телу.
                const toolCallHtml = message.isToolCall ? await serviceOrThrow('stChat.formatMessage', { mesid }) : null;
                if (isGlyphStart) glyphOffset = 0;
                const nextMesid = order[idx + 1];
                const nextInGlyph = nextMesid !== undefined && glyphHeaderByMesid.get(nextMesid) === glyphHeaderMesid;
                const tight = !isGlyphStart && isCot(message);
                const nextTight = nextInGlyph && isCot(byMesid.get(nextMesid));
                const isGlyphEnd = !nextInGlyph;
                const padTop = tight ? 0 : ROW_PAD;
                const padBottom = (isCot(message) || nextTight) ? 0 : ROW_PAD;
                const avatarFloatHeight = (chromeMounts && !isGlyphStart) ? Math.max(0, AVATAR_WRAP - (glyphOffset + padTop)) : 0;
                const chromeHeight = await ensureRowChrome(mesid, {
                    padTop, padBottom, tight, avatarFloatHeight,
                    name: message.name, avatarUrl: message.avatarUrl, isUser: message.isUser,
                    turnIndex: Number(mesid), genDurationMs: message.genDurationMs, sendDate: message.sendDate,
                    reasoningText: message.reasoningText, swipeIndex: message.swipeIndex,
                    swipeCount: message.swipeCount, text: message.text, isLast, isGlyphStart,
                    isToolCall: message.isToolCall, toolCallHtml, genStatus: genStatus.get(mesid) ?? null,
                });
                // Сколько высоты аватарки хром САМ не занял — ровно на
                // столько тело должно продолжить обтекание своей отдельной
                // заглушкой (`avatarSpacerHtml()` в `syncMesid()`). `0` для
                // ToolCall (у него нет WebGL-тела вовсе, обтекать нечем), для
                // продолжений глифа (аватарки нет — обтекать нечего с самого
                // начала) и когда `chromeMounts` вовсе не задан (см.
                // `ensureRowChrome()` выше — `createFinalUi` не дан Ядру,
                // хром отключён целиком: тогда и рисовать-то нечего, никакой
                // РЕАЛЬНОЙ аватарки на экране, чтобы вокруг неё обтекать).
                lastChromeHeight.set(mesid, chromeHeight);
                bodyUse.delete(mesid); bodyUse.set(mesid, true);
                const avatarRemainder = (chromeMounts && !message.isToolCall) ? Math.max(0, AVATAR_WRAP - (glyphOffset + chromeHeight)) : 0;
                const measuredBodyHeight = message.isToolCall ? 0 : await syncMesid(message, avatarRemainder);
                // Пока сообщение правится, под поле ввода закладывается минимум ~4 строки — короткое тело иначе давало бы крошечный textarea.
                const bodyHeight = rowStates.get(mesid)?.editing() ? Math.max(measuredBodyHeight, EDIT_MIN_HEIGHT) : measuredBodyHeight;
                if (chromeMounts && !message.isToolCall) await syncBodyImages(mesid, chromeHeight);
                // Зазор входит в `totalHeight` ЭТОГО сообщения (не отдельная
                // запись) — виртуализация (`computeVisibleRange`) суммирует
                // `heights` по `mesid`, ей негде было бы учесть зазор, будь
                // он отдельной сущностью; так `y` для следующей строки и
                // `heights`-карта остаются согласованы без специального кода
                // в `chat-viewport-math.js`. `Math.max(AVATAR_HEIGHT, ...)` —
                // НАЙДЕНО ЖИВЬЁМ: `chromeHeight + bodyHeight` сам по себе
                // может оказаться КОРОЧЕ аватарки (имя+один короткий абзац
                // текста, вместе меньше 136px) — без этой поправки
                // СЛЕДУЮЩАЯ строка начиналась бы, пока аватарка этой ещё
                // видна на экране, наезжая на её нижнюю часть.
                {
                    const editState = rowStates.get(mesid);
                    if (editState?.editing()) {
                        const prev = editState.editRect.peek();
                        const height = bodyHeight;
                        if (!prev || prev.top !== chromeHeight || prev.height !== height) editState.editRect.set({ top: chromeHeight, height });
                    }
                }
                const ownHeight = chromeHeight + bodyHeight;
                const totalHeight = ((chromeMounts && isGlyphEnd) ? Math.max(GLYPH_MIN_HEIGHT - glyphOffset, ownHeight) : ownHeight) + gap;
                glyphOffset += totalHeight - gap;
                positions.push({ mesid, y: topPx, width: viewportWidth });

                // Копим span фона текущего глифа по ходу того же прохода —
                // строки одного глифа всегда идут подряд в `order`. Новый
                // span запускается на смене `glyphHeaderMesid` относительно
                // ПОСЛЕДНЕГО добавленного — НЕ на `isGlyphStart`: если
                // видимое окно начинается СЕРЕДИНОЙ глифа (его заголовок
                // прокручен выше экрана), `isGlyphStart` для самой первой
                // видимой строки будет `false`, но span для её (уже
                // невидимого) заголовка ещё не заведён — `glyphSpans` был бы
                // пуст, и `glyphSpans[-1].height` упало бы (поймано тестами).
                const lastSpan = glyphSpans[glyphSpans.length - 1];
                if (!lastSpan || lastSpan.headerMesid !== glyphHeaderMesid) {
                    glyphSpans.push({ headerMesid: glyphHeaderMesid, top: topPx, height: 0 });
                }
                glyphSpans[glyphSpans.length - 1].height += (totalHeight - gap);
                neededGlyphs.add(glyphHeaderMesid);

                const hadHeight = heights.has(mesid);
                const next = reconcileMeasuredHeight(heights, mesid, totalHeight);
                if (next) { if (hadHeight) heightsChanged = true; for (const [k, v] of next) heights.set(k, v); }

                // Квады — в ФИЗИЧЕСКИХ пикселях backing store канваса
                // (`webglChat.attach()`/`resize()` ниже уже выставили его
                // размер как `viewportWidth/Height * devicePixelRatio`) —
                // `computeQuadVertices` в webgl-renderer.js нормирует ровно по
                // `canvas.width/height`, так что единицы должны совпадать.
                // Хром — реальный DOM, остаётся в ЛОГИЧЕСКИХ пикселях (никакого
                // devicePixelRatio здесь — CSS и так рисует его резко).
                // `x: TEXT_PADDING * devicePixelRatio` — owner: "Глиф все-еще
                // слишком близко к левой и правой границе текста, без
                // спейсинга" — тело сдвинуто вправо на тот же отступ, что
                // `contentWidth()` уже вычло из ширины растеризации, иначе
                // текст оказался бы ýже фона, но всё ещё прижатым к левому
                // краю, а не отцентрован с равными полями по бокам.
                // `physicalTextureSize` — ТОЧНЫЙ размер уже загруженной
                // текстуры (см. doc-comment у самой карты выше за причиной:
                // пересчитывать `contentWidth() * devicePixelRatio` заново
                // здесь давало дробный результат при дробном DPR, на пиксель-
                // другой ШИРЕ реальной текстуры, округлённой ВНУТРИ
                // растеризатора — GPU растягивал текстуру под квад чуть
                // большего размера, `LINEAR`-фильтр честно интерполировал
                // край, и это выглядело как лёгкий блюр/ореол вокруг текста).
                // Фолбэк на пересчёт — только пока текстуры для ЭТОГО mesid
                // ещё вообще не было (первый кадр после `attach()`, до первого
                // `syncMesid()` в этом же проходе — практически никогда не
                // видим, `syncMesid()` выше уже гарантированно отработал).
                // ToolCall — нет текстуры вообще (тело целиком в хроме, см.
                // выше), значит и квада для неё нет: нечего рисовать на
                // канвасе для этого `mesid`.
                if (!message.isToolCall && !rowStates.get(mesid)?.editing()) {
                    const physicalSize = physicalTextureSize.get(mesid)
                        ?? { width: contentWidth() * devicePixelRatio, height: bodyHeight * devicePixelRatio };
                    if (lastCanvas && mesid === lastBodyMesid) {
                        lastPlacement = { mesid, cssX: TEXT_PADDING, cssY: topPx + chromeHeight, physicalSize };
                    } else {
                        quads.push({
                            textureId: mesid, x: TEXT_PADDING * devicePixelRatio,
                            y: (topPx + chromeHeight + canvasPad()) * devicePixelRatio,
                            width: physicalSize.width,
                            height: physicalSize.height,
                        });
                    }
                }
                y += totalHeight;
            }

            await applySkeletons(skeletonSpecs);
            // Строки, что держим смонтированными, но в этом быстром кадре не считали, прячем за экран — иначе они висели бы на старых позициях.
            if (visibleOnly) for (const mesid of retained) if (!needed.has(mesid) && rowStates.has(mesid)) positions.push({ mesid, y: -1e6, width: viewportWidth });
            lastNeeded = retained;
            lastFrame = { order, byMesid, glyphHeaderByMesid, indexByMesid, needed, frameScrollTop };
            await enforceBudget(retained);
            if (visibleOnly) {
                clearTimeout(fullPassTimer);
                fullPassTimer = setTimeout(() => { render({ fresh: false }); }, QUICK_SCROLL_MS + 10);
            }

            // Фоны глифов — вне видимой окна больше не нужны, убираем ДО
            // того, как расставим оставшиеся (тот же приём, что `lastNeeded`
            // чуть выше для тел/зеркал).
            for (const headerMesid of lastNeededGlyphs) if (!neededGlyphs.has(headerMesid)) await forgetGlyphBg(headerMesid);
            lastNeededGlyphs = neededGlyphs;
            for (const span of glyphSpans) {
                const bg = await ensureGlyphBg(span.headerMesid);
                if (bg) {
                    // Тот же стиль — не трогаем DOM: даже запись одинаковых значений заставляла браузер перерисовывать фон глифа (таймер, стрим, светофор).
                    const bgKey = `${span.top}|${viewportWidth}|${span.height}`;
                    if (glyphBgApplied.get(span.headerMesid) !== bgKey) {
                        await serviceOrNull('dom.setProp', { el: bg, key: 'style', value: { transform: `translateY(${span.top}px)`, width: `${viewportWidth}px`, height: `${span.height}px` } });
                        glyphBgApplied.set(span.headerMesid, bgKey);
                    }
                }
            }

            // `range.totalHeight` — сумма высот ВСЕХ сообщений (не только
            // видимых), уже посчитана `computeVisibleRange()` для внутренних
            // нужд (см. chat-viewport-math.js) — переиспользуется здесь как
            // публичная величина: реальному DOM-скроллу (обёртке в UI движка,
            // не канвасу — у канваса своего скролла нет) нужен "distance",
            // подо что подставить родной скроллбар браузера.
            // Сумма по ОБНОВЛЁННЫМ высотам, а не `range.totalHeight` (посчитан по
            // высотам ДО этого прохода — после раскрытия ризонинга общая высота
            // и окно виртуализации были бы устаревшими на один рендер, скролл
            // "уезжал"). Если высоты поменялись — добиваем ещё проход(ы), пока
            // окно не устаканится (не больше 3 подряд).
            let settledTotal = 0;
            for (const m of order) settledTotal += heights.get(m) ?? rowHeight;
            lastTotalHeight = settledTotal;
            if (heightsChanged && settlePasses < 3) { settlePasses += 1; renderQueued = true; } else if (!heightsChanged) settlePasses = 0;

            // Второй проход — синхронный, без единого `await` внутри: хром и
            // канвас коммитятся в одном и том же тике браузера.
            renderedScrollTop = frameScrollTop;
            for (const p of positions) {
                const key = `${p.y}|${p.width}`;
                if (rowPositionApplied.get(p.mesid) === key) continue; // позиция не изменилась — DOM строки не трогаем
                rowPositionApplied.set(p.mesid, key);
                rowStates.get(p.mesid)?.position.set({ y: p.y, width: p.width });
            }
            // Кадр без изменений (те же квады, ни одной новой текстуры) не перерисовываем — иначе любая правка внутри
            // сообщения заставляла перерисовывать весь канвас.
            const quadsKey = JSON.stringify(quads);
            if (dirtyMain || quadsKey !== lastQuadsKey) {
                await serviceOrNull('webglChat.drawFrame', { canvas, quads });
                lastQuadsKey = quadsKey;
                dirtyMain = false;
            }
            if (lastCanvas) await drawLastCanvas(lastPlacement);
            if (globalThis.__stmeBusStats) globalThis.__stmeRendered = { scrollTop: renderedScrollTop, at: performance.now() };   // диагностика задержки: до какого scrollTop дорисован кадр
            publishEvent('ui.chatViewport.render.completed', { visible: quads.length, total: order.length, totalHeight: lastTotalHeight, userToggle: toggleRender, renderedScrollTop });
            if (!renderQueued) toggleRender = false;
            schedulePrefetch();
            return true;
        } catch (error) {
            console.error('[chatViewport] render failed:', error);
            publishEvent('ui.chatViewport.render.failed', { message: error.message });
            throw error;
        } finally {
            rendering = false;
            if (renderQueued) { renderQueued = false; const fresh = pendingFresh; pendingFresh = false; render({ fresh }); }
        }
    }

    async function forgetAll() {
        // Не только `mirrors`: у ToolCall-строк тела/зеркала нет вовсе, их хром иначе переживал бы смену чата и висел на экране в новом.
        for (const mesid of new Set([...mirrors.keys(), ...chromeRoots.keys(), ...rowStates.keys(), ...textureHome.keys()])) await forgetMesid(mesid);
        for (const headerMesid of [...glyphBgRoots.keys()]) await forgetGlyphBg(headerMesid);
        heights.clear();
        snapshot = null;
        lastChromeHeight.clear();
        lastFrame = null;
        prefetchGen += 1;
        lastNeeded = new Set();
        lastNeededGlyphs = new Set();
        // `genStatus` — НЕ в `forgetMesid()` (тот чистит за собой при обычном
        // выезде строки за пределы окна виртуализации — статус светофора
        // должен ПЕРЕЖИТЬ прокрутку, "фиксирует свой последний цвет"
        // навсегда, а не только пока строка на экране). Здесь — да: `st.
        // chatChanged` (другой чат) делает те же числа-`mesid` совсем
        // ДРУГИМИ сообщениями, старая раскраска была бы враньём про новый
        // чат.
        genStatus.clear();
    }

    /** CSS-подавление нативного `#chat` — НИКОГДА удаление узла (см. doc-comment файла: `deleteMessage` требует, чтобы `.mes[mesid]` физически существовал). */
    async function applySuppression(shouldSuppress) {
        const container = await serviceOrNull('stChat.container');
        if (!container) return;
        if (shouldSuppress) await serviceOrThrow('dom.setProp', { el: container, key: 'class', value: SUPPRESS_CLASS });
        else await serviceOrThrow('dom.removeProp', { el: container, key: 'class' });
    }

    async function setEnabled({ enabled: next } = {}) {
        enabled = Boolean(next);
        await applySuppression(enabled);
        if (enabled) return render();
        await forgetAll();
        return true;
    }

    /** Backing store канваса — ФИЗИЧЕСКИЕ пиксели; CSS-размер самого элемента остаётся логическим явным стилем, иначе канвас визуально раздулся бы до backing-store размера. */
    async function applyCanvasSize() {
        lastQuadsKey = null; // ресайз очищает канвас — следующий кадр обязан нарисоваться
        dirtyMain = true;
        await serviceOrThrow('webglChat.resize', { canvas, width: Math.round(viewportWidth * devicePixelRatio), height: Math.round(canvasHeight() * devicePixelRatio) });
        await serviceOrThrow('dom.setProp', { el: canvas, key: 'style', value: { width: `${viewportWidth}px`, height: `${canvasHeight()}px`, top: `${-canvasPad()}px` } });
    }

    async function attach({ canvas: nextCanvas, lastCanvas: nextLastCanvas, mirrorContainer: nextMirrorContainer, chromeContainer: nextChromeContainer, width, height, css: nextCss = '' } = {}) {
        if (!nextCanvas || !nextMirrorContainer) throw new Error('chatViewport.attach: "canvas" and "mirrorContainer" are required.');
        canvas = nextCanvas;
        mirrorContainer = nextMirrorContainer;
        // `chromeContainer` — опционален: без него (или без `createFinalUi`,
        // см. конструктор) Ядро по-прежнему рисует тело сообщений, просто
        // без DOM-хрома поверх — обратная совместимость с уже написанными
        // сценарными тестами, которые о хроме ничего не знают.
        chromeContainer = nextChromeContainer ?? null;
        css = String(nextCss ?? '');
        viewportWidth = Math.max(1, Math.round(Number(width) || 0));
        viewportHeight = Math.max(1, Math.round(Number(height) || 0));
        devicePixelRatio = Math.max(1, Number(getDevicePixelRatio()) || 1);

        const glReady = await serviceOrNull('webglChat.attach', {
            canvas,
            width: Math.round(viewportWidth * devicePixelRatio),
            height: Math.round(canvasHeight() * devicePixelRatio),
        });
        if (!glReady) return false; // нет WebGL — Модуль/потребитель сам решает откатываться на нативный чат
        await serviceOrThrow('dom.setProp', { el: canvas, key: 'style', value: { width: `${viewportWidth}px`, height: `${canvasHeight()}px`, top: `${-canvasPad()}px` } });
        // ^ webglChat.attach() уже само выставило backing store в физических
        // пикселях — здесь только логический CSS-размер элемента (без него
        // канвас визуально раздулся бы до backing-store размера).

        attached = true;
        lastQuadsKey = null;
        dirtyMain = true;
        lastCanvas = null;
        if (nextLastCanvas) {
            const ready = await serviceOrNull('webglChat.attach', { canvas: nextLastCanvas, width: 1, height: 1 });
            if (ready) { lastCanvas = nextLastCanvas; lastCanvasSize = { w: 0, h: 0 }; lastQuadKeyL3 = null; lastTransformL3 = null; dirtyLast = true; }
        }
        if (persistentCache) setTimeout(() => { serviceOrNull('rasterCache.prune', {}).catch(() => {}); }, 5000);
        for (const event of REDRAW_EVENTS) subscriptions.push(host.events.subscribe(event, () => { render(); }));
        // Состав/цвета говорящих изменились — все растры устарели (ключ кэша строки — текст, не покраска).
        subscriptions.push(host.events.subscribe('speaker.castChanged', () => { rasterizedText.clear(); render({ fresh: true }); }));
        subscriptions.push(host.events.subscribe('st.chatChanged', () => { forgetAll().then(render); }));

        // Подвал сообщения (RP Time и т.п.) — см. doc-comment у
        // `.stme-chat-viewport-footer-slot` в `buildRowTree()`. Резолвер живёт
        // РОВНО пока этот Chat Viewport подключён — `detach()` ниже снимает
        // его, возвращая `message-footer.js` к его собственному дефолту
        // (настоящий `.mes`), иначе владелец `hostResolver` пережил бы
        // отключение Chat Viewport и указывал бы на чужие, уже удалённые
        // узлы.
        await coreOrNull('ui.messageFooter.setHostResolver', { resolver: mesid => footerSlots.get(glyphHeadOf.get(mesid) ?? mesid) ?? null });

        // Полоска-светофор — owner: "Посмотри в нашем светофоре" (тот же
        // словарь событий, что уже классифицирует `cores/ui/activity-
        // light.js`, но здесь ТРИ цвета вместо пяти — working/success/error,
        // "прервано без ошибки" и "настоящая ошибка" владелец слил в один
        // красный намеренно). `liveMesid()` — тот же приём, что уже даёт
        // `message-footer.js` самому RP Time (`pendingMesid.set(await
        // currentMesid())`): в payload'ах `generation.*` mesid не летит
        // вовсе (`cores/generation/index.js` несёт только `runId`), а
        // "последнее отрисованное сообщение ПРЯМО СЕЙЧАС" в момент события
        // — лучшее доступное приближение "какое сообщение генерируется".
        const markGenStatus = async status => {
            const mesid = await coreOrNull('ui.messageFooter.liveMesid', {});
            if (mesid == null) return;
            genStatus.set(String(mesid), status);
            render();
        };
        subscriptions.push(host.events.subscribe('generation.beforeSend', () => { markGenStatus('working'); }));
        subscriptions.push(host.events.subscribe('generation.sending', () => { markGenStatus('working'); }));
        subscriptions.push(host.events.subscribe('generation.toolCall', () => { markGenStatus('working'); }));
        subscriptions.push(host.events.subscribe('generation.completed', payload => {
            markGenStatus(payload?.outcome === 'stopped' ? 'error' : 'success');
        }));
        subscriptions.push(host.events.subscribe('generation.superseded', () => { markGenStatus('error'); }));
        subscriptions.push(host.events.subscribe('generation.aborted', () => { markGenStatus('error'); }));
        subscriptions.push(host.events.subscribe('generation.prepareFailed', () => { markGenStatus('error'); }));

        // Прямая подписка на сырое ST-событие, В ОБХОД `host.events` — см.
        // doc-comment `STREAM_TOKEN_ST_EVENT` выше за причиной. `onStreamToken`
        // — та же ссылка на функцию, что нужна `stEvents.unsubscribe()` в
        // `detach()` (см. doc-comment `services/st-events.js`'s `.off()`
        // — снять подписку можно только ТЕМ ЖЕ обработчиком).
        const onStreamToken = () => { render(); };
        await serviceOrNull('stEvents.subscribe', { event: STREAM_TOKEN_ST_EVENT, handler: onStreamToken });
        subscriptions.push(() => { serviceOrNull('stEvents.unsubscribe', { event: STREAM_TOKEN_ST_EVENT, handler: onStreamToken }); });

        await applySuppression(enabled);
        await render();
        // Найдено живьём: сразу после `webglChat.attach()` (свежий GL-контекст
        // на только что вставленном канвасе) самый первый `drawFrame()`
        // иногда не докомпозичивается браузером — пиксели реально нарисованы
        // (подтверждено прямым `readPixels()`), но не отображаются, пока не
        // случится ЕЩЁ один рендер. `requestAnimationFrame` для этого
        // защитного повтора НЕ подошёл — не срабатывает для фоновой/
        // неактивной вкладки (проверено живьём: событие `render.completed`
        // так и не пришло второй раз в этом окружении), а именно так чаще
        // всего и открыт реальный чат ST, когда пользователь смотрит в
        // другое окно. `setTimeout` не настолько зависим от видимости
        // вкладки. `typeof window !== 'undefined'` — только в реальном
        // браузере, не в Node-тестах (там `window` нет вовсе).
        if (typeof window !== 'undefined') setTimeout(() => { render(); }, 50);
        return true;
    }

    async function detach() {
        for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
        await coreOrNull('ui.messageFooter.clearHostResolver', {});
        await forgetAll();
        await applySuppression(false);
        if (canvas) await serviceOrNull('webglChat.detach', { canvas });
        if (lastCanvas) { await serviceOrNull('webglChat.detach', { canvas: lastCanvas }); lastCanvas = null; }
        textureHome.clear();
        attached = false;
        canvas = null;
        mirrorContainer = null;
        await clearSkeletons();
        chromeContainer = null;
    }

    async function setViewport({ scrollTop: nextScrollTop, viewportHeight: nextViewportHeight, viewportWidth: nextViewportWidth } = {}) {
        if (Number.isFinite(nextScrollTop)) {
            const target = Math.max(0, nextScrollTop);
            if (target !== scrollTop) {
                const nowT = performance.now();
                const dt = nowT - lastVelAt;
                scrollVelocity = (dt > 0 && dt < 500) ? scrollVelocity * 0.5 + ((target - scrollTop) / dt) * 0.5 : 0;
                lastVelAt = nowT;
                lastScrollAt = nowT;
            }
            scrollTop = target;
        }
        const sizeChanged =
            (Number.isFinite(nextViewportHeight) && nextViewportHeight !== viewportHeight) ||
            (Number.isFinite(nextViewportWidth) && nextViewportWidth !== viewportWidth);
        if (Number.isFinite(nextViewportHeight)) viewportHeight = Math.max(0, nextViewportHeight);
        if (Number.isFinite(nextViewportWidth)) viewportWidth = Math.max(0, nextViewportWidth);
        // Канвас (и его backing store) меняет размер только когда контейнер
        // реально изменил размер — обычный скролл (только `scrollTop`) не
        // должен дёргать WebGL-ресайз на каждый пиксель прокрутки.
        if (sizeChanged && attached) await applyCanvasSize();
        return render({ fresh: sizeChanged });
    }

    async function deleteMessage({ mesid } = {}) {
        await serviceOrThrow('stChat.deleteMessage', { mesid });
        return render();
    }

    async function swipe({ mesid, direction } = {}) {
        await serviceOrThrow('stChat.swipe', { mesid, direction });
        return render();
    }

    async function regenerate() {
        await serviceOrThrow('stChat.regenerate', {});
        return render();
    }

    async function editMessage({ mesid, text } = {}) {
        await serviceOrThrow('stChat.setText', { mesid, text });
        return render();
    }

    const unregisters = [
        host.own.register('chatViewport.attach', params => attach(params)),
        host.own.register('chatViewport.detach', () => detach()),
        host.own.register('chatViewport.setViewport', params => setViewport(params)),
        host.own.register('chatViewport.setEnabled', params => setEnabled(params)),
        host.own.register('chatViewport.deleteMessage', params => deleteMessage(params)),
        host.own.register('chatViewport.swipe', params => swipe(params)),
        host.own.register('chatViewport.regenerate', () => regenerate()),
        host.own.register('chatViewport.editMessage', params => editMessage(params)),
        host.own.register('chatViewport.visibleMesids', () => [...lastNeeded]),
        host.own.register('chatViewport.totalHeight', () => lastTotalHeight),
    ];

    return {
        attach,
        detach,
        setViewport,
        setEnabled,
        deleteMessage,
        swipe,
        regenerate,
        editMessage,
        render,
        visibleMesids: () => [...lastNeeded],
        totalHeight: () => lastTotalHeight,
        renderedScrollTop: () => renderedScrollTop,
        canvasPad: () => canvasPad(),
        isAttached: () => attached,
        stop: () => { for (const unregister of unregisters) unregister(); },
    };
}
