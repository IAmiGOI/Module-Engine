/**
 * Подписи карты по масштабу — как у звёздной карты EVE Online: издалека видны названия регионов и самые важные ноды, вблизи
 * подписываются остальные, а подписи никогда не налезают друг на друга. Чистые функции: без DOM и Cytoscape, всё считается в
 * экранных пикселях (`renderedPosition` ноды и `zoom` карты).
 */

export const LABEL_FONT_PX = 10;
const CHAR_WIDTH = 6.4; // заглавные полужирные 9px — шире строчных
const LABEL_HEIGHT = 13;

/** Порог масштаба, с которого подписи получает каждый уровень важности: Core — всегда, крупные ноды — от `mid`, остальные — от `near`. */
export const ZOOM_TIERS = Object.freeze({ mid: 0.9, near: 1.7 });

/**
 * Название региона: издалека крупное и яркое, при приближении гаснет (вблизи важны ноды, а не регионы). `zoom` — масштаб Cytoscape.
 * Возвращает `{ opacity, fontPx }`; `opacity: 0` — подпись прячется.
 */
export function regionLabelStyle(zoom) {
    const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
    const opacity = Math.max(0, Math.min(1, (1.9 - z) / 1.1)) * 0.9; // 0.9 при z ≤ 0.8, гаснет до 0 к z = 1.9
    const fontPx = Math.max(10, Math.min(15, 11 / Math.sqrt(z)));
    return { opacity, fontPx: Math.round(fontPx * 10) / 10 };
}

/** Уровень важности ноды для подписей: 0 — Core/защищённая, 1 — крупная, 2 — остальные. */
export function labelTier(node) {
    if (node.core || node.protectedNode) return 0;
    return (node.size ?? 0) >= 20 ? 1 : 2;
}

const boxOf = candidate => {
    const width = Math.max(1, String(candidate.label ?? '').length) * CHAR_WIDTH;
    const left = candidate.x - width / 2;
    const top = candidate.y + (candidate.radius ?? 5) + 2;
    return { left, right: left + width, top, bottom: top + LABEL_HEIGHT };
};

const overlaps = (a, b, margin) => a.left < b.right + margin && a.right > b.left - margin && a.top < b.bottom + margin && a.bottom > b.top - margin;

/**
 * Какие ноды подписывать. `candidates` — `{ id, label, x, y, radius, tier, weight }` в экранных пикселях. Уровни включаются по
 * масштабу (`ZOOM_TIERS`); внутри уровня важнее — больший `weight`; подпись, налезающая на уже выбранную, пропускается.
 * Кандидат с `forced: true` (под курсором, маяк ретрива) подписывается всегда и раньше остальных: он тоже занимает место, из-за него
 * пропускаются другие. `maxLabels` — потолок на случай огромных графов. Возвращает `Set` id.
 */
export function chooseNodeLabels(candidates, zoom, { viewport = null, maxLabels = 60, margin = 2 } = {}) {
    const visibleTier = zoom >= ZOOM_TIERS.near ? 2 : zoom >= ZOOM_TIERS.mid ? 1 : 0;
    const inView = point => !viewport || (point.x >= -20 && point.y >= -20 && point.x <= viewport.width + 20 && point.y <= viewport.height + 20);
    const forced = candidates.filter(item => item.forced && inView(item));
    const pool = candidates.filter(item => !item.forced && item.tier <= visibleTier && inView(item))
        .sort((a, b) => a.tier - b.tier || (b.weight ?? 0) - (a.weight ?? 0));
    const accepted = [];
    const chosen = new Set();
    for (const item of forced) { accepted.push(boxOf(item)); chosen.add(item.id); }
    for (const item of pool) {
        if (chosen.size >= maxLabels) break;
        const box = boxOf(item);
        if (accepted.some(other => overlaps(box, other, margin))) continue;
        accepted.push(box);
        chosen.add(item.id);
    }
    return chosen;
}

/**
 * Какие названия регионов показывать: регионы с большим весом (число нод) первыми, налезающие на уже выбранные — скрываются
 * (при сильном отдалении регионы сползаются к центру и иначе слились бы в кашу). `items`: `{ id, label, x, y, fontPx, weight }`
 * — точка подписи (центр) в экранных пикселях. Ширина — оценка по числу символов с учётом разрядки заглавных.
 */
export function chooseRegionLabels(items, { margin = 6 } = {}) {
    const accepted = [];
    const chosen = new Set();
    for (const item of [...items].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))) {
        const width = Math.max(1, String(item.label ?? '').length) * item.fontPx * 0.78 + item.fontPx * 3; // + счётчик «24/23»
        const box = { left: item.x - width / 2, right: item.x + width / 2, top: item.y - item.fontPx * 0.7, bottom: item.y + item.fontPx * 0.7 };
        if (accepted.some(other => overlaps(box, other, margin))) continue;
        accepted.push(box);
        chosen.add(item.id);
    }
    return chosen;
}
