/**
 * Метрики окна графа памяти — MEMORY_GRAPH_UI_PLAN.md, Этап 6.1. Идея как у звёздной карты EVE Online: ОДНА и та же
 * карта, но РЕЖИМ решает, что показывают цвет/размер/свечение — ТОЛЬКО чистые функции, без Cytoscape/DOM.
 * `graphStylesheet()` (stylesheet.js) не знает НИ ОДНОЙ метрики, только `data(color|size|glow)` — план прямо
 * запрещает "зашивать метрики в стили".
 *
 * `ctx` — всё, что метрике может понадобиться КРОМЕ самой ноды: `regionsById` (`Object<id, region>` — та же форма,
 * что `memory-graph-panel.js`'s `regionsById()` уже строит для `layoutGraph()`, `region.count`/`region.capacity`
 * нужны метрике `risk`), `hueByRegionId` (`Map(regionId → hue)`, hue берётся из УЖЕ посчитанных `layoutGraph()`'s
 * зон — метрика `region` красит ноду В ТОТ ЖЕ оттенок, что и фон её зоны, план прямо просит "видеть границы
 * регионов по нодам"), `now`/`lastRetrieval` (задел под будущие метрики, сегодня не используются).
 */

function toHex(component) {
    return Math.max(0, Math.min(255, Math.round(component))).toString(16).padStart(2, '0');
}

/** Линейная интерполяция по N ≥ 2 RGB-стопам (не только 2, как у `weightColor()` в stylesheet.js — например `retrieved` берёт 3: серый → янтарный → белый). */
function interpolateStops(stops, t) {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
    const segments = stops.length - 1;
    const scaled = clamped * segments;
    const index = Math.min(segments - 1, Math.floor(scaled));
    const localT = scaled - index;
    const from = stops[index];
    const to = stops[index + 1];
    const rgb = from.map((component, i) => component + (to[i] - component) * localT);
    return `#${rgb.map(toHex).join('')}`;
}

const RGB = {
    red: [0xe7, 0x4c, 0x3c], amber: [0xf1, 0xc4, 0x0f], green: [0x2e, 0xcc, 0x71],
    gray: [0x6b, 0x72, 0x80], white: [0xff, 0xff, 0xff],
    darkBlue: [0x1b, 0x3a, 0x6b], lightBlue: [0x7e, 0xc8, 0xf5],
    lightGray: [0xd8, 0xdc, 0xe4], darkGray: [0x3a, 0x3e, 0x47],
};
const GRAY_HEX = `#${RGB.gray.map(toHex).join('')}`;

/** Заполненность региона ноды — та же величина, что и подпись зоны "12/23" (Этап 4.3), нужна метрике `risk`. */
function regionFillRatio(node, ctx) {
    const region = ctx?.regionsById?.[node.regionId];
    if (!region || !Number.isFinite(region.capacity) || region.capacity <= 0) return 0;
    return (region.count ?? 0) / region.capacity;
}

function hueForRegion(node, ctx) {
    if (node.regionId == null) return null; // накопитель — не регион, свой нейтральный цвет (см. palette ниже)
    const byId = ctx?.hueByRegionId;
    if (!byId) return null;
    return byId instanceof Map ? (byId.get(node.regionId) ?? null) : (byId[node.regionId] ?? null);
}

const SOURCE_COLORS = { chat: '#4c6fff', lorebook: '#2ecc71', card: '#f1c40f', manual: '#e874e0', unknown: GRAY_HEX };

/**
 * Каждая метрика: `{ id, label, description, value(node, ctx), scale: 'rank'|'linear'|'categorical', palette,
 * format(value), higherIsBetter }`. `value()` для `rank` ВСЕГДА возвращает уже готовое число в [0,1] (метрика сама
 * нормирует свою величину — `weightRank` у Ядра уже такой, `importance`/10 приводится к тому же виду здесь);
 * `linear` возвращает СЫРУЮ величину (`degree`, `ageTurns`, …) — нормирует по факту данных `metricDomain()`.
 */
export const METRICS = [
    {
        id: 'weight', label: 'Weight', description: 'Overall graph weight (importance + connections + decay) — the same value eviction uses.',
        value: node => (node.protectedNode ? 1 : (node.weightRank ?? 0)),
        scale: 'rank', palette: [RGB.red, RGB.amber, RGB.green], higherIsBetter: true,
        format: value => (value == null ? '—' : value.toFixed(2)),
    },
    {
        id: 'risk', label: 'Eviction risk', description: 'Will be evicted first if <region> fills up — only shown once a region is at least 80% full.',
        value: (node, ctx) => (node.protectedNode || regionFillRatio(node, ctx) < 0.8 ? 0 : 1 - (node.weightRank ?? 0)),
        scale: 'rank', palette: [RGB.gray, RGB.red], higherIsBetter: false,
        format: value => (value == null ? '—' : `${Math.round(value * 100)}%`),
    },
    {
        id: 'importance', label: 'Importance', description: 'Model-assigned importance (0-10) — the color memory graph used before weight existed.',
        value: node => Math.max(0, Math.min(10, node.importance ?? 0)) / 10,
        scale: 'rank', palette: [RGB.red, RGB.amber, RGB.green], higherIsBetter: true,
        format: value => (value == null ? '—' : String(Math.round(value * 10))),
    },
    {
        id: 'connections', label: 'Connections', description: 'Number of edges (degree) — also the default "Size by".',
        value: node => node.degree ?? 0,
        scale: 'linear', palette: [RGB.darkBlue, RGB.lightBlue], higherIsBetter: true,
        format: value => (value == null ? '—' : String(Math.round(value))),
    },
    {
        id: 'age', label: 'Age', description: 'Turns since the node was created — lighter is newer, darker is older.',
        value: node => node.ageTurns ?? 0,
        scale: 'linear', palette: [RGB.lightGray, RGB.darkGray], higherIsBetter: false,
        format: value => (value == null ? '—' : `${Math.round(value)}t`),
    },
    {
        id: 'idle', label: 'Idle', description: 'Turns since the node was last touched/retrieved — green is recent, gray is long ago.',
        value: node => node.idleTurns ?? 0,
        scale: 'linear', palette: [RGB.green, RGB.gray], higherIsBetter: false,
        format: value => (value == null ? '—' : `${Math.round(value)}t`),
    },
    {
        id: 'retrieved', label: 'Retrieved', description: 'How many times this node has appeared in the prompt — 0 is gray, then amber to white as it gets "hotter".',
        value: node => node.retrievedCount ?? 0,
        scale: 'linear', palette: [RGB.gray, RGB.amber, RGB.white], higherIsBetter: true,
        format: value => (value == null ? '—' : `${Math.round(value)}×`),
        zeroIsSpecial: true, // 0 — плоский серый, НЕ нижний конец амбер→белой рампы (см. metricColor())
    },
    {
        id: 'region', label: 'Region', description: 'Colors each node by its own region\'s zone hue — see region boundaries by node color alone.',
        value: hueForRegion,
        scale: 'categorical', palette: hue => (hue == null ? GRAY_HEX : `hsl(${hue}, 65%, 55%)`),
        format: () => '',
    },
    {
        id: 'source', label: 'Source', description: 'Where this node originally came from: live chat, Lorebook import, the character card, or a manual entry.',
        value: node => node.source ?? 'unknown',
        scale: 'categorical', palette: value => SOURCE_COLORS[value] ?? GRAY_HEX,
        format: value => value ?? 'unknown',
    },
];

export function findMetric(id) {
    return METRICS.find(metric => metric.id === id) ?? METRICS[0];
}

/** Значение метрики → цвет. `domain` — только для `linear` (см. `metricDomain()`); `rank`/`categorical` его игнорируют. */
export function metricColor(metric, value, domain) {
    if (metric.scale === 'categorical') return metric.palette(value);
    if (metric.zeroIsSpecial && value === 0) return GRAY_HEX;
    if (metric.scale === 'rank') return interpolateStops(metric.palette, value ?? 0);
    const { min = 0, max = 1 } = domain ?? {};
    const t = max > min ? ((value ?? min) - min) / (max - min) : 0;
    return interpolateStops(metric.palette, t);
}

/** `linear` → `{min,max}` по РЕАЛЬНЫМ данным (не выдуманный диапазон — план прямо просит "реальные min/max по нодам"); `categorical` → список различных значений; `rank` — фиксированная шкала [0,1], зависеть от данных ей незачем. */
export function metricDomain(metric, nodes, ctx) {
    if (metric.scale === 'linear') {
        const values = nodes.map(node => metric.value(node, ctx)).filter(value => typeof value === 'number' && Number.isFinite(value));
        if (!values.length) return { min: 0, max: 1 };
        return { min: Math.min(...values), max: Math.max(...values) };
    }
    if (metric.scale === 'categorical') {
        return [...new Set(nodes.map(node => metric.value(node, ctx)))];
    }
    return { min: 0, max: 1 };
}
