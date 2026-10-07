import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { createMusicServerCore } from '../cores/music-server/index.js';
import { EMBEDDING_MODEL_ID } from '../libraries/core/embedding.js';
import {
    isServerConfigured, sectionsUrl, sectionUrl, audioUrl, parseSections, parseSectionTracks, isServerTrack, SERVER_TRACK_PREFIX,
} from '../libraries/shared/music-catalog.js';

const MODEL = EMBEDDING_MODEL_ID;
const server = { url: 'https://music.example/', key: 'k 1' };
const vector = n => Array.from({ length: 4 }, (_, i) => (i === n ? 1 : 0));

test('addresses carry the read key (the <audio> element cannot send headers) and never double the slash', () => {
    assert.equal(sectionsUrl(server), 'https://music.example/api/sections?k=k%201');
    assert.equal(sectionUrl(server, 'dark fantasy'), 'https://music.example/api/sections/dark%20fantasy?k=k%201');
    assert.equal(audioUrl(server, 'ab12', 'mp3'), 'https://music.example/audio/ab12.mp3?k=k%201');
    assert.equal(audioUrl({ url: 'https://music.example' }, 'ab12', 'mp3'), 'https://music.example/audio/ab12.mp3', 'no key — no query');
});

test('a server is configured only by a real http(s) address', () => {
    assert.equal(isServerConfigured({ url: '' }), false);
    assert.equal(isServerConfigured({ url: 'ftp://x' }), false);
    assert.equal(isServerConfigured(undefined), false);
    assert.equal(isServerConfigured(server), true);
});

test('sections: empty sections and junk are dropped; a catalog of another model is refused whole', () => {
    const body = { model: MODEL, dim: 4, sections: [{ id: 'a', name: 'A', tracks: 3 }, { id: 'empty', name: 'E', tracks: 0 }, null, { name: 'no id', tracks: 2 }] };
    assert.deepEqual(parseSections(JSON.stringify(body), { model: MODEL }), [{ id: 'a', name: 'A', tracks: 3 }]);
    assert.equal(parseSections(JSON.stringify({ ...body, model: 'another/model' }), { model: MODEL }), null);
    assert.equal(parseSections('<html>', { model: MODEL }), null);
});

test('section tracks become audio-by-address tracks with a vector and NO name or tags; broken entries are skipped one by one', () => {
    const body = {
        model: MODEL, dim: 4, name: 'Fantasy',
        tracks: [
            { id: 'ok1', ext: 'mp3', v: vector(0) },
            { id: 'short', ext: 'mp3', v: [1, 0] },
            { id: 'nan', ext: 'mp3', v: [1, 0, 0, null] },
            { id: '../evil', ext: 'mp3', v: vector(1) },
            { id: 'badext', ext: 'mp3/../x', v: vector(1) },
        ],
    };
    const parsed = parseSectionTracks(JSON.stringify(body), { server, sectionId: 'fantasy', model: MODEL, dim: 4 });
    assert.equal(parsed.name, 'Fantasy');
    assert.equal(parsed.tracks.length, 1);
    const [track] = parsed.tracks;
    assert.equal(track.id, `${SERVER_TRACK_PREFIX}fantasy_ok1`);
    assert.deepEqual([track.name, track.description, track.artist], ['', '', '']);
    assert.deepEqual(track.source, { kind: 'url', ref: 'https://music.example/audio/ok1.mp3?k=k%201' });
    assert.equal(isServerTrack(track), true);
    assert.equal(isServerTrack({ id: 'x' }), false);
});

test('a section computed by another model or with another vector length is refused whole — vectors would not be comparable', () => {
    const body = { model: MODEL, dim: 4, tracks: [{ id: 'a', ext: 'mp3', v: vector(0) }] };
    assert.equal(parseSectionTracks(JSON.stringify({ ...body, model: 'other' }), { server, sectionId: 's', model: MODEL, dim: 4 }), null);
    assert.equal(parseSectionTracks(JSON.stringify({ ...body, dim: 8 }), { server, sectionId: 's', model: MODEL, dim: 4 }), null);
    assert.equal(parseSectionTracks('not json', { server, sectionId: 's', model: MODEL, dim: 4 }), null);
});

// --- Ядро ---------------------------------------------------------------------

function buildCore({ server: cfg = server, responses }) {
    const engine = createEngine();
    const calls = [];
    engine.buses.network.register('http.request', ({ url }) => {
        calls.push(url);
        const answer = responses[url.split('?')[0].replace('https://music.example', '')];
        return answer ?? { ok: false, status: 404, text: '' };
    });
    const core = createMusicServerCore(engine.registerCaller('core.musicServer', 'cores', { tier: 'official', networkAccess: true }), { server: cfg, dim: 4 });
    return { core, calls };
}

const okJson = body => ({ ok: true, status: 200, text: JSON.stringify(body) });

test('the core reads sections and a section once, then answers from memory until forced', async () => {
    const { core, calls } = buildCore({
        responses: {
            '/api/sections': okJson({ model: MODEL, dim: 4, sections: [{ id: 'fantasy', name: 'Fantasy', tracks: 1 }] }),
            '/api/sections/fantasy': okJson({ model: MODEL, dim: 4, name: 'Fantasy', tracks: [{ id: 'a', ext: 'mp3', v: vector(2) }] }),
        },
    });
    const sections = await core.sections();
    assert.deepEqual(sections, { configured: true, ok: true, sections: [{ id: 'fantasy', name: 'Fantasy', tracks: 1 }] });
    const section = await core.section({ id: 'fantasy' });
    assert.equal(section.ok, true);
    assert.equal(section.tracks.length, 1);
    await core.sections(); await core.section({ id: 'fantasy' });
    assert.equal(calls.length, 2, 'repeat reads do not touch the network');
    await core.section({ id: 'fantasy', force: true });
    assert.equal(calls.length, 3);
});

test('the core never throws: no server, a down server and an incompatible catalog all answer with ok:false', async () => {
    const none = buildCore({ server: { url: '' }, responses: {} });
    assert.deepEqual(await none.core.sections(), { configured: false, ok: false, sections: [] });
    assert.equal((await none.core.section({ id: 'x' })).ok, false);
    assert.equal(none.calls.length, 0, 'an unconfigured server is never contacted');

    const down = buildCore({ responses: {} });
    const downSections = await down.core.sections();
    assert.equal(downSections.ok, false);
    assert.equal(downSections.configured, true);

    const foreign = buildCore({ responses: { '/api/sections': okJson({ model: 'other', dim: 4, sections: [{ id: 'a', name: 'A', tracks: 1 }] }) } });
    assert.equal((await foreign.core.sections()).ok, false);
});

test('the core tells the server which embedding model produced the scene vector (the server refuses vectors of another model)', async () => {
    const engine = createEngine();
    const bodies = [];
    engine.buses.network.register('http.request', ({ url, body }) => { bodies.push({ url, body: JSON.parse(body) }); return { ok: true, status: 200, text: JSON.stringify({ action: 'keep' }) }; });
    const core = createMusicServerCore(engine.registerCaller('core.musicServer', 'cores', { tier: 'official', networkAccess: true }), { server, dim: 4 });
    assert.deepEqual(await core.pick({ section: 'fantasy', vector: [0.1, 0.2, 0.3, 0.4] }), { action: 'keep', intensity: null, pattern: null });
    assert.equal(bodies[0].body.model, MODEL);
    assert.ok(bodies[0].url.includes('/api/pick'));
});
