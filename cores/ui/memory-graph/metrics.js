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
import { hslToRgb } from './plane-field.js';

/** Оттенок 0-360 → `#rrggbb` (насыщенность и яркость те же, что были у прежней hsl-строки: 65% / 55%). */
function hueToHex(hue) {
    return `#${hslToRgb(hue, 65, 55).map(toHex).join('')}`;
}

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

/**
 * Среднее двух оттенков (0-360, круговое, а не арифметическое) — прямой запрос владельца: рёбра красятся в цвет
 * региона, который они соединяют. Ребро между ДВУМЯ РАЗНЫМИ регионами берёт середину МЕНЬШЕЙ дуги между их
 * оттенками (не арифметическое среднее — оно ошибается ровно там, где важнее всего: среднее 350° и 10° должно быть
 * 0° (они рядом на цветовом круге), а `(350+10)/2=180` дало бы противоположный, совершенно случайный цвет).
 */
export function averageHue(hueA, hueB) {
    const radA = (hueA * Math.PI) / 180;
    const radB = (hueB * Math.PI) / 180;
    const x = (Math.cos(radA) + Math.cos(radB)) / 2;
    const y = (Math.sin(radA) + Math.sin(radB)) / 2;
    const hue = (Math.atan2(y, x) * 180) / Math.PI;
    return hue < 0 ? hue + 360 : hue;
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
        // Только hex: `line-gradient-stop-colors` Cytoscape — список цветов через пробел, а `hsl(0, 65%, 55%)` сам содержит пробелы и запятые и
        // разбирается неверно ("style property is invalid" → исключение при применении стиля → ноды не рисуются, ROADMAP 5.123).
        scale: 'categorical', palette: hue => (hue == null ? GRAY_HEX : hueToHex(hue)),
        format: () => '',
    },
    {
        id: 'source', label: 'Source', description: 'Where this node originally came from: live chat, Lorebook import, the character card, or a manual entry.',
        value: node => node.source ?? 'unknown',
        scale: 'categorical', palette: value => SOURCE_COLORS[value] ?? GRAY_HEX,
        format: value => value ?? 'unknown',
    },
];

/** Метрики structured-графа (вид ноды и Core) — в списке выбора только у таких графов; `findMetric` находит их по id. */
export const STRUCTURED_METRICS = [
    {
        id: 'kind', label: 'Kind', description: 'Entity, object, fact or event — what the node is.',
        value: node => node.kind ?? 'fact',
        scale: 'categorical', palette: value => KIND_COLORS[value] ?? GRAY_HEX,
        format: value => value ?? 'fact',
    },
    {
        id: 'core', label: 'Core', description: 'Core nodes are bright, everything else is muted — shows the plot skeleton.',
        value: node => (node.core ? 1 : 0.15),
        scale: 'rank', palette: [RGB.darkGray, RGB.amber], higherIsBetter: true,
        format: value => (value >= 1 ? 'core' : '—'),
    },
];
const KIND_COLORS = { entity: '#4c9aff', object: '#2ecc71', fact: '#f1c40f', event: '#e874e0' };

export function findMetric(id) {
    return METRICS.find(metric => metric.id === id) ?? STRUCTURED_METRICS.find(metric => metric.id === id) ?? METRICS[0];
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

// РЕАЛЬНАЯ ЖАЛОБА владельца (реворк UI, ROADMAP.md 5.108м, скриншоты ноды с резким кольцом свечения): "свет
// активен всегда, а его включение активирует его второй раз поверх, что просто баг". Раньше КАЖДЫЙ режим,
// включая `'none'`, возвращал безусловный floor `0.12` (плюс `+0.25` у защищённых нод) — настоящего "выключено"
// не существовало, любое усиление свечения (смена режима, подсветка ретрива поверх) выглядело как наложение
// НА УЖЕ ГОРЯЩИЙ огонёк, а не честное включение с нуля. `GLOW_CEILING` снижен с прежних 0.9 — тот же потолок
// раньше при увеличенном (широком, см. `underlay-padding` в stylesheet.js) радиусе подложки выглядел бы сплошным
// ярким пятном, а не мягким свечением.
const GLOW_CEILING = 0.5;

/**
 * Свечение ноды (`data(glow)` → `underlay-opacity` в `graphStylesheet()`) — раньше жило ВНУТРИ
 * `createMemoryGraphPanelCore()` (`memory-graph-panel.js`) как замыкание над сигналом `glowMode()`, непроверяемо
 * напрямую (единственный тест панели — смоук без настоящего DOM/cytoscape, эта функция реально не выполнялась).
 * Перенесена сюда как чистая функция — `mode` явным параметром вместо чтения сигнала изнутри, тот же приём, что
 * у `findMetric()`/`metricColor()`/`metricDomain()` выше — теперь юнит-тестируема напрямую.
 *
 * `'none'` — ЧЕСТНЫЙ ноль для обычной ноды (защищённая — только свой `bump`, тоже без скрытого floor). Остальные
 * режимы растут от 0 (не от прежнего floor) до `GLOW_CEILING`, плюс тот же `bump`.
 */
export function glowValue(node, mode, ctx, retrievedDomain) {
    const bump = node.protectedNode ? 0.25 : 0;
    switch (mode) {
        case 'retrieved': {
            const { min, max } = retrievedDomain;
            const t = max > min ? ((node.retrievedCount ?? 0) - min) / (max - min) : 0;
            return Math.min(0.9, GLOW_CEILING * t + bump);
        }
        case 'risk': return Math.min(0.9, GLOW_CEILING * findMetric('risk').value(node, ctx) + bump);
        case 'core': return node.core ? 0.5 : 0;
        case 'none': return bump;
        case 'weight':
        default: return Math.min(0.9, GLOW_CEILING * (node.protectedNode ? 1 : (node.weightRank ?? 0)) + bump);
    }
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
