import { buildFontSpec, computeLineHeight, isSameStyle } from './style.js';

/**
 * Жадный перенос строк одного абзаца — тот же алгоритм, что у браузера при `white-space: normal; overflow-wrap: normal`:
 * - кусок, не влезающий в остаток строки, уходит на следующую; пробел перед ним «висит» в конце предыдущей и в ширину не считается;
 * - кусок шире всей строки ставится один и вылезает за край (`overflow-wrap: normal` — слово не рвётся);
 * - строка рядом с float-заглушкой аватарки укорачивается; если в укороченную не влезает даже первый кусок — строка опускается под заглушку.
 *
 * Высота строки — `line-height` блока. Картинка (строчная, по базовой линии) может её увеличить: верх строки — максимум из «текст над
 * базовой линией с половиной интерлиньяжа» и высоты картинки, низ — «текст под базовой линией с другой половиной».
 */

/**
 * Ширина строки так, как её считает LayoutNG при переносе: у каждого куска строки из ОДНОГО текстового узла (или картинки) float-ширина
 * округляется ВВЕРХ до `LayoutUnit` (1/64 px), куски складываются уже целыми. Возвращает число в 1/64 px. Проверено замерами: ширины
 * текстовых узлов в DOM — ровно `ceil(ширина canvas × 64) / 64`.
 */
export function computeLineUnits(widthBySource) {
    let units = 0;
    for (const width of widthBySource.values()) units += Math.ceil(width * 64 - 1e-7);
    return units;
}

/**
 * Влезает ли строка (`units` — в 1/64 px) в `available`. У LayoutNG `AvailableWidthToFit() = AvailableWidth().AddEpsilon()` — одна 1/64 px
 * запаса на округление. Сверка: заголовок 19201/64 при 300px влез, строка 40770/64 при 637px — нет.
 */
export function fitsInLine(units, available) {
    return units <= Math.round(available * 64) + 1;
}

/** `line-height` в `LayoutUnit`: 1,4 × 17,55px = 24,57px у браузера — 24,5625 (ближайшая 1/64). */
export function snapToLayoutUnit(value) {
    return Math.round(value * 64) / 64;
}

/**
 * Интерлиньяж над и под текстом. Замерено в Chromium: при `line-height` 21px и шрифте 15 + 5 лишний 1px целиком уходит ВНИЗ (верх
 * текста — на верху строки, низ строки с картинкой 80px — 80 + 5 + 1 = 86). Верхняя половина — вниз до целого пикселя, остаток — снизу.
 */
export function splitLeading(lineHeight, ascent, descent) {
    const leading = lineHeight - (ascent + descent);
    const top = Math.floor(leading / 2);
    return { top, bottom: leading - top };
}

/** Размер строчной картинки: `width` из атрибута или натуральный, `max-width: 100%` блока, высота — по пропорции (`height: auto`). */
export function computeImageBox(img, natural, containerWidth) {
    const naturalWidth = natural?.width || 0;
    const naturalHeight = natural?.height || 0;
    let width = img.width ?? naturalWidth;
    if (!(width > 0)) return { width: 0, height: 0 };
    width = Math.min(width, containerWidth);
    const height = naturalWidth > 0 ? width * (naturalHeight / naturalWidth) : (img.height ?? 0);
    return { width, height };
}

/**
 * Раскладывает элементы абзаца (`breaks.js`) в строки. `box` — горизонтальные границы содержимого блока (координаты тела), `top` — где
 * начинается первая строка, `exclusion` — `{ width, height }` float-заглушки в левом верхнем углу тела или `null`.
 * Возвращает `{ lines, bottom }`; каждая строка — `{ top, height, baseline, x, width, available, parts, images }`.
 */
export function breakParagraph(items, { style, align = 'left', box, top, exclusion, theme, env }) {
    const lineHeight = snapToLayoutUnit(computeLineHeight(style, theme));
    const baseFont = buildFontSpec(style, theme);
    const metrics = env.fontMetrics(baseFont);
    const ascent = Math.round(metrics.ascent);
    const descent = Math.round(metrics.descent);
    const leading = splitLeading(lineHeight, ascent, descent);
    const containerWidth = box.right - box.left;

    const widthOf = item => {
        if (item.width !== undefined) return item.width;
        if (item.k === 'space') { item.font = buildFontSpec(item.style, theme); item.width = env.textWidth(item.font, ' '); }
        else if (item.k === 'img') {
            const boxSize = computeImageBox(item.img, env.imageSize(item.img.src), containerWidth);
            item.width = boxSize.width;
            item.height = boxSize.height;
            item.src = item;
        } else {
            item.width = 0;
            for (const part of item.parts) {
                part.font = buildFontSpec(part.style, theme);
                part.width = env.textWidth(part.font, part.text);
                item.width += part.width;
            }
        }
        return item.width;
    };

    const extentAt = y => {
        let left = box.left;
        const shortened = Boolean(exclusion && y < exclusion.height && y + lineHeight > 0 && exclusion.width > box.left);
        if (shortened) left = Math.max(left, exclusion.width);
        return { left, right: box.right, shortened };
    };

    const lines = [];
    let y = top;
    let line = null;
    const openLine = () => { line = { top: y, extent: extentAt(y), placed: [], width: 0, bySource: new Map(), pendingSpace: null, hasContent: false }; };
    const pieces = item => (item.k === 'unit' ? item.parts : [item]);
    /** Ширина строки в 1/64 px, если добавить к ней элементы `extra` (не меняя саму строку). */
    const unitsWith = extra => {
        const bySource = new Map(line.bySource);
        for (const element of extra) for (const piece of pieces(element)) bySource.set(piece.src, (bySource.get(piece.src) ?? 0) + piece.width);
        return computeLineUnits(bySource);
    };
    const place = element => {
        for (const piece of pieces(element)) line.bySource.set(piece.src, (line.bySource.get(piece.src) ?? 0) + piece.width);
        line.placed.push(element);
        line.width += element.width;
    };
    const closeLine = () => {
        lines.push(finishLine(line, { lineHeight, ascent, descent, leading, align }));
        y = lines[lines.length - 1].top + lines[lines.length - 1].height;
        line = null;
    };

    openLine();
    for (let index = 0; index < items.length;) {
        const item = items[index];
        if (item.k === 'br') { closeLine(); openLine(); index += 1; continue; }
        if (item.k === 'space') { if (line.hasContent) line.pendingSpace = item; index += 1; continue; }
        widthOf(item);
        const available = line.extent.right - line.extent.left;
        if (!line.hasContent) {
            if (!fitsInLine(unitsWith([item]), available) && line.extent.shortened) {
                y = exclusion.height;
                openLine();
                continue;
            }
        } else {
            if (line.pendingSpace) widthOf(line.pendingSpace);
            const candidate = line.pendingSpace ? [line.pendingSpace, item] : [item];
            if (!fitsInLine(unitsWith(candidate), available)) { closeLine(); openLine(); continue; }
            if (line.pendingSpace) place(line.pendingSpace);
        }
        line.pendingSpace = null;
        place(item);
        line.hasContent = true;
        index += 1;
    }
    if (line.hasContent) closeLine();
    return { lines, bottom: y };
}

function finishLine(line, { lineHeight, ascent, descent, leading, align }) {
    const available = line.extent.right - line.extent.left;
    const offset = align === 'center' ? Math.max(0, (available - line.width) / 2) : 0;
    let x = line.extent.left + offset;
    const parts = [];
    const images = [];
    for (const item of line.placed) {
        if (item.k === 'img') {
            images.push({ src: item.img.src, x, width: item.width, height: item.height });
            x += item.width;
            continue;
        }
        const pieces = item.k === 'space' ? [{ text: ' ', style: item.style, font: item.font, width: item.width }] : item.parts;
        for (const piece of pieces) {
            const last = parts[parts.length - 1];
            if (last && isSameStyle(last.style, piece.style)) {
                last.text += piece.text;
                last.width += piece.width;
            } else {
                parts.push({ text: piece.text, style: piece.style, font: piece.font, x, width: piece.width });
            }
            x += piece.width;
        }
    }
    const tallestImage = images.reduce((max, image) => Math.max(max, image.height), 0);
    const aboveBaseline = Math.max(ascent + leading.top, tallestImage);
    const height = tallestImage > ascent + leading.top ? aboveBaseline + descent + leading.bottom : lineHeight;
    const baseline = line.top + aboveBaseline;
    for (const image of images) image.y = baseline - image.height;
    return { top: line.top, height, baseline, x: line.extent.left + offset, width: line.width, available, parts, images };
}
