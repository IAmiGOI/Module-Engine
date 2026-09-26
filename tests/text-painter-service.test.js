import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerTextPainterService, resolveTextColor, computeTiles, paintLayout, TEXT_SHADOWS } from '../services/text-painter.js';
import { parseBody, computeTextLayout } from '../libraries/shared/text-layout/index.js';
import { parseMiniHtml } from './helpers/mini-html.js';

/** Фейковый 2D-контекст: пишет вызовы, `measureText` — 10px на символ, пробел 5px; ascent/descent 15/5. */
function createFakeCanvas(width = 1, height = 1, log = []) {
    const context = {
        font: '', fillStyle: '', shadowBlur: 0, shadowColor: '', textBaseline: '', calls: log,
        measureText(text) { return { width: [...text].reduce((sum, char) => sum + (char === ' ' ? 5 : 10), 0), fontBoundingBoxAscent: 15, fontBoundingBoxDescent: 5 }; },
        fillText(text, x, y) { log.push({ op: 'fillText', text, x, y, font: this.font, fillStyle: this.fillStyle, shadowBlur: this.shadowBlur }); },
        fillRect(x, y, w, h) { log.push({ op: 'fillRect', x, y, w, h, fillStyle: this.fillStyle }); },
        setTransform(...args) { log.push({ op: 'setTransform', args }); },
    };
    return { width, height, getContext: () => context, log };
}

function buildService(overrides = {}) {
    const engine = createEngine();
    const canvases = [];
    const fontLoads = [];
    registerTextPainterService(engine.buses.services, {
        createCanvas: (width, height) => { const canvas = createFakeCanvas(width, height, []); canvases.push(canvas); return canvas; },
        parseHtml: html => parseMiniHtml(html),
        loadImageSize: async src => (src === 'ok.png' ? { width: 40, height: 20 } : null),
        loadFont: async (font, chars) => { fontLoads.push({ font, chars }); },
        ...overrides,
    });
    const caller = engine.registerCaller('core.probe', 'cores', {
        tier: 'official',
        allowedContracts: ['textPainter.parse', 'textPainter.measure', 'textPainter.metrics', 'textPainter.imageSizes', 'textPainter.paint'],
    });
    const call = (contract, params) => new Promise(resolve => caller.services.subscribe(contract, { params }, resolve));
    return { call, canvases, fontLoads };
}

test('resolveTextColor maps layout roles to theme colours and keeps explicit markup colours', () => {
    const colors = { body: '#111', em: '#222', quote: '#333' };
    assert.equal(resolveTextColor('@em', colors), '#222');
    assert.equal(resolveTextColor('@quote', colors), '#333');
    assert.equal(resolveTextColor('@link', colors), '#111', 'a role the theme has no colour for falls back to the body colour');
    assert.equal(resolveTextColor('#abcdef', colors), '#abcdef');
});

test('computeTiles splits a tall body so that no tile is taller than the texture limit in PHYSICAL pixels', () => {
    assert.deepEqual(computeTiles(100, 2, 4096), [{ top: 0, height: 100 }]);
    assert.deepEqual(computeTiles(5000, 2, 4096), [{ top: 0, height: 2048 }, { top: 2048, height: 2048 }, { top: 4096, height: 904 }]);
    assert.deepEqual(computeTiles(0, 1), [{ top: 0, height: 1 }], 'an empty body still gets one (1px) tile');
});

test('textPainter.parse uses the injected HTML parser and returns the layout blocks or the reason for the old path', async () => {
    const { call } = buildService();
    const supported = await call('textPainter.parse', { html: '<p>hi</p>' });
    assert.equal(supported.ok, true);
    assert.equal(supported.value.ok, true);
    assert.equal(supported.value.blocks[0].kind, 'para');
    const unsupported = await call('textPainter.parse', { html: '<table></table>' });
    assert.deepEqual({ ok: unsupported.value.ok, reason: unsupported.value.reason }, { ok: false, reason: '<table>' });
});

test('textPainter.measure loads each font for exactly the characters it has not seen yet BEFORE measuring (a not-yet-loaded web font would be measured with the fallback)', async () => {
    const { call, fontLoads } = buildService();
    const first = await call('textPainter.measure', { requests: [{ font: 'F', text: 'ab' }, { font: 'F', text: 'b c' }] });
    assert.deepEqual(first.value, [20, 25]);
    assert.deepEqual(fontLoads, [{ font: 'F', chars: 'ab c' }]);
    await call('textPainter.measure', { requests: [{ font: 'F', text: 'abc' }, { font: 'F', text: 'жa' }] });
    assert.deepEqual(fontLoads.slice(1), [{ font: 'F', chars: 'ж' }], 'only the new character triggers a load (web fonts load per unicode range)');
});

test('textPainter.metrics returns the font bounding box ascent/descent', async () => {
    const { call } = buildService();
    assert.deepEqual((await call('textPainter.metrics', { fonts: ['F'] })).value, [{ ascent: 15, descent: 5 }]);
});

test('textPainter.imageSizes returns natural sizes and null for images that fail to load', async () => {
    const { call } = buildService();
    assert.deepEqual((await call('textPainter.imageSizes', { srcs: ['ok.png', 'broken.png'] })).value, [{ width: 40, height: 20 }, null]);
});

function layoutOf(html, width = 300) {
    const parsed = parseBody(parseMiniHtml(html));
    const canvas = createFakeCanvas();
    const context = canvas.getContext();
    return computeTextLayout({
        parsed, width, theme: { fontFamily: 'T' },
        measure: (font, text) => context.measureText(text).width,
        metrics: () => ({ ascent: 15, descent: 5 }),
    });
}

test('paintLayout draws each run at its layout position and baseline, in its font and resolved colour, once per text-shadow layer', () => {
    const layout = layoutOf('<p>ab <em>cd</em></p>');
    const log = [];
    paintLayout(createFakeCanvas(1, 1, log).getContext(), layout, { dpr: 2, colors: { body: '#fff', em: '#aaa' } });
    const texts = log.filter(call => call.op === 'fillText');
    assert.equal(texts.length, 2 * TEXT_SHADOWS.length);
    assert.deepEqual(texts.map(call => [call.text, call.x, call.y, call.fillStyle]), [
        ['ab ', 0, 15, '#fff'], ['ab ', 0, 15, '#fff'],
        ['cd', 25, 15, '#aaa'], ['cd', 25, 15, '#aaa'],
    ]);
    assert.deepEqual(texts.slice(0, 2).map(call => call.shadowBlur), [5 * 2, 2 * 2], 'shadowBlur is not scaled by the transform, so it is given in physical pixels');
});

test('paintLayout draws underline/strike bars, list markers and the two-pixel hr', () => {
    const log = [];
    paintLayout(createFakeCanvas(1, 1, log).getContext(), layoutOf('<p><u>ab</u></p><ul><li>x</li></ul><hr>'), { colors: { body: '#fff' } });
    assert.ok(log.some(call => call.op === 'fillRect' && call.w === 20), 'underline as wide as the run');
    assert.ok(log.some(call => call.op === 'fillText' && call.text === '• '), 'bullet marker');
    assert.equal(log.filter(call => call.op === 'fillRect' && call.h === 1 && call.w === 300).length, 2, 'hr: two one-pixel rows');
});

test('textPainter.paint makes one canvas per tile at physical size, each shifted to its tile top', async () => {
    const { call, canvases } = buildService();
    const layout = layoutOf('<p>a</p><p>b</p>');
    const result = await call('textPainter.paint', { layout, dpr: 2, maxTextureSize: 64 });
    assert.equal(result.ok, true);
    assert.equal(result.value.width, 600);
    assert.deepEqual(result.value.tiles.map(tile => [tile.top, tile.height, tile.physicalHeight]), [[0, 32, 64], [32, 20, 40]]);
    const painted = canvases.slice(-2);
    assert.deepEqual(painted[1].getContext().calls.find(entry => entry.op === 'setTransform').args, [2, 0, 0, 2, 0, -64]);
});
