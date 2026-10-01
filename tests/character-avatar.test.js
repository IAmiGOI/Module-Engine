import test from 'node:test';
import assert from 'node:assert/strict';
import { computeAvatarCrop, isAvatarImageUrl, isDecodableImageType, MAX_IMAGE_BYTES } from '../libraries/core/character-avatar.js';
import { computeInfoboxImages, computeInfoboxText } from '../libraries/core/web-infobox.js';
import { computeAnilistCandidates, computeVndbCandidates, computeCharacterPageText } from '../libraries/core/web-character-sources.js';
import { createContractBus } from '../libraries/shared/contract-bus.js';
import { request } from '../libraries/shared/request.js';
import { registerStCharacterAvatarService } from '../services/st-character-avatar.js';
import { createEngine } from '../libraries/shared/engine.js';
import { createCharacterCardsCore } from '../cores/character-cards/index.js';
import { createCharacterActions } from '../cores/guide/character-actions.js';

test('the portrait crop is 2:3: a wide picture gives a vertical strip (center, left or right), a tall one keeps the top (or the middle, or the bottom), a 2:3 one is taken whole', () => {
    assert.deepEqual(computeAvatarCrop({ width: 1920, height: 1080 }), { sx: 600, sy: 0, sw: 720, sh: 1080 });
    assert.deepEqual(computeAvatarCrop({ width: 1920, height: 1080, focus: 'left' }), { sx: 0, sy: 0, sw: 720, sh: 1080 });
    assert.deepEqual(computeAvatarCrop({ width: 1920, height: 1080, focus: 'right' }), { sx: 1200, sy: 0, sw: 720, sh: 1080 });
    assert.deepEqual(computeAvatarCrop({ width: 600, height: 1200 }), { sx: 0, sy: 0, sw: 600, sh: 900 }, 'a tall picture keeps its top: faces are up there');
    assert.deepEqual(computeAvatarCrop({ width: 600, height: 1200, focus: 'center' }), { sx: 0, sy: 150, sw: 600, sh: 900 });
    assert.deepEqual(computeAvatarCrop({ width: 600, height: 1200, focus: 'bottom' }), { sx: 0, sy: 300, sw: 600, sh: 900 });
    assert.deepEqual(computeAvatarCrop({ width: 400, height: 600 }), { sx: 0, sy: 0, sw: 400, sh: 600 });
    assert.deepEqual(computeAvatarCrop({ width: 400, height: 600, focus: 'nonsense' }), { sx: 0, sy: 0, sw: 400, sh: 600 });
});

test('only ordinary web image addresses of decodable types are used', () => {
    for (const bad of ['file:///a.png', 'http://127.0.0.1/a.png', 'https://host:8000/a.png', 'https://localhost/a.png', 'nonsense', '']) assert.equal(isAvatarImageUrl(bad), false, bad);
    assert.equal(isAvatarImageUrl('https://s4.anilist.co/a.jpg'), true);
    assert.deepEqual(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'text/html'].map(isDecodableImageType), [true, true, true, false, false]);
});

const FANDOM = '<aside class="portable-infobox"><div class="wds-tab__content"><figure class="pi-item pi-image"><a href="https://static.wikia.nocookie.net/rezero/images/8/81/Emilia_LN.png/revision/latest?cb=1" class="image image-thumbnail" title="Light Novel"><img src="https://static.wikia.nocookie.net/small.png"></a></figure><figure><a href="https://static.wikia.nocookie.net/rezero/images/7/7c/Emilia_anime.png/revision/latest?cb=2" class="image image-thumbnail" title="Anime"></a></figure></div><div class="pi-item pi-data"><h3 class="pi-data-label">Age</h3><div class="pi-data-value">17</div></div></aside>';
const WIKIPEDIA = '<table class="infobox ib-character"><tr><td class="infobox-image"><span><a href="/wiki/File:E.png"><img alt="Emilia as illustrated" src="//upload.wikimedia.org/wikipedia/en/1/14/E.png?utm_source=x" width="237"></a></span></td></tr><tr><th class="infobox-label">Created by</th><td class="infobox-data">Tappei</td></tr></table>';

test('infobox pictures are listed with their labels: Fandom gives the full-size addresses with the tab names, Wikipedia the table picture; they appear in the page text for the model to choose from', () => {
    assert.deepEqual(computeInfoboxImages(FANDOM), [{ label: 'Light Novel', url: 'https://static.wikia.nocookie.net/rezero/images/8/81/Emilia_LN.png/revision/latest?cb=1' }, { label: 'Anime', url: 'https://static.wikia.nocookie.net/rezero/images/7/7c/Emilia_anime.png/revision/latest?cb=2' }]);
    assert.deepEqual(computeInfoboxImages(WIKIPEDIA), [{ label: 'Emilia as illustrated', url: 'https://upload.wikimedia.org/wikipedia/en/1/14/E.png' }]);
    assert.deepEqual(computeInfoboxImages('<p>none</p>'), []);
    assert.match(computeInfoboxText(FANDOM), /Age: 17\n\[Images — for character\.avatar\]\nImage \(Light Novel\): https:\/\/static\.wikia/);
});

test('a character from AniList brings its portrait into the page text under Images; VNDB is marked as a host that usually blocks downloads', () => {
    const [emilia] = computeAnilistCandidates({ data: { Page: { characters: [{ id: 1, name: { full: 'Emilia' }, image: { large: 'https://s4.anilist.co/e.jpg' }, media: { nodes: [] } }] } } });
    assert.equal(emilia.image, 'https://s4.anilist.co/e.jpg');
    assert.match(computeCharacterPageText(emilia), /## Images\nPortrait \(AniList\): https:\/\/s4\.anilist\.co\/e\.jpg/);
    const [saber] = computeVndbCandidates({ results: [{ id: 'c1', name: 'Saber', image: { url: 'https://t.vndb.org/s.jpg' } }] });
    assert.match(computeCharacterPageText(saber), /Portrait \(VNDB — this host usually blocks direct download\)/);
});

function build({ fetchImage = () => ({ ok: true, status: 200, blob: async () => ({ type: 'image/png', size: 1000 }) }), size = [1920, 1080] } = {}) {
    const bus = createContractBus();
    const log = { fetched: [], uploads: [], drawn: [], closed: 0 };
    const fetch = async (url, options = {}) => {
        log.fetched.push(url);
        if (url === '/api/characters/edit-avatar') { log.uploads.push([...options.body.entries()].map(([key, value]) => [key, typeof value === 'string' ? value : 'file'])); return { ok: true, status: 200 }; }
        if (url.startsWith('/characters/')) return { ok: true, status: 200, blob: async () => new Blob(['old'], { type: 'image/png' }) };
        if (url.startsWith('/thumbnail')) return { ok: true, status: 200 };
        return fetchImage(url);
    };
    registerStCharacterAvatarService(bus, {
        getContext: () => ({ getRequestHeaders: () => ({ 'X-CSRF': 't' }), getCharacters: async () => { log.refreshed = (log.refreshed ?? 0) + 1; } }),
        fetch, FormDataCtor: FormData,
        decodeImage: async () => ({ width: size[0], height: size[1], close: () => { log.closed += 1; } }),
        createCanvas: (width, height) => ({ width, height, getContext: () => ({ drawImage: (...args) => log.drawn.push(args.slice(1)) }), toBlob: callback => callback(new Blob(['png'], { type: 'image/png' })) }),
    });
    return { call: (contract, params) => request(bus, contract, { params }), log };
}

test('the picture is downloaded, cut to the 2:3 portrait at the chosen side, drawn at 512×768 and uploaded to SillyTavern as the avatar of that card, which then refreshes; the source size is reported', async () => {
    const { call, log } = build();
    const done = await call('stCharacterAvatar.set', { avatar: 'Emilia.png', url: 'https://static.wikia.nocookie.net/a.png', focus: 'left' });
    assert.deepEqual(done.value, { avatar: 'Emilia.png', width: 512, height: 768, source: [1920, 1080], canUndo: true });
    assert.deepEqual(log.drawn[0], [0, 0, 720, 1080, 0, 0, 512, 768]);
    assert.deepEqual(log.uploads[0], [['avatar', 'file'], ['avatar_url', 'Emilia.png']]);
    assert.equal(log.closed, 1);
    assert.ok(log.refreshed >= 1);
});

test('the last replacement can be undone once; there is nothing to undo otherwise', async () => {
    const { call, log } = build();
    assert.equal((await call('stCharacterAvatar.undo', { avatar: 'Emilia.png' })).ok, false);
    await call('stCharacterAvatar.set', { avatar: 'Emilia.png', url: 'https://static.wikia.nocookie.net/a.png' });
    assert.equal((await call('stCharacterAvatar.undo', { avatar: 'Emilia.png' })).ok, true);
    assert.equal(log.uploads.length, 2, 'the old picture was uploaded back');
    assert.equal((await call('stCharacterAvatar.undo', { avatar: 'Emilia.png' })).ok, false, 'only one step back');
});

test('refusals say what to do: a host that blocks downloads, a page that is not a picture, a picture that is too big, an address that is not ordinary; nothing is uploaded', async () => {
    const blocked = build({ fetchImage: () => { throw new TypeError('Failed to fetch'); } });
    assert.match((await blocked.call('stCharacterAvatar.set', { avatar: 'a.png', url: 'https://t.vndb.org/x.jpg' })).error.message, /does not allow downloading[^]*AniList, Wikipedia or a Fandom wiki/);
    const html = build({ fetchImage: () => ({ ok: true, status: 200, blob: async () => ({ type: 'text/html', size: 10 }) }) });
    assert.match((await html.call('stCharacterAvatar.set', { avatar: 'a.png', url: 'https://x.org/page' })).error.message, /not a picture I can use \(text\/html\)/);
    const huge = build({ fetchImage: () => ({ ok: true, status: 200, blob: async () => ({ type: 'image/png', size: MAX_IMAGE_BYTES + 1 }) }) });
    assert.match((await huge.call('stCharacterAvatar.set', { avatar: 'a.png', url: 'https://x.org/a.png' })).error.message, /too large/);
    const plain = build();
    assert.match((await plain.call('stCharacterAvatar.set', { avatar: 'a.png', url: 'http://127.0.0.1/a.png' })).error.message, /ordinary http\(s\) image address/);
    assert.equal((await plain.call('stCharacterAvatar.set', { avatar: '', url: 'https://x.org/a.png' })).ok, false);
    for (const world of [blocked, html, huge, plain]) assert.equal(world.log.uploads.length, 0);
});

test('the card core resolves the character, calls the service and announces the change; the guide action refuses a missing address and reports what happened in one line', async () => {
    const engine = createEngine();
    const services = engine.buses.services;
    const sent = [];
    services.register('stCharacterCard.list', () => [{ avatar: 'Emilia.png', name: 'Emilia', tags: [] }]);
    services.register('stCharacterAvatar.set', params => { sent.push(['set', params]); return { source: [1920, 1080], canUndo: true }; });
    services.register('stCharacterAvatar.undo', params => { sent.push(['undo', params]); return true; });
    const events = [];
    createCharacterCardsCore(engine.registerCaller('core.characterCard', 'cores', { tier: 'official' }), { publish: (event, payload) => events.push([event, payload]), now: () => 1 });
    const call = (contract, params) => request(engine.buses.cores, contract, { params });
    const actions = createCharacterActions({ call });
    const done = await actions['character.avatar'].run({ avatar: 'Emilia.png', url: 'https://x.org/a.png', focus: 'top' });
    assert.deepEqual(done, { ok: true, message: 'The picture of “Emilia” is set (1920×1080 cropped to a 2:3 portrait).' });
    assert.deepEqual(sent[0], ['set', { avatar: 'Emilia.png', url: 'https://x.org/a.png', focus: 'top' }]);
    assert.deepEqual(events.at(-1), ['characterCard.changed', { avatar: 'Emilia.png', action: 'avatar' }]);
    assert.equal((await actions['character.avatar'].run({ avatar: 'Emilia.png' })).ok, false);
    assert.equal((await actions['character.avatar'].run({ avatar: 'Emilia.png', undo: true })).message, 'The previous picture of “Emilia” is back.');
    assert.equal(actions['character.avatar'].autoApply && actions['character.avatar'].thenContinue, true);
});
