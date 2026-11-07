import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    COUNSELLOR_SYSTEM, COUNSELLOR_REVIEW, COUNSELLOR_DAY, COUNSELLOR_MESSAGE,
} from '../libraries/core/decision-prompts.js';

function sectionFromDoc(heading) {
    const doc = readFileSync(new URL('../docs/research-decision/PROMPTS.md', import.meta.url), 'utf8');
    const start = doc.indexOf(heading);
    assert.ok(start >= 0, `PROMPTS.md has no section "${heading}"`);
    const fence = doc.indexOf('```text', start);
    const body = doc.indexOf('\n', fence) + 1;
    return doc.slice(body, doc.indexOf('```', body)).trimEnd();
}

test('the Counsellor system prompt is PROMPTS.md section 28 word for word', () => {
    assert.equal(COUNSELLOR_SYSTEM, sectionFromDoc('## 28. Советник — system'));
});

test('the review task is PROMPTS.md section 29 word for word', () => {
    assert.equal(COUNSELLOR_REVIEW, sectionFromDoc('## 29. Советник — разбор Ведомости'));
});

test('the day task is PROMPTS.md section 30 word for word', () => {
    assert.equal(COUNSELLOR_DAY, sectionFromDoc('## 30. Советник — конец RP-дня'));
});

test('the user-message task is PROMPTS.md section 31 word for word', () => {
    assert.equal(COUNSELLOR_MESSAGE, sectionFromDoc('## 31. Советник — сообщение пользователя'));
});
