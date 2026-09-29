import { zonePath } from './layout.js';

/**
 * Миниатюра графа для карточки библиотеки — SVG-строка не больше 8 КБ (MEMORY_GRAPH_TYPES_PLAN.md, этап 9). Зоны регионов
 * цветом их оттенка и точки нод по позициям раскладки. Не помещается — сначала убирается часть нод (рядовые раньше Core),
 * потом зоны. Чистая функция.
 */

export const THUMBNAIL_LIMIT = 8192;

const round = value => Math.round(value * 10) / 10;

export function buildThumbnailSvg({ zones = [], positions, nodes }, { limit = THUMBNAIL_LIMIT, size = 120 } = {}) {
    const points = nodes.map(node => ({ node, at: positions.get(node.id) })).filter(item => item.at);
    if (!points.length) return null;
    const xs = points.map(item => item.at.x);
    const ys = points.map(item => item.at.y);
    const pad = 20;
    const minX = Math.min(...xs) - pad;
    const minY = Math.min(...ys) - pad;
    const span = Math.max(Math.max(...xs) + pad - minX, Math.max(...ys) + pad - minY, 1);
    const scale = size / span;
    const zoneSvg = zones.map(zone => `<path d="${zonePath(zone)}" fill="hsl(${Math.round(zone.hue ?? 0)},45%,35%)" opacity=".5"/>`).join('');
    const dot = ({ node, at }) => `<circle cx="${round((at.x - minX) * scale)}" cy="${round((at.y - minY) * scale)}" r="${node.core ? 2.2 : 1.2}" fill="${node.core ? '#fff' : '#9fb4ff'}"/>`;
    const wrap = (zonesPart, dots) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}"><g transform="translate(${round(-minX * scale)} ${round(-minY * scale)}) scale(${round(scale)})">${zonesPart}</g>${dots}</svg>`;
    // Порядок: Core-точки последними (рисуются сверху и отбрасываются в последнюю очередь).
    const ordered = [...points].sort((a, b) => Number(Boolean(a.node.core)) - Number(Boolean(b.node.core)));
    for (const keepZones of [true, false]) {
        for (let keep = ordered.length; keep >= 0; keep = keep > 40 ? Math.floor(keep * 0.7) : keep - 8) {
            const dots = ordered.slice(ordered.length - Math.max(keep, 0)).map(dot).join('');
            const svg = wrap(keepZones ? zoneSvg : '', dots);
            if (svg.length <= limit) return svg;
            if (keep <= 0) break;
        }
    }
    return null;
}
