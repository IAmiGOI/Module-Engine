import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTextBlocks, parseInline, plainText } from '../libraries/core/guide-markup.js';

test('bullet lists are recognised with any bullet, even right after a sentence with no blank line; a wrapped item stays one item', () => {
    const blocks = parseTextBlocks("Here's what your fields do:\n- **Preset** — *Natural date*. Time format.\n* **Model connection** — connection_2\n• Third\n  continued here\n\nDone.");
    assert.deepEqual(blocks.map(block => block.type), ['p', 'ul', 'p']);
    assert.deepEqual(blocks[1].items, ['**Preset** — *Natural date*. Time format.', '**Model connection** — connection_2', 'Third continued here']);
    assert.deepEqual(blocks[0].lines, ["Here's what your fields do:"]);
});

test('numbered lists, headings and plain multi-line paragraphs', () => {
    const blocks = parseTextBlocks('## Steps\n1. Open it\n2) Press save\nThen wait.\nAnd relax.');
    assert.deepEqual(blocks.map(block => block.type), ['h', 'ol', 'p']);
    assert.equal(blocks[0].text, 'Steps');
    assert.deepEqual(blocks[1].items, ['Open it', 'Press save']);
    assert.deepEqual(blocks[2].lines, ['Then wait.', 'And relax.']);
    assert.deepEqual(parseTextBlocks('').length, 0);
});

test('inline: italic and code join bold and links; underscores in names and lone asterisks are left alone', () => {
    assert.deepEqual(parseInline('a *b* `c` **d** hero_status 2*3 and *e*').map(part => [part.type, part.text ?? part.label]), [
        ['text', 'a '], ['italic', 'b'], ['text', ' '], ['code', 'c'], ['text', ' '], ['bold', 'd'], ['text', ' hero_status 2*3 and '], ['italic', 'e'],
    ]);
    assert.equal(plainText('The *time* is `12:00`.'), 'The time is 12:00.');
});
