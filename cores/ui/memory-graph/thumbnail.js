/**
 * Миниатюра графа для карточки библиотеки — SVG-строка не больше 8 КБ (MEMORY_GRAPH_TYPES_PLAN.md, этап 9). В духе самой карты:
 * тёмный фон, мягкое цветное свечение каждого региона (размытый круг по центру и разбросу его нод) и точки нод поверх.
 * Точек не больше `maxDots` (Core — всегда, остальные выбираются равномерно), поэтому размер не зависит от размера графа.
 * Чистая функция.
 */

export const THUMBNAIL_LIMIT = 8192;

const round = value => Math.round(value * 10) / 10;

export function buildThumbnailSvg({ zones = [], positions, nodes }, { limit = THUMBNAIL_LIMIT, size = 120, maxDots = 110 } = {}) {
    const points = nodes.map(node => ({ node, at: positions.get(node.id) })).filter(item => item.at);
    if (!points.length) return null;
    const hueByRegion = new Map(zones.map(zone => [zone.regionId, zone.hue ?? 0]));
    const xs = points.map(item => item.at.x);
    const ys = points.map(item => item.at.y);
    const pad = 16;
    const minX = Math.min(...xs) - pad;
    const minY = Math.min(...ys) - pad;
    const span = Math.max(Math.max(...xs) + pad - minX, Math.max(...ys) + pad - minY, 1);
    const scale = size / span;
    const px = at => ({ x: (at.x - minX) * scale, y: (at.y - minY) * scale });
    const hueOf = node => hueByRegion.get(node.regionId) ?? null;

    // Свечение региона: круг по центроиду его нод, радиус — по разбросу; размывается одним фильтром на всю группу.
    const byRegion = new Map();
    for (const item of points) {
        const hue = hueOf(item.node);
        if (hue === null) continue;
        if (!byRegion.has(item.node.regionId)) byRegion.set(item.node.regionId, { hue, list: [] });
        byRegion.get(item.node.regionId).list.push(px(item.at));
    }
    const glows = [...byRegion.values()].map(({ hue, list }) => {
        const cx = list.reduce((sum, p) => sum + p.x, 0) / list.length;
        const cy = list.reduce((sum, p) => sum + p.y, 0) / list.length;
        const spread = Math.sqrt(list.reduce((sum, p) => sum + (p.x - cx) ** 2 + (p.y - cy) ** 2, 0) / list.length);
        return `<circle cx="${round(cx)}" cy="${round(cy)}" r="${round(Math.max(6, spread * 1.5 + 4))}" fill="hsl(${Math.round(hue)},65%,45%)" opacity=".55"/>`;
    }).join('');

    // Точки: Core всегда, остальные — равномерная выборка до `maxDots`.
    const cores = points.filter(item => item.node.core);
    const rest = points.filter(item => !item.node.core);
    const step = Math.max(1, Math.ceil(rest.length / Math.max(1, maxDots - Math.min(cores.length, maxDots))));
    const chosen = [...rest.filter((_, index) => index % step === 0), ...cores];
    const dot = ({ node, at }) => {
        const p = px(at);
        const hue = hueOf(node);
        const fill = node.core ? '#f4f6ff' : hue === null ? '#b8c2e6' : `hsl(${Math.round(hue)},70%,72%)`;
        return `<circle cx="${round(p.x)}" cy="${round(p.y)}" r="${node.core ? 2 : 1.1}" fill="${fill}"/>`;
    };
    const wrap = dots => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="#0b0f1a"/><defs><filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="5"/></filter></defs><g filter="url(#b)">${glows}</g>${dots}</svg>`;

    // Не влезло — отбрасываются обычные точки с конца выборки, потом свечение.
    for (let keep = chosen.length; keep >= 0; keep = keep > 30 ? Math.floor(keep * 0.8) : keep - 6) {
        const svg = wrap(chosen.slice(chosen.length - Math.max(keep, 0)).map(dot).join(''));
        if (svg.length <= limit) return svg;
        if (keep <= 0) break;
    }
    return null;
}
