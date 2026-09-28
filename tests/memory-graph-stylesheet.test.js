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

test('graphStylesheet() drives node size/color/glow ENTIRELY from data() — never a hardcoded number for a metric-driven property', () => {
    const rules = graphStylesheet();
    const nodeRule = rules.find(rule => rule.selector === 'node');
    assert.equal(nodeRule.style.width, 'data(size)');
    assert.equal(nodeRule.style.height, 'data(size)');
    assert.equal(nodeRule.style['background-color'], 'data(color)');
    assert.equal(nodeRule.style['underlay-color'], 'data(color)');
    assert.equal(nodeRule.style['underlay-opacity'], 'data(glow)');
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
