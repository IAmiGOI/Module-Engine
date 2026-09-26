import { computeBreakItems } from './breaks.js';
import { breakParagraph, snapToLayoutUnit, splitLeading } from './line-breaker.js';
import { buildFontSpec, computeLineHeight } from './style.js';

/**
 * Вертикальная раскладка блоков — повторяет то, что делает браузер с CSS тела (`* { margin: 0 }`, `> * + * { margin-top: gap }`,
 * отступы списков/цитат):
 * - Отступы схлопываются: пустой блок (`<p></p>`, ST вставляет такие между абзацами) не добавляет свой промежуток к соседнему — берётся
 *   больший из подряд идущих, а не сумма.
 * - Отступ перед самым первым содержимым и после последнего в высоту не входит: у зеркала (не BFC) они схлопываются наружу.
 * - `div`/`center`/`blockquote`/списки без своих полей и рамок — их отступы тоже схлопываются с детьми.
 *
 * `hr` — рамка 1px сверху и снизу при нулевой высоте (стиль браузера по умолчанию, поля сброшены): 2px.
 */

const RULE_HEIGHT = 2;
const BULLETS = ['•', '◦', '▪'];

function hasLineContent(items) {
    return items.some(item => item.k === 'unit' || item.k === 'img' || item.k === 'br');
}

/** Начало содержимого блока: накопленный отступ применяется, если это не самое начало тела. */
function beginContent(state) {
    if (!state.atStart) state.y += state.pendingGap;
    state.pendingGap = 0;
    state.atStart = false;
}

function layoutPara(block, box, state, context) {
    const items = computeBreakItems(block.inlines);
    if (!hasLineContent(items)) return;
    beginContent(state);
    const { lines, bottom } = breakParagraph(items, {
        style: block.style, align: block.align, box, top: state.y, exclusion: context.exclusion, theme: context.theme, env: context.env,
    });
    for (const line of lines) {
        context.out.lines.push(line);
        for (const image of line.images) context.out.boxes.push({ kind: 'image', ...image });
    }
    state.y = bottom;
}

function markerText(list, index) {
    if (list.ordered) return `${list.start + index}. `;
    return `${BULLETS[Math.min(list.depth, BULLETS.length - 1)]} `;
}

function layoutList(block, box, state, context) {
    const { theme, env, out } = context;
    const inner = { left: box.left + theme.listIndentEm * theme.fontSize, right: box.right };
    block.items.forEach((itemBlocks, index) => {
        const text = markerText(block, index);
        const font = buildFontSpec(block.markerStyle, theme);
        const width = env.textWidth(font, text);
        // Маркер кладётся ДО содержимого пункта — порядок коробок совпадает с порядком в документе (вложенный список идёт после маркера пункта).
        const marker = { kind: 'marker', text, font, style: block.markerStyle, x: inner.left - width, baseline: 0, width };
        out.boxes.push(marker);
        const firstLine = out.lines.length;
        layoutBlocks(itemBlocks, inner, state, context);
        if (out.lines.length > firstLine) marker.baseline = out.lines[firstLine].baseline;
        else {
            // Пустой пункт: маркер сам создаёт строку высотой в межстрочный интервал.
            beginContent(state);
            const lineHeight = snapToLayoutUnit(computeLineHeight(block.markerStyle, theme));
            const metrics = env.fontMetrics(font);
            const ascent = Math.round(metrics.ascent);
            const descent = Math.round(metrics.descent);
            marker.baseline = state.y + splitLeading(lineHeight, ascent, descent).top + ascent;
            state.y += lineHeight;
        }
    });
}

export function layoutBlocks(blocks, box, state, context) {
    for (const block of blocks) {
        if (block.gap) state.pendingGap = Math.max(state.pendingGap, context.theme.blockGap);
        if (block.kind === 'para') layoutPara(block, box, state, context);
        else if (block.kind === 'rule') {
            beginContent(state);
            context.out.boxes.push({ kind: 'rule', x: box.left, y: state.y, width: box.right - box.left, height: RULE_HEIGHT });
            state.y += RULE_HEIGHT;
        } else if (block.kind === 'group') layoutBlocks(block.blocks, box, state, context);
        else if (block.kind === 'quote') layoutBlocks(block.blocks, { left: box.left + context.theme.quoteIndent, right: box.right }, state, context);
        else if (block.kind === 'list') layoutList(block, box, state, context);
    }
}
