/**
 * Стили Cytoscape окна графа памяти — MEMORY_GRAPH_UI_PLAN.md, Этап 4.2. Заменяет прежний Этап-1 перенос
 * (фиксированный размер 7px, цвет только по важности, свечения нет — см. git-историю этого файла) на раскладку,
 * что и требует план: размер/цвет/свечение приходят ЦЕЛИКОМ через `data(size|color|glow)` — сам массив стилей
 * НИЧЕГО не знает про метрики ("Чего НЕ делать" плана: "не зашивать метрики в стили Cytoscape — только
 * data(color|size|glow), считает metrics.js"). `weightColor()` — единственная метрика, которую панель умеет
 * считать САМА уже сейчас (Этап 2 Ядра уже отдаёт `weightRank` на каждой ноде): полноценный выбор метрики/режима
 * карты (`metrics.js`, несколько `color by`/`size by`/`glow by`) — Этап 6 того же плана, отдельный файл, сюда не
 * относится. Функция (не голая константа) — сигнатура без аргументов сегодня, к Этапу 6 может понадобиться
 * параметр текущего режима.
 */

/** Идентификатор маркера места будущей ноды в режиме создания (см. `ensureCytoscape()`/`syncCytoscape()`) — стиль ссылается на него через CSS-селектор `#id`. */
import { structuredStyleRules } from './kinds-view.js';

export const PREVIEW_ID = '__memory_graph_preview__';

/** Шрифт подписей нод: системный гротеск вместо шрифта Cytoscape по умолчанию, чуть плотнее и без тяжёлой обводки. */
export const LABEL_FONT = Object.freeze({ 'font-family': '"Noto Sans", "Segoe UI", system-ui, -apple-system, sans-serif', 'font-size': 10, 'font-weight': 500 });

const WEIGHT_COLOR_STOPS = [
    [0xe7, 0x4c, 0x3c], // 0.0 — красный (самый слабый узел по весу — первый кандидат на вытеснение)
    [0xf1, 0xc4, 0x0f], // 0.5 — янтарный
    [0x2e, 0xcc, 0x71], // 1.0 — зелёный (та же логика "сильнее — зеленее", что раньше была у важности)
];

function toHex(component) {
    return Math.round(component).toString(16).padStart(2, '0');
}

/** Цвет узла по умолчанию — `weightRank` (0..1, тот же ранг, что уже отдаёт `memoryGraph.nodes`, Этап 2 плана) через две линейные интерполяции (0→0.5 и 0.5→1). Вход за пределами [0,1] — клэмп, не экстраполяция. */
export function weightColor(rank) {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(rank) ? rank : 0));
    const segment = clamped <= 0.5 ? 0 : 1;
    const t = clamped <= 0.5 ? clamped / 0.5 : (clamped - 0.5) / 0.5;
    const from = WEIGHT_COLOR_STOPS[segment];
    const to = WEIGHT_COLOR_STOPS[segment + 1];
    const rgb = from.map((component, index) => component + (to[index] - component) * t);
    return `#${rgb.map(toHex).join('')}`;
}

export function graphStylesheet() {
    return [
        {
            selector: 'node',
            style: {
                // Размер/цвет — ЦЕЛИКОМ из данных (`nodeElements()` в memory-graph-panel.js считает `size` через
                // `nodeRadius()`*2 (layout.js) и `color` через `weightColor(weightRank)`) — стиль не решает САМ,
                // только применяет.
                width: 'data(size)', height: 'data(size)', 'background-color': 'data(color)', color: '#fff',
                // Свечение по режиму карты (пункт 3 запроса) БОЛЬШЕ НЕ рисуется через Cytoscape's `underlay-*` —
                // РЕАЛЬНАЯ ЖАЛОБА владельца, дважды подряд (сначала "резкое узкое кольцо", потом, после первой
                // попытки его расширить и приглушить, ещё резче: "СВЕЧЕНИЕ ВСЕ ЕЩЕ УЖАСНОЕ. ПОЧЕМУ ОНО КРУГОМ, А НЕ
                // СВЕТОМ?"): `underlay-*` физически не умеет ничего, кроме заливки ОДНИМ сплошным цветом с РОВНОЙ
                // непрозрачностью по всей площади `padding` — раздвигать/приглушать её можно бесконечно, но кругом
                // она и останется, настоящего затухания от центра к краю у этого свойства нет вообще (Cytoscape
                // 3.30.2). Честный свет — canvas с реальным `createRadialGradient()` под нодами (`paintGlowCanvas()`
                // в memory-graph-panel.js) — непрерывная функция расстояния, которую растеризует сам браузер, не
                // Cytoscape-стиль. `underlay-opacity` здесь — `0`: базовое свечение выключено СОВСЕМ, эти три
                // свойства (`color`/`padding`/`shape`) остаются ТОЛЬКО донором для классов подсветки ретрива
                // (`.beacon`/`.route-node`/`.noise` ниже — они свою `underlay-opacity` переопределяют сами,
                // независимо от этой правки, и остаются на Cytoscape's underlay — отдельный, второстепенный язык
                // подсветки, не повседневное свечение).
                'underlay-color': 'data(color)', 'underlay-padding': 'mapData(size, 8, 34, 16, 46)',
                'underlay-opacity': 0, 'underlay-shape': 'ellipse',
            },
        },
        // Подпись — ВСЕГДА у защищённых (центр/под-центр региона) и у достаточно крупных нод (size >= 20px), у
        // остальных — только под курсором (класс `.hovered`, тот же `mouseover`/`mouseout`, что и раньше): при
        // реальном графе подписи разом на ВСЕХ нодах превращались в нечитаемое нагромождение (жалоба пользователя,
        // унаследована от Этапа-1 версии этого файла). Светлый текст с тёмной обводкой — читается на любом фоне
        // зоны (Этап 4.3 красит фон зон в цвет их региона, не всегда тёмно-серый).
        {
            selector: 'node[?protectedNode], node[size >= 20], node.hovered',
            style: {
                label: 'data(label)', 'text-valign': 'bottom', 'text-margin-y': 5, 'min-zoomed-font-size': 8,
                ...LABEL_FONT, color: '#e8ecf8', 'text-outline-color': '#0b0f1a', 'text-outline-width': 1.5, 'text-outline-opacity': 0.75,
            },
        },
        // Защищённые — та же заливка по весу (у них `weightRank` всегда 1, см. Ядро), только БЕЛАЯ ОБВОДКА и
        // усиленное свечение отличают роль — не отдельный цвет (иначе он спорил бы со шкалой веса/метрики).
        // `line-color` — из данных, не хардкод (прямой запрос владельца: ребро красится в цвет региона, который оно
        // соединяет, когда узлы красятся по метрике `region`; считает `buildNextElements()`/`regionEdgeStyle()` в
        // memory-graph-panel.js). ВНЕ этого режима — `DEFAULT_EDGE_COLOR`, тот же цвет, что раньше был здесь
        // константой — стиль как и везде НЕ решает сам, только применяет.
        {
            selector: 'edge',
            style: { width: 0.6, 'line-color': 'data(lineColor)', 'line-opacity': 0.35, 'curve-style': 'bezier' },
        },
        // РЕАЛЬНЫЙ БАГ, найден живьём (владелец: "ноды сами теперь не показываются... двигать карту мышкой больше
        // не могу") — `line-gradient-stop-colors`/`line-fill` были ЧАСТЬЮ БАЗОВОГО правила `edge` выше, со значением
        // `data(lineGradientColors)`, которое у ОБЫЧНЫХ (не меж-региональных) рёбер — ПУСТАЯ строка (`buildNextElements()`
        // ставит её так по умолчанию). Cytoscape не может провалидировать пустую строку как список цветов градиента
        // — похоже, это ломает компиляцию ВСЕЙ таблицы стилей разом (не только этого правила), отсюда и пропавшие
        // ноды, и сломанное панорамирование. Исправлено — свойства градиента вынесены в ОТДЕЛЬНЫЙ селектор,
        // применяются ТОЛЬКО к рёбрам, у которых `lineFill` РОВНО `'linear-gradient'` (Cytoscape data-селектор
        // `[field = "value"]`) — `lineGradientColors` у таких рёбер ВСЕГДА непустая (гарантия `regionEdgeStyle()`),
        // обычные рёбра эту пару свойств вообще не видят.
        {
            selector: 'edge[lineFill = "linear-gradient"]',
            style: { 'line-fill': 'linear-gradient', 'line-gradient-stop-colors': 'data(lineGradientColors)' },
        },
        // Бэкбон — ребро между двумя защищёнными (центры/под-центры регионов) — заметнее обычных "mentions"-рёбер
        // между рядовыми нодами. `backbone` — булево поле, которое `edgeElements()` в панели считает по обоим
        // концам ребра (Ядро само это не помечает — регионы и рёбра для него разные сущности).
        { selector: 'edge[?backbone]', style: { 'line-opacity': 0.6, width: 1 } },
        // structured (kinds-view.js): форма по виду, обводка Core, стрелки событий — по данным, у legacy-элементов не срабатывают.
        ...structuredStyleRules(),
        // Подсветка ретрива — MEMORY_GRAPH_UI_PLAN.md, Этап 5 (пункт 4 запроса, ПЕРЕКЛЮЧАТЕЛЬ, не таймер). Классы
        // считает чистая `retrievalClasses()` (retrieval-overlay.js), панель только вешает/снимает их на элементы —
        // сам стиль, как и везде выше, ничего не знает ПРО ЧТО именно подсвечивает.
        { selector: 'node.beacon', style: { 'underlay-opacity': 0.6, 'underlay-padding': 'mapData(size, 8, 34, 12, 22)', 'border-color': '#7aa2ff', 'border-width': 2, label: 'data(label)' } },
        { selector: 'node.route-node', style: { 'underlay-opacity': 0.4 } },
        { selector: 'node.noise', style: { 'border-width': 1, 'border-color': 'rgba(255,255,255,0.4)', 'underlay-opacity': 0.3 } },
        // `.dimmed` идёт ПОСЛЕДНИМ — должен побеждать `opacity` независимо от того, какие ещё классы/селекторы
        // выше уже что-то задали этому же элементу (у Cytoscape при равной специфичности побеждает ПОРЯДОК в
        // массиве, не порядок классов на самом элементе).
        { selector: '.dimmed', style: { opacity: 0.25 } },
        {
            selector: 'edge.route',
            style: {
                width: 2.2, 'line-color': '#7aa2ff', 'line-opacity': 0.95, 'line-style': 'dashed',
                'line-dash-pattern': [6, 3], // сам бегущий пунктир (смещение `line-dash-offset`) двигает `retrieval-overlay.js`'s rAF-цикл в панели
            },
        },
        // Фильтры/поиск (Этап 6.5) — `.filtered` СКРЫВАЕТ элемент (`display:none`), раскладку не пересчитывает
        // (позиции остаются из `layoutGraph()` — план прямо просит "карта не прыгает"); `.match` подсвечивает
        // совпадение поиска жёлтой обводкой, не спорит ни с одним из цветов метрик выше.
        { selector: '.filtered', style: { display: 'none' } },
        { selector: 'node.match', style: { 'border-color': '#ffd76a', 'border-width': 2.5 } },
        // Режим "Connect" (Этап 7.3) — первая выбранная нода подсвечена, пока ждём вторую.
        { selector: 'node.connect-selected', style: { 'border-color': '#7aa2ff', 'border-width': 3 } },
        // Маркер места будущего узла в режиме создания — пунктир, не сплошная заливка, чтобы не путать с настоящим
        // узлом; не кликабелен и не перетаскиваем (`grabbable`/`selectable: false` при добавлении в панели).
        {
            selector: `#${PREVIEW_ID}`,
            style: {
                label: 'data(label)', 'background-color': 'rgba(74,158,255,0.15)',
                'border-width': 2, 'border-style': 'dashed', 'border-color': '#4a9eff',
                color: '#4a9eff', ...LABEL_FONT, 'text-valign': 'bottom', 'text-margin-y': 4,
                width: 2.4, height: 2.4,
            },
        },
    ];
}
