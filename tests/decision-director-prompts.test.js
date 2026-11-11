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

test('the Decree prompt carries no example, and a rule of section 5 names a choice, not words', async () => {
    const { DIRECTOR_DECREE_SYSTEM } = await import('../libraries/core/decision-prompts-director.js');
    assert.doesNotMatch(DIRECTOR_DECREE_SYSTEM, /--- example ---/);
    assert.match(DIRECTOR_DECREE_SYSTEM, /A rule names the choice, never the words/);
});
