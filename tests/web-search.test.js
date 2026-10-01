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
    assert.equal(computeReadableText(html), 'Faputa\nShe has five tails.\nHeight: 1.2 m');
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
    registerStWebSearchService(bus, { getContext: () => ({ getRequestHeaders: () => ({ 'X-CSRF': 't' }) }), fetch });
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

test('the guide\'s web actions are safe to run by themselves and report results or failures as plain notes', async () => {
    const callService = async (contract, params) => (contract === 'stWebSearch.search'
        ? (params.query === 'none' ? { ok: true, value: { source: 'web', results: [] } } : { ok: true, value: { source: 'wikipedia', results: [{ title: 'T', url: 'https://x.org', snippet: 'S' }] } })
        : { ok: false, error: { message: 'HTTP 500' } });
    const actions = createWebActions({ callService });
    assert.equal(actions['web.search'].safe && actions['web.read'].safe, true);
    assert.equal((await actions['web.search'].run({ query: 'q' })).message, 'Search results for “q” (Wikipedia):\n1. T — https://x.org\n   S');
    assert.match((await actions['web.search'].run({ query: 'none' })).message, /Nothing found/);
    assert.deepEqual(await actions['web.read'].run({ url: 'https://x.org' }), { ok: false, message: 'The page did not open: HTTP 500' });
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
