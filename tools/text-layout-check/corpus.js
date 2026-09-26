/**
 * Корпус сверки раскладчика. Две части:
 * - `SYNTHETIC` — по одному крайнему случаю на правило (списки, цитаты, заголовки, center, пустые абзацы, `<br>` по краям, эмодзи, CJK,
 *   длинные слова, неразрывные пробелы, дефисы, тире, косые черты, картинки, заглушка аватарки, неподдерживаемая разметка);
 * - `buildRoleplayCorpus()` — сообщения в том виде, в каком их отдаёт `messageFormatting()` ST: абзацы `<p>`, одиночные переносы `<br>`,
 *   реплики в `<q>"…"</q>`, действия в `<em>`, пустые `<p></p>` между абзацами, раскраска говорящих `span style="color"`. Текст собирается
 *   детерминированно (свой ГПСЧ с фиксированным зерном) — прогоны сравнимы между собой.
 *
 * Настоящие транскрипты владельца проверяются в живой ST (`st-console.js`) — там корпус берётся из чатов.
 */

const SPACER = (height, width = 124) => `<div class="stme-chat-viewport-avatar-spacer" style="float:left;width:${width}px;height:${height}px;visibility:hidden;" aria-hidden="true"></div>`;
const IMAGE = (width, height, color = '#7a5') => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${color}"/></svg>`)}`;

export const SYNTHETIC = [
    { id: 'plain', html: '<p>Just a short line.</p>' },
    { id: 'two-paragraphs', html: '<p>First paragraph of text that is long enough to wrap at narrow widths, at least twice or so.</p>\n<p>Second one.</p>' },
    { id: 'empty-paragraphs', html: '<p>One.</p><p></p><p>Two, after an empty paragraph.</p><p></p>' },
    { id: 'leading-empty', html: '<p></p><p>Starts after an empty paragraph.</p>' },
    { id: 'br-edges', html: '<p><br>Starts with a break and ends with one.<br></p><p>Double<br><br>break.</p>' },
    { id: 'br-between-blocks', html: '<p>Above.</p><br><p>Below a bare break.</p>' },
    { id: 'bare-text', html: 'Bare text without any paragraph, like a message formatted with simple line breaks.<br>Second line after a break.' },
    { id: 'lists', html: '<ul><li>First item that is long enough to wrap onto a second line at a narrow width</li><li>Second<ul><li>Nested item</li><li>Another nested item</li></ul></li></ul><ol start="7"><li>Seventh</li><li>Eighth item</li></ol>' },
    { id: 'list-with-paragraphs', html: '<p>Before the list.</p><ol><li><p>Item with a paragraph inside.</p></li><li><p>Second.</p></li></ol><p>After.</p>' },
    { id: 'empty-list-item', html: '<ul><li></li><li>After an empty item.</li></ul>' },
    { id: 'blockquote', html: '<blockquote><p>Quoted text that wraps across a couple of lines when the column is narrow enough, indented by ten pixels.</p></blockquote><p>After the quote.</p>' },
    { id: 'headings', html: '<h1>Heading one</h1><h2>Heading two</h2><h3>Heading three, rather long so that it wraps somewhere</h3><h4>Four</h4><h5>Five</h5><h6>Six</h6><p>Body.</p>' },
    { id: 'hr', html: '<p>Above the rule.</p><hr><p>Below the rule.</p>' },
    { id: 'center', html: '<center>Centred text in a center element, long enough to wrap across more than one line.</center><p>Normal.</p>' },
    { id: 'center-paragraph', html: '<center><p>Centred paragraph.</p><p>Another centred paragraph.</p></center>' },
    { id: 'div-group', html: '<div><p>Inside a plain div.</p><p>Second.</p></div><p>Outside.</p>' },
    { id: 'emoji', html: '<p>Emoji inline 😀 and a family 👩‍👩‍👧 and flags 🇯🇵🇺🇦 mixed with words to wrap them around 🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉</p>' },
    { id: 'cjk', html: '<p>日本語の文章です。これは折り返しのテストです。「引用」と、句読点。中文句子，测试换行。한국어 문장입니다.</p>' },
    { id: 'long-word', html: '<p>Short words then an extraordinarilylongwordwithoutanyspacesthatcannotbreakanywhereatall and more.</p>' },
    { id: 'long-url', html: '<p>A link-like path: https://example.com/some/very/long/path/that/goes/on/and/on/for/a/while?query=1 end.</p>' },
    { id: 'nbsp', html: '<p>Numbers with non-breaking spaces: 10&nbsp;000&nbsp;000 and Mr.&nbsp;Smith and a&nbsp;b&nbsp;c&nbsp;d&nbsp;e&nbsp;f&nbsp;g&nbsp;h&nbsp;i&nbsp;j&nbsp;k.</p>' },
    { id: 'hyphens-dashes', html: '<p>Well-known, state-of-the-art, twenty-one, -5 degrees, pre-war—post-war, en–dash, and/or, either/or, wait…what, really?!yes, (parenthetical)words.</p>' },
    { id: 'em-dash-no-spaces', html: '<p>She paused—just for a moment—then continued—without looking back—toward the door that stood at the end of the corridor.</p>' },
    { id: 'styles-mixed', html: '<p>Plain <em>italic</em> <strong>bold</strong> <strong><em>both</em></strong> <u>under</u> <s>strike</s> <a href="#">link text</a> <font color="#e0a">font color</font> <span style="color: #7cf; font-weight: bold">span bold</span> <span style="font-style: italic">span italic</span>.</p>' },
    { id: 'word-split-styles', html: '<p>Mid<em>word</em>style and <strong>bo</strong>ld and un<u>der</u>line inside single words wrapping around the edges of narrow columns.</p>' },
    { id: 'image-inline', html: `<p>Text before an image <img src="${IMAGE(120, 80)}"> and after it, long enough to wrap.</p>` },
    { id: 'image-wide', html: `<p><img src="${IMAGE(1200, 400, '#57a')}"></p><p>Caption below a wide image.</p>` },
    { id: 'image-width-attr', html: `<p><img src="${IMAGE(300, 300, '#a57')}" width="100"></p>` },
    { id: 'spacer-short', html: `${SPACER(40)}<p>Short text next to the avatar.</p>` },
    { id: 'spacer-long', html: `${SPACER(120)}<p>A longer paragraph that flows next to the avatar spacer and then continues below it once the spacer ends, with enough words to fill several lines at every tested width, including the widest one used by the check.</p><p>Second paragraph after the gap.</p>` },
    { id: 'spacer-list', html: `${SPACER(90)}<ul><li>List next to the avatar</li><li>Second item</li><li>Third item that is long enough to wrap a bit</li><li>Fourth</li></ul>` },
    { id: 'spacer-quote', html: `${SPACER(60)}<blockquote><p>Quote next to the avatar, long enough to wrap onto a few lines at narrow widths.</p></blockquote>` },
    { id: 'spacer-center', html: `${SPACER(60)}<center>Centred next to the avatar, wrapping over some lines.</center>` },
    { id: 'spacer-longword', html: `${SPACER(60)}<p>Averyveryverylongunbreakablewordthatwillnotfit next to the avatar.</p>` },
    { id: 'cyrillic', html: '<p><q>"Ну и что теперь?"</q> — спросила она, не оборачиваясь. <em>Ветер трепал подол платья.</em> Он пожал плечами и ничего не ответил, только посмотрел на дорогу, уходящую за холм.</p>' },
    { id: 'unsupported-table', html: '<table><tr><td>cell</td></tr></table>' },
    { id: 'unsupported-details', html: '<details><summary>Tool calls: Notebook</summary><p>payload</p></details>' },
    { id: 'unsupported-code', html: '<p>Inline <code>code()</code> here.</p><pre><code>block\ncode</code></pre>' },
    { id: 'unsupported-styled-div', html: '<div style="border:1px solid red;padding:8px">Card-like block</div>' },
];

/** Детерминированный ГПСЧ (mulberry32): одинаковое зерно — одинаковый корпус. */
function createRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const NARRATION = [
    'She doesn\'t let go of your wrist.',
    'Down the hallway — bare feet slapping hardwood — she yanks open the closet by the front door.',
    'Sandals. She kicks them on one-handed, still holding you, still dragging.',
    'The front door swings open and afternoon light floods in — bright, white, the kind that makes you squint.',
    'Tokyo-3 stretches out beyond the walkway. Clean streets. Buildings that could sink into the earth at a moment\'s notice.',
    'Her grip on your wrist tightens.',
    'The towel comes up higher. Her jaw sets.',
    'One word. No insult, no deflection, no performance. Just the flat, stripped-down refusal of someone whose boundary got stepped over twice in sixty seconds.',
    'She stops. Swallows. Looks at the tile.',
    'Her eyes find yours. Red-rimmed. Tired. Not angry at you, exactly — angry at the fact that she has to ask at all.',
    'Rain drums against the window, steady and patient, as if it has all night.',
    'The kettle clicks off somewhere behind her; neither of them moves to pour it.',
    'He counts the steps under his breath — twelve, thirteen, fourteen — and the landing creaks exactly where he knew it would.',
    'A long, low whistle from the street below; a dog answers it, then thinks better of it.',
];
const ACTIONS = ['she smiles softly', 'he shrugs', 'her voice drops to a whisper', 'without looking back', 'a beat of silence', 'she exhales slowly through her nose', 'he rubs the back of his neck'];
const LINES = [
    'Put those on. I\'m not waiting.',
    'No.',
    'I said I need a minute, Sasha. One minute. In here. Alone.',
    '...Be me again. Okay?',
    'You really thought that would work?',
    'Fine. Fine! Have it your way — but don\'t come crying to me later.',
    'Where were you last night?',
    'It\'s not a game. I\'m not being cute.',
];
const SPEAKER_COLORS = ['#e8a0bf', '#8fc1e3', '#f2c14e'];

function pick(random, list) {
    return list[Math.floor(random() * list.length)];
}

function sentence(random, speakers) {
    const roll = random();
    if (roll < 0.45) return pick(random, NARRATION);
    if (roll < 0.6) return `<em>${pick(random, ACTIONS)}</em>`;
    const line = `<q>"${pick(random, LINES)}"</q>`;
    if (speakers && random() < 0.5) return `<span class="stme-speaker-paint" style="color: ${pick(random, SPEAKER_COLORS)};">${line}</span>`;
    return line;
}

function paragraph(random, speakers) {
    const count = 1 + Math.floor(random() * 5);
    const parts = [];
    for (let index = 0; index < count; index += 1) {
        parts.push(sentence(random, speakers));
        if (index < count - 1) parts.push(random() < 0.2 ? '<br>' : ' ');
    }
    return `<p>${parts.join('')}</p>`;
}

/** `count` сообщений: 1–8 абзацев, иногда пустые `<p></p>` между ними (ST), иногда заглушка аватарки перед телом. */
export function buildRoleplayCorpus({ count = 60, seed = 20260927 } = {}) {
    const random = createRandom(seed);
    const samples = [];
    for (let index = 0; index < count; index += 1) {
        const speakers = random() < 0.3;
        const paragraphs = [];
        const total = 1 + Math.floor(random() * 8);
        for (let p = 0; p < total; p += 1) {
            paragraphs.push(paragraph(random, speakers));
            if (p < total - 1 && random() < 0.25) paragraphs.push('<p></p>');
        }
        const spacer = random() < 0.4 ? SPACER(Math.round(20 + random() * 110)) : '';
        samples.push({ id: `rp-${index + 1}`, html: spacer + paragraphs.join('\n') });
    }
    return samples;
}

export const DEFAULT_WIDTHS = [247, 300, 389, 520, 613, 800];
