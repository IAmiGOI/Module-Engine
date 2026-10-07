import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { createMusicServerCore } from '../cores/music-server/index.js';
import { EMBEDDING_MODEL_ID } from '../libraries/core/embedding.js';
import { placesUrl, parsePlaces, parsePick } from '../libraries/shared/music-catalog.js';

const MODEL = EMBEDDING_MODEL_ID;
const server = { url: 'https://music.example/', key: 'k 1' };

test('placesUrl() follows the key handling of the other URLs', () => {
    assert.equal(placesUrl({ url: 'https://music.example/' }), 'https://music.example/api/places');
    assert.equal(placesUrl(server), 'https://music.example/api/places?k=k%201');
});

test('parsePlaces() validates shapes, ids, sizes and the model', () => {
    const ok = JSON.stringify({ model: MODEL, places: [
        { id: 'tavern', keywords: ['inn', 'ale house', '', 5, 'x'.repeat(81)] },
        { id: 'bad id!', keywords: ['a'] },
        { id: 'tavern', keywords: ['dup'] },
        { id: 'empty', keywords: [] },
        { id: 'nokw' },
        null,
        { id: 'sea-port_2', keywords: ['harbor'] },
    ] });
    assert.deepEqual(parsePlaces(ok, { model: MODEL }), [{ id: 'tavern', keywords: ['inn', 'ale house'] }, { id: 'sea-port_2', keywords: ['harbor'] }]);
    assert.deepEqual(parsePlaces(ok, { model: 'other' }), [], 'another model is ignored');
    assert.deepEqual(parsePlaces('nope', { model: MODEL }), []);
    assert.deepEqual(parsePlaces(JSON.stringify({ model: MODEL, places: 'x' }), { model: MODEL }), []);
    const many = JSON.stringify({ model: MODEL, places: Array.from({ length: 600 }, (_, i) => ({ id: `p${i}`, keywords: Array.from({ length: 100 }, (_, j) => `w${j}`) })) });
    const parsed = parsePlaces(many, { model: MODEL });
    assert.equal(parsed.length, 500);
    assert.equal(parsed[0].keywords.length, 60);
});

test('parsePick() carries a validated place on play and keep', () => {
    const ctx = { server, sectionId: 's' };
    assert.equal(parsePick(JSON.stringify({ action: 'play', id: 'a', ext: 'mp3', place: 'tavern' }), ctx).place, 'tavern');
    assert.equal(parsePick(JSON.stringify({ action: 'play', id: 'a', ext: 'mp3', place: 'bad place' }), ctx).place ?? null, null);
    assert.equal(parsePick(JSON.stringify({ action: 'keep', place: 'sea-port' }), ctx).place, 'sea-port');
    assert.equal(parsePick(JSON.stringify({ action: 'keep', place: 42 }), ctx).place ?? null, null);
});

test('the core fetches the registry and forwards only well-formed places/place in pick()', async () => {
    const engine = createEngine();
    const calls = [];
    engine.buses.network.register('http.request', ({ url, body }) => {
        calls.push({ url, body: body ? JSON.parse(body) : null });
        return url.includes('/api/places')
            ? { ok: true, status: 200, text: JSON.stringify({ model: MODEL, places: [{ id: 'tavern', keywords: ['inn'] }] }) }
            : { ok: true, status: 200, text: JSON.stringify({ action: 'keep' }) };
    });
    const core = createMusicServerCore(engine.registerCaller('core.musicServer', 'cores', { tier: 'official', networkAccess: true }), { server, dim: 4 });
    assert.deepEqual(await core.places(), { ok: true, places: [{ id: 'tavern', keywords: ['inn'] }] });
    assert.ok(calls[0].url.includes('/api/places') && calls[0].url.includes('k=k%201'));

    await core.pick({ section: 's', vector: [1], places: { tavern: 3, 'bad key!': 2, zero: 0, frac: 1.5, neg: -1 }, place: 'tavern' });
    assert.deepEqual(calls[1].body.places, { tavern: 3 });
    assert.equal(calls[1].body.place, 'tavern');
    await core.pick({ section: 's', vector: [1], places: { zero: 0 }, place: 'no good' });
    assert.equal('places' in calls[2].body, false);
    assert.equal('place' in calls[2].body, false);
    await core.pick({ section: 's', vector: [1], places: 'junk' });
    assert.equal('places' in calls[3].body, false);
    const big = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`p${i}`, 1]));
    await core.pick({ section: 's', vector: [1], places: big });
    assert.equal(Object.keys(calls[4].body.places).length, 64);

    const down = createMusicServerCore(createEngine().registerCaller('core.musicServer', 'cores', { tier: 'official', networkAccess: true }), { server: {}, dim: 4 });
    assert.deepEqual(await down.places(), { ok: false, places: [] });
});
