import test from 'node:test';
import assert from 'node:assert/strict';
import { weightColor, graphStylesheet, PREVIEW_ID } from '../cores/ui/memory-graph/stylesheet.js';

test('weightColor() maps the weakest rank (0) to red and the strongest rank (1) to green', () => {
    assert.equal(weightColor(0), '#e74c3c');
    assert.equal(weightColor(1), '#2ecc71');
});

test('weightColor() maps the midpoint (0.5) to amber, matching the old importance-based "sicker->healthier" scale', () => {
    assert.equal(weightColor(0.5), '#f1c40f');
});

test('weightColor() clamps out-of-range input instead of extrapolating past red/green', () => {
    assert.equal(weightColor(-5), weightColor(0));
    assert.equal(weightColor(5), weightColor(1));
});

test('weightColor() treats a non-finite rank (null/NaN — e.g. a brand-new node with no weight yet) as the weakest (0), not a crash', () => {
    assert.equal(weightColor(null), weightColor(0));
    assert.equal(weightColor(NaN), weightColor(0));
});

test('graphStylesheet() drives node size/color ENTIRELY from data() — never a hardcoded number for a metric-driven property', () => {
    const rules = graphStylesheet();
    const nodeRule = rules.find(rule => rule.selector === 'node');
    assert.equal(nodeRule.style.width, 'data(size)');
    assert.equal(nodeRule.style.height, 'data(size)');
    assert.equal(nodeRule.style['background-color'], 'data(color)');
    assert.equal(nodeRule.style['underlay-color'], 'data(color)');
});

// РЕАЛЬНАЯ ЖАЛОБА владельца (реворк UI, ROADMAP.md 5.108м): "СВЕЧЕНИЕ ВСЕ ЕЩЕ УЖАСНОЕ. ПОЧЕМУ ОНО КРУГОМ, А НЕ
// СВЕТОМ?" — Cytoscape's underlay-* не умеет градиент/затухание, только заливку сплошным цветом. Повседневное
// свечение переехало на честный canvas-радиальный градиент (`paintGlowCanvas()`, memory-graph-panel.js); базовая
// `underlay-opacity` теперь константный `0` — НЕ `data(glow)` (старый контракт), — `underlay-color`/`-padding`/
// `-shape` остаются только донором для классов подсветки ретрива ниже.
test('graphStylesheet() disables the base node underlay entirely — ambient glow moved to a real canvas radial gradient, not Cytoscape\'s flat-color underlay', () => {
    const rules = graphStylesheet();
    const nodeRule = rules.find(rule => rule.selector === 'node');
    assert.equal(nodeRule.style['underlay-opacity'], 0);
});

test('graphStylesheet() still lets the retrieval-highlight classes (beacon/route-node/noise) override underlay-opacity for their own, independent highlight — a secondary language, not the disabled ambient glow', () => {
    const rules = graphStylesheet();
    const beaconRule = rules.find(rule => rule.selector === 'node.beacon');
    const routeNodeRule = rules.find(rule => rule.selector === 'node.route-node');
    const noiseRule = rules.find(rule => rule.selector === 'node.noise');
    assert.ok(beaconRule.style['underlay-opacity'] > 0);
    assert.ok(routeNodeRule.style['underlay-opacity'] > 0);
    assert.ok(noiseRule.style['underlay-opacity'] > 0);
});

test('graphStylesheet() shows a label for protected nodes and large nodes without requiring hover, but keeps hover working for everything else', () => {
    const rules = graphStylesheet();
    const labelRule = rules.find(rule => rule.selector.includes('protectedNode') && rule.selector.includes('hovered'));
    assert.ok(labelRule, 'one rule must cover protected OR large OR hovered nodes');
    assert.equal(labelRule.style.label, 'data(label)');
});

test('graphStylesheet() still carries the PREVIEW_ID marker rule, unchanged in spirit — a dashed, non-interactive placeholder', () => {
    const rules = graphStylesheet();
    const previewRule = rules.find(rule => rule.selector === `#${PREVIEW_ID}`);
    assert.ok(previewRule);
    assert.equal(previewRule.style['border-style'], 'dashed');
});

test('graphStylesheet() gives backbone edges (both endpoints protected) a heavier, more opaque line than ordinary edges', () => {
    const rules = graphStylesheet();
    const edgeRule = rules.find(rule => rule.selector === 'edge');
    const backboneRule = rules.find(rule => rule.selector === 'edge[?backbone]');
    assert.ok(backboneRule.style.width > edgeRule.style.width);
    assert.ok(backboneRule.style['line-opacity'] > edgeRule.style['line-opacity']);
});

// РЕАЛЬНЫЙ БАГ, найден живьём (владелец: "ноды сами теперь не показываются... двигать карту мышкой больше не
// могу") — подтверждено на настоящем Cytoscape 3.30.2: базовое правило `edge` с БЕЗУСЛОВНЫМ
// `'line-gradient-stop-colors': 'data(lineGradientColors)'` бросает исключение ПРЯМО В КОНСТРУКТОРЕ `cytoscape(...)`,
// как только хоть у одного ребра это поле — пустая строка (обычный, не меж-региональный случай, ровно то, что
// `buildNextElements()` ставит по умолчанию) — Cytoscape не может провалидировать '' как список цветов градиента.
// Этот тест не поднимает настоящий Cytoscape (не может, здесь нет DOM/canvas), но ловит именно ЭТУ ошибку
// конфигурации статически: `line-gradient-stop-colors` не должно быть в правиле с селектором РОВНО `'edge'`
// (безусловным, применяется КО ВСЕМ рёбрам) — только в правиле с более узким, ОТФИЛЬТРОВАННЫМ селектором.
test('graphStylesheet() never puts line-gradient-stop-colors on the UNCONDITIONAL "edge" selector — real Cytoscape throws in its constructor as soon as any edge has an empty lineGradientColors (the ordinary, non-cross-region case)', () => {
    const rules = graphStylesheet();
    const unconditionalEdgeRule = rules.find(rule => rule.selector === 'edge');
    assert.equal(unconditionalEdgeRule.style['line-gradient-stop-colors'], undefined, 'line-gradient-stop-colors must live on a filtered selector, not the bare "edge" rule that applies to every edge including ones with an empty gradient string');
});

test('graphStylesheet() applies line-gradient-stop-colors only to edges explicitly marked lineFill === "linear-gradient" — a narrower selector than the bare "edge" rule', () => {
    const rules = graphStylesheet();
    const gradientRule = rules.find(rule => rule.style['line-gradient-stop-colors'] !== undefined);
    assert.ok(gradientRule, 'some rule must still set line-gradient-stop-colors for real cross-region edges');
    assert.notEqual(gradientRule.selector, 'edge', 'must not be the unconditional selector');
    assert.match(gradientRule.selector, /lineFill/, 'selector must filter on lineFill so only real gradient edges get this property');
});
