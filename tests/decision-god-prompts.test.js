import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    GOD_SYSTEM, GOD_BUILD_TASK, GOD_THINK_BUILD, GOD_PRAYER_TASK, GOD_THINK_PRAYER, GOD_DECLARATION_TASK,
    GOD_MATERIAL_HEADER, NO_MATERIAL, GOD_SCALES_HEADER, GOD_PRAYERS_HEADER, GOD_RP_HEADER,
    GOD_QUESTIONS_HEADER, NO_QUESTIONS, CREATION_HEADER, DISCOVERIES_HEADER, GOD_ASKS_HEADER,
} from '../libraries/core/decision-prompts.js';

const doc = () => readFileSync(new URL('../docs/research-decision/PROMPTS.md', import.meta.url), 'utf8');

function sectionBlocks(heading) {
    const text = doc();
    const start = text.indexOf(heading);
    assert.ok(start >= 0, `PROMPTS.md has no section "${heading}"`);
    // Следующий раздел нумерован; «## How You…» внутри CoT — не раздел.
    const next = /\n## \d+\./g;
    next.lastIndex = start + 1;
    const match = next.exec(text);
    const end = match ? match.index : text.length;
    const blocks = [];
    let at = start;
    for (;;) {
        const fence = text.indexOf('```text', at);
        if (fence < 0 || fence > end) break;
        const body = text.indexOf('\n', fence) + 1;
        const close = text.indexOf('```', body);
        if (close < 0 || close > end) break;
        blocks.push(text.slice(body, close).trimEnd());
        at = close + 3;
    }
    return blocks;
}

test('the God system prompt is PROMPTS.md section 36 word for word', () => {
    assert.equal(GOD_SYSTEM, sectionBlocks('## 36. God — system')[0]);
});

test('the God build task and its CoT are PROMPTS.md section 37 word for word', () => {
    const blocks = sectionBlocks('## 37. God — построение Creation');
    assert.equal(GOD_BUILD_TASK, blocks[0]);
    assert.equal(GOD_THINK_BUILD, blocks[1]);
});

test('the God Prayer task and its CoT are PROMPTS.md section 38 word for word', () => {
    const blocks = sectionBlocks('## 38. God — Молитва');
    assert.equal(GOD_PRAYER_TASK, blocks[0]);
    assert.equal(GOD_THINK_PRAYER, blocks[1]);
});

test('the God Declaration task is PROMPTS.md section 39 word for word', () => {
    assert.equal(GOD_DECLARATION_TASK, sectionBlocks('## 39. God — Декларация')[0]);
});

test('the God and Counsellor context headers are the ones documented in sections 40 and 32', () => {
    const text = doc();
    for (const value of [
        GOD_MATERIAL_HEADER, NO_MATERIAL, GOD_SCALES_HEADER, GOD_PRAYERS_HEADER, GOD_RP_HEADER,
        GOD_QUESTIONS_HEADER, NO_QUESTIONS, CREATION_HEADER, DISCOVERIES_HEADER, GOD_ASKS_HEADER,
    ]) {
        assert.ok(text.includes(value), `PROMPTS.md is missing "${value}"`);
    }
    assert.notEqual(GOD_QUESTIONS_HEADER, GOD_ASKS_HEADER, 'the two question headers belong to different readers');
});

test('the resolver prompt binds an attempt to the Scales and sends a bypass to a Prayer', () => {
    const section = sectionBlocks('## 2. Резолвер — задание на ход')[0];
    assert.match(section, /binds every attempt that uses it/);
    assert.match(section, /not forbidden: it is an honest discovery/);
    assert.match(section, /pass it to God as a prayer/);
});
