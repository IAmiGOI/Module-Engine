import test from 'node:test';
import { addAssigned } from './music-kit.js';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createApp } from '../tools/music-server/app.js';
import { MODEL_ID } from '../tools/music-server/embed.js';
import { describeFeedback } from '../libraries/shared/music-player-model.js';

const DIM = 384;
const fakeEmbed = async text => Array.from({ length: DIM }, (_, i) => (i === String(text).length % DIM ? 1 : 0));
const scene = n => Array.from({ length: DIM }, (_, i) => (i === n % DIM ? 1 : 0));

async function start({ limits } = {}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'me-feedback-'));
    const app = await createApp({ dir, embed: fakeEmbed, adminToken: 'owner-secret', readKey: 'readers', ...(limits ? { limits } : {}) });
    await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.address().port}`;
    const admin = { Authorization: 'Bearer owner-secret', 'Content-Type': 'application/json' };
    const api = async (pathname, method, body) => { const response = await fetch(base + pathname, { method, headers: admin, body: body ? JSON.stringify(body) : undefined }); return { status: response.status, body: await response.json().catch(() => null) }; };
    const send = (body, { key = 'readers', model = MODEL_ID } = {}) => fetch(`${base}/api/feedback?k=${key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, ...body }) });
    const addTrack = (section, group, title) => addAssigned(base, admin, { section, group, title });
    const stop = async () => { app.closeAllConnections?.(); await new Promise(resolve => app.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); };
    return { base, api, send, addTrack, stop };
}

async function world(ctx) {
    const section = (await ctx.api('/api/admin/sections', 'POST', { name: 'Moods', mode: 'groups' })).body;
    const calm = (await ctx.api('/api/admin/groups', 'POST', { section: section.id, name: 'Calm', description: 'quiet calm evening' })).body;
    const fight = (await ctx.api('/api/admin/groups', 'POST', { section: section.id, name: 'Fight', description: 'a brutal fight with swords' })).body;
    const calmTrack = await ctx.addTrack(section.id, calm.id, 'Calm track');
    const fightTrack = await ctx.addTrack(section.id, fight.id, 'Fight track');
    return { section, calm, fight, calmTrack, fightTrack };
}

test('a mark from ME lands in a REVIEW QUEUE, not in the dictionary: the owner sees the track and its group, never the vector', async () => {
    const ctx = await start();
    try {
        const w = await world(ctx);
        const sent = await ctx.send({ section: w.section.id, vector: scene(5), track: w.calmTrack.id, mark: 'bad' });
        assert.equal(sent.status, 200);
        assert.deepEqual(await sent.json(), { ok: true, queued: 1, updated: false });
        const catalog = (await ctx.api('/api/admin/catalog', 'GET')).body;
        assert.equal(catalog.examples.length, 0, 'nothing was learned yet');
        assert.equal(catalog.feedback.length, 1);
        assert.deepEqual([catalog.feedback[0].mark, catalog.feedback[0].trackTitle, catalog.feedback[0].groupName], ['bad', 'Calm track', 'Calm']);
        assert.equal('vector' in catalog.feedback[0], false);
        // тот же трек на той же сцене не копится, а меняет отметку
        const again = await (await ctx.send({ section: w.section.id, vector: scene(5), track: w.calmTrack.id, mark: 'good' })).json();
        assert.deepEqual([again.queued, again.updated], [1, true]);
        assert.equal((await ctx.api('/api/admin/catalog', 'GET')).body.feedback[0].mark, 'good');
    } finally { await ctx.stop(); }
});

test('what a reader may send is checked: the read key, the model, a real vector, a mark, a track of that very section — and the public answer never carries the queue', async () => {
    const ctx = await start();
    try {
        const w = await world(ctx);
        const good = { section: w.section.id, vector: scene(7), track: w.calmTrack.id, mark: 'good' };
        assert.equal((await ctx.send(good, { key: 'wrong' })).status, 401);
        assert.deepEqual(await (await ctx.send(good, { model: 'other-model' })).json(), { ok: false, reason: 'model mismatch' });
        assert.equal((await ctx.send({ ...good, vector: [0.1, 0.2] })).status, 400);
        assert.equal((await ctx.send({ ...good, vector: Array(DIM).fill(NaN) })).status, 400);
        assert.equal((await ctx.send({ ...good, mark: 'great' })).status, 400);
        assert.equal((await ctx.send({ ...good, track: 'nope' })).status, 400);
        assert.equal((await ctx.send({ ...good, section: 'nope' })).status, 404);
        const other = (await ctx.api('/api/admin/sections', 'POST', { name: 'Other', mode: 'groups' })).body;
        assert.equal((await ctx.send({ ...good, section: other.id })).status, 400, 'a track of another section');
        assert.equal((await ctx.api('/api/admin/catalog', 'GET')).body.feedback.length, 0);
        assert.equal((await (await fetch(`${ctx.base}/api/sections?k=readers`)).text()).includes('feedback'), false);
    } finally { await ctx.stop(); }
});

test('the queue is capped (the oldest are dropped) and rate-limited per address, so a public key cannot flood the owner', async () => {
    const ctx = await start({ limits: { feedbackPerMinute: 3, pickPerMinute: 60, catalogPerMinute: 60, audioPerMinute: 90, audioBytesPerSecond: 0 } });
    try {
        const w = await world(ctx);
        const statuses = [];
        for (let n = 0; n < 5; n += 1) statuses.push((await ctx.send({ section: w.section.id, vector: scene(10 + n), track: w.calmTrack.id, mark: 'bad' })).status);
        assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
        assert.equal((await ctx.api('/api/admin/catalog', 'GET')).body.feedback.length, 3);
    } finally { await ctx.stop(); }
    const free = await start({ limits: { feedbackPerMinute: 0, pickPerMinute: 0, catalogPerMinute: 0, audioPerMinute: 0, audioBytesPerSecond: 0 } });
    try {
        const w = await world(free);
        for (let n = 0; n < 305; n += 1) await free.send({ section: w.section.id, vector: scene(n), track: w.calmTrack.id, mark: 'bad' });
        const queue = (await free.api('/api/admin/catalog', 'GET')).body.feedback;
        assert.equal(queue.length, 300, 'capped');
    } finally { await free.stop(); }
});

test('resolving: "right" makes the scene an example of the played track\'s group; "wrong" makes it an example of the group the owner picks; either way it leaves the queue and the scene text is never invented', async () => {
    const ctx = await start();
    try {
        const w = await world(ctx);
        await ctx.send({ section: w.section.id, vector: scene(20), track: w.calmTrack.id, mark: 'good' });
        await ctx.send({ section: w.section.id, vector: scene(21), track: w.calmTrack.id, mark: 'bad' });
        let queue = (await ctx.api('/api/admin/catalog', 'GET')).body.feedback;
        const good = queue.find(item => item.mark === 'good'), bad = queue.find(item => item.mark === 'bad');
        assert.equal((await ctx.api(`/api/admin/feedback/${good.id}`, 'POST', {})).body.group, w.calm.id, 'default: the group that played');
        assert.equal((await ctx.api(`/api/admin/feedback/${bad.id}`, 'POST', { group: w.fight.id })).body.group, w.fight.id);
        const catalog = (await ctx.api('/api/admin/catalog', 'GET')).body;
        assert.equal(catalog.feedback.length, 0);
        assert.deepEqual(catalog.examples.map(item => item.group).sort(), [w.calm.id, w.fight.id].sort());
        assert.ok(catalog.examples.every(item => item.cleaned === true && item.source === 'feedback'));
        assert.equal((await ctx.api(`/api/admin/feedback/${good.id}`, 'POST', {})).status, 404, 'resolved once');
        // сцена правда стала эталоном: выбор по ЭТОМУ вектору теперь опирается на неё (similarity с эталоном видна в предпросмотре как группа без ошибок)
        assert.equal((await ctx.api('/api/admin/preview', 'POST', { section: w.section.id, messages: ['x'.repeat(21)] })).status, 200);
    } finally { await ctx.stop(); }
});

test('dismissing drops a mark without learning anything; a wrong group is refused; deleting the track removes its marks; a per-track section cannot learn scenes, only dismiss', async () => {
    const ctx = await start();
    try {
        const w = await world(ctx);
        await ctx.send({ section: w.section.id, vector: scene(30), track: w.fightTrack.id, mark: 'bad' });
        const item = (await ctx.api('/api/admin/catalog', 'GET')).body.feedback[0];
        assert.equal((await ctx.api(`/api/admin/feedback/${item.id}`, 'POST', { group: 'nope' })).status, 400);
        assert.equal((await ctx.api(`/api/admin/feedback/${item.id}`, 'DELETE')).status, 200);
        assert.equal((await ctx.api('/api/admin/catalog', 'GET')).body.examples.length, 0);
        assert.equal((await ctx.api(`/api/admin/feedback/${item.id}`, 'DELETE')).status, 404);

        await ctx.send({ section: w.section.id, vector: scene(31), track: w.fightTrack.id, mark: 'good' });
        assert.equal((await ctx.api(`/api/admin/tracks/${w.fightTrack.id}`, 'DELETE')).status, 200);
        assert.equal((await ctx.api('/api/admin/catalog', 'GET')).body.feedback.length, 0, 'marks of a deleted track are gone');

        const flat = (await ctx.api('/api/admin/sections', 'POST', { name: 'Flat' })).body;
        const track = await addAssigned(ctx.base, { Authorization: 'Bearer owner-secret', 'Content-Type': 'application/json' }, { section: flat.id, title: 'T', description: 'tagged track' });
        await ctx.send({ section: flat.id, vector: scene(32), track: track.id, mark: 'good' });
        const flatItem = (await ctx.api('/api/admin/catalog', 'GET')).body.feedback[0];
        assert.equal((await ctx.api(`/api/admin/feedback/${flatItem.id}`, 'POST', {})).status, 400);
    } finally { await ctx.stop(); }
});

test('the caption under the thumbs says only what happened: asking, sending, sent (right / wrong), failed', () => {
    assert.equal(describeFeedback(), 'Is this the right music?');
    assert.equal(describeFeedback({ mark: 'good', status: 'sending' }), 'Sending…');
    assert.equal(describeFeedback({ mark: 'good', status: 'sent' }), 'Sent: right music for this scene');
    assert.equal(describeFeedback({ mark: 'bad', status: 'sent' }), 'Sent: wrong music for this scene');
    assert.equal(describeFeedback({ mark: 'bad', status: 'failed' }), 'Could not send — try again');
});
