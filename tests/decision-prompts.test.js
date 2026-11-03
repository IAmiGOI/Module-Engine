import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DIRECTOR_SYSTEM, DIRECTOR_TURN } from '../libraries/core/decision-prompts.js';

function sectionFromDoc(heading) {
    const doc = readFileSync(new URL('../docs/research-decision/PROMPTS.md', import.meta.url), 'utf8');
    const start = doc.indexOf(heading);
    const fence = doc.indexOf('```text', start);
    const body = doc.indexOf('\n', fence) + 1;
    return doc.slice(body, doc.indexOf('```', body)).trimEnd();
}

test('the director system prompt is the PROMPTS.md section 1 text word for word', () => {
    assert.equal(DIRECTOR_SYSTEM, sectionFromDoc('## 1. Директор — system'));
});

test('the turn task is the PROMPTS.md section 2 text word for word', () => {
    assert.equal(DIRECTOR_TURN, sectionFromDoc('## 2. Директор — задание на ход'));
});
