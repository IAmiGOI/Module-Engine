import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHARACTER_BANK_BUILDER, LOREBOOK_MARKER, BANK_TIMELINE_ADJUST, fillPrompt } from '../libraries/core/decision-prompts.js';

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

test('every bank placeholder is filled, including the importance floor', () => {
    const filled = fillPrompt(CHARACTER_BANK_BUILDER, {
        name: 'Lena', source_kind: 'card', source: 'A traveller.', canon_hint: '', aliases: '', timeline: '', guide: '',
        importance_floor: 'This character is already key in this story. ', steps: 12,
        // Name Literal mentions the literal macro on purpose; it must stay in the prompt.
        char: '{{char}}',
    });
    assert.deepEqual([...filled.matchAll(/\{\{[a-z0-9_]+\}\}/gi)].map(match => match[0]), ['{{char}}'], 'only the literal macro named by Name Literal remains');
    assert.match(filled, /CHARACTER: Lena/);
    assert.match(filled, /SOURCE \(card\):\nA traveller\./);
    assert.match(filled, /IMPORTANCE: decide it yourself.*This character is already key in this story\. A key bank/);
    assert.match(filled, /Its last line is "IMPORTANCE: key" or "IMPORTANCE: minor"\./);
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


test('the timeline adjust prompt is the PROMPTS.md section 17 text word for word', () => {
    const doc = readFileSync(new URL('../docs/research-decision/PROMPTS.md', import.meta.url), 'utf8');
    const start = doc.indexOf('## 17. Правка банка под таймлайн');
    const fence = doc.indexOf('```text', start);
    const body = doc.indexOf('\n', fence) + 1;
    assert.equal(BANK_TIMELINE_ADJUST, doc.slice(body, doc.indexOf('```', body)).trimEnd());
});

test('the lorebook marking prompt is the PROMPTS.md section 11 text word for word', () => {
    const doc = readFileSync(new URL('../docs/research-decision/PROMPTS.md', import.meta.url), 'utf8');
    const start = doc.indexOf('## 11. Директор — разметка лорбука при холодном запуске');
    const fence = doc.indexOf('```text', start);
    const body = doc.indexOf('\n', fence) + 1;
    assert.equal(LOREBOOK_MARKER, doc.slice(body, doc.indexOf('```', body)).trimEnd());
});

test('the IMPORTANCE line is split from the bank text; without it the importance is unknown', async () => {
    const { splitBankImportance } = await import('../libraries/core/decision-banks.js');
    assert.deepEqual(splitBankImportance('***Rem***\nA maid.\n\n**IMPORTANCE: key**\n'), { text: '***Rem***\nA maid.', importance: 'key' });
    assert.deepEqual(splitBankImportance('***Rem***\nA maid.\nIMPORTANCE: Minor'), { text: '***Rem***\nA maid.', importance: 'minor' });
    assert.deepEqual(splitBankImportance('***Rem***\nA maid.'), { text: '***Rem***\nA maid.', importance: null });
});
