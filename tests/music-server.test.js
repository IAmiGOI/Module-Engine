import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createApp } from '../tools/music-server/app.js';
import { MODEL_ID } from '../tools/music-server/embed.js';
import { EMBEDDING_MODEL_ID } from '../libraries/core/embedding.js';
import { parseSections, parseSectionTracks } from '../libraries/shared/music-catalog.js';

const DIM = 384;
// Фейк эмбеддинга: детерминированный вектор из длины текста — реальная модель (~50 МБ) в тестах не нужна, проверяется сам сервер.
const fakeEmbed = async text => Array.from({ length: DIM }, (_, i) => (i === String(text).length % DIM ? 1 : 0));

async function start({ readKey = '', maxUpload } = {}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'me-music-'));
    const app = await createApp({ dir, embed: fakeEmbed, adminToken: 'owner-secret', readKey, ...(maxUpload ? { maxUpload } : {}) });
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
