import { escapeHtml } from './home-html.js';

/**
 * HTML тела блока хаба для растеризации (общий CSS растра — `homeCss` из home-html.js: классы `wg-*` и `hb-title`). Позиции — только `top`/`left`, корень без
 * `overflow` (см. правила растра в home-html.js). Точка статуса и стрелка — DOM (cores/ui/hub/), поэтому справа оставлено место `HUB_TILE_RIGHT`.
 */
export const HUB_TILE_RIGHT = 40;

export function tileBodyHtml(tile, summary) {
    const [first = '', second = ''] = summary.lines;
    return `<div class="hb"><div class="hb-title" style="left:16px;top:14px;right:${HUB_TILE_RIGHT}px">${escapeHtml(tile.title)}</div>`
        + `<div class="wg-text" style="left:16px;top:44px;right:16px;font-weight:600">${escapeHtml(first)}</div>`
        + (second ? `<div class="wg-muted" style="left:16px;top:68px;right:16px">${escapeHtml(second)}</div>` : '')
        + `</div>`;
}
