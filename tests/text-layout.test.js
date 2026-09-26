import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBody, computeTextLayout } from '../libraries/shared/text-layout/index.js';
import { parseMiniHtml } from './helpers/mini-html.js';

/**
 * Фейковая метрика: каждая графема 10px (жирная — 12px), пробел 5px; у шрифта ascent 14 / descent 4 → при межстрочном 21px половины
 * интерлиньяжа 1,5 + 1,5. Числа круглые, чтобы ожидаемые переносы и высоты считались в уме.
 */
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function fakeMeasure(font, text) {
    const bold = /(^|\s)700\s/.test(font);
    let width = 0;
    for (const { segment } of graphemes.segment(text)) width += segment === ' ' ? 5 : (bold ? 12 : 10);
    return width;
}
const fakeMetrics = () => ({ ascent: 14, descent: 4 });
const THEME = { fontSize: 15, lineHeight: 1.4, fontFamily: 'Test', blockGap: 10 };

function layout(html, width, extra = {}) {
    const parsed = parseBody(parseMiniHtml(html));
    assert.equal(parsed.ok, true, `expected supported markup, got: ${parsed.reason}`);
    const result = computeTextLayout({ parsed, width, theme: THEME, measure: fakeMeasure, metrics: fakeMetrics, ...extra });
    assert.equal(result.complete, true);
    return result;
}
const lineTexts = result => result.lines.map(line => line.parts.map(part => part.text).join(''));
const spacer = (width, height) => `<div class="stme-chat-viewport-avatar-spacer" style="float:left;width:${width}px;height:${height}px;visibility:hidden;" aria-hidden="true"></div>`;

test('two paragraphs are two lines with exactly one block gap between them', () => {
    const result = layout('<p>aaa</p><p>bbb</p>', 300);
    assert.deepEqual(result.lines.map(line => line.top), [0, 31]);
    assert.equal(result.height, 21 + 10 + 21);
});

test('a word that does not fit the rest of the line moves down whole, and the space before it hangs at the end of the previous line', () => {
    const result = layout('<p>aaaa bbbb cccc</p>', 100);
    assert.deepEqual(lineTexts(result), ['aaaa bbbb', 'cccc']);
    assert.equal(result.lines[0].width, 85, 'the hanging space is not part of the line width');
});

test('a line that is filled exactly to the edge still fits; one pixel less wraps', () => {
    assert.deepEqual(lineTexts(layout('<p>aaaa bbbb</p>', 85)), ['aaaa bbbb']);
    assert.deepEqual(lineTexts(layout('<p>aaaa bbbb</p>', 84)), ['aaaa', 'bbbb']);
});

test('a trailing space never pushes the last word to a new line', () => {
    assert.deepEqual(lineTexts(layout('<p>aaaa bbbb </p>', 85)), ['aaaa bbbb']);
});

test('whitespace collapses across element boundaries into a single space, and leading/trailing block whitespace disappears', () => {
    const result = layout('<p>  aa \n <em> bb</em>   </p>', 300);
    assert.deepEqual(lineTexts(result), ['aa bb']);
    assert.equal(result.lines[0].width, 45);
});

test('<br> rules: at the end of a block it adds nothing, doubled it adds one empty line, at the start it opens an empty line', () => {
    assert.equal(layout('<p>aa<br></p>', 300).height, 21);
    assert.equal(layout('<p>aa<br><br></p>', 300).height, 42);
    assert.equal(layout('<p><br>aa</p>', 300).height, 42);
    assert.equal(layout('<p><br></p>', 300).height, 21, 'a block holding only <br> is one line tall');
});

test('empty paragraphs between paragraphs collapse into a single gap, and empty ones at the edges add no height', () => {
    assert.equal(layout('<p>aa</p><p></p><p>bb</p>', 300).height, 21 + 10 + 21);
    assert.equal(layout('<p></p><p>aa</p><p></p>', 300).height, 21);
});

test('text directly in the body next to blocks forms an anonymous paragraph that gets no gap of its own', () => {
    assert.equal(layout('<p>aa</p>bb', 300).height, 42, 'anonymous text after a paragraph: no margin, it is not an element');
    assert.equal(layout('aa<p>bb</p>', 300).height, 42, 'the paragraph after bare text has no preceding ELEMENT sibling either');
    assert.equal(layout('<br><p>bb</p>', 300).height, 21 + 10 + 21, 'a leading <br> is an element: the paragraph after it gets the gap');
});

test('lines next to the avatar spacer are shortened; below it they use the full width; the first block after the spacer has no gap', () => {
    const result = layout(`${spacer(100, 30)}<p>aaaa bbbb cccc dddd eeee ffff gggg hhhh</p>`, 200);
    assert.equal(result.lines[0].top, 0, 'no gap after the spacer');
    assert.deepEqual(lineTexts(result), ['aaaa bbbb', 'cccc dddd', 'eeee ffff gggg hhhh']);
    assert.deepEqual(result.lines.map(line => line.x), [100, 100, 0], 'lines at y=0 and y=21 overlap the 30px spacer, the one at y=42 does not');
});

test('a word too wide for the shortened line next to the spacer drops below the spacer instead of overflowing', () => {
    const result = layout(`${spacer(150, 30)}<p>aaaaaaaa</p>`, 200);
    assert.equal(result.lines[0].top, 30);
    assert.equal(result.lines[0].x, 0);
    assert.equal(result.height, 51);
});

test('a single word wider than the whole line stays whole on its own line and overflows (overflow-wrap: normal)', () => {
    const result = layout('<p>aa bbbbbbbbbbbbbbbbbbbb cc</p>', 100);
    assert.deepEqual(lineTexts(result), ['aa', 'bbbbbbbbbbbbbbbbbbbb', 'cc']);
});

test('a hyphen gives a break after itself (Tokyo-3 too, as in Chrome), except a word-initial hyphen before a digit (-5)', () => {
    assert.deepEqual(lineTexts(layout('<p>aaaa-bbbb</p>', 60)), ['aaaa-', 'bbbb']);
    assert.deepEqual(lineTexts(layout('<p>aaaa-5555</p>', 60)), ['aaaa-', '5555']);
    assert.deepEqual(lineTexts(layout('<p>-bbbbbb</p>', 40)), ['-', 'bbbbbb']);
    assert.deepEqual(lineTexts(layout('<p>-5555</p>', 40)), ['-5555']);
});

test('Chrome-specific punctuation rules: a break after "?" even before letters (URLs), none after "!" or "," before letters, one after an ellipsis', () => {
    assert.deepEqual(lineTexts(layout('<p>aaaa?bbbb</p>', 60)), ['aaaa?', 'bbbb']);
    assert.deepEqual(lineTexts(layout('<p>aaaa!bbbb</p>', 60)), ['aaaa!bbbb']);
    assert.deepEqual(lineTexts(layout('<p>aaaa,bbbb</p>', 60)), ['aaaa,bbbb']);
    assert.deepEqual(lineTexts(layout('<p>aaaa…bbbb</p>', 60)), ['aaaa…', 'bbbb']);
});

test('a slash does not open a break before letters (and/or, URLs stay whole), as in Chrome', () => {
    assert.deepEqual(lineTexts(layout('<p>aaaa/bbbb</p>', 60)), ['aaaa/bbbb']);
});

test('like LayoutNG, each text node\'s share of a line is rounded UP to 1/64px and the line may exceed the box by one 1/64px', () => {
    const run = (html, width, widths) => {
        const parsed = parseBody(parseMiniHtml(html));
        return lineTexts(computeTextLayout({ parsed, width, theme: THEME, measure: (font, text) => widths[text] ?? fakeMeasure(font, text), metrics: fakeMetrics }));
    };
    // Один узел: 100 + 0,01 → вверх до 100 + 1/64 — это ровно допуск, влезает (так в Chrome влез заголовок 300,0105px в 300px).
    assert.deepEqual(run('<p>aa bb</p>', 100, { aa: 50, bb: 45.01 }), ['aa bb']);
    // Те же ширины в ТРЁХ узлах: каждый округляется вверх отдельно — 3/64 сверх ширины, не влезает (так в Chrome не влезла строка 637,0093px в 637px).
    assert.deepEqual(run('<p><em>aa</em> <b>bb</b></p>', 100, { aa: 49.99, bb: 45.02 }), ['aa', 'bb']);
});

test('quotes stick to the words they wrap, dialogue is never split at a quotation mark', () => {
    assert.deepEqual(lineTexts(layout('<p>"aaaa"bbbb</p>', 60)), ['"aaaa"bbbb']);
});

test('ideographs can break between any two characters, but not before closing punctuation', () => {
    assert.deepEqual(lineTexts(layout('<p>日本語日本語</p>', 40)), ['日本語日', '本語']);
    assert.deepEqual(lineTexts(layout('<p>日本語。</p>', 30)), ['日本', '語。']);
});

test('an emoji sequence is one unbreakable grapheme and a break opportunity on both sides', () => {
    const result = layout('<p>aaa👩‍👩‍👧bbb</p>', 40);
    assert.deepEqual(lineTexts(result), ['aaa👩‍👩‍👧', 'bbb']);
});

test('centred text is offset by half of the free space, per line', () => {
    const result = layout('<center>aaaa</center>', 100);
    assert.equal(result.lines[0].x, 30);
});

test('lists indent by 1.4em and put a marker before the first line of each item; nested bullets change shape; ol honours start', () => {
    const result = layout('<ul><li>aa</li><li>bb<ul><li>cc</li></ul></li></ul><ol start="3"><li>dd</li></ol>', 300);
    assert.deepEqual(result.lines.map(line => line.x), [21, 21, 42, 21]);
    const markers = result.boxes.filter(box => box.kind === 'marker').map(box => box.text);
    assert.deepEqual(markers, ['• ', '• ', '◦ ', '3. ']);
    assert.equal(result.height, 21 * 3 + 10 + 21);
});

test('a heading line is 1.4 times its own font size and bold', () => {
    const result = layout('<h1>aa</h1>', 300);
    assert.equal(result.height, 30 * 1.4);
    assert.match(result.lines[0].parts[0].font, /^700 30px/);
});

test('hr is two pixels tall and takes part in the block gaps like any other block', () => {
    const result = layout('<p>aa</p><hr><p>bb</p>', 300);
    assert.equal(result.height, 21 + 10 + 2 + 10 + 21);
    assert.deepEqual(result.boxes.find(box => box.kind === 'rule'), { kind: 'rule', x: 0, y: 31, width: 300, height: 2 });
});

test('blockquote content is indented by 10px', () => {
    assert.equal(layout('<blockquote><p>aa</p></blockquote>', 300).lines[0].x, 10);
});

test('an inline image sits on the baseline and grows its line to the image height plus the text part below the baseline', () => {
    const result = layout('<p>aa<img src="x.png"></p>', 300, { imageSize: () => ({ width: 40, height: 50 }) });
    assert.equal(result.lines[0].height, 50 + 4 + 2, 'leading 3px: 1 above the text (rounded down), 2 below');
    assert.deepEqual(result.boxes.find(box => box.kind === 'image'), { kind: 'image', src: 'x.png', x: 20, y: 0, width: 40, height: 50 });
});

test('an image wider than the block is scaled down to the block width keeping its proportions', () => {
    const result = layout('<p><img src="x.png"></p>', 100, { imageSize: () => ({ width: 400, height: 200 }) });
    const image = result.boxes.find(box => box.kind === 'image');
    assert.deepEqual([image.width, image.height], [100, 50]);
});

test('colours are roles resolved later: em uses the em colour, but inside a quote or a coloured font it inherits', () => {
    const colours = html => layout(html, 500).lines[0].parts.map(part => [part.text.trim(), part.style.color]).filter(([text]) => text !== '');
    assert.deepEqual(colours('<p>a <em>b</em> <q>c <em>d</em></q></p>'), [['a', '@body'], ['b', '@em'], ['c', '@quote'], ['d', '@quote']]);
    assert.deepEqual(colours('<p><font color="#f00">a <q>b</q></font></p>'), [['a b', '#f00']]);
    assert.deepEqual(colours('<p><span style="color: #0f0">a</span></p>'), [['a', '#0f0']]);
});

test('missing measurements are reported in one batch; the second pass with them filled in is complete', () => {
    const parsed = parseBody(parseMiniHtml('<p>aa <b>bb</b></p>'));
    const known = new Map();
    const first = computeTextLayout({ parsed, width: 300, theme: THEME, measure: (font, text) => known.get(`${font}|${text}`), metrics: () => undefined });
    assert.equal(first.complete, false);
    assert.deepEqual(first.missing.measures.map(item => item.text).sort(), [' ', 'aa', 'bb']);
    assert.equal(first.missing.metrics.length, 1);
    for (const { font, text } of first.missing.measures) known.set(`${font}|${text}`, fakeMeasure(font, text));
    const second = computeTextLayout({ parsed, width: 300, theme: THEME, measure: (font, text) => known.get(`${font}|${text}`), metrics: fakeMetrics });
    assert.equal(second.complete, true);
    assert.equal(second.lines[0].width, 20 + 5 + 24);
});

test('markup the layout does not handle is reported with a reason instead of being drawn wrong', () => {
    const reason = html => parseBody(parseMiniHtml(html)).reason;
    assert.match(reason('<table><tr><td>a</td></tr></table>'), /table/);
    assert.match(reason('<details><summary>a</summary>b</details>'), /details/);
    assert.match(reason('<p><span style="padding: 4px">a</span></p>'), /padding/);
    assert.match(reason('<p style="text-align:center">a</p>'), /style/);
    assert.match(reason('<p><code>a</code></p>'), /code/);
    assert.match(reason('<p>שלום</p>'), /script/);
    assert.match(reason('<p><em><p>a</p></em></p>'), /inside inline/);
    assert.match(reason('<img>'), /src/);
});
