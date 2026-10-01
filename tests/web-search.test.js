import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDuckDuckGoResults, computeWikipediaResults, computeReadableText, computeMediaWikiParseUrls, computeMediaWikiText, isReadableWebUrl } from '../libraries/core/web-text.js';
import { createContractBus } from '../libraries/shared/contract-bus.js';
import { request } from '../libraries/shared/request.js';
import { registerStWebSearchService } from '../services/st-web-search.js';
import { createWebActions } from '../cores/guide/web-actions.js';

const DUCK_HTML = `
<div class="result"><h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fmadeinabyss.fandom.com%2Fwiki%2FFaputa&amp;rut=abc">Faputa &amp; the <b>Hollows</b> | Made in Abyss Wiki</a></h2>
<a class="result__snippet" href="//x">Faputa is the <b>daughter</b> of Irumyuui.</a></div>
<div class="result"><h2><a class="result__a" href="https://en.wikipedia.org/wiki/Made_in_Abyss">Made in Abyss - Wikipedia</a></h2>
<a class="result__snippet" href="x">A Japanese manga.</a></div>
<div class="result"><a class="result__a" href="javascript:alert(1)">bad</a></div>`;

test('search results are read from the DuckDuckGo page: the real address is unwrapped from its redirect, tags and entities are cleaned, a non-web link is dropped', () => {
    const results = computeDuckDuckGoResults(DUCK_HTML);
    assert.deepEqual(results, [
        { title: 'Faputa & the Hollows | Made in Abyss Wiki', url: 'https://madeinabyss.fandom.com/wiki/Faputa', snippet: 'Faputa is the daughter of Irumyuui.' },
        { title: 'Made in Abyss - Wikipedia', url: 'https://en.wikipedia.org/wiki/Made_in_Abyss', snippet: 'A Japanese manga.' },
    ]);
    assert.deepEqual(computeDuckDuckGoResults('<html>Unusual traffic, please verify</html>'), []);
});

test('Wikipedia results become pages with their match marks removed from the snippet', () => {
    const results = computeWikipediaResults({ query: { search: [{ title: 'Made in Abyss', snippet: 'a <span class="searchmatch">manga</span> &amp; anime' }] } });
    assert.deepEqual(results, [{ title: 'Made in Abyss', url: 'https://en.wikipedia.org/wiki/Made_in_Abyss', snippet: 'a manga & anime' }]);
});

test('a page is reduced to its readable paragraphs: scripts, menus and footers go, long text is cut with a note saying how much there was', () => {
    const html = '<html><head><style>p{}</style></head><body><nav>Menu Home</nav><script>var x=1;</script><h1>Faputa</h1><p>She has <b>five</b> tails.</p><p>Height: 1.2&nbsp;m</p><footer>Copyright</footer></body></html>';
    assert.equal(computeReadableText(html), '## Faputa\nShe has five tails.\nHeight: 1.2 m');
    const long = computeReadableText(`<body>${'<p>word </p>'.repeat(2000)}</body>`, 500);
    assert.match(long, /\[cut: the page has \d+ characters, this is the first 500\]$/);
});

test('only ordinary web addresses may be opened: no other schemes, ports or numeric hosts', () => {
    assert.equal(isReadableWebUrl('https://en.wikipedia.org/wiki/X'), true);
    for (const bad of ['file:///etc/passwd', 'ftp://a.b', 'http://127.0.0.1/', 'http://localhost:8000/', 'http://[::1]/', 'not a url', '']) assert.equal(isReadableWebUrl(bad), false, bad);
});

function buildWebService({ visit, wikipedia } = {}) {
    const bus = createContractBus();
    const calls = [];
    const fetch = async (url, options) => {
        calls.push(url);
        if (url === '/api/search/visit') return visit(JSON.parse(options.body));
        return wikipedia(url);
    };
    registerStWebSearchService(bus, { getContext: () => ({ getRequestHeaders: () => ({ 'X-CSRF': 't' }) }), fetch, hostGapMs: { default: 0 } });
    return { call: (contract, params) => request(bus, contract, { params }), calls };
}

const okText = text => ({ ok: true, status: 200, text: async () => text });

test('the search asks ST to open the DuckDuckGo page and returns its results; if that page gives nothing the search falls back to Wikipedia instead of failing', async () => {
    const first = buildWebService({ visit: body => { assert.match(body.url, /^https:\/\/html\.duckduckgo\.com\/html\/\?q=Faputa%20tails$/); return okText(DUCK_HTML); } });
    const found = await first.call('stWebSearch.search', { query: 'Faputa tails' });
    assert.equal(found.value.source, 'web');
    assert.equal(found.value.results.length, 2);
    const fallback = buildWebService({ visit: () => ({ ok: false, status: 500, text: async () => '' }), wikipedia: () => ({ ok: true, json: async () => ({ query: { search: [{ title: 'Faputa', snippet: 's' }] } }) }) });
    const viaWiki = await fallback.call('stWebSearch.search', { query: 'Faputa' });
    assert.deepEqual([viaWiki.value.source, viaWiki.value.results[0].title], ['wikipedia', 'Faputa']);
    assert.equal((await fallback.call('stWebSearch.search', { query: '  ' })).ok, false);
});

test('reading a page goes through ST and returns readable text; an address that is not an ordinary web page is refused before any request', async () => {
    const { call, calls } = buildWebService({ visit: body => okText(`<body><p>Page of ${body.url}</p></body>`) });
    assert.equal((await call('stWebSearch.read', { url: 'https://example.org/a' })).value.text, 'Page of https://example.org/a');
    assert.equal((await call('stWebSearch.read', { url: 'http://127.0.0.1:8000/' })).ok, false);
    assert.equal(calls.length, 1);
});

test('a wiki page address gets the API addresses of the wiki engine; anything that is not a wiki page gets none', () => {
    assert.deepEqual(computeMediaWikiParseUrls('https://madeinabyss.fandom.com/wiki/Faputa'), [
        'https://madeinabyss.fandom.com/api.php?action=parse&prop=text&format=json&origin=*&disableeditsection=1&redirects=1&page=Faputa',
        'https://madeinabyss.fandom.com/w/api.php?action=parse&prop=text&format=json&origin=*&disableeditsection=1&redirects=1&page=Faputa',
    ]);
    for (const other of ['https://example.org/article', 'http://x.fandom.com/wiki/A', 'not a url']) assert.deepEqual(computeMediaWikiParseUrls(other), []);
    assert.equal(computeMediaWikiText({ parse: { text: { '*': '<div><p>Species Narehate</p><p>Tails 5</p></div>' } } }), 'Species Narehate\nTails 5');
    assert.equal(computeMediaWikiText({ error: { code: 'missingtitle' } }), '');
});

test('when ST cannot open a wiki page (Fandom answers it with an error) the page is read through the wiki API instead, and a page that fails both ways reports the first error', async () => {
    const wikiHtml = '<div><p>Faputa has five tails.</p></div>';
    const viaApi = buildWebService({ visit: () => ({ ok: false, status: 500, text: async () => '' }), wikipedia: url => (url.startsWith('https://madeinabyss.fandom.com/api.php?') ? { ok: true, json: async () => ({ parse: { text: { '*': wikiHtml } } }) } : { ok: false }) });
    assert.equal((await viaApi.call('stWebSearch.read', { url: 'https://madeinabyss.fandom.com/wiki/Faputa' })).value.text, 'Faputa has five tails.');
    const failing = buildWebService({ visit: () => ({ ok: false, status: 500, text: async () => '' }), wikipedia: () => ({ ok: false }) });
    assert.match((await failing.call('stWebSearch.read', { url: 'https://madeinabyss.fandom.com/wiki/Faputa' })).error.message, /did not open \(HTTP 500\)/);
    assert.match((await failing.call('stWebSearch.read', { url: 'https://example.org/page' })).error.message, /did not open/);
});

test('the guide’s web actions are safe to run by themselves; the chat gets a one-line note and the full text goes to the model as the detail, and a failure is a plain note', async () => {
    const callService = async (contract, params) => {
        if (contract === 'stWebSearch.search') return params.query === 'none' ? { ok: true, value: { source: 'web', results: [] } } : { ok: true, value: { source: 'wikipedia', results: [{ title: 'T', url: 'https://x.org', snippet: 'S' }] } };
        if (params.url === 'https://x.org/bad') return { ok: false, error: { message: 'HTTP 500' } };
        if (contract === 'stWebSearch.open') return { ok: true, value: { id: 'p1', url: params.url, chars: 15, outline: [{ number: 1, title: 'Beginning', offset: 0, chars: 15 }], head: 'Page body text.' } };
        return { ok: true, value: { id: 'p1', from: 0, to: 15, total: 15, next: null, text: 'Page body text.' } };
    };
    const actions = createWebActions({ callService });
    for (const id of ['web.search', 'web.read', 'web.page', 'web.find']) assert.equal(actions[id].safe && actions[id].thenContinue, true, `${id}: she runs it and reads the result by herself`);
    const found = await actions['web.search'].run({ query: 'q' });
    assert.equal(found.message, 'Searched Wikipedia for “q”: 1 result.');
    assert.equal(found.detail, 'Search results for “q” (Wikipedia):\n1. T — https://x.org\n   S');
    assert.match((await actions['web.search'].run({ query: 'none' })).detail, /Nothing found/);
    const page = await actions['web.read'].run({ url: 'https://x.org/ok' });
    assert.equal(page.message, 'Opened a short page from x.org (15 characters).');
    assert.equal(page.detail, 'Page p1 — https://x.org/ok (15 characters, whole):\nPage body text.');
    assert.deepEqual(await actions['web.read'].run({ url: 'https://x.org/bad' }), { ok: false, message: 'The page did not open: HTTP 500' });
});

test('a long page is NOT pulled into the chat: she gets the id, the size, the sections and the beginning, then reads a section, a stretch or the places a search found', async () => {
    const calls = [];
    const callService = async (contract, params) => {
        calls.push([contract, params]);
        if (contract === 'stWebSearch.open') return { ok: true, value: { id: 'p2', url: params.url, chars: 90000, outline: [{ number: 1, title: 'Beginning', offset: 0, chars: 500 }, { number: 2, title: 'Appearance', offset: 500, chars: 4000 }], head: 'Faputa is…' } };
        if (contract === 'stWebSearch.view') return { ok: true, value: { id: 'p2', section: params.section ? '2. Appearance' : '', from: 500, to: 900, total: 90000, next: 900, text: 'Five tails.' } };
        return { ok: true, value: { id: 'p2', matches: [{ offset: 700, score: 2, snippet: 'five tails', section: '2. Appearance' }] } };
    };
    const actions = createWebActions({ callService });
    const opened = await actions['web.read'].run({ url: 'https://x.org/long' });
    assert.equal(opened.message, 'Opened a page from x.org: 90000 characters, 2 sections.');
    assert.match(opened.detail, /Sections:\n1\. Beginning \(500 characters, from 0\)\n2\. Appearance \(4000 characters, from 500\)\nBeginning:\nFaputa is…$/);
    assert.equal(calls.length, 1, 'no body was fetched into the conversation');
    const piece = await actions['web.page'].run({ id: 'p2', section: 2 });
    assert.match(piece.detail, /section “2\. Appearance”[^]*Five tails\.\n\[The page goes on: continue with offset 900\.\]/);
    const places = await actions['web.find'].run({ id: 'p2', query: 'tails' });
    assert.equal(places.detail, 'Places on page p2 for “tails” (by words only: the meaning search is not available right now):\n1. offset 700, section 2. Appearance [words]: …five tails…');
});

test('the service keeps the whole page in the backend: open gives the outline, view reads a section or a stretch with the place to continue from, find returns the best places, and a wrong id or section says what exists', async () => {
    const body = '<body><h1>Faputa</h1><p>A princess of the Hollow.</p><h2>Appearance</h2><p>She has five tails and white hair.</p><h2>Abilities</h2><p>Immense strength.</p></body>';
    const { call } = buildWebService({ visit: () => okText(body) });
    const opened = (await call('stWebSearch.open', { url: 'https://example.org/faputa' })).value;
    assert.deepEqual(opened.outline.map(item => item.title), ['Faputa', 'Appearance', 'Abilities']);
    assert.ok(opened.head.startsWith('## Faputa'));
    const section = (await call('stWebSearch.view', { id: opened.id, section: 'appear' })).value;
    assert.deepEqual([section.section, section.text.includes('five tails'), section.text.includes('Immense')], ['2. Appearance', true, false]);
    const stretch = (await call('stWebSearch.view', { id: opened.id, offset: 0, chars: 200 })).value;
    assert.equal(stretch.next, null, 'a short page is read to its end');
    const places = (await call('stWebSearch.find', { id: opened.id, query: 'tails hair' })).value.matches;
    assert.equal(places[0].section, '2. Appearance');
    assert.match((await call('stWebSearch.view', { id: 'p99' })).error.message, /There is no open page “p99”.*p1/);
    assert.match((await call('stWebSearch.view', { id: opened.id, section: 'nothing' })).error.message, /no section “nothing”.*1\. Faputa; 2\. Appearance/);
    assert.equal((await call('stWebSearch.open', { url: 'http://127.0.0.1/' })).ok, false);
});

