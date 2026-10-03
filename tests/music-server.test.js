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

import { pickTrack, similarity, scoreItems } from '../tools/music-server/pick.js';
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
    assert.equal(pickTrack({ items, vector: axis(3), dim: 4, force: true, minPlausibleCosine: -1 }).action, 'play', 'force plays the best even if weak');
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

        const ask = body => fetch(`${base}/api/pick`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: MODEL_ID, section: section.id, ...body }) }).then(r => r.json());
        const scene = await fakeEmbed(description);
        const played = await ask({ vector: scene });
        assert.deepEqual([played.action, played.id, played.ext], ['play', made.id, 'mp3']);
        assert.equal((await ask({ vector: scene, current: made.id })).action, 'keep');
        assert.equal((await fetch(`${base}/api/pick`, { method: 'POST', body: JSON.stringify({ model: MODEL_ID, section: 'nope', vector: scene }) })).status, 404);
        // Защита от «тихого мусора»: вектор другой модели (или без метки модели — так присылали старые версии ME) ничего не выбирает; вектор не похожий на сцену — тоже.
        const stale = await fetch(`${base}/api/pick`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ section: section.id, vector: scene }) }).then(r => r.json());
        assert.deepEqual([stale.action, stale.reason], ['none', 'model mismatch']);
        const foreign = await ask({ model: 'Xenova/multilingual-e5-small', vector: scene });
        assert.equal(foreign.action, 'none');
        const junk = await ask({ vector: Array(384).fill(0.05).map((x, i) => (i % 2 ? x : -x)) });
        assert.deepEqual([junk.action, junk.reason], ['none', 'implausible vector']);
    } finally { app.closeAllConnections?.(); await new Promise(resolve => app.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); }
});

test('the owner can test a scene: pasted messages show which group/track would play and how the candidates rank; nothing is counted as played', async () => {
    const ctx = await start();
    try {
        const section = await (await post(ctx, '/api/admin/sections', { name: 'Moods', mode: 'groups' })).json();
        const love = await (await post(ctx, '/api/admin/groups', { section: section.id, name: 'Love', description: 'tender romantic evening' })).json();
        const fight = await (await post(ctx, '/api/admin/groups', { section: section.id, name: 'Fight', description: 'brutal fight at night and a long text' })).json();
        await uploadTo(ctx, section.id, love.id);
        await uploadTo(ctx, section.id, fight.id);
        const ask = body => post(ctx, '/api/admin/preview', { section: section.id, ...body }).then(r => r.json());

        const hit = await ask({ messages: ['tender romantic evening'], minSimilarity: 0.5 });   // тот же текст → тот же вектор у фейка
        assert.equal(hit.action, 'play');
        assert.equal(hit.chosen.group, 'Love');
        assert.deepEqual(hit.ranking.map(row => row.label), ['Love', 'Fight'], 'candidates are listed by group, best first');
        assert.equal(hit.ranking[0].similarity > hit.ranking[1].similarity, true);

        const miss = await ask({ messages: ['x'], minSimilarity: 0.99 });
        assert.equal(miss.action, 'none', 'below the floor nothing would change');
        assert.equal((await post(ctx, '/api/admin/preview', { section: section.id, messages: [] })).status, 400);
        assert.equal((await ctx.json('/api/admin/preview', { method: 'POST', headers: {}, body: { section: section.id, messages: ['x'] } })).status, 401, 'owner only');
    } finally { await ctx.stop(); }
});

test('centering: tracks that all look alike in raw cosine are told apart once the shared part is removed, and an indistinct scene picks nothing', () => {
    const common = [10, 10, 0, 0];
    const crowd = [
        { id: 'A', ext: 'mp3', vector: [10, 10, 2, 0] }, { id: 'B', ext: 'mp3', vector: [10, 10, 0, 2] },
        { id: 'C', ext: 'mp3', vector: [10, 10, -2, 0] }, { id: 'D', ext: 'mp3', vector: [10, 10, 0, -2] },
    ];
    const scene = [10, 10, 2, 0.2];
    // Сырой косинус: все четыре в пределах нескольких сотых — старое окно «близких» взяло бы любой.
    const raw = crowd.map(item => similarity(scene, item.vector));
    assert.ok(Math.max(...raw) - Math.min(...raw) < 0.05);
    for (const roll of [0, 0.5, 0.99]) assert.equal(pickTrack({ items: crowd, vector: scene, dim: 4, randomFn: () => roll }).id, 'A', 'the clear match wins whatever the dice say');
    assert.equal(pickTrack({ items: crowd, vector: common, dim: 4 }).action, 'none', 'a scene like the average of the library stands out from nothing');
    assert.equal(pickTrack({ items: crowd, vector: common, dim: 4, force: true }).action, 'play', 'but Skip still plays the best available');
    assert.equal(pickTrack({ items: crowd, vector: scene, dim: 4, currentId: 'A' }).action, 'keep');
    assert.equal(pickTrack({ items: crowd, vector: [10, 10, 0, 2.2], dim: 4, currentId: 'A' }).id, 'B', 'a clearly different scene switches');
});

test('the "when NOT to play" tag: a group is cut when the scene sits much closer to its NOT-description than is usual for that group; ordinary leaning does not cut it', () => {
    const DIM_N = 12;
    const hot = n => Array.from({ length: DIM_N }, (_, i) => (i === n ? 1 : 0.3));   // «ось n» на общем фоне
    const items = [0, 1, 2, 3, 4, 5].map(n => ({ id: `T${n}`, ext: 'mp3', vector: hot(n) }));
    items[0] = { ...items[0], negVector: hot(6) };   // «не включать» группы 0 — это ось 6
    const sceneOnAxis6 = hot(6);
    const rows = scoreItems({ items, vector: sceneOnAxis6 }).rows;
    assert.equal(rows[0].vetoed, true, 'the scene is exactly what group 0 says NOT to play');
    assert.equal(rows.slice(1).some(row => row.vetoed), false, 'groups with no NOT-tag are never cut');

    const onAxis3 = scoreItems({ items, vector: hot(3) }).rows;
    assert.equal(onAxis3[0].vetoed, false, 'a scene far from the NOT-description leaves the group alone');

    // Отсечённая группа не может выиграть и по кнопке «следующий».
    const forced = pickTrack({ items, vector: sceneOnAxis6, dim: DIM_N, force: true });
    assert.notEqual(forced.id, 'T0');

    // Мало вариантов (шкалы нет): трек отсекается, если сцена ближе к «не включать», чем к самому треку.
    const pair = [{ id: 'X', ext: 'mp3', vector: [1, 0], negVector: [0, 1] }, { id: 'Y', ext: 'mp3', vector: [0.9, 0.3] }];
    assert.equal(pickTrack({ items: pair, vector: [0.1, 1], dim: 2, minSimilarity: 0, minPlausibleCosine: -1 }).id, 'Y');
});

test('negative tags are the owner\'s: the admin catalog shows the text (no vectors), public answers never contain it', async () => {
    const ctx = await start();
    try {
        const section = await (await post(ctx, '/api/admin/sections', { name: 'Moods', mode: 'groups' })).json();
        const group = await (await post(ctx, '/api/admin/groups', { section: section.id, name: 'Calm', description: 'quiet evening', negative: 'comedy, bickering, jokes' })).json();
        await uploadTo(ctx, section.id, group.id);
        const catalog = await (await ctx.json('/api/admin/catalog')).json();
        assert.equal(catalog.groups[0].negative, 'comedy, bickering, jokes');
        assert.equal('negVector' in catalog.groups[0], false);

        await post(ctx, `/api/admin/groups/${group.id}`, { negative: '' }, 'PATCH');
        assert.equal((await (await ctx.json('/api/admin/catalog')).json()).groups[0].negative, '', 'clearing the field removes it');

        const pick = await fetch(`${ctx.base}/api/pick`, { method: 'POST', body: JSON.stringify({ section: section.id, vector: await fakeEmbed('quiet evening') }) });
        assert.equal((await pick.text()).includes('bickering'), false);
        assert.equal((await (await fetch(`${ctx.base}/api/sections/${section.id}`)).text()).includes('bickering'), false);
    } finally { await ctx.stop(); }
});

test('audio of a track inside a tagged group is served to listeners (the track has no vector of its own — its group does); an untagged group stays closed', async () => {
    const ctx = await start();
    try {
        const section = await (await post(ctx, '/api/admin/sections', { name: 'Moods', mode: 'groups' })).json();
        const tagged = await (await post(ctx, '/api/admin/groups', { section: section.id, name: 'Calm', description: 'quiet evening' })).json();
        const silent = await (await post(ctx, '/api/admin/groups', { section: section.id, name: 'No tag' })).json();
        const a = await (await uploadTo(ctx, section.id, tagged.id)).json();
        const b = await (await uploadTo(ctx, section.id, silent.id)).json();
        assert.equal((await fetch(`${ctx.base}/audio/${a.id}.mp3`)).status, 200, 'listeners can fetch it');
        assert.equal((await fetch(`${ctx.base}/audio/${a.id}.mp3`, { headers: { Range: 'bytes=0-1' } })).status, 206);
        assert.equal((await fetch(`${ctx.base}/audio/${b.id}.mp3`)).status, 404, 'a group with no tag stays closed');
    } finally { await ctx.stop(); }
});

// --- Время, Jev и накал ----------------------------------------------------------------

import { sceneIntensity, INTENSITY_STATEMENTS } from '../tools/music-server/pick.js';

const crowdOf = extra => [
    { id: 'A', ext: 'mp3', vector: [10, 10, 2, 0], statement: 'calm walk' }, { id: 'B', ext: 'mp3', vector: [10, 10, 0, 2], statement: 'tense chase' },
    { id: 'C', ext: 'mp3', vector: [10, 10, -2, 0], statement: 'sad farewell' }, { id: 'D', ext: 'mp3', vector: [10, 10, 0, -2], statement: 'happy feast' },
].map(item => ({ ...item, ...(extra?.[item.id] ?? {}) }));
const sceneA = [10, 10, 2, 0.2];
/** Ответы Jev по тексту вопросов: `chances` — {текст категории → вероятность}, `intensity` — [тихо, средне, сильно]. */
const jev = (questions, chances, intensity = [0.1, 0.1, 0.1]) => {
    const answers = {};
    for (const [id, text] of Object.entries(questions)) {
        if (id.startsWith('c')) answers[id] = Object.entries(chances).find(([statement]) => text.endsWith(statement))?.[1] ?? 0.05;
        else answers[id] = intensity[Number(id.slice(1))];
    }
    return answers;
};

test('time: the first minute of a track is never interrupted, but Skip and a finished track are free', () => {
    const items = crowdOf();
    assert.equal(pickTrack({ items, vector: sceneA, dim: 4, currentId: 'C', elapsed: 20, remaining: 150 }).action, 'keep', 'too early to change');
    assert.equal(pickTrack({ items, vector: sceneA, dim: 4, currentId: 'C', elapsed: 90, remaining: 120 }).id, 'A', 'a sharp shift mid-track still changes it');
    assert.equal(pickTrack({ items, vector: sceneA, dim: 4, currentId: 'C', elapsed: 5, remaining: 150, force: true }).id, 'A', 'Skip ignores the clock');
    const twins = [{ id: 'A', ext: 'mp3', vector: [1, 0] }, { id: 'B', ext: 'mp3', vector: [1, 0] }];
    assert.equal(pickTrack({ items: twins, vector: [1, 0], dim: 2, currentId: 'A', ended: true, minSimilarity: 0 }).id, 'B', 'a finished track follows the scene but does not repeat');
});

test('smart: the server asks Jev only when a change is due, then follows Jev when it is confident', () => {
    const items = crowdOf();
    assert.equal(pickTrack({ items, vector: sceneA, dim: 4, currentId: 'A', elapsed: 200, remaining: 20, smart: true }).action, 'keep', 'nothing to change — Jev is not bothered');

    const ask = pickTrack({ items, vector: sceneA, dim: 4, currentId: 'C', elapsed: 200, remaining: 20, smart: true });
    assert.equal(ask.action, 'ask');
    assert.ok(Object.keys(ask.questions).every(id => /^[ci]\d$/.test(id)));
    assert.equal(INTENSITY_STATEMENTS.every(text => Object.values(ask.questions).includes(text)), true, 'the intensity statements are always asked');
    assert.ok(Object.values(ask.questions).some(text => text.endsWith('calm walk')), 'categories go as statements');

    const base = { items, vector: sceneA, dim: 4, currentId: 'C', elapsed: 200, remaining: 20, smart: true };
    // Jev уверен, что сцена — погоня, хотя по вектору ближе «прогулка»: слушаемся Jev.
    assert.equal(pickTrack({ ...base, answers: jev(ask.questions, { 'tense chase': 0.9, 'calm walk': 0.2 }) }).id, 'B');
    // Jev не уверен ни в чём (< 0.3) — остаётся выбор по вектору.
    assert.equal(pickTrack({ ...base, answers: jev(ask.questions, { 'tense chase': 0.2, 'calm walk': 0.25 }) }).id, 'A');
    // Jev не ответил / недоступен — тоже по вектору.
    assert.equal(pickTrack({ ...base, answers: {} }).id, 'A');
    // Jev называет категорию, которая уже играет — музыка не меняется.
    assert.equal(pickTrack({ ...base, currentId: 'B', answers: jev(ask.questions, { 'tense chase': 0.9 }) }).action, 'keep');
    // Кнопка «следующий» Jev не трогает.
    assert.equal(pickTrack({ ...base, force: true }).action, 'play');
});

test('intensity: the scene level comes from Jev, is smoothed by the previous one, and nudges the pick toward music of the same level', () => {
    assert.equal(sceneIntensity({}), null, 'no answers — no level');
    assert.ok(Math.abs(sceneIntensity({ i0: 0.9, i1: 0.05, i2: 0.05 }) - 1.1) < 0.05);
    assert.ok(Math.abs(sceneIntensity({ i0: 0.05, i1: 0.05, i2: 0.9 }) - 2.9) < 0.05);
    const smoothed = sceneIntensity({ i0: 0.05, i1: 0.05, i2: 0.9 }, 1);
    assert.ok(smoothed > 1 && smoothed < 2.9, 'a jump is softened by the previous level');

    const items = crowdOf({ A: { intensity: 1 }, B: { intensity: 3 } });
    const ask = pickTrack({ items, vector: sceneA, dim: 4, currentId: 'C', elapsed: 200, remaining: 20, smart: true });
    const both = { 'calm walk': 0.8, 'tense chase': 0.8 };   // Jev не отдаёт предпочтения — решает накал
    const loud = pickTrack({ items, vector: sceneA, dim: 4, currentId: 'C', elapsed: 200, remaining: 20, smart: true, answers: jev(ask.questions, both, [0.02, 0.05, 0.9]) });
    const quiet = pickTrack({ items, vector: sceneA, dim: 4, currentId: 'C', elapsed: 200, remaining: 20, smart: true, answers: jev(ask.questions, both, [0.9, 0.05, 0.02]) });
    assert.equal(loud.id, 'B', 'an intense scene picks the intense music');
    assert.equal(quiet.id, 'A', 'a quiet scene picks the quiet music');
    assert.ok(loud.intensity > 2 && quiet.intensity < 2, 'the level is returned so ME can send it back next time');
});

// --- Словарь эталонных сцен ---------------------------------------------------------

const SCENE_TEXT = (n) => `Scene number ${n}: she stands by the window and says nothing for a long time.`;

test('reference scenes: added per group in a group section, deduplicated, validated, listed to the owner, and gone with their group', async () => {
    const ctx = await start();
    try {
        const section = await (await post(ctx, '/api/admin/sections', { name: 'Moods', mode: 'groups' })).json();
        const group = await (await post(ctx, '/api/admin/groups', { section: section.id, name: 'Quiet', description: 'quiet sadness' })).json();
        const add = body => post(ctx, '/api/admin/examples', body);

        const first = await (await add({ section: section.id, group: group.id, texts: [SCENE_TEXT(1), SCENE_TEXT(2), SCENE_TEXT(2), 'short'] })).json();
        assert.deepEqual(first, { added: 2, skipped: 0 }, 'a duplicate inside one call and a too-short text are ignored');
        const again = await (await add({ section: section.id, group: group.id, texts: [SCENE_TEXT(1), SCENE_TEXT(3)] })).json();
        assert.deepEqual(again, { added: 1, skipped: 1 }, 'a text already in the group is skipped');
        assert.equal((await add({ section: section.id, group: group.id, texts: ['x'] })).status, 400, 'nothing usable — refused');
        assert.equal((await add({ section: section.id, group: 'nope', texts: [SCENE_TEXT(9)] })).status, 400, 'a group of another section is refused');

        const plain = await (await post(ctx, '/api/admin/sections', { name: 'Plain' })).json();
        assert.equal((await add({ section: plain.id, group: group.id, texts: [SCENE_TEXT(9)] })).status, 400, 'only group sections have a dictionary');

        const catalog = await (await ctx.json('/api/admin/catalog')).json();
        assert.equal(catalog.examples.length, 3);
        assert.ok(catalog.examples.every(item => item.text && item.vector === undefined), 'the owner sees the text, never the vectors');

        const publicText = await (await fetch(`${ctx.base}/api/sections/${section.id}`)).text() + await (await fetch(`${ctx.base}/api/sections`)).text();
        assert.equal(publicText.includes('Scene number'), false, 'reference scenes never leave the server');

        const one = catalog.examples[0];
        assert.equal((await ctx.json(`/api/admin/examples/${one.id}`, { method: 'DELETE' })).status, 200);
        assert.equal((await ctx.json(`/api/admin/examples/${one.id}`, { method: 'DELETE' })).status, 404);
        assert.equal((await ctx.json(`/api/admin/groups/${group.id}`, { method: 'DELETE' })).status, 200, 'the group is empty of tracks');
        assert.equal((await (await ctx.json('/api/admin/catalog')).json()).examples.length, 0, 'examples go with the group');
    } finally { await ctx.stop(); }
});

test('reference scenes pull the choice toward the group whose examples look like the scene — only when at least three groups have enough examples', () => {
    const DIM_P = 12;
    const hot = n => Array.from({ length: DIM_P }, (_, i) => (i === n ? 1 : 0.3));
    const items = [0, 1, 2, 3].map(n => ({ id: `G${n}`, ext: 'mp3', vector: hot(n), group: `g${n}` }));
    const scene = hot(1);   // по тегам ближе всего группа g1
    assert.equal(pickTrack({ items, vector: scene, dim: DIM_P, minSimilarity: 0 }).id, 'G1', 'tags alone: g1');

    // Эталоны группы g2 выглядят в точности как эта сцена; у остальных — свои, далёкие.
    const near = hot(1).map((x, i) => x + (i === 5 ? 0.02 : 0));
    const prototypes = new Map([['g0', [hot(0), hot(0), hot(0)]], ['g1', [hot(5), hot(6), hot(7)]], ['g2', [near, near, near]], ['g3', [hot(8), hot(9), hot(10)]]]);
    assert.equal(pickTrack({ items, vector: scene, dim: DIM_P, minSimilarity: 0, prototypes }).id, 'G2', 'the dictionary outweighs the tag');

    const thin = new Map([['g2', [near, near, near]], ['g0', [hot(0), hot(0), hot(0)]]]);   // эталоны только у двух групп — шкалы нет
    assert.equal(pickTrack({ items, vector: scene, dim: DIM_P, minSimilarity: 0, prototypes: thin }).id, 'G1', 'too small a dictionary is ignored');
    const few = new Map([['g0', [hot(0)]], ['g1', [hot(5)]], ['g2', [near]], ['g3', [hot(8)]]]);   // по одному эталону — мало
    assert.equal(pickTrack({ items, vector: scene, dim: DIM_P, minSimilarity: 0, prototypes: few }).id, 'G1', 'groups with fewer than three examples do not count');
});
