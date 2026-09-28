/**
 * Фон регионов — новые зоны (`layoutGraph()`, layout.js), а не старый дартборд 5×3 (`legacy-geometry.js`'s
 * `renderRegionBackgroundSvg()` — Б1 плана: клинья дартса никак не совпадали с СЕМАНТИЧЕСКИМИ регионами
 * бутстрапа) — MEMORY_GRAPH_UI_PLAN.md, Этап 4.3. Та же техника рисования, что у старой подложки (см. её
 * doc-comment в legacy-geometry.js): `<svg>` в МОДЕЛЬНЫХ единицах со СВОИМ локальным нулём в углу (сдвинуты на
 * половину стороны от модельного (0,0), который у зон/нод лежит В ЦЕНТРЕ), синхронизируется с живым pan/zoom
 * канваса через тот же `backgroundTransformCss()` — меняется только ИСТОЧНИК путей (`zonePath()` из layout.js,
 * а не `regionWedgePath()`) и то, что сторона теперь НЕ фиксированный `MAX_RADIUS`, а считается от реального
 * внешнего края зон (регионы — данные переменного размера, не сетка 5×3).
 */

import { zonePath } from './layout.js';

export const ZONES_SVG_ID = 'stme-memory-graph-zones-svg';

/** Заливка/контур зоны по её `hue` (layout.js — равномерно по кругу, индекс региона). Накопитель (regionId: null) — не регион, отдельный нейтральный серый, не встаёт в цветовой круг регионов. */
function zoneColors(zone) {
    if (zone.regionId === null) return { fill: 'rgba(255,255,255,0.035)', stroke: 'rgba(255,255,255,0.12)' };
    return { fill: `hsla(${zone.hue}, 60%, 55%, 0.06)`, stroke: `hsla(${zone.hue}, 60%, 65%, 0.25)` };
}

/** Экранирование текста подписи региона — метка берётся из ЛЮБОГО `label`/содержимого центральной ноды (Ядро, `regionsForResponse()`), может содержать `&`/`<`/`>`/кавычки, которые сломали бы разметку `<text>`. */
function escapeXml(text) {
    return String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
}

/** Точка подписи — на внешней дуге зоны, чуть внутрь от `rOuter`, чтобы текст не обрезался краем `<svg>`. */
function labelPoint(zone, half) {
    const angle = (zone.a0 + zone.a1) / 2;
    const r = Math.max(0, zone.rOuter - 10);
    return { x: half + Math.cos(angle) * r, y: half + Math.sin(angle) * r };
}

/**
 * `zonePath(zone)` возвращает путь в МОДЕЛЬНЫХ координатах, центрированных на (0,0) (её собственный doc-comment:
 * "сдвиг в положительные координаты делает вызывающий") — сдвигаем каждую пару "x,y" на `half` регэкспом, а не
 * переписывая саму геометрию здесь: путь состоит ТОЛЬКО из `M`/`L`/`A`-команд, где координатные пары — всегда вида
 * "число,число" (см. `zonePath()`'s `pt()`), а параметры дуги (радиусы, флаги) разделены пробелами, не запятой —
 * регэксп не может случайно задеть их.
 */
function shiftPath(path, half) {
    return path.replace(/(-?\d+\.?\d*),(-?\d+\.?\d*)/g, (_, x, y) => `${(Number(x) + half).toFixed(2)},${(Number(y) + half).toFixed(2)}`);
}

/**
 * `zones` — вывод `layoutGraph()`. `highlightRegionId` — зона под курсором во время перетаскивания (Этап 7 плана
 * будет звать эту же функцию заново с новым значением при каждом кадре драга — зоны и так пересобираются редко,
 * см. `zonesSignature()` ниже, а не отдельный DOM-класс/атрибут поверх уже нарисованного пути). Пустой список зон
 * (граф без единой ноды) — пустая строка, рисовать нечего.
 */
export function renderZonesSvg(zones, { highlightRegionId } = {}) {
    if (!zones.length) return '';
    const half = Math.max(...zones.map(zone => zone.rOuter));
    const size = half * 2;
    const parts = zones.map(zone => {
        const { fill, stroke } = zoneColors(zone);
        const highlighted = zone.regionId === highlightRegionId;
        const strokeColor = highlighted ? 'rgba(255,255,255,0.8)' : stroke;
        const strokeWidth = highlighted ? 1.5 : 0.5;
        const label = zone.label ?? (zone.regionId ?? 'Unplaced');
        const countText = Number.isFinite(zone.capacity) ? `${zone.count}/${zone.capacity}` : `${zone.count}`;
        const point = labelPoint(zone, half);
        return `<path d="${shiftPath(zonePath(zone), half)}" fill="${fill}" stroke="${strokeColor}" stroke-width="${strokeWidth}" data-region-id="${zone.regionId ?? ''}" />`
            + `<text x="${point.x.toFixed(2)}" y="${point.y.toFixed(2)}" fill="rgba(255,255,255,0.45)" font-size="9" text-anchor="middle">${escapeXml(label)} · ${countText}</text>`;
    });
    // Явные пиксельные `width`/`height` (не `100%`) — та же причина, что у `renderRegionBackgroundSvg()`: 1 единица
    // SVG должна остаться РОВНО 1 CSS-пикселем, без скрытого масштабирования от вписывания в контейнер, иначе
    // внешний `transform: scale(zoom)` (`backgroundTransformCss()`) домножился бы на этот скрытый коэффициент.
    return `<svg id="${ZONES_SVG_ID}" style="position:absolute;left:0;top:0;transform-origin:0 0;" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
}

/** Половина стороны `<svg>`, которую использовал (или использовал бы) `renderZonesSvg()` для этих зон — нужна вызывающему отдельно, чтобы держать `backgroundTransformCss()`'s смещение синхронным без повторного рендера строки. */
export function zonesHalfExtent(zones) {
    return zones.length ? Math.max(...zones.map(zone => zone.rOuter)) : 0;
}

/**
 * Сериализация набора зон — ТОЛЬКО геометрически значимые поля (не `anchor`, он выводится из `a0`/`a1`/радиусов и
 * ничего не добавляет к сравнению). Позволяет панели перерисовывать `<svg>` ТОЛЬКО когда зоны РЕАЛЬНО изменились
 * (план прямо просит: "перерисовывать SVG, когда меняется набор зон... не на каждый pan/zoom") — `nodes()`/`regions()`
 * сигналы могут дёрнуться по причине, не влияющей на раскладку (например у ноды поменялся только `content`), и
 * `layoutGraph()` в этом случае детерминированно вернёт БАЙТ-В-БАЙТ те же зоны — пересобирать DOM ради этого незачем.
 */
export function zonesSignature(zones) {
    return zones.map(zone => [
        zone.regionId, zone.a0.toFixed(4), zone.a1.toFixed(4), zone.rInner.toFixed(2), zone.rOuter.toFixed(2), zone.label, zone.count, zone.capacity,
    ].join('|')).join(';');
}
