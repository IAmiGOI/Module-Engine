import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    DIRECTOR_DECREE_SYSTEM, DIRECTOR_DECREE_TASK, DIRECTOR_THINK_DECREE,
    REPORTS_HEADER, NO_REPORTS, LAST_DECREES_HEADER, TOUCHED_BANKS_HEADER, DIRECTOR_RP_HEADER,
} from '../libraries/core/decision-prompts.js';

function blocksFromDoc(heading) {
    const doc = readFileSync(new URL('../docs/research-decision/PROMPTS.md', import.meta.url), 'utf8');
    const start = doc.indexOf(heading);
    assert.ok(start >= 0, `PROMPTS.md has no section "${heading}"`);
    const blocks = [];
    // Следующий раздел нумерован; «## How You Issue A Decree» внутри CoT — не раздел.
    const next = /\n## \d+\./g;
    next.lastIndex = start + 1;
    // Заголовок внутри блока ```text (пример Указа) — не раздел: до него нечётное число ```.
    let match = next.exec(doc);
    while (match && (doc.slice(0, match.index).match(/```/g) ?? []).length % 2 === 1) match = next.exec(doc);
    const sectionEnd = match ? match.index : doc.length;
    let at = start;
    for (;;) {
        const fence = doc.indexOf('```text', at);
        if (fence < 0 || fence > sectionEnd) break;
        const body = doc.indexOf('\n', fence) + 1;
        const end = doc.indexOf('```', body);
        if (end < 0 || end > sectionEnd) break;
        blocks.push(doc.slice(body, end).trimEnd());
        at = end + 3;
    }
    return blocks;
}

test('the Director system prompt is PROMPTS.md section 33 word for word', () => {
    assert.equal(DIRECTOR_DECREE_SYSTEM, blocksFromDoc('## 33. Director — system')[0]);
});

test('the Director task and CoT are PROMPTS.md section 34 word for word', () => {
    const blocks = blocksFromDoc('## 34. Director — задание и CoT');
    assert.equal(DIRECTOR_DECREE_TASK, blocks[0]);
    assert.equal(DIRECTOR_THINK_DECREE, blocks[1]);
});

test('the Director context headers are the ones documented in section 35', () => {
    const doc = readFileSync(new URL('../docs/research-decision/PROMPTS.md', import.meta.url), 'utf8');
    for (const value of [REPORTS_HEADER, NO_REPORTS, LAST_DECREES_HEADER, TOUCHED_BANKS_HEADER, DIRECTOR_RP_HEADER]) {
        assert.ok(doc.includes(value), `PROMPTS.md is missing "${value}"`);
    }
});

test('the example Decree in the Director prompt is a full decree.md, and its mood reads back unchanged', async () => {
    const { DIRECTOR_DECREE_SYSTEM } = await import('../libraries/core/decision-prompts-director.js');
    const { parsePart } = await import('../libraries/core/court-bank-files.js');
    const { normalizeMood } = await import('../libraries/core/decision-decree.js');
    const example = DIRECTOR_DECREE_SYSTEM.split('--- example ---\n')[1].split('--- end of example ---')[0];
    const sections = parsePart(example, 'decree');
    for (const no of [1, 2, 3, 4, 5]) assert.ok(sections[no].length, `section ${no}`);
    assert.match(sections[3][0], /^Long goal: /);
    assert.match(sections[3][1], /^Today: /);
    assert.equal(sections[4].length, 3);
    assert.equal(normalizeMood(sections[4].join('; ')), sections[4].join('; '));
    for (const line of sections[5]) assert.match(line, /^When .+, (she|he|they) /);
});
