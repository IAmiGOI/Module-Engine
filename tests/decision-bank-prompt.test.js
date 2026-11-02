import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHARACTER_BANK_BUILDER, fillPrompt } from '../libraries/core/decision-prompts.js';

function promptFromDoc() {
    const doc = readFileSync(new URL('../docs/research-decision/PROMPTS.md', import.meta.url), 'utf8');
    const start = doc.indexOf('## 10. Субагент — сборка дата-банка');
    const fence = doc.indexOf('```text', start);
    const body = doc.indexOf('\n', fence) + 1;
    return doc.slice(body, doc.indexOf('```', body)).trimEnd();
}

test('the bank subagent prompt is the PROMPTS.md section 10 text word for word', () => {
    assert.equal(CHARACTER_BANK_BUILDER, promptFromDoc());
});

test('every bank placeholder is filled, including the size band', () => {
    const filled = fillPrompt(CHARACTER_BANK_BUILDER, {
        name: 'Lena', source_kind: 'card', source: 'A traveller.', canon_hint: '',
        size_band: 'key', steps: 12,
        // Name Literal mentions the literal macro on purpose; it must stay in the prompt.
        char: '{{char}}',
    });
    assert.deepEqual([...filled.matchAll(/\{\{[a-z0-9_]+\}\}/gi)].map(match => match[0]), ['{{char}}'], 'only the literal macro named by Name Literal remains');
    assert.match(filled, /CHARACTER: Lena/);
    assert.match(filled, /SOURCE \(card\):\nA traveller\./);
    assert.match(filled, /SIZE: key/);
    assert.match(filled, /at most 12 steps/);
});

test('the size band is key for the main card character and library levels 1–2, minor for the rest', async () => {
    const { bankSizeBand } = await import('../libraries/core/decision-banks.js');
    assert.equal(bankSizeBand({ isMain: true }), 'key');
    assert.equal(bankSizeBand({ level: 1 }), 'key');
    assert.equal(bankSizeBand({ level: 2 }), 'key');
    assert.equal(bankSizeBand({ level: 3 }), 'minor');
    assert.equal(bankSizeBand({}), 'minor');
});
