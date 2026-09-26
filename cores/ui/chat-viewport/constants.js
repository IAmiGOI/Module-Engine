/**
 * События ST, после которых видимое содержимое сообщения могло измениться.
 * `st.streamTokenReceived` сюда НЕ входит — он вообще никогда не долетел бы
 * через `host.events` (см. `STREAM_TOKEN_ST_EVENT` ниже, doc-comment
 * объясняет почему), поэтому больше не значится здесь как "ещё одно
 * событие общей шины".
 */
export const REDRAW_EVENTS = Object.freeze([
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
export const STREAM_TOKEN_ST_EVENT = 'STREAM_TOKEN_RECEIVED';

export const SUPPRESS_CLASS = 'stme-chat-viewport-suppress-native';
export const MIRROR_CLASS = 'stme-chat-viewport-mirror';
export const DEFAULT_ROW_HEIGHT = 96;
export const DEFAULT_OVERSCAN = 3;
/** Зазор МЕЖДУ глифами (owner: "между ними нет спейса") — px, логические. Добавляется к высоте ПЕРВОГО сообщения нового глифа (см. `render()`), не отдельной сущностью — так виртуализация (`computeVisibleRange`) видит его в своей сумме высот "бесплатно", без отдельного учёта зазоров. */
export const GLYPH_GAP = 10;
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
export const TEXT_PADDING = 10;
/** Пачка изменений высоты хрома за это время — один пересчёт строк. */
export const CHROME_REFLOW_MS = 30;
export const AVATAR_CSS_WIDTH = 102;  // как `Avatar()` (libraries/shared/widgets.js) по умолчанию
export const AVATAR_CSS_HEIGHT = 136;
export const AVATAR_SUPERSAMPLE = 2; // во сколько раз подготовленная аватарка больше физического размера на экране
export const SKELETON_POOL_MAX = 14;
export const MEASURE_BATCH_MS = 3; // окно сбора измерений в одну пачку
export const EDIT_MIN_HEIGHT = 96; // минимальная высота тела в режиме правки, px
/** Сколько мс после последнего скролла считаем, что пользователь ещё листает (рисуем только видимое). */
export const QUICK_SCROLL_MS = 150;
/** На сколько мс вперёд по ходу прокрутки предзагружаем (скорость × это время). */
export const PREFETCH_HORIZON_MS = 1500;
/** Высота канваса последнего сообщения растёт ступенями (ресайз очищает канвас — на каждый токен нельзя). */
export const LAST_CANVAS_STEP = 512;
export const MAX_CANVAS_CSS = 8000;

/** Быстрый нестойкий хеш строки (cyrb53) — ключ постоянного кэша растров. */
export function hashString(str) {
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
export const PRELAUNCH_CONCURRENCY = 10;
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
export const AVATAR_WIDTH = 102;
export const AVATAR_HEIGHT = 136;
export const GEN_STRIPE_WIDTH = 6;
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
// (см. `.stme-chat-viewport-avatar-col` в styles/) СОВПАДАЕТ по
// величине с `TEXT_PADDING`, он взаимно гасится с оффсетом квада, и
// остаётся просто ширина самой колонки аватарки.
// Ширина колонки аватарки целиком, как её рисует хром: аватарка + gap 6 +
// полоска + margin-right 10 (styles/ `.stme-chat-viewport-avatar-col`).
export const AVATAR_SPACER_WIDTH = AVATAR_WIDTH + 6 + GEN_STRIPE_WIDTH + 10;
// Вертикальные отступы строки хрома (styles/ `.stme-chat-viewport-row`).
export const ROW_PAD = 6;
// Низ аватарки в координатах глифа (сверху вниз): верхний padding + высота.
export const AVATAR_WRAP = ROW_PAD + AVATAR_HEIGHT;
// Минимальная высота глифа целиком — аватарка + оба padding.
export const GLYPH_MIN_HEIGHT = AVATAR_HEIGHT + 2 * ROW_PAD;

/** Непрозрачность тела сообщения, скрытого от промптов (`is_system`): текст приглушён, но читаем. */
export const HIDDEN_BODY_OPACITY = 0.5;
