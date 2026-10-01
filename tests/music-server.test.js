import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createApp } from '../tools/music-server/app.js';
import { MODEL_ID } from '../tools/music-server/embed.js';
import { EMBEDDING_MODEL_ID } from '../libraries/core/embedding.js';
import { createRateLimiter, clientAddress } from '../tools/music-server/rate-limit.js';
import { parseSections, parseSectionTracks } from '../libraries/shared/music-catalog.js';

const DIM = 384;
// Фейк эмбеддинга: детерминированный вектор из длины текста — реальная модель (~50 МБ) в тестах не нужна, проверяется сам сервер.
const fakeEmbed = async text => Array.from({ length: DIM }, (_, i) => (i === String(text).length % DIM ? 1 : 0));

async function start({ readKey = '', maxUpload, limits } = {}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'me-music-'));
    const app = await createApp({ dir, embed: fakeEmbed, adminToken: 'owner-secret', readKey, legacyCatalog: true, ...(maxUpload ? { maxUpload } : {}), ...(limits ? { limits } : {}) });
    await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.address().port}`;
    const admin = { Authorization: 'Bearer owner-secret' };
    const json = (pathname, { method = 'GET', body, headers = admin } = {}) => fetch(base + pathname, { method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const stop = async () => { app.closeAllConnections?.(); await new Promise(resolve => app.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); };
    return { base, admin, json, stop, dir };
}

const upload = (ctx, section, { title = 'Night camp', description = 'quiet night camp, acoustic guitar', ext = 'mp3', bytes = Buffer.from('0123456789') } = {}) =>
    fetch(`${ctx.base}/api/admin/tracks?${new URLSearchParams({ section, title, description, ext })}`, { method: 'POST', headers: ctx.admin, body: bytes });

test('the model id and vector size match what ME computes with — otherwise vectors would not be comparable', () => {
    assert.equal(MODEL_ID, EMBEDDING_MODEL_ID);
});

test('admin routes need the owner token; public reads need the read key when one is set', async () => {
    const ctx = await start({ readKey: 'readers' });
    try {
        assert.equal((await ctx.json('/api/admin/catalog', { headers: {} })).status, 401);
        assert.equal((await ctx.json('/api/admin/catalog', { headers: { Authorization: 'Bearer nope' } })).status, 401);
        assert.equal((await ctx.json('/api/admin/catalog')).status, 200);
        assert.equal((await fetch(`${ctx.base}/api/sections`)).status, 401);
        assert.equal((await fetch(`${ctx.base}/api/sections?k=readers`)).status, 200);
        assert.equal((await fetch(`${ctx.base}/api/sections?k=readers`)).headers.get('access-control-allow-origin'), '*');
    } finally { await ctx.stop(); }
});

test('server refuses to start without an owner token', async () => {
    await assert.rejects(createApp({ dir: os.tmpdir(), embed: fakeEmbed, adminToken: '' }), /ADMIN_TOKEN/);
});

test('owner builds a section, uploads a tagged track; ME reads it through the client parser — and sees no title or tag text', async () => {
    const ctx = await start();
    try {
        const created = await (await ctx.json('/api/admin/sections', { method: 'POST', body: { name: 'Dark Fantasy' } })).json();
        assert.equal(created.id, 'dark-fantasy');
        assert.equal((await upload(ctx, created.id)).status, 201);

        const sectionsText = await (await fetch(`${ctx.base}/api/sections`)).text();
        const sections = parseSections(sectionsText, { model: EMBEDDING_MODEL_ID });
        assert.deepEqual(sections, [{ id: 'dark-fantasy', name: 'Dark Fantasy', tracks: 1 }]);

        const sectionText = await (await fetch(`${ctx.base}/api/sections/dark-fantasy`)).text();
        const parsed = parseSectionTracks(sectionText, { server: { url: ctx.base }, sectionId: 'dark-fantasy', model: EMBEDDING_MODEL_ID, dim: DIM });
        assert.equal(parsed.tracks.length, 1);
        assert.equal(sectionText.includes('quiet night camp'), false, 'tag text never leaves the server');
        assert.equal(sectionText.includes('Night camp'), false, 'track title never leaves the server');

        const audio = await fetch(parsed.tracks[0].source.ref);
        assert.equal(audio.status, 200);
        assert.equal(audio.headers.get('content-type'), 'audio/mpeg');
        assert.equal((await audio.text()), '0123456789');
    } finally { await ctx.stop(); }
});

test('a track with no tag is silent: absent from the public catalog and its audio is closed — but the owner can still audition it', async () => {
    const ctx = await start();
    try {
        const { id } = await (await ctx.json('/api/admin/sections', { method: 'POST', body: { name: 'Rain' } })).json();
        const track = await (await upload(ctx, id, { description: '' })).json();
        assert.deepEqual(await (await fetch(`${ctx.base}/api/sections`)).json().then(body => body.sections), [], 'a section with no playable track is not offered');
        assert.equal((await fetch(`${ctx.base}/audio/${track.id}.mp3`)).status, 404);
        assert.equal((await fetch(`${ctx.base}/audio/${track.id}.mp3`, { headers: ctx.admin })).status, 200);

        const tagged = await ctx.json(`/api/admin/tracks/${track.id}`, { method: 'PATCH', body: { description: 'soft rain on a window' } });
        assert.equal(tagged.status, 200);
        assert.equal((await fetch(`${ctx.base}/audio/${track.id}.mp3`)).status, 200, 'writing the tag makes it playable');
    } finally { await ctx.stop(); }
});

test('Range requests work (seeking in <audio>), including suffix ranges and out-of-range', async () => {
    const ctx = await start();
    try {
        const { id } = await (await ctx.json('/api/admin/sections', { method: 'POST', body: { name: 'A' } })).json();
        const track = await (await upload(ctx, id)).json();
        const get = range => fetch(`${ctx.base}/audio/${track.id}.mp3`, { headers: { Range: range } });
        const middle = await get('bytes=2-5');
        assert.equal(middle.status, 206);
        assert.equal(middle.headers.get('content-range'), 'bytes 2-5/10');
        assert.equal(await middle.text(), '2345');
        assert.equal(await (await get('bytes=-3')).text(), '789');
        assert.equal(await (await get('bytes=7-')).text(), '789');
        assert.equal((await get('bytes=99-')).status, 416);
    } finally { await ctx.stop(); }
});

test('editing a tag recomputes the vector; moving a track between sections works; deleting removes the file', async () => {
    const ctx = await start();
    try {
        const a = await (await ctx.json('/api/admin/sections', { method: 'POST', body: { name: 'A' } })).json();
        const b = await (await ctx.json('/api/admin/sections', { method: 'POST', body: { name: 'B' } })).json();
        const track = await (await upload(ctx, a.id, { description: 'short' })).json();
        const vectorOf = async section => (await (await fetch(`${ctx.base}/api/sections/${section}`)).json()).tracks[0]?.v.findIndex(x => x === 1);
        assert.equal(await vectorOf(a.id), 5);

        await ctx.json(`/api/admin/tracks/${track.id}`, { method: 'PATCH', body: { description: 'a much longer tag text', section: b.id } });
        assert.equal(await vectorOf(b.id), 22, 'new tag → new vector');
        assert.equal((await (await fetch(`${ctx.base}/api/sections/${a.id}`)).json()).tracks?.length ?? 0, 0, 'moved out of A');

        const file = path.join(ctx.dir, 'audio', `${track.id}.mp3`);
        await fs.access(file);
        assert.equal((await ctx.json(`/api/admin/tracks/${track.id}`, { method: 'DELETE' })).status, 200);
        await assert.rejects(fs.access(file));
    } finally { await ctx.stop(); }
});

test('a non-empty section cannot be deleted; non-audio and oversized uploads are refused and leave no files behind', async () => {
    const ctx = await start({ maxUpload: 16 });
    try {
        const { id } = await (await ctx.json('/api/admin/sections', { method: 'POST', body: { name: 'A' } })).json();
        assert.equal((await upload(ctx, id)).status, 201);
        assert.equal((await ctx.json(`/api/admin/sections/${id}`, { method: 'DELETE' })).status, 409);
        assert.equal((await upload(ctx, id, { ext: 'exe' })).status, 400);
        assert.equal((await upload(ctx, id, { bytes: Buffer.alloc(64) })).status, 413);
        assert.equal((await upload(ctx, 'no-such-section')).status, 404);
        assert.deepEqual(await fs.readdir(path.join(ctx.dir, 'tmp')), [], 'failed uploads clean their temp files');
        assert.equal((await fs.readdir(path.join(ctx.dir, 'audio'))).length, 1);
    } finally { await ctx.stop(); }
});

test('the catalog survives a restart', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'me-music-'));
    const open = async () => { const app = await createApp({ dir, embed: fakeEmbed, adminToken: 't' }); await new Promise(resolve => app.listen(0, '127.0.0.1', resolve)); return app; };
    const close = app => new Promise(resolve => { app.closeAllConnections?.(); app.close(resolve); });
    let app = await open();
    try {
        let base = `http://127.0.0.1:${app.address().port}`;
        await fetch(`${base}/api/admin/sections`, { method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Keep' }) });
        await close(app);
        app = await open();
        base = `http://127.0.0.1:${app.address().port}`;
        const catalog = await (await fetch(`${base}/api/admin/catalog`, { headers: { Authorization: 'Bearer t' } })).json();
        assert.deepEqual(catalog.sections.map(item => item.name), ['Keep']);
    } finally { await close(app); await fs.rm(dir, { recursive: true, force: true }); }
});

// --- Лимиты ---------------------------------------------------------------------

test('the limiter allows N hits a minute per address, then says how long to wait, and forgets after the window', () => {
    let time = 1_000_000;
    const limiter = createRateLimiter({ perMinute: 3, now: () => time });
    assert.deepEqual([1, 2, 3].map(() => limiter.take('a').ok), [true, true, true]);
    const refused = limiter.take('a');
    assert.equal(refused.ok, false);
    assert.equal(refused.retryAfter, 60);
    assert.equal(limiter.take('b').ok, true, 'another address has its own allowance');
    time += 61_000;
    assert.equal(limiter.take('a').ok, true, 'the window slides');
});

test('the client address is trusted from X-Forwarded-For only when the request comes from our own proxy', () => {
    const request = (remoteAddress, forwarded) => ({ socket: { remoteAddress }, headers: forwarded ? { 'x-forwarded-for': forwarded } : {} });
    assert.equal(clientAddress(request('127.0.0.1', '5.6.7.8, 9.9.9.9')), '5.6.7.8');
    assert.equal(clientAddress(request('::ffff:127.0.0.1', '5.6.7.8')), '5.6.7.8');
    assert.equal(clientAddress(request('203.0.113.9', '5.6.7.8')), '203.0.113.9', 'a stranger cannot pick his own address');
});

test('too many catalog or audio requests get 429 with Retry-After; the owner is never limited', async () => {
    const ctx = await start({ limits: { catalogPerMinute: 3, audioPerMinute: 2, audioBytesPerSecond: 0 } });
    try {
        const { id } = await (await ctx.json('/api/admin/sections', { method: 'POST', body: { name: 'A' } })).json();
        const track = await (await upload(ctx, id)).json();
        const statuses = [];
        for (let i = 0; i < 5; i += 1) statuses.push((await fetch(`${ctx.base}/api/sections`)).status);
        assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
        const refused = await fetch(`${ctx.base}/api/sections`);
        assert.ok(Number(refused.headers.get('retry-after')) >= 1);
        const audio = [];
        for (let i = 0; i < 3; i += 1) audio.push((await fetch(`${ctx.base}/audio/${track.id}.mp3`)).status);
        assert.deepEqual(audio, [200, 200, 429], 'audio has its own allowance');
        for (let i = 0; i < 6; i += 1) assert.equal((await fetch(`${ctx.base}/api/admin/catalog`, { headers: ctx.admin })).status, 200);
        assert.equal((await fetch(`${ctx.base}/audio/${track.id}.mp3`, { headers: ctx.admin })).status, 200, 'the owner auditions freely');
    } finally { await ctx.stop(); }
});

test('audio is sent no faster than the speed limit; the owner gets full speed', async () => {
    const ctx = await start({ limits: { catalogPerMinute: 0, audioPerMinute: 0, audioBytesPerSecond: 100 } });   // 100 байт/с = порции по 10 байт каждые 100 мс
    try {
        const { id } = await (await ctx.json('/api/admin/sections', { method: 'POST', body: { name: 'A' } })).json();
        const track = await (await upload(ctx, id, { bytes: Buffer.alloc(100, 7) })).json();
        let started = Date.now();
        const slow = await (await fetch(`${ctx.base}/audio/${track.id}.mp3`)).arrayBuffer();
        const slowMs = Date.now() - started;
        assert.equal(slow.byteLength, 100, 'the whole file still arrives');
        assert.ok(slowMs >= 800, `100 bytes at 100 B/s take about a second, took ${slowMs} ms`);
        started = Date.now();
        await (await fetch(`${ctx.base}/audio/${track.id}.mp3`, { headers: ctx.admin })).arrayBuffer();
        assert.ok(Date.now() - started < 400, 'the owner is not throttled');
    } finally { await ctx.stop(); }
});

// --- Разделы «по группам» ----------------------------------------------------------

const post = (ctx, pathname, body, method = 'POST') => ctx.json(pathname, { method, body });
const uploadTo = (ctx, section, group, { bytes = Buffer.from('abcdef') } = {}) =>
    fetch(`${ctx.base}/api/admin/tracks?${new URLSearchParams({ section, ...(group ? { group } : {}), title: 'x', ext: 'mp3', description: 'own tag that a grouped track must ignore' })}`, { method: 'POST', headers: ctx.admin, body: bytes });

test('a group section serves one vector per GROUP and tracks only point at their group; the client parser expands it', async () => {
    const ctx = await start();
    try {
        const section = await (await post(ctx, '/api/admin/sections', { name: 'Moods', mode: 'groups' })).json();
        assert.equal(section.mode, 'groups');
        const love = await (await post(ctx, '/api/admin/groups', { section: section.id, name: 'Love', description: 'tender romantic evening' })).json();
        const fight = await (await post(ctx, '/api/admin/groups', { section: section.id, name: 'Fight', description: 'brutal fight at night' })).json();
        const a = await (await uploadTo(ctx, section.id, love.id)).json();
        await uploadTo(ctx, section.id, love.id);
        await uploadTo(ctx, section.id, fight.id);

        assert.equal(a.vector, null, 'a track inside a group has no tag of its own, whatever was sent');
        const text = await (await fetch(`${ctx.base}/api/sections/${section.id}`)).text();
        const body = JSON.parse(text);
        assert.equal(body.mode, 'groups');
        assert.equal(body.groups.length, 2);
        assert.equal(body.tracks.length, 3);
        assert.ok(body.tracks.every(track => track.g && track.v === undefined), 'tracks carry no vector — the group does');
        assert.equal(text.includes('tender romantic'), false, 'the group tag text never leaves the server');
        assert.equal(text.includes('Love'), false, 'group names stay private too');

        const parsed = parseSectionTracks(text, { server: { url: ctx.base }, sectionId: section.id, model: EMBEDDING_MODEL_ID, dim: DIM });
        assert.equal(parsed.tracks.length, 3);
        const byGroup = Map.groupBy(parsed.tracks, track => track.group);
        assert.deepEqual([...byGroup.values()].map(list => list.length).sort(), [1, 2]);
        const [first, second] = [...byGroup.values()].find(list => list.length === 2);
        assert.deepEqual(first.vector, second.vector, 'tracks of one group share the group vector');
    } finally { await ctx.stop(); }
});

test('in a group section a track with no group, or in a group with no tag, stays silent; groups cannot live in a per-track section', async () => {
    const ctx = await start();
    try {
        const section = await (await post(ctx, '/api/admin/sections', { name: 'Moods', mode: 'groups' })).json();
        const untagged = await (await post(ctx, '/api/admin/groups', { section: section.id, name: 'Empty tag' })).json();
        await uploadTo(ctx, section.id, '');
        await uploadTo(ctx, section.id, untagged.id);
        assert.deepEqual((await (await fetch(`${ctx.base}/api/sections`)).json()).sections, [], 'nothing can play yet');

        await post(ctx, `/api/admin/groups/${untagged.id}`, { description: 'calm morning' }, 'PATCH');
        assert.equal((await (await fetch(`${ctx.base}/api/sections`)).json()).sections[0].tracks, 1, 'writing the group tag wakes the tracks in it');

        const plain = await (await post(ctx, '/api/admin/sections', { name: 'Plain' })).json();
        assert.equal(plain.mode, 'tracks', 'tracks is the default mode');
        assert.equal((await post(ctx, '/api/admin/groups', { section: plain.id, name: 'No' })).status, 400);
    } finally { await ctx.stop(); }
});

test('moving a track to another group works; moving it to another section drops the group; a non-empty group cannot be deleted', async () => {
    const ctx = await start();
    try {
        const moods = await (await post(ctx, '/api/admin/sections', { name: 'Moods', mode: 'groups' })).json();
        const other = await (await post(ctx, '/api/admin/sections', { name: 'Other', mode: 'groups' })).json();
        const g1 = await (await post(ctx, '/api/admin/groups', { section: moods.id, name: 'G1', description: 'one' })).json();
        const g2 = await (await post(ctx, '/api/admin/groups', { section: moods.id, name: 'G2', description: 'two' })).json();
        const foreign = await (await post(ctx, '/api/admin/groups', { section: other.id, name: 'F', description: 'three' })).json();
        const track = await (await uploadTo(ctx, moods.id, g1.id)).json();

        assert.equal((await ctx.json(`/api/admin/groups/${g1.id}`, { method: 'DELETE' })).status, 409);
        assert.equal((await post(ctx, `/api/admin/tracks/${track.id}`, { group: g2.id }, 'PATCH')).status, 200);
        assert.equal((await post(ctx, `/api/admin/tracks/${track.id}`, { group: foreign.id }, 'PATCH')).status, 400, 'a group of another section is refused');
        assert.equal((await ctx.json(`/api/admin/groups/${g1.id}`, { method: 'DELETE' })).status, 200, 'now empty');

        const moved = await (await post(ctx, `/api/admin/tracks/${track.id}`, { section: other.id }, 'PATCH')).json();
        assert.equal(moved.group, null, 'the old group does not follow the track');
        assert.equal((await (await fetch(`${ctx.base}/api/sections`)).json()).sections.length, 0, 'so it is silent until grouped again');
    } finally { await ctx.stop(); }
});

// --- Выбор на сервере ----------------------------------------------------------------

import { pickTrack } from '../tools/music-server/pick.js';
import { selectTrack } from '../libraries/core/track-selection.js';

const axis = (n, dim = 4) => Array.from({ length: dim }, (_, i) => (i === n ? 1 : 0));
const items = [
    { id: 'a', ext: 'mp3', vector: axis(0), group: 'g1' },
    { id: 'b', ext: 'mp3', vector: axis(0), group: 'g1' },
    { id: 'c', ext: 'mp3', vector: axis(1), group: 'g2' },
];

test('server pick matches what ME used to choose locally (same scoring, floor, cluster and weighting)', () => {
    for (const roll of [0, 0.3, 0.6, 0.99]) {
        const server = pickTrack({ items, vector: axis(0), dim: 4, randomFn: () => roll });
        const local = selectTrack({ tracks: items.map(item => ({ ...item, playCount: 0 })), sceneVector: axis(0), minSimilarity: 0.55, closeMargin: 0.04, randomFn: () => roll });
        assert.equal(server.id, local.track.id);
    }
    assert.equal(pickTrack({ items, vector: axis(3), dim: 4 }).action, 'none', 'nothing fits — the playing music goes on');
});

test('server pick keeps the playing track unless the newcomer is clearly better; force skips the floor and the margin', () => {
    assert.equal(pickTrack({ items, vector: axis(0), dim: 4, currentId: 'a', randomFn: () => 0.99 }).action, 'keep', 'a sibling of equal fit is not worth a switch');
    assert.equal(pickTrack({ items, vector: axis(1), dim: 4, currentId: 'a' }).id, 'c', 'a clearly better fit replaces it');
    assert.equal(pickTrack({ items, vector: axis(3), dim: 4, force: true }).action, 'play', 'force plays the best even if weak');
    assert.equal(pickTrack({ items, vector: [1, 2], dim: 4 }).action, 'none', 'a malformed vector is refused, not crashed on');
});

test('when a track ends the server plays another of the same group, rotating by play count', () => {
    const plays = new Map([['a', 5]]);
    assert.equal(pickTrack({ items, dim: 4, currentId: 'b', ended: true, plays }).id, 'a');
    assert.equal(pickTrack({ items, dim: 4, currentId: 'c', ended: true }).id, 'c', 'a group of one repeats its track');
    assert.equal(pickTrack({ items, dim: 4, currentId: 'zzz', ended: true }).action, 'none');
});

test('by default the server hands out no vectors at all; ME sends the scene vector and gets one track back', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'me-music-'));
    const app = await createApp({ dir, embed: fakeEmbed, adminToken: 'owner-secret' });
    await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.address().port}`;
    const admin = { Authorization: 'Bearer owner-secret', 'Content-Type': 'application/json' };
    try {
        const section = await (await fetch(`${base}/api/admin/sections`, { method: 'POST', headers: admin, body: JSON.stringify({ name: 'Mood' }) })).json();
        const description = 'quiet night camp, acoustic guitar';
        const made = await (await fetch(`${base}/api/admin/tracks?${new URLSearchParams({ section: section.id, ext: 'mp3', description })}`, { method: 'POST', headers: admin, body: Buffer.from('xx') })).json();
        assert.equal((await fetch(`${base}/api/sections/${section.id}`)).status, 404, 'vectors stay on the server');
        assert.equal((await fetch(`${base}/api/sections`)).status, 200, 'section names are still listed');

        const ask = body => fetch(`${base}/api/pick`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ section: section.id, ...body }) }).then(r => r.json());
        const scene = await fakeEmbed(description);
        const played = await ask({ vector: scene });
        assert.deepEqual([played.action, played.id, played.ext], ['play', made.id, 'mp3']);
        assert.equal((await ask({ vector: scene, current: made.id })).action, 'keep');
        assert.equal((await fetch(`${base}/api/pick`, { method: 'POST', body: JSON.stringify({ section: 'nope', vector: scene }) })).status, 404);
    } finally { app.closeAllConnections?.(); await new Promise(resolve => app.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); }
});
