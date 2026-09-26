import { parseBody } from '../libraries/shared/text-layout/index.js';

/**
 * Сервис отрисовки текста Chat Viewport — всё, что раскладчику (`libraries/shared/text-layout`) нужно от браузера, и сама отрисовка:
 * - `textPainter.parse({ html })` — настоящий HTML-парсер браузера → блоки раскладки или `{ ok: false, reason }` (старый путь);
 * - `textPainter.measure({ requests: [{ font, text }] })` → ширины, `textPainter.metrics({ fonts })` → `{ ascent, descent }`: Canvas 2D
 *   `measureText` на НАСТОЯЩИХ веб-шрифтах страницы (шрифт темы ST), пакетом — Ядро не ходит в Сервис за каждым словом;
 * - `textPainter.imageSizes({ srcs })` → натуральные размеры картинок;
 * - `textPainter.paint({ layout, dpr, colors, maxTextureSize })` → холст(ы) для `webglChat.uploadTexture`.
 *
 * Шрифт перед измерением ОБЯЗАН быть загружен: `measureText` с ещё не загруженным веб-шрифтом молча меряет запасным — раскладка
 * разошлась бы с отрисовкой. Поэтому каждое измерение ждёт `document.fonts.load(шрифт, символы)` для тех символов, что ещё не встречались
 * (веб-шрифты грузятся по `unicode-range`: кириллица — отдельный файл).
 */

/** Совпадает с CSS тела (`text-shadow: 0 0 5px rgba(0,0,0,.30), 0 0 2px rgba(0,0,0,.18)`): лёгкое затемнение за текстом. */
export const TEXT_SHADOWS = Object.freeze([
    Object.freeze({ blur: 5, color: 'rgba(0, 0, 0, 0.30)' }),
    Object.freeze({ blur: 2, color: 'rgba(0, 0, 0, 0.18)' }),
]);
/** Типичный безопасный предел текстуры WebGL; выше — плитки. */
export const DEFAULT_MAX_TEXTURE_SIZE = 4096;
const RULE_COLORS = ['rgba(128, 128, 128, 0.9)', 'rgba(200, 200, 200, 0.6)'];

/** Роль цвета раскладки (`@body`/`@em`/`@quote`/`@link`) → цвет темы; явный цвет из разметки — как есть. */
export function resolveTextColor(color, colors = {}) {
    if (typeof color !== 'string' || !color.startsWith('@')) return color || colors.body || '#dcdcd2';
    const role = color.slice(1);
    return colors[role] || colors.body || '#dcdcd2';
}

/** Плитки по вертикали (логические px), каждая не выше `maxTextureSize` ФИЗИЧЕСКИХ px. */
export function computeTiles(height, dpr, maxTextureSize = DEFAULT_MAX_TEXTURE_SIZE) {
    const tileLogical = Math.max(1, Math.floor(maxTextureSize / dpr));
    const tiles = [];
    for (let top = 0; top < height || tiles.length === 0; top += tileLogical) tiles.push({ top, height: Math.max(1, Math.min(tileLogical, Math.ceil(height) - top)) });
    return tiles;
}

function drawTextRun(context, text, x, baseline, dpr) {
    // Две тени — два прохода: у Canvas 2D одна тень на вызов. Непрозрачный текст поверх себя же не меняется, складываются только ореолы.
    for (const shadow of TEXT_SHADOWS) {
        context.shadowColor = shadow.color;
        context.shadowBlur = shadow.blur * dpr; // `shadowBlur` не масштабируется трансформацией — в физических px
        context.fillText(text, x, baseline);
    }
    context.shadowColor = 'transparent';
    context.shadowBlur = 0;
}

function drawDecorations(context, part, baseline, fontSize) {
    const thickness = Math.max(1, fontSize / 15);
    if (part.style.underline) context.fillRect(part.x, baseline + fontSize * 0.12, part.width, thickness);
    if (part.style.strike) context.fillRect(part.x, baseline - fontSize * 0.3, part.width, thickness);
}

/**
 * Рисует раскладку в 2D-контекст, уже масштабированный на `dpr` и сдвинутый на верх плитки. Чистая функция над переданным контекстом —
 * тестируется фейковым контекстом, записывающим вызовы.
 */
export function paintLayout(context, layout, { dpr = 1, colors = {}, top = 0, bottom = Infinity } = {}) {
    context.textBaseline = 'alphabetic';
    for (const line of layout.lines) {
        if (line.top + line.height < top || line.top > bottom) continue;
        for (const part of line.parts) {
            if (!part.text.trim()) continue;
            context.font = part.font;
            context.fillStyle = resolveTextColor(part.style.color, colors);
            drawTextRun(context, part.text, part.x, line.baseline, dpr);
            const fontSize = Number(/(\d+(?:\.\d+)?)px/.exec(part.font)?.[1] ?? 15);
            drawDecorations(context, part, line.baseline, fontSize);
        }
    }
    for (const box of layout.boxes) {
        if (box.kind === 'marker') {
            if (box.baseline < top - 50 || box.baseline > bottom + 50) continue;
            context.font = box.font;
            context.fillStyle = resolveTextColor(box.style?.color, colors);
            drawTextRun(context, box.text, box.x, box.baseline, dpr);
        } else if (box.kind === 'rule') {
            context.fillStyle = RULE_COLORS[0];
            context.fillRect(box.x, box.y, box.width, 1);
            context.fillStyle = RULE_COLORS[1];
            context.fillRect(box.x, box.y + 1, box.width, 1);
        }
    }
}

function defaultCreateCanvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
}

function defaultParseHtml(html) {
    return new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
}

function defaultLoadImageSize(src) {
    return new Promise(resolve => {
        const image = new Image();
        image.onload = () => resolve(image.naturalWidth > 0 ? { width: image.naturalWidth, height: image.naturalHeight } : null);
        image.onerror = () => resolve(null);
        image.src = src;
    });
}

function defaultLoadFont(font, text) {
    return globalThis.document?.fonts?.load ? document.fonts.load(font, text).then(() => {}, () => {}) : Promise.resolve();
}

export function registerTextPainterService(servicesBus, {
    createCanvas = defaultCreateCanvas,
    parseHtml = defaultParseHtml,
    loadImageSize = defaultLoadImageSize,
    loadFont = defaultLoadFont,
} = {}) {
    let measuringContext = null;
    const context2d = () => {
        if (!measuringContext) {
            measuringContext = createCanvas(1, 1).getContext('2d');
            if ('textRendering' in measuringContext) measuringContext.textRendering = 'geometricPrecision';
        }
        return measuringContext;
    };
    const seenChars = new Map(); // шрифт → символы, для которых он уже загружен
    const widths = new Map();
    const metricsCache = new Map();
    const imageSizes = new Map();

    async function ensureFonts(requests) {
        const pending = new Map();
        for (const { font, text } of requests) {
            const seen = seenChars.get(font) ?? new Set();
            seenChars.set(font, seen);
            for (const char of String(text ?? '')) {
                if (seen.has(char)) continue;
                seen.add(char);
                pending.set(font, (pending.get(font) ?? '') + char);
            }
        }
        await Promise.all([...pending].map(([font, chars]) => loadFont(font, chars)));
    }

    async function measure({ requests = [] } = {}) {
        await ensureFonts(requests);
        const context = context2d();
        return requests.map(({ font, text }) => {
            const key = `${font}\u0000${text}`;
            let width = widths.get(key);
            if (width === undefined) {
                context.font = font;
                width = context.measureText(text).width;
                widths.set(key, width);
            }
            return width;
        });
    }

    async function metrics({ fonts = [] } = {}) {
        await ensureFonts(fonts.map(font => ({ font, text: 'Hg' })));
        const context = context2d();
        return fonts.map(font => {
            let value = metricsCache.get(font);
            if (!value) {
                context.font = font;
                const measured = context.measureText('');
                value = { ascent: measured.fontBoundingBoxAscent, descent: measured.fontBoundingBoxDescent };
                metricsCache.set(font, value);
            }
            return value;
        });
    }

    async function sizesOf({ srcs = [] } = {}) {
        return Promise.all(srcs.map(async src => {
            if (!imageSizes.has(src)) imageSizes.set(src, loadImageSize(src));
            return imageSizes.get(src);
        }));
    }

    async function paint({ layout, dpr = 1, colors = {}, maxTextureSize = DEFAULT_MAX_TEXTURE_SIZE } = {}) {
        const physicalWidth = Math.max(1, Math.ceil(layout.width * dpr));
        const fonts = new Set(layout.lines.flatMap(line => line.parts.map(part => part.font)).concat(layout.boxes.filter(box => box.font).map(box => box.font)));
        await ensureFonts([...fonts].map(font => ({ font, text: layout.lines.flatMap(line => line.parts.filter(part => part.font === font).map(part => part.text)).join('') })));
        const tiles = computeTiles(layout.height, dpr, maxTextureSize).map(tile => {
            const physicalHeight = Math.max(1, Math.ceil(tile.height * dpr));
            const canvas = createCanvas(physicalWidth, physicalHeight);
            const context = canvas.getContext('2d');
            if ('textRendering' in context) context.textRendering = 'geometricPrecision';
            context.setTransform(dpr, 0, 0, dpr, 0, -tile.top * dpr);
            paintLayout(context, layout, { dpr, colors, top: tile.top, bottom: tile.top + tile.height });
            return { image: canvas, top: tile.top, height: tile.height, physicalWidth, physicalHeight };
        });
        return { tiles, width: physicalWidth, height: Math.max(1, Math.ceil(layout.height * dpr)) };
    }

    const unregisters = [
        servicesBus.register('textPainter.parse', ({ html } = {}) => parseBody(parseHtml(String(html ?? ''))), { loadMetric: () => 1 }),
        servicesBus.register('textPainter.measure', params => measure(params), { loadMetric: () => 1 }),
        servicesBus.register('textPainter.metrics', params => metrics(params), { loadMetric: () => 1 }),
        servicesBus.register('textPainter.imageSizes', params => sizesOf(params), { loadMetric: () => 1 }),
        servicesBus.register('textPainter.paint', params => paint(params), { loadMetric: () => 1 }),
    ];
    return () => { for (const unregister of unregisters) unregister(); };
}
