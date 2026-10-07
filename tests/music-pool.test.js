import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createApp } from '../tools/music-server/app.js';
import { MODEL_ID } from '../tools/music-server/embed.js';
import { uploadToPool, assign, addAssigned } from './music-kit.js';

const DIM = 384;
const fakeEmbed = async text => Array.from({ length: DIM }, (_, i) => (i === String(text).length % DIM ? 1 : 0));
const text = length => 'z'.repeat(length);

async function start({ seed = null, dir = null } = {}) {
    const root = dir ?? await fs.mkdtemp(path.join(os.tmpdir(), 'me-pool-'));
    if (seed) { await fs.writeFile(path.join(root, 'catalog.json'), JSON.stringify(seed)); await fs.mkdir(path.join(root, 'audio'), { recursive: true }); for (const item of seed.tracks ?? []) await fs.writeFile(path.join(root, 'audio', `${item.id}.${item.ext}`), item.id); }
    const app = await createApp({ dir: root, embed: fakeEmbed, adminToken: 'owner-secret', readKey: 'readers' });
    await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.address().port}`;
    const admin = { Authorization: 'Bearer owner-secret', 'Content-Type': 'application/json' };
    const api = async (pathname, method, body) => { const response = await fetch(base + pathname, { method, headers: admin, body: body ? JSON.stringify(body) : undefined }); return { status: response.status, body: await response.json().catch(() => null) }; };
    const pick = body => fetch(`${base}/api/pick?k=readers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: MODEL_ID, minSimilarity: 0.2, switchMargin: 0.05, ...body }) }).then(response => response.json());
    const stop = async () => { app.closeAllConnections?.(); await new Promise(resolve => app.close(resolve)); if (!dir) await fs.rm(root, { recursive: true, force: true }); };
    return { base, api, pick, admin, root, stop };
}

const vectorOf = async length => fakeEmbed(text(length));

test('an old catalog (a track owns its section, group and tag) moves into the pool without losing anything: the same sections play the same tracks, and a copy of the old file is kept', async () => {
    const seed = {
        sections: [{ id: 'moods', name: 'Moods', mode: 'groups' }, { id: 'flat', name: 'Flat' }],
        groups: [{ id: 'calm', section: 'moods', name: 'Calm', description: 'quiet', vector: await vectorOf(5), negative: '', negVector: null }],
        tracks: [
            { id: 'a1', section: 'moods', group: 'calm', ext: 'mp3', title: 'Calm one', description: '', vector: null, createdAt: 1 },
            { id: 'b2', section: 'flat', group: null, ext: 'ogg', title: 'Flat tagged', description: 'tagged track', vector: await vectorOf(12), negative: '', negVector: null, intensity: 2, createdAt: 2 },
            { id: 'c3', section: 'flat', group: null, ext: 'mp3', title: 'Flat silent', description: '', vector: null, createdAt: 3 },
        ],
        examples: [], patterns: [], feedback: [],
    };
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'me-pool-'));
    const ctx = await start({ seed, dir });
    try {
        const publicBefore = JSON.parse(await fs.readFile(path.join(dir, 'catalog.json.pre-pool'), 'utf8'));
        assert.equal(publicBefore.tracks[0].section, 'moods', 'the pre-migration file is kept as it was');

        const catalog = (await ctx.api('/api/admin/catalog', 'GET')).body;
        assert.deepEqual(catalog.tracks.map(item => item.id).sort(), ['a1', 'b2', 'c3']);
        assert.ok(catalog.tracks.every(item => !('section' in item) && !('group' in item) && !('description' in item)), 'tracks are pure pool entries now');
        assert.equal(catalog.assignments.length, 3);
        const flat = catalog.assignments.find(item => item.track === 'b2');
        assert.deepEqual([flat.section, flat.group, flat.description, flat.tagged, flat.intensity], ['flat', null, 'tagged track', true, 2]);

        const sections = (await (await fetch(`${ctx.base}/api/sections?k=readers`)).json()).sections;
        assert.deepEqual(sections.map(item => [item.id, item.tracks]).sort(), [['flat', 1], ['moods', 1]], 'what played before still plays; the silent track is still silent');
        assert.equal((await fetch(`${ctx.base}/audio/a1.mp3?k=readers`)).status, 200);
        assert.equal((await fetch(`${ctx.base}/audio/c3.mp3?k=readers`)).status, 404);
    } finally { await ctx.stop(); }
    // второй запуск на уже перенесённом каталоге ничего не меняет
    const before = await fs.readFile(path.join(dir, 'catalog.json'), 'utf8');
    const again = await start({ dir });
    try {
        assert.equal(await fs.readFile(path.join(dir, 'catalog.json'), 'utf8'), before);
        assert.equal((await again.api('/api/admin/catalog', 'GET')).body.assignments.length, 3);
    } finally { await again.stop(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('upload goes to the POOL: no section is needed, the track is silent for readers (but the owner can audition it) until it is assigned, and listed in the pool with how many places it is in', async () => {
    const ctx = await start();
    try {
        const up = await uploadToPool(ctx.base, ctx.admin, { title: 'Loose', bytes: Buffer.from('0123456789') });
        assert.equal(up.status, 201);
        const track = await up.json();
        assert.equal(await (await fetch(`${ctx.base}/audio/${track.id}.mp3?k=readers`)).status, 404, 'unassigned — silent for readers');
        assert.equal((await fetch(`${ctx.base}/audio/${track.id}.mp3`, { headers: ctx.admin })).status, 200, 'the owner can audition it');
        let pool = (await ctx.api('/api/admin/catalog', 'GET')).body.tracks;
        assert.deepEqual([pool[0].title, pool[0].assigned], ['Loose', 0]);
        assert.equal((await ctx.api(`/api/admin/tracks/${track.id}`, 'PATCH', { title: 'Renamed' })).body.title, 'Renamed');
        assert.equal((await uploadToPool(ctx.base, ctx.admin, { ext: 'exe' })).status, 400);
    } finally { await ctx.stop(); }
});

test('one track in several groups and sections at once — one file, many assignments; taking it out of one place leaves the others; deleting it from the pool removes every assignment and the file', async () => {
    const ctx = await start();
    try {
        const moods = (await ctx.api('/api/admin/sections', 'POST', { name: 'Moods', mode: 'groups' })).body;
        const other = (await ctx.api('/api/admin/sections', 'POST', { name: 'Other', mode: 'groups' })).body;
        const flat = (await ctx.api('/api/admin/sections', 'POST', { name: 'Flat' })).body;
        const g1 = (await ctx.api('/api/admin/groups', 'POST', { section: moods.id, name: 'G1', description: text(11) })).body;
        const g2 = (await ctx.api('/api/admin/groups', 'POST', { section: moods.id, name: 'G2', description: text(12) })).body;
        const g3 = (await ctx.api('/api/admin/groups', 'POST', { section: other.id, name: 'G3', description: text(13) })).body;
        const track = await (await uploadToPool(ctx.base, ctx.admin, { title: 'Shared' })).json();

        const made = [];
        for (const body of [{ section: moods.id, group: g1.id }, { section: moods.id, group: g2.id }, { section: other.id, group: g3.id }, { section: flat.id, description: text(14) }]) {
            const response = await assign(ctx.base, ctx.admin, { track: track.id, ...body });
            assert.equal(response.status, 201);
            made.push(await response.json());
        }
        const again = await (await assign(ctx.base, ctx.admin, { track: track.id, section: moods.id, group: g1.id })).json();
        assert.equal(again.existing, true);
        assert.equal(again.assignment, made[0].assignment, 'assigning the same pair twice changes nothing');
        const catalog = (await ctx.api('/api/admin/catalog', 'GET')).body;
        assert.equal(catalog.assignments.length, 4);
        assert.equal(catalog.tracks.find(item => item.id === track.id).assigned, 4);
        assert.equal((await fs.readdir(path.join(ctx.root, 'audio'))).length, 1, 'one file for all of them');

        const counts = async () => Object.fromEntries((await (await fetch(`${ctx.base}/api/sections?k=readers`)).json()).sections.map(item => [item.id, item.tracks]));
        assert.deepEqual(await counts(), { [moods.id]: 1, [other.id]: 1, [flat.id]: 1 }, 'a track in two groups of one section is still ONE track there');
        assert.equal((await ctx.api(`/api/admin/assignments/${made[1].assignment}`, 'DELETE')).status, 200);
        assert.equal((await ctx.api('/api/admin/catalog', 'GET')).body.assignments.length, 3);
        assert.equal((await fetch(`${ctx.base}/audio/${track.id}.mp3?k=readers`)).status, 200, 'still playable from the other places');

        assert.equal((await ctx.api(`/api/admin/groups/${g1.id}`, 'DELETE')).status, 409, 'a group with an assigned track is protected');
        assert.equal((await ctx.api(`/api/admin/tracks/${track.id}`, 'DELETE')).status, 200);
        assert.equal((await ctx.api('/api/admin/catalog', 'GET')).body.assignments.length, 0);
        assert.deepEqual(await fs.readdir(path.join(ctx.root, 'audio')), []);
        assert.equal((await ctx.api(`/api/admin/groups/${g1.id}`, 'DELETE')).status, 200, 'now the group is empty');
    } finally { await ctx.stop(); }
});

test('assignment rules: a grouped section needs a group of that section; a per-track section has no groups and its tag belongs to the ASSIGNMENT (the same track can carry different tags in different sections)', async () => {
    const ctx = await start();
    try {
        const grouped = (await ctx.api('/api/admin/sections', 'POST', { name: 'G', mode: 'groups' })).body;
        const flatA = (await ctx.api('/api/admin/sections', 'POST', { name: 'A' })).body;
        const flatB = (await ctx.api('/api/admin/sections', 'POST', { name: 'B' })).body;
        const group = (await ctx.api('/api/admin/groups', 'POST', { section: grouped.id, name: 'X', description: text(7) })).body;
        const track = await (await uploadToPool(ctx.base, ctx.admin, { title: 'T' })).json();
        assert.equal((await ctx.api('/api/admin/assignments', 'POST', { track: track.id, section: grouped.id })).status, 400, 'no group');
        assert.equal((await ctx.api('/api/admin/assignments', 'POST', { track: track.id, section: flatA.id, group: group.id })).body.group, null, 'a group sent to a per-track section is ignored');
        assert.equal((await ctx.api('/api/admin/assignments', 'POST', { track: 'nope', section: flatA.id })).status, 404);
        assert.equal((await ctx.api('/api/admin/assignments', 'POST', { track: track.id, section: 'nope' })).status, 404);
        assert.equal((await ctx.api('/api/admin/assignments', 'POST', { track: track.id, section: grouped.id, group: 'nope' })).status, 400);

        const a = (await ctx.api('/api/admin/catalog', 'GET')).body.assignments.find(item => item.section === flatA.id);
        const b = (await ctx.api('/api/admin/assignments', 'POST', { track: track.id, section: flatB.id, description: text(20), intensity: 3 })).body;
        await ctx.api(`/api/admin/assignments/${a.id}`, 'PATCH', { description: text(9), intensity: 1 });
        const list = (await ctx.api('/api/admin/catalog', 'GET')).body.assignments;
        assert.deepEqual([list.find(item => item.id === a.id).intensity, list.find(item => item.id === b.assignment).intensity], [1, 3]);
        const vectorIndex = async section => (await (await fetch(`${ctx.base}/api/sections/${section}?k=readers`)).json()).tracks?.[0];
        assert.equal((await ctx.api('/api/admin/assignments/nope', 'PATCH', { description: 'x' })).status, 404);
        assert.equal((await ctx.api(`/api/admin/assignments/${a.id}`, 'PATCH', { group: group.id })).status, 400, 'groups only in grouped sections');
        assert.ok(vectorIndex);
    } finally { await ctx.stop(); }
});

test('bulk assignment: many tracks into one group at once; already placed ones are skipped; one unknown track refuses the whole call; the size is limited', async () => {
    const ctx = await start();
    try {
        const section = (await ctx.api('/api/admin/sections', 'POST', { name: 'S', mode: 'groups' })).body;
        const group = (await ctx.api('/api/admin/groups', 'POST', { section: section.id, name: 'G', description: text(8) })).body;
        const ids = [];
        for (let n = 0; n < 4; n += 1) ids.push((await (await uploadToPool(ctx.base, ctx.admin, { title: `T${n}` })).json()).id);
        await ctx.api('/api/admin/assignments', 'POST', { track: ids[0], section: section.id, group: group.id });
        const done = await ctx.api('/api/admin/assignments/bulk', 'POST', { tracks: ids, section: section.id, group: group.id });
        assert.deepEqual(done.body, { added: 3, skipped: 1 });
        assert.equal((await ctx.api('/api/admin/catalog', 'GET')).body.assignments.length, 4);
        assert.equal((await ctx.api('/api/admin/assignments/bulk', 'POST', { tracks: [...ids, 'nope'], section: section.id, group: group.id })).status, 400);
        assert.equal((await ctx.api('/api/admin/assignments/bulk', 'POST', { tracks: [], section: section.id, group: group.id })).status, 400);
        assert.equal((await ctx.api('/api/admin/assignments/bulk', 'POST', { tracks: ids, section: section.id })).status, 400, 'a group is required');
        const tooMany = await ctx.api('/api/admin/assignments/bulk', 'POST', { tracks: Array.from({ length: 501 }, (_, n) => `x${n}`), section: section.id, group: group.id });
        assert.equal(tooMany.status, 400);
        assert.match(tooMany.body.error, /500/, 'refused for its SIZE, before anything is looked up');
    } finally { await ctx.stop(); }
});

test('a pattern step can be ANY track of the pool, even one assigned nowhere — such a track is played only by the pattern, and its audio is served to readers because of it', async () => {
    const ctx = await start();
    try {
        const section = (await ctx.api('/api/admin/sections', 'POST', { name: 'S', mode: 'groups' })).body;
        const group = (await ctx.api('/api/admin/groups', 'POST', { section: section.id, name: 'G', description: text(8) })).body;
        await addAssigned(ctx.base, ctx.admin, { section: section.id, group: group.id, title: 'ordinary' });
        const song = await (await uploadToPool(ctx.base, ctx.admin, { title: 'The song' })).json();
        assert.equal((await fetch(`${ctx.base}/audio/${song.id}.mp3?k=readers`)).status, 404, 'silent until a pattern uses it');
        const node = (await ctx.api('/api/admin/patterns', 'POST', { section: section.id, kind: 'track', ref: song.id, description: text(25) })).body;
        assert.equal(node.ref, song.id);
        assert.equal((await fetch(`${ctx.base}/audio/${song.id}.mp3?k=readers`)).status, 200, 'now it is a pattern step');
        const played = await ctx.pick({ section: section.id, vector: await vectorOf(25) });
        assert.deepEqual([played.action, played.id, played.pattern], ['play', song.id, node.id]);
        assert.equal((await ctx.api(`/api/admin/tracks/${song.id}`, 'DELETE')).status, 409, 'a pattern step is protected');
        const sent = await fetch(`${ctx.base}/api/feedback?k=readers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: MODEL_ID, section: section.id, vector: await vectorOf(25), track: song.id, mark: 'good' }) });
        assert.equal((await sent.json()).ok, true, 'a mark on a pattern-only track is accepted');
    } finally { await ctx.stop(); }
});
