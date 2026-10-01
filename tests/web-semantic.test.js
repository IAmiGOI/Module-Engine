import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkPage, computeChunkPassage, computeSimilarity, rankBySimilarity, fuseMatches, MAX_CHUNKS } from '../libraries/core/web-semantic.js';
import { computeOutline, findInText } from '../libraries/core/web-pages.js';
import { createPageSearch } from '../cores/guide/page-search.js';

const PAGE = ['## Infobox', 'Age: 17', '## Personality', 'She attacks fiercely and never retreats from a fight.', 'She is kind to children.', '## History', 'Born in the sixth layer.'].join('\n');

test('a page is cut into chunks along its paragraphs and sections: a section always starts a new chunk, offsets point into the page, and the section label is attached', () => {
    const outline = computeOutline(PAGE);
    const chunks = chunkPage(PAGE, outline);
    assert.deepEqual(chunks.map(chunk => chunk.section), ['1. Infobox', '2. Personality', '3. History']);
    for (const chunk of chunks) assert.ok(PAGE.slice(chunk.offset, chunk.end).includes(chunk.text.split('\n')[0]));
    assert.equal(computeChunkPassage(chunks[1]), `Personality: ${chunks[1].text}`);
});

test('long text is cut near the target size without losing words, and there are never more chunks than the cap', () => {
    const paragraph = 'word '.repeat(60).trim();
    const text = `## Long\n${Array.from({ length: 40 }, () => paragraph).join('\n')}`;
    const chunks = chunkPage(text, computeOutline(text));
    assert.ok(chunks.length > 5 && chunks.every(chunk => chunk.text.length <= 1100));
    assert.equal(chunks.map(chunk => chunk.text).join('\n').replace(/\s+/g, ' ').split('word').length, text.split('word').length);
    const huge = Array.from({ length: 5000 }, (_, index) => `## S${index}\nline`).join('\n');
    assert.equal(chunkPage(huge, computeOutline(huge)).length, MAX_CHUNKS);
});

test('similarity is the dot product of normalised vectors; only chunks close to the best one count (E5 scores are all close), best first, at most eight', () => {
    assert.equal(computeSimilarity([1, 0], [1, 0]), 1);
    assert.equal(computeSimilarity([1, 0], [1]), 0);
    const vectors = new Map([[0, [0.97, 0.243]], [1, [0.5, 0.866]], [2, [1, 0]], [3, [0.8, 0.6]]]);
    assert.deepEqual(rankBySimilarity([1, 0], vectors).map(item => item.index), [2, 0]);
    assert.deepEqual(rankBySimilarity([1, 0], new Map([[0, [0.3, 0.954]]])), [], 'nothing near enough is nothing');
    assert.deepEqual(rankBySimilarity([1, 0], new Map()), []);
    assert.equal(rankBySimilarity([1, 0], new Map(Array.from({ length: 20 }, (_, index) => [index, [1, 0]]))).length, 8);
});

test('the table of contents and the references are not embedded, but stay in the outline', () => {
    const page = ['## Faputa', 'She fights.', '## Contents', '1 Appearance', '2 Personality', '## Personality', 'Kind.', '## References', '1. Chapter 4'].join('\n');
    assert.deepEqual(chunkPage(page, computeOutline(page)).map(chunk => chunk.sectionTitle), ['Faputa', 'Personality']);
});

test('words and meaning are fused by rank: a place found both ways rises, a place only by meaning is kept, and each says how it was found', () => {
    const chunks = chunkPage(PAGE, computeOutline(PAGE));
    const lexical = findInText(PAGE, 'fight children', computeOutline(PAGE));
    const fused = fuseMatches({ lexical, semantic: [{ index: 1, score: 0.9 }, { index: 2, score: 0.85 }], chunks });
    assert.equal(fused[0].via, 'both');
    assert.equal(fused[0].section, '2. Personality');
    assert.ok(fused.some(item => item.via === 'meaning' && item.section === '3. History'));
    assert.deepEqual(fuseMatches({ lexical: [], semantic: [], chunks }), []);
});

function build({ embed }) {
    const calls = [];
    const text = { id: 'p1', url: 'https://x.org/a', text: PAGE, outline: computeOutline(PAGE) };
    const callService = async (contract, params) => {
        calls.push(contract);
        if (contract === 'stWebSearch.find') return { ok: true, value: { id: 'p1', url: text.url, matches: findInText(PAGE, params.query, text.outline) } };
        if (contract === 'stWebSearch.text') return { ok: true, value: text };
        return embed(params);
    };
    let clock = 0;
    return { search: createPageSearch({ callService, now: () => clock }).search, calls, advance: ms => { clock += ms; } };
}

// A toy "meaning": texts about fighting point one way, everything else the other.
const toyEmbed = ({ text }) => ({ ok: true, value: /fight|battle|attack|combat/i.test(text) ? [1, 0] : [0, 1] });

test('a question in other words finds the place by meaning where the words do not match, and the page is prepared once: the second question only embeds the question', async () => {
    const { search, calls } = build({ embed: toyEmbed });
    const first = (await search({ id: 'p1', query: 'combat style' })).value;
    assert.equal(first.meaning, 'used');
    assert.equal(first.matches[0].section, '2. Personality');
    assert.equal(first.matches[0].via, 'meaning');
    const embeddings = calls.filter(call => call === 'embedding.compute').length;
    assert.equal(embeddings, 1 + 3, 'the query and the three chunks');
    await search({ id: 'p1', query: 'battle' });
    assert.equal(calls.filter(call => call === 'embedding.compute').length, embeddings + 1, 'only the new question');
});

test('when the embedding is not available the search still answers by words, says so, and does not try again for a minute', async () => {
    const { search, calls, advance } = build({ embed: () => ({ ok: false, error: { message: 'model failed' } }) });
    const result = (await search({ id: 'p1', query: 'children' })).value;
    assert.deepEqual([result.meaning, result.matches[0].via], ['unavailable', 'words']);
    const tries = calls.filter(call => call === 'embedding.compute').length;
    await search({ id: 'p1', query: 'children' });
    assert.equal(calls.filter(call => call === 'embedding.compute').length, tries, 'no new attempt inside the pause');
    advance(61000);
    await search({ id: 'p1', query: 'children' });
    assert.ok(calls.filter(call => call === 'embedding.compute').length > tries, 'tried again after the pause');
});

test('a wrong page id is an error from the page store, not a silent empty answer', async () => {
    const callService = async contract => (contract === 'stWebSearch.find' ? { ok: false, error: { message: 'There is no open page “p9”.' } } : { ok: true, value: [1, 0] });
    const result = await createPageSearch({ callService }).search({ id: 'p9', query: 'x' });
    assert.equal(result.ok, false);
});
