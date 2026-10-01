import test from 'node:test';
import assert from 'node:assert/strict';
import { createContractBus } from '../libraries/shared/contract-bus.js';
import { request } from '../libraries/shared/request.js';
import { registerStWebSearchService } from '../services/st-web-search.js';
import { createWebActions } from '../cores/guide/web-actions.js';

const ANILIST = { data: { Page: { characters: [{ id: 88572, name: { full: 'Emilia', native: 'エミリア', alternative: ['Emily'] }, description: 'A half-elf.', gender: 'Female', age: '18', favourites: 50000, siteUrl: 'https://anilist.co/character/88572', media: { nodes: [{ title: { romaji: 'Re:Zero' } }] } }] } } };
const VNDB = { results: [{ id: 'c1', name: 'Emilia (VN)', description: 'vn', vns: [{ title: 'A VN' }] }] };
const WIKI_PAGE = { parse: { text: { '*': '<aside class="portable-infobox"><h2 class="pi-item pi-header">Profile</h2><div class="pi-item pi-data"><h3 class="pi-data-label">Age</h3><div class="pi-data-value">17</div></div></aside><h2>Appearance</h2><p>Five tails.</p>' } } };

function build({ failVndb = false } = {}) {
    const bus = createContractBus();
    const log = [];
    const fetch = async (url, options = {}) => {
        log.push(url);
        const json = data => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
        if (url === '/api/search/visit') return { ok: false, status: 500, text: async () => '' };
        if (url.startsWith('https://graphql.anilist.co')) return json(ANILIST);
        if (url.startsWith('https://api.vndb.org')) return failVndb ? { ok: false, status: 503 } : json(VNDB);
        if (url.startsWith('https://api.jikan.moe')) return { ok: false, status: 504 };
        if (url.includes('list=search')) return json({ query: { search: [{ title: 'Faputa', snippet: 'a <b>tail</b>' }] } });
        if (url.includes('meta=siteinfo')) return url.startsWith('https://madeinabyss.fandom.com') ? json({ query: { general: { sitename: 'Made in Abyss Wiki' } } }) : { ok: false, status: 404 };
        if (url.includes('action=parse')) return json(WIKI_PAGE);
        return { ok: false, status: 404 };
    };
    const time = { at: 1000, slept: [] };
    registerStWebSearchService(bus, { getContext: () => ({ getRequestHeaders: () => ({}) }), fetch, hostGapMs: { 'graphql.anilist.co': 2100, default: 0 }, now: () => time.at, sleep: async ms => { time.slept.push(ms); time.at += ms; } });
    return { call: (contract, params) => request(bus, contract, { params }), log, time, bus };
}

test('a character search asks AniList, VNDB and Jikan together; a database that does not answer is only named, the rest still count, and the best candidate comes first', async () => {
    const { call } = build();
    const found = (await call('stWebSearch.characters', { query: 'Emily' })).value;
    assert.deepEqual(found.failed, ['MyAnimeList']);
    assert.deepEqual(found.candidates.map(item => item.ref), ['anilist:88572', 'vndb:c1']);
    assert.match(found.candidates[0].line, /Emilia \(エミリア\), AniList; from: Re:Zero; also called: Emily/);
    assert.equal((await call('stWebSearch.characters', { query: '  ' })).ok, false);
});

test('a candidate opens as a page with sections (names, facts, description) for web.page and web.find, from what the search already got — no second request', async () => {
    const { call, log } = build();
    await call('stWebSearch.characters', { query: 'Emilia' });
    const before = log.length;
    const opened = (await call('stWebSearch.open', { ref: 'anilist:88572' })).value;
    assert.equal(log.length, before, 'taken from the search result');
    assert.deepEqual(opened.outline.map(item => item.title), ['Emilia', 'Names', 'Facts', 'Appears in', 'Description']);
    const facts = (await call('stWebSearch.view', { id: opened.id, section: 'Facts' })).value.text;
    assert.match(facts, /Gender: Female\nAge: 18/);
    const fresh = build();
    assert.equal((await fresh.call('stWebSearch.open', { ref: 'anilist:88572' })).value.outline.length, 5, 'an unknown ref is fetched by its id');
    assert.equal((await fresh.call('stWebSearch.open', { ref: 'nope:1' })).ok, false);
});

test('the same request is answered from memory, and AniList is asked no faster than its limit allows', async () => {
    const { call, log, time } = build();
    await call('stWebSearch.characters', { query: 'Emilia' });
    const answered = () => log.filter(url => url.startsWith('https://graphql.anilist.co') || url.startsWith('https://api.vndb.org')).length;
    const asked = answered();
    await call('stWebSearch.characters', { query: 'Emilia' });
    assert.equal(answered(), asked, 'the answers that came are not fetched again (a database that failed is simply tried again)');
    await call('stWebSearch.characters', { query: 'Faputa' });
    await call('stWebSearch.characters', { query: 'Reg' });
    assert.deepEqual(time.slept, [2100, 2100], 'every new AniList request waits for its slot');
});

test('a wiki is searched inside itself, its host is checked, and its page is read through its API with the infobox first', async () => {
    const { call, log } = build();
    const results = (await call('stWebSearch.wiki', { host: 'madeinabyss.fandom.com', query: 'Faputa' })).value.results;
    assert.deepEqual(results, [{ title: 'Faputa', url: 'https://madeinabyss.fandom.com/wiki/Faputa', snippet: 'a tail' }]);
    assert.equal((await call('stWebSearch.wiki', { host: 'http://evil.test/x', query: 'a' })).ok, false);
    const opened = (await call('stWebSearch.open', { url: 'https://madeinabyss.fandom.com/wiki/Faputa' })).value;
    assert.deepEqual(opened.outline.map(item => item.title), ['Infobox', 'Appearance']);
    assert.ok(!log.includes('/api/search/visit'), 'a wiki page does not even try the ST server first');
});

test('wiki guessing tries the likely sub-domains and returns only those that answer', async () => {
    const { call } = build();
    assert.deepEqual((await call('stWebSearch.wikiGuess', { franchise: 'Made in Abyss' })).value.wikis, [{ host: 'madeinabyss.fandom.com', name: 'Made in Abyss Wiki' }]);
    assert.deepEqual((await call('stWebSearch.wikiGuess', { franchise: 'Zzz Nothing' })).value.wikis, []);
});

test('the new actions are safe and continue by themselves; the character list, the wiki list and the wiki results reach the model as the detail, and failures are plain notes', async () => {
    const answers = {
        'stWebSearch.characters': { ok: true, value: { candidates: [{ ref: 'anilist:1', line: 'anilist:1 — Emilia, AniList' }], failed: ['VNDB'] } },
        'stWebSearch.wikiGuess': { ok: true, value: { wikis: [{ host: 'x.fandom.com', name: 'X Wiki' }] } },
        'stWebSearch.wiki': { ok: true, value: { results: [{ title: 'T', url: 'https://x.fandom.com/wiki/T', snippet: 's' }] } },
    };
    const actions = createWebActions({ callService: async contract => answers[contract] ?? { ok: false, error: { message: 'down' } } });
    for (const id of ['web.character', 'web.wikis', 'web.wiki']) assert.equal(actions[id].safe && actions[id].thenContinue, true, id);
    const character = await actions['web.character'].run({ name: 'Emilia' });
    assert.equal(character.message, 'Looked up “Emilia” in the character databases: 1 candidate (VNDB did not answer).');
    assert.equal(character.detail, 'Candidates for “Emilia” (VNDB did not answer):\n1. anilist:1 — Emilia, AniList');
    assert.equal((await actions['web.wikis'].run({ franchise: 'X' })).detail, 'Wikis for “X”:\n- x.fandom.com (X Wiki)');
    assert.match((await actions['web.wiki'].run({ host: 'x.fandom.com', query: 'T' })).detail, /1\. T — https:\/\/x\.fandom\.com\/wiki\/T\n {3}s/);
    assert.deepEqual(await createWebActions({ callService: async () => ({ ok: false, error: { message: 'down' } }) })['web.character'].run({ name: 'a' }), { ok: false, message: 'The character search failed: down' });
});
