import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerHtmlRasterizerService, buildForeignObjectSvg } from '../services/html-rasterizer.js';

// --- Unit level: buildForeignObjectSvg is pure — string in, string out ---

test('buildForeignObjectSvg wraps the given HTML in a foreignObject sized to width/height', () => {
    const svg = buildForeignObjectSvg({ html: '<p>hi</p>', width: 300.6, height: 150.2 });
    assert.match(svg, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="301" height="150">/);
    assert.match(svg, /<foreignObject width="100%" height="100%">/);
    assert.match(svg, /<p>hi<\/p>/);
});

test('buildForeignObjectSvg inlines the given CSS as a <style> tag inside the foreignObject — foreignObject does not inherit the host page stylesheet', () => {
    const svg = buildForeignObjectSvg({ html: '<p>hi</p>', width: 100, height: 50, css: '.x{color:red}' });
    assert.match(svg, /<style>\.x\{color:red\}<\/style>/);
});

test('buildForeignObjectSvg omits the <style> tag entirely when no css is given, rather than emitting an empty one', () => {
    const svg = buildForeignObjectSvg({ html: '<p>hi</p>', width: 100, height: 50 });
    assert.doesNotMatch(svg, /<style>/);
});

test('buildForeignObjectSvg with scale=2 doubles the OUTER svg size (physical resolution) but keeps the inner content box at the LOGICAL width, scaled up via CSS transform — this is what keeps text wrapping identical to the logical-size DOM mirror while still rasterizing at a sharper resolution', () => {
    const svg = buildForeignObjectSvg({ html: '<p>hi</p>', width: 300, height: 150, scale: 2 });
    assert.match(svg, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="600" height="300">/);
    assert.match(svg, /style="width:300px; transform: scale\(2\); transform-origin: top left;"/);
});

test('buildForeignObjectSvg defaults scale to 1 — outer and logical sizes match exactly, no transform surprise for existing (pre-DPR-fix) callers', () => {
    const svg = buildForeignObjectSvg({ html: '<p>hi</p>', width: 300, height: 150 });
    assert.match(svg, /transform: scale\(1\)/);
});

test('buildForeignObjectSvg clamps width/height to at least 1 — a zero-size message row must not produce a zero-area SVG', () => {
    const svg = buildForeignObjectSvg({ html: '', width: 0, height: -5 });
    assert.match(svg, /width="1" height="1"/);
});

// --- Scenario level (TESTING.md "Уровень 2" flavor, service-focused like
// st-chat-service.test.js): real engine, real Gate, only the browser-only
// `rasterizeToImage` boundary is faked — it's a real platform capability
// (loading a data-URI SVG through <img>), not something Node can do. ---

// Тождественный фейк по умолчанию — реальный `normalizeHtmlToXml` требует
// `document`/`XMLSerializer`, которых в Node нет (тот же разрез, что у
// `rasterizeToImage`). Тесты, которым важно именно ЭТО поведение, передают
// свой собственный фейк явно (см. ниже).
function buildService(rasterizeToImage, { normalizeHtmlToXml = html => html } = {}) {
    const engine = createEngine();
    registerHtmlRasterizerService(engine.buses.services, { rasterizeToImage, normalizeHtmlToXml });
    const caller = engine.registerCaller('module.probe', 'modules', {
        tier: 'community',
        allowedContracts: ['htmlRasterizer.rasterize'],
    });
    return { engine, caller };
}

function call(caller, contract, params) {
    return new Promise(resolve => caller.services.subscribe(contract, { params }, resolve));
}

test('htmlRasterizer.rasterize passes the built SVG to the injected rasterizer and returns its image alongside the resolved width/height', async () => {
    const seenSvgs = [];
    const fakeImage = { __fake: 'image' };
    const { caller } = buildService(async svgString => { seenSvgs.push(svgString); return fakeImage; });

    const result = await call(caller, 'htmlRasterizer.rasterize', { html: '<p>hello</p>', width: 400, height: 120, css: 'p{color:blue}' });

    assert.equal(result.ok, true);
    assert.equal(result.value.image, fakeImage);
    assert.equal(result.value.width, 400);
    assert.equal(result.value.height, 120);
    assert.equal(seenSvgs.length, 1);
    assert.match(seenSvgs[0], /<p>hello<\/p>/);
    assert.match(seenSvgs[0], /p\{color:blue\}/);
});

test('htmlRasterizer.rasterize runs the html through normalizeHtmlToXml BEFORE embedding it in the SVG — found live in real SillyTavern 1.18: messageFormatting() output (unescaped "&", unclosed <br>) is valid HTML but not valid XML, and an SVG containing it fails to decode entirely', async () => {
    const seenSvgs = [];
    const { caller } = buildService(
        async svgString => { seenSvgs.push(svgString); return { __fake: 'image' }; },
        { normalizeHtmlToXml: html => html.replace(/<br>/g, '<br/>').replace(/&(?!amp;)/g, '&amp;') },
    );

    await call(caller, 'htmlRasterizer.rasterize', { html: '<p>Tom & Jerry<br>next line</p>', width: 100, height: 50 });

    assert.match(seenSvgs[0], /Tom &amp; Jerry<br\/>next line/);
});

test('htmlRasterizer.rasterize with scale:2 returns PHYSICAL width/height (doubled), not the logical input — the caller (Chat Viewport) builds its WebGL quad from this, so it must match the actual image resolution', async () => {
    const { caller } = buildService(async () => ({ __fake: 'image' }));

    const result = await call(caller, 'htmlRasterizer.rasterize', { html: '<p>x</p>', width: 400, height: 120, scale: 2 });

    assert.equal(result.value.width, 800);
    assert.equal(result.value.height, 240);
});

test('htmlRasterizer.rasterize surfaces a decode failure as a Gate-level error, not a silent blank image', async () => {
    const { caller } = buildService(async () => { throw new Error('boom'); });

    const result = await call(caller, 'htmlRasterizer.rasterize', { html: '<p>x</p>', width: 100, height: 50 });

    assert.equal(result.ok, false);
    assert.match(result.error.message, /boom/);
});
