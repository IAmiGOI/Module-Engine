import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    DIRECTOR_SYSTEM, DIRECTOR_TURN,
    WRITER_AGENCY_QUESTION, WRITER_RESOLUTION_QUESTION, WRITER_REWRITE_PROMPT,
    WRITER_REASON_AGENCY, WRITER_REASON_RESOLUTION,
    FORM_KNOWLEDGE_QUESTION, FORM_KNOWLEDGE_REFUSAL,
    BOOTSTRAP_TASK, ASK_USER_DESCRIPTION, ASK_USER_ANSWERED, ASK_USER_SKIPPED, ASK_USER_NOT_ALLOWED, ASK_USER_LIMIT, ASK_USER_STREAK,
    WRITE_CHAT_BRIEF_DESCRIPTION,
} from '../libraries/core/decision-prompts.js';

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

function blockFromDoc(marker) {
    const doc = readFileSync(new URL('../docs/research-decision/PROMPTS.md', import.meta.url), 'utf8');
    const start = doc.indexOf(marker);
    const fence = doc.indexOf('```text', start);
    const body = doc.indexOf('\n', fence) + 1;
    return doc.slice(body, doc.indexOf('```', body)).trimEnd();
}

test('the writer check questions, reasons and rewrite prompt are PROMPTS.md section 13 word for word', () => {
    assert.equal(WRITER_AGENCY_QUESTION, blockFromDoc('**user_agency:**'));
    assert.equal(WRITER_RESOLUTION_QUESTION, blockFromDoc('**past_resolution:**'));
    assert.equal(WRITER_REWRITE_PROMPT, blockFromDoc('Дополнительный промпт для переписывания'));
    const reasons = blockFromDoc('Строки причин:').split('\n');
    assert.equal(WRITER_REASON_AGENCY, reasons[0]);
    assert.equal(WRITER_REASON_RESOLUTION, reasons[1]);
});

test('the form knowledge question and refusal are PROMPTS.md section 14 word for word', () => {
    assert.equal(FORM_KNOWLEDGE_QUESTION, blockFromDoc('**knowledge_conflict:**'));
    assert.equal(FORM_KNOWLEDGE_REFUSAL, blockFromDoc('Ответ `submit_turn`, если проверка не прошла'));
});

function blocksFromDoc(marker, count) {
    const doc = readFileSync(new URL('../docs/research-decision/PROMPTS.md', import.meta.url), 'utf8');
    let at = doc.indexOf(marker);
    const out = [];
    for (let index = 0; index < count; index += 1) {
        const fence = doc.indexOf('```text', at);
        const body = doc.indexOf('\n', fence) + 1;
        const end = doc.indexOf('```', body);
        out.push(doc.slice(body, end).trimEnd());
        at = end + 3;
    }
    return out;
}

test('the bootstrap task is PROMPTS.md section 15 word for word', () => {
    assert.equal(BOOTSTRAP_TASK, blockFromDoc('## 15. Директор — bootstrap нового чата'));
});

test('the ask_user and write_chat_brief texts are PROMPTS.md section 16 word for word', () => {
    assert.equal(ASK_USER_DESCRIPTION, blockFromDoc('**ask_user** — описание инструмента:'));
    const answers = blocksFromDoc('Ответы инструмента:', 5);
    assert.deepEqual(answers, [ASK_USER_ANSWERED, ASK_USER_SKIPPED, ASK_USER_NOT_ALLOWED, ASK_USER_LIMIT, ASK_USER_STREAK]);
    assert.equal(WRITE_CHAT_BRIEF_DESCRIPTION, blockFromDoc('**write_chat_brief** — описание инструмента:'));
});

test('HOW TO THINK is PROMPTS.md section 18 and sits at the very end of the director context, not in the system prompt', async () => {
    const { DIRECTOR_REASONING, DIRECTOR_SYSTEM } = await import('../libraries/core/decision-prompts.js');
    const { buildDeciderContext } = await import('../libraries/core/decision-context.js');
    assert.equal(DIRECTOR_REASONING, blockFromDoc('## 18. Директор — как думать'));
    assert.doesNotMatch(DIRECTOR_SYSTEM, /HOW TO THINK/);
    const turn = buildDeciderContext({ chat: [{ mes: 'Hi', is_user: true }] });
    assert.ok(turn.messages.at(-1).content.endsWith(DIRECTOR_REASONING), 'the last words before generation');
    const background = buildDeciderContext({ task: 'A researcher reported.' });
    assert.ok(background.messages.at(-1).content.endsWith(DIRECTOR_REASONING), 'background cycles too');
});

test('the reroll rule is PROMPTS.md section 19 word for word', async () => {
    const { DIRECTOR_REROLL } = await import('../libraries/core/decision-prompts.js');
    assert.equal(DIRECTOR_REROLL, blockFromDoc('## 19. Директор — переигровка хода'));
});

test('the social assess refusal is PROMPTS.md section 20 word for word', async () => {
    const { ASSESS_SOCIAL_REFUSAL } = await import('../libraries/core/decision-prompts.js');
    assert.equal(ASSESS_SOCIAL_REFUSAL, blockFromDoc('## 20. Директор — отказ assess на разговор'));
});

test('the thinking-cut prompt is PROMPTS.md section 21 word for word', async () => {
    const { DIRECTOR_CONCRETE } = await import('../libraries/core/decision-prompts.js');
    assert.equal(DIRECTOR_CONCRETE, blockFromDoc('## 21. Директор — обрыв долгого размышления'));
});
