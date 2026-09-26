import { parseBody, computeTextLayout } from '../../libraries/shared/text-layout/index.js';

/**
 * Сверка раскладчика с браузером (запускается в браузере: страница `index.html` или консоль настоящей ST, см. `st-console.js`).
 *
 * Эталон — настоящее зеркало Chat Viewport: те же классы (`stme-chat-viewport-mirror-host` > `stme-chat-viewport-mirror`) и тот же
 * `styles/chat-viewport/mirror-row.css`, что на странице ST. Для каждого сообщения и ширины сравнивается:
 * - разбиение на строки: текст каждой строки (по вертикальным позициям графем через `Range`) против строк раскладчика, пробелы не учитываются;
 * - высота: `getBoundingClientRect().height` зеркала против высоты раскладки;
 * - базовые линии: верх графемы в DOM против `baseline − ascent` раскладки (проверка того, что отрисовка встанет туда же, где браузер).
 */

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function createCanvasMeasurer() {
    const context = document.createElement('canvas').getContext('2d');
    if ('textRendering' in context) context.textRendering = 'geometricPrecision';
    const widths = new Map();
    const metrics = new Map();
    return {
        measure(font, text) {
            const key = `${font}\u0000${text}`;
            let value = widths.get(key);
            if (value === undefined) {
                context.font = font;
                value = context.measureText(text).width;
                widths.set(key, value);
            }
            return value;
        },
        metrics(font) {
            let value = metrics.get(font);
            if (!value) {
                context.font = font;
                const measured = context.measureText('');
                value = { ascent: measured.fontBoundingBoxAscent, descent: measured.fontBoundingBoxDescent };
                metrics.set(font, value);
            }
            return value;
        },
    };
}

/** Строки DOM: графемы с одинаковой вертикалью — одна строка. Возвращает `[{ text, top }]`. */
function readDomLines(root, lineHeight) {
    const lines = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        let offset = 0;
        for (const { segment } of graphemeSegmenter.segment(node.data)) {
            const start = offset;
            offset += segment.length;
            if (/^\s$/.test(segment)) continue;
            range.setStart(node, start);
            range.setEnd(node, offset);
            const rect = range.getClientRects()[0];
            if (!rect) continue;
            const last = lines[lines.length - 1];
            if (!last || rect.top > last.top + lineHeight / 2) lines.push({ text: segment, top: rect.top });
            else last.text += segment;
        }
    }
    return lines;
}

async function waitForImages(root) {
    await Promise.all([...root.querySelectorAll('img')].map(img => (img.complete ? null : img.decode().catch(() => {}))));
}

function engineLineTexts(layout) {
    return layout.lines.map(line => line.parts.map(part => part.text).join('').replace(/\s+/g, ''));
}

/**
 * `samples: [{ id, html }]`, `widths: number[]`, `theme` (как у раскладчика: fontFamily, fontSize, lineHeight, blockGap…).
 * Зеркало должно уже стоять в документе: `host` — элемент `.stme-chat-viewport-mirror-host`.
 */
export async function runLayoutCheck({ samples, widths, theme, host, measurer = createCanvasMeasurer(), onProgress }) {
    const mirror = document.createElement('div');
    mirror.className = 'stme-chat-viewport-mirror';
    mirror.style.fontFamily = theme.fontFamily;
    host.append(mirror);
    const naturalSizes = new Map();
    const lineHeight = theme.fontSize * theme.lineHeight;
    const runs = [];
    const unsupported = new Map();
    let done = 0;
    for (const sample of samples) {
        const parsed = parseBody(new DOMParser().parseFromString(`<body>${sample.html}</body>`, 'text/html').body);
        if (!parsed.ok) {
            unsupported.set(parsed.reason, (unsupported.get(parsed.reason) ?? 0) + 1);
            runs.push({ id: sample.id, supported: false, reason: parsed.reason });
            continue;
        }
        for (const width of widths) {
            mirror.style.width = `${width}px`;
            mirror.innerHTML = sample.html;
            await waitForImages(mirror);
            for (const img of mirror.querySelectorAll('img')) naturalSizes.set(img.getAttribute('src'), { width: img.naturalWidth, height: img.naturalHeight });
            const domHeight = mirror.getBoundingClientRect().height;
            const mirrorTop = mirror.getBoundingClientRect().top;
            const domLines = readDomLines(mirror, lineHeight).map(line => ({ text: line.text, top: line.top - mirrorTop }));
            const layout = computeTextLayout({
                parsed, width, theme, measure: measurer.measure, metrics: measurer.metrics, imageSize: src => naturalSizes.get(src),
            });
            if (!layout.complete) throw new Error(`layout incomplete for ${sample.id}: ${JSON.stringify(layout.missing).slice(0, 200)}`);
            const engineLines = engineLineTexts(layout).filter(text => text.length);
            const textLines = layout.lines.filter(line => line.parts.some(part => part.text.trim()));
            let firstMismatch = -1;
            const count = Math.max(engineLines.length, domLines.length);
            for (let index = 0; index < count; index += 1) if (engineLines[index] !== domLines[index]?.text) { firstMismatch = index; break; }
            let maxBaselineError = 0;
            if (firstMismatch < 0) {
                textLines.forEach((line, index) => {
                    const firstFont = line.parts.find(part => part.text.trim())?.font;
                    const ascent = measurer.metrics(firstFont).ascent;
                    maxBaselineError = Math.max(maxBaselineError, Math.abs((line.baseline - ascent) - domLines[index].top));
                });
            }
            runs.push({
                id: sample.id, width, supported: true,
                linesMatch: firstMismatch < 0, domLineCount: domLines.length, engineLineCount: engineLines.length,
                domHeight, engineHeight: layout.height, heightDiff: layout.height - domHeight, maxBaselineError,
                mismatch: firstMismatch < 0 ? null : { line: firstMismatch, dom: domLines[firstMismatch]?.text ?? null, engine: engineLines[firstMismatch] ?? null },
            });
        }
        done += 1;
        onProgress?.(done, samples.length);
    }
    mirror.remove();
    return summarize(runs, unsupported, samples.length);
}

function summarize(runs, unsupported, messageCount) {
    const tested = runs.filter(run => run.supported);
    const unsupportedMessages = runs.filter(run => !run.supported).length;
    const linesExact = tested.filter(run => run.linesMatch).length;
    const heightWithin1 = tested.filter(run => Math.abs(run.heightDiff) <= 1).length;
    const percent = value => (tested.length ? Math.round((1000 * value) / tested.length) / 10 : 0);
    return {
        messages: messageCount,
        unsupportedMessages,
        unsupportedShare: Math.round((1000 * unsupportedMessages) / Math.max(1, messageCount)) / 10,
        unsupportedReasons: Object.fromEntries(unsupported),
        runs: tested.length,
        linesExactPct: percent(linesExact),
        heightWithin1pxPct: percent(heightWithin1),
        maxAbsHeightDiff: tested.reduce((max, run) => Math.max(max, Math.abs(run.heightDiff)), 0),
        meanAbsHeightDiff: tested.length ? tested.reduce((sum, run) => sum + Math.abs(run.heightDiff), 0) / tested.length : 0,
        maxBaselineError: tested.reduce((max, run) => Math.max(max, run.maxBaselineError), 0),
        mismatches: tested.filter(run => !run.linesMatch || Math.abs(run.heightDiff) > 1),
        worstHeights: [...tested].sort((a, b) => Math.abs(b.heightDiff) - Math.abs(a.heightDiff)).slice(0, 8).map(run => ({ id: run.id, width: run.width, heightDiff: run.heightDiff, domHeight: run.domHeight })),
        worstBaselines: [...tested].sort((a, b) => b.maxBaselineError - a.maxBaselineError).slice(0, 8).map(run => ({ id: run.id, width: run.width, maxBaselineError: run.maxBaselineError })),
    };
}
