import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DIRECTOR_WINDOW_SUMMARY, fillPrompt } from '../libraries/core/decision-prompts.js';

function promptFromDoc() {
    const doc = readFileSync(new URL('../docs/research-decision/PROMPTS.md', import.meta.url), 'utf8');
    const start = doc.indexOf('## 12. Директор — сводка выпавших циклов окна');
    const fence = doc.indexOf('```text', start);
    const body = doc.indexOf('\n', fence) + 1;
    return doc.slice(body, doc.indexOf('```', body)).trimEnd();
}

test('the window summary prompt is the PROMPTS.md section 12 text word for word', () => {
    assert.equal(DIRECTOR_WINDOW_SUMMARY, promptFromDoc());
});

test('every window summary placeholder is filled', () => {
    const filled = fillPrompt(DIRECTOR_WINDOW_SUMMARY, { cycles: 'TURN 1 (compressed)', arc: 'The Escape', reason: '50 cycles' });
    assert.doesNotMatch(filled, /\{\{[a-z0-9_]+\}\}/i);
    assert.match(filled, /rolled over \(50 cycles\)/);
    assert.match(filled, /ARC: The Escape/);
    assert.match(filled, /TURN 1 \(compressed\)/);
});
