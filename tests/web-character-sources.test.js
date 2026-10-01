import test from 'node:test';
import assert from 'node:assert/strict';
import { computeInfoboxFacts, computeInfoboxText } from '../libraries/core/web-infobox.js';
import { computePageText } from '../libraries/core/web-text.js';
import { computeAnilistCandidates, computeVndbCandidates, computeJikanCandidates, computeAnilistDescription, computeVndbDescription, rankCandidates, describeCandidate, computeCharacterPageText, buildAnilistBody, buildVndbBody, buildJikanUrl } from '../libraries/core/web-character-sources.js';
import { isWikiHost, computeWikiSearchUrl, computeWikiResults, computeWikiSlugs } from '../libraries/core/web-wiki.js';

const FANDOM = `<aside class="portable-infobox"><h2 class="pi-item pi-title" data-source="title">Faputa</h2>
<div class="pi-item pi-data" data-source="japanese"><h3 class="pi-data-label">Japanese</h3><div class="pi-data-value">ファプタ</div></div>
<section class="pi-item pi-group"><h2 class="pi-item pi-header">Profile</h2>
<div class="pi-item pi-data" data-source="gender"><h3 class="pi-data-label">Gender</h3><div class="pi-data-value"><p><a href="/wiki/Category:Female">Female</a></p></div></div>
<div class="pi-item pi-data" data-source="relatives"><h3 class="pi-data-label">Relatives</h3><div class="pi-data-value">Irumyuui (Mother)<br>Vueko (Grandmother)</div></div></section></aside>
<h2>Appearance</h2><p>She has five tails.</p>`;

const WIKIPEDIA = '<table class="infobox ib-character"><tbody><tr><th colspan="2" class="infobox-above">Emilia</th></tr><tr><th scope="row" class="infobox-label"><div>First appearance</div></th><td class="infobox-data">Prologue (2014)</td></tr><tr><th scope="row" class="infobox-label">Created&#160;by</th><td class="infobox-data"><a href="/wiki/T">Tappei Nagatsuki</a></td></tr></tbody></table><p>Emilia is a half-elf.</p>';

test('a Fandom infobox becomes "field: value" lines grouped under its headers, with links and line breaks flattened', () => {
    const facts = computeInfoboxFacts(FANDOM);
    assert.deepEqual(facts.map(fact => [fact.group, fact.label, fact.value]), [['', 'Japanese', 'ファプタ'], ['Profile', 'Gender', 'Female'], ['Profile', 'Relatives', 'Irumyuui (Mother); Vueko (Grandmother)']]);
    assert.equal(computeInfoboxText(FANDOM), '## Infobox\nJapanese: ファプタ\n[Profile]\nGender: Female\nRelatives: Irumyuui (Mother); Vueko (Grandmother)');
});

test('a Wikipedia infobox table is read the same way, and a page without an infobox gives nothing', () => {
    assert.deepEqual(computeInfoboxFacts(WIKIPEDIA).map(fact => [fact.label, fact.value]), [['First appearance', 'Prologue (2014)'], ['Created by', 'Tappei Nagatsuki']]);
    assert.equal(computeInfoboxText('<p>Nothing here</p>'), '');
});

test('the page text starts with the infobox as its first section instead of losing it with the side blocks, and the Wikipedia table is not repeated in the body', () => {
    const fandom = computePageText(FANDOM);
    assert.ok(fandom.startsWith('## Infobox\nJapanese: ファプタ'));
    assert.ok(fandom.includes('## Appearance\nShe has five tails.'));
    const wiki = computePageText(`<body>${WIKIPEDIA}</body>`);
    assert.equal(wiki.split('First appearance').length - 1, 1, 'the table text appears once');
    assert.ok(wiki.endsWith('Emilia is a half-elf.'));
});

const ANILIST = { data: { Page: { characters: [{ id: 88572, name: { full: 'Emilia', native: 'エミリア', alternative: ['Emily', 'Lia'], alternativeSpoiler: ['Satella'] }, description: '**Height:** 164 cm\n\nA half-elf. [Subaru](https://anilist.co/x) meets her. ~!She is a witch!~', gender: 'Female', age: '18', dateOfBirth: { year: null, month: 9, day: 23 }, bloodType: null, favourites: 50000, siteUrl: 'https://anilist.co/character/88572', media: { nodes: [{ type: 'ANIME', title: { romaji: 'Re:Zero', english: 'Re:ZERO -Starting Life in Another World-' } }] } }, { id: 5, name: { full: 'Emilia Hermit', native: '', alternative: [] }, description: 'Other', favourites: 3, media: { nodes: [] } }] } } };

test('AniList answers become candidates with nicknames (spoiler ones too), facts, titles and a readable description with the spoilers marked', () => {
    const [emilia] = computeAnilistCandidates(ANILIST);
    assert.deepEqual([emilia.ref, emilia.name, emilia.native, emilia.aliases, emilia.titles], ['anilist:88572', 'Emilia', 'エミリア', ['Emily', 'Lia', 'Satella'], ['Re:ZERO -Starting Life in Another World-']]);
    assert.deepEqual(emilia.facts, [['Gender', 'Female'], ['Age', '18'], ['Birthday', '09-23']]);
    assert.equal(emilia.description, 'Height: 164 cm\n\nA half-elf. Subaru meets her. [spoiler: She is a witch]');
    assert.equal(computeAnilistDescription(null), '');
});

test('VNDB and Jikan answers become the same kind of candidate, BBCode is cleaned', () => {
    const [saber] = computeVndbCandidates({ results: [{ id: 'c42', name: 'Saber', original: 'セイバー', aliases: ['Artoria'], description: 'Servant of [url=/c15]Shirou[/url]. [spoiler]King[/spoiler]', age: 15, blood_type: 'o', height: 154, sex: ['f', 'f'], vns: [{ title: 'Fate/stay night' }] }] });
    assert.deepEqual([saber.ref, saber.source, saber.titles, saber.description], ['vndb:c42', 'VNDB', ['Fate/stay night'], 'Servant of Shirou. [spoiler: King]']);
    assert.deepEqual(saber.facts.map(fact => fact[0]), ['Sex', 'Age', 'Blood type', 'Height']);
    const [jikan] = computeJikanCandidates({ data: [{ mal_id: 118737, name: 'Emilia', name_kanji: 'エミリア', nicknames: ['Emi'], about: 'Half-elf.', favorites: 1000, anime: [{ anime: { title: 'Re:Zero' } }] }] });
    assert.deepEqual([jikan.ref, jikan.source, jikan.titles, jikan.favourites], ['jikan:118737', 'MyAnimeList', ['Re:Zero'], 1000]);
    assert.deepEqual(computeVndbCandidates(null), []);
});

test('candidates are ranked: an exact name or nickname first, then partial matches, then by favourites; at most six', () => {
    const [emilia, other] = computeAnilistCandidates(ANILIST);
    assert.deepEqual(rankCandidates([other, emilia], 'emily').map(item => item.ref), ['anilist:88572', 'anilist:5']);
    assert.deepEqual(rankCandidates([other, emilia], 'Emilia').map(item => item.ref), ['anilist:88572', 'anilist:5']);
    assert.equal(rankCandidates(Array.from({ length: 10 }, (_, index) => ({ ...other, ref: `x:${index}` })), 'zzz').length, 6);
});

test('a candidate line says who, where from and what else she is called; the page text has sections to move through', () => {
    const [emilia] = computeAnilistCandidates(ANILIST);
    assert.match(describeCandidate(emilia), /^anilist:88572 — Emilia \(エミリア\), AniList; from: Re:ZERO.*; also called: Emily, Lia, Satella; 50000 favourites\n {3}Height: 164 cm/);
    const text = computeCharacterPageText(emilia);
    assert.deepEqual(text.split('\n').filter(line => line.startsWith('## ')), ['## Emilia', '## Names', '## Facts', '## Appears in', '## Description']);
});

test('request bodies carry the search or the id, bounded', () => {
    assert.deepEqual(buildAnilistBody({ id: '88572' }).variables, { id: 88572 });
    assert.equal(buildAnilistBody({ search: 'x'.repeat(500) }).variables.search.length, 100);
    assert.deepEqual(buildVndbBody({ id: 'c42' }).filters, ['id', '=', 'c42']);
    assert.match(buildJikanUrl({ search: 'Emilia Re:Zero' }), /\?limit=8&order_by=favorites&sort=desc&q=Emilia%20Re%3AZero$/);
    assert.match(buildJikanUrl({ id: 7 }), /\/characters\/7\/full$/);
});

test('a wiki host is only a plain host name; search addresses and results are built for it; franchise names become likely sub-domains', () => {
    for (const bad of ['', 'localhost', '127.0.0.1', 'https://a.fandom.com', 'a.fandom.com/evil', 'a b.com', 'a.fandom.com:8000']) assert.equal(isWikiHost(bad), false, bad);
    assert.equal(isWikiHost('madeinabyss.fandom.com'), true);
    assert.match(computeWikiSearchUrl('madeinabyss.fandom.com', 'Faputa tails'), /^https:\/\/madeinabyss\.fandom\.com\/api\.php\?.*srsearch=Faputa%20tails$/);
    assert.deepEqual(computeWikiResults({ query: { search: [{ title: 'Faputa/Relationships', snippet: 'a <span class="searchmatch">b</span> &quot;c&quot;' }] } }, 'x.fandom.com'), [{ title: 'Faputa/Relationships', url: 'https://x.fandom.com/wiki/Faputa/Relationships', snippet: 'a b "c"' }]);
    assert.deepEqual(computeWikiSlugs('Made in Abyss'), ['madeinabyss', 'made-in-abyss']);
    assert.deepEqual(computeWikiSlugs('The Witcher'), ['thewitcher', 'the-witcher', 'witcher']);
    assert.deepEqual(computeWikiSlugs('  !! '), []);
});

test('a named franchise puts its characters before more popular ones from elsewhere', () => {
    const [emilia] = computeAnilistCandidates(ANILIST);
    const stranger = { ...emilia, ref: 'anilist:9', favourites: 999999, titles: ['Another Show'] };
    assert.equal(rankCandidates([stranger, emilia], 'Emilia')[0].ref, 'anilist:9');
    assert.equal(rankCandidates([stranger, emilia], 'Emilia', 're:zero')[0].ref, 'anilist:88572');
});
