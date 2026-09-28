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
export const PREVIEW_ID = '__memory_graph_preview__';

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
                // Свечение (пункт 3 запроса) — подложка Cytoscape (`underlay-*`, есть в 3.30.2). `data(glow)` —
                // тоже посчитан заранее (см. doc-comment файла), сам стиль не знает, ПОЧЕМУ узел светится сильнее.
                'underlay-color': 'data(color)', 'underlay-padding': 'mapData(size, 8, 34, 3, 10)',
                'underlay-opacity': 'data(glow)', 'underlay-shape': 'ellipse',
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
                label: 'data(label)', 'font-size': 9, 'text-valign': 'bottom', 'text-margin-y': 4,
                'min-zoomed-font-size': 8, color: '#eef2ff', 'text-outline-color': '#0b0f1a', 'text-outline-width': 2,
            },
        },
        // Защищённые — та же заливка по весу (у них `weightRank` всегда 1, см. Ядро), только БЕЛАЯ ОБВОДКА и
        // усиленное свечение отличают роль — не отдельный цвет (иначе он спорил бы со шкалой веса/метрики).
        { selector: 'node[?protectedNode]', style: { 'border-width': 1.5, 'border-color': '#fff' } },
        {
            selector: 'edge',
            style: { width: 0.6, 'line-color': '#9fb4ff', 'line-opacity': 0.35, 'curve-style': 'bezier' },
        },
        // Бэкбон — ребро между двумя защищёнными (центры/под-центры регионов) — заметнее обычных "mentions"-рёбер
        // между рядовыми нодами. `backbone` — булево поле, которое `edgeElements()` в панели считает по обоим
        // концам ребра (Ядро само это не помечает — регионы и рёбра для него разные сущности).
        { selector: 'edge[?backbone]', style: { 'line-opacity': 0.6, width: 1 } },
        // Маркер места будущего узла в режиме создания — пунктир, не сплошная заливка, чтобы не путать с настоящим
        // узлом; не кликабелен и не перетаскиваем (`grabbable`/`selectable: false` при добавлении в панели).
        {
            selector: `#${PREVIEW_ID}`,
            style: {
                label: 'data(label)', 'background-color': 'rgba(74,158,255,0.15)',
                'border-width': 2, 'border-style': 'dashed', 'border-color': '#4a9eff',
                color: '#4a9eff', 'font-size': 9, 'text-valign': 'bottom', 'text-margin-y': 4,
                width: 2.4, height: 2.4,
            },
        },
    ];
}
