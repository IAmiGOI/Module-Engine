import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createApp } from '../tools/music-server/app.js';
import { MODEL_ID } from '../tools/music-server/embed.js';
import { resolveStep, findEntry, nextStep, sceneBreaksPattern, decidePattern } from '../tools/music-server/patterns.js';
import { parsePick } from '../libraries/shared/music-catalog.js';

const D = 12;
const hot = n => Array.from({ length: D }, (_, i) => (i === n ? 1 : 0.3));
const group = n => ({ id: `T${n}`, ext: 'mp3', vector: hot(n), group: `g${n}` });
const regular = [group(0), group(1), group(2), group(3)];
const tracks = [...regular.map(item => ({ id: item.id, ext: 'mp3', group: item.group })), { id: 'EXTRA', ext: 'ogg', group: 'gx' }, { id: 'EXTRA2', ext: 'ogg', group: 'gx' }];
const node = (id, parent, kind, ref, extra = {}) => ({ id, parent, kind, ref, order: 0, ...extra });
const base = { dim: D, minSimilarity: 0, switchMargin: 0, elapsed: 500, remaining: 5, prototypes: null };

test('resolveStep: a track step is that very track; a group step rotates among the group\'s tracks, never the same one twice running while others exist', () => {
    assert.equal(resolveStep(node('n', null, 'track', 'EXTRA'), { tracks }).id, 'EXTRA');
    const step = node('n', null, 'group', 'gx');
    assert.equal(resolveStep(step, { tracks, currentId: 'EXTRA', randomFn: () => 0 }).id, 'EXTRA2');
    assert.equal(resolveStep(step, { tracks, plays: new Map([['EXTRA', 5]]), randomFn: () => 0.99 }).id, 'EXTRA2', 'the less played one is favoured');
    assert.equal(resolveStep(node('n', null, 'group', 'g0'), { tracks, currentId: 'T0' }).id, 'T0', 'a group of one repeats rather than going silent');
    assert.equal(resolveStep(node('n', null, 'group', 'gone'), { tracks }), null, 'an emptied step plays nothing');
});

test('entry: a tagged root joins the game only when the scene fits it better than every ordinary group — and the playing track holds it back like it holds back any change', () => {
    const nodes = [node('R', null, 'track', 'EXTRA', { vector: hot(7) })];
    const scene = hot(7);
    const entry = findEntry({ ...base, nodes, items: regular, vector: scene });
    assert.equal(entry?.node.id, 'R');
    assert.equal(findEntry({ ...base, nodes, items: regular, vector: hot(1) }), null, 'a scene of an ordinary group stays ordinary');
    const leaning = hot(7).map((x, i) => 0.4 * x + 0.6 * hot(1)[i]);
    assert.equal(findEntry({ ...base, nodes, items: regular, vector: leaning }), null, 'a scene that leans to an ordinary group more than to the root stays ordinary');
    assert.equal(findEntry({ ...base, nodes: [node('R', null, 'track', 'EXTRA')], items: regular, vector: scene }), null, 'a root with no tag is never entered by scene');
    assert.equal(findEntry({ ...base, nodes, items: regular, vector: scene, currentId: 'T0', elapsed: 10 }), null, 'the first minute of a track is not interrupted');
    assert.equal(findEntry({ ...base, nodes, items: regular, vector: scene, currentId: 'T0', ended: true, elapsed: 10 })?.node.id, 'R', 'a finished track is free');
});

test('fork: the scene chooses the branch by the branches\' tags; one branch — it is taken; no branch fits — the pattern is over; untagged branches are the fallback', () => {
    const parent = node('P', null, 'track', 'EXTRA');
    const left = node('L', 'P', 'track', 'T0', { vector: hot(8) });
    const right = node('Rr', 'P', 'track', 'T1', { vector: hot(9), order: 1 });
    const third = node('X', 'P', 'track', 'T2', { vector: hot(10), order: 2 });
    const pick = (nodes, vector, extra = {}) => nextStep({ ...base, minSimilarity: 0.2, nodes, node: parent, vector, ...extra })?.node.id ?? null;
    assert.equal(pick([parent, left, right, third], hot(8)), 'L');
    assert.equal(pick([parent, left, right, third], hot(9)), 'Rr');
    assert.equal(pick([parent, left], hot(5).map(x => -x)), 'L', 'a single branch needs no scene, even a scene that looks nothing like its tag');
    assert.equal(pick([parent, left, right, third], hot(1)), null, 'the scene fits none of the branches');
    const open = node('O', 'P', 'track', 'T3', { order: 3 });
    assert.equal(pick([parent, left, right, third, open], hot(1)), 'O', 'an untagged branch catches what the tagged ones do not');
    assert.equal(pick([parent, left, right, third, open], hot(9)), 'Rr', 'but tagged branches win when they fit');
    assert.equal(pick([parent], hot(1)), null, 'a leaf has no next step');
    assert.equal(pick([parent, left, right], null, { randomFn: () => 0 }) !== null, true, 'with no scene vector a fork still moves on');
});

test('a sharp change of scene breaks the pattern, small drift does not, and the first minute of a track is not interrupted', () => {
    const args = { ...base, items: regular, minSimilarity: 0.2, switchMargin: 0.05 };
    assert.equal(sceneBreaksPattern({ ...args, vector: hot(1) }), true, 'the scene sits squarely on an ordinary group');
    assert.equal(sceneBreaksPattern({ ...args, vector: hot(9) }), false, 'a scene that matches no ordinary group is not a reason to leave');
    assert.equal(sceneBreaksPattern({ ...args, vector: hot(1), elapsed: 5 }), false);
});

test('decidePattern: entry, step by step along a deep chain, then out when the chain ends — depth is unlimited and shared beginnings are one node', () => {
    const chain = [node('c0', null, 'track', 'EXTRA', { vector: hot(7) })];
    for (let depth = 1; depth <= 8; depth += 1) chain.push(node(`c${depth}`, `c${depth - 1}`, 'track', depth % 2 ? 'EXTRA2' : 'EXTRA'));
    const common = { ...base, nodes: chain, tracks, items: regular, vector: hot(7), plays: new Map(), randomFn: () => 0 };
    let state = decidePattern({ ...common, currentId: null });
    assert.deepEqual([state.action, state.pattern], ['play', 'c0']);
    for (let depth = 1; depth <= 8; depth += 1) {
        state = decidePattern({ ...common, patternId: state.pattern, currentId: state.id, ended: true });
        assert.deepEqual([state.action, state.pattern], ['play', `c${depth}`], `step ${depth}`);
    }
    assert.equal(decidePattern({ ...common, patternId: 'c8', currentId: 'EXTRA', ended: true }), null, 'the last step is done: ordinary choice again');
});

test('decidePattern: inside a pattern the track is kept, the skip button moves one step, an unknown node id means "no pattern", and nodes never start from the skip button', () => {
    const nodes = [node('a', null, 'track', 'EXTRA', { vector: hot(7) }), node('b', 'a', 'track', 'EXTRA2')];
    const common = { ...base, minSimilarity: 0.2, switchMargin: 0.05, nodes, tracks, items: regular, vector: hot(7), plays: new Map(), randomFn: () => 0 };
    assert.deepEqual(decidePattern({ ...common, patternId: 'a', currentId: 'EXTRA' }), { action: 'keep', pattern: 'a' });
    assert.equal(decidePattern({ ...common, patternId: 'a', currentId: 'EXTRA', force: true }).pattern, 'b');
    assert.equal(decidePattern({ ...common, patternId: 'a', currentId: 'EXTRA', vector: hot(1) }), null, 'the scene broke away');
    assert.equal(decidePattern({ ...common, patternId: 'deleted', currentId: 'EXTRA' })?.pattern, 'a', 'a stale id behaves as no pattern: the scene may enter again');
    assert.equal(decidePattern({ ...common, force: true }), null, 'skip never starts a pattern');
    assert.equal(decidePattern({ ...common, nodes: [] }), null);
});

test('the client reads the pattern node from the answer, and only a safe id', () => {
    const server = { url: 'https://s.example', key: '' };
    assert.equal(parsePick(JSON.stringify({ action: 'keep', pattern: 'ab12' }), { server, sectionId: 'x' }).pattern, 'ab12');
    assert.equal(parsePick(JSON.stringify({ action: 'play', id: 't1', ext: 'mp3', pattern: 'ab12' }), { server, sectionId: 'x' }).pattern, 'ab12');
    assert.equal(parsePick(JSON.stringify({ action: 'play', id: 't1', ext: 'mp3' }), { server, sectionId: 'x' }).pattern, null);
    assert.equal(parsePick(JSON.stringify({ action: 'keep', pattern: '../x' }), { server, sectionId: 'x' }).pattern, null);
});

// --- сервер целиком ---------------------------------------------------------------------------------------------------

const DIM = 384;
const fakeEmbed = async text => Array.from({ length: DIM }, (_, i) => (i === String(text).length % DIM ? 1 : 0));
const text = length => 'x'.repeat(length);

async function start() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'me-patterns-'));
    const app = await createApp({ dir, embed: fakeEmbed, adminToken: 'owner-secret', readKey: 'readers' });
    await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.address().port}`;
    const admin = { Authorization: 'Bearer owner-secret', 'Content-Type': 'application/json' };
    const api = async (pathname, method, body) => { const response = await fetch(base + pathname, { method, headers: admin, body: body ? JSON.stringify(body) : undefined }); return { status: response.status, body: await response.json().catch(() => null) }; };
    const pick = body => fetch(`${base}/api/pick?k=readers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: MODEL_ID, minSimilarity: 0.2, switchMargin: 0.05, elapsed: 500, remaining: 5, ...body }) }).then(response => response.json());
    const stop = async () => { app.closeAllConnections?.(); await new Promise(resolve => app.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); };
    const addTrack = (section, group, title) => fetch(`${base}/api/admin/tracks?${new URLSearchParams({ section, group, title, ext: 'mp3' })}`, { method: 'POST', headers: admin, body: Buffer.from(title) }).then(response => response.json());
    return { base, api, pick, stop, addTrack };
}

test('a pattern tree on the real server: fork by scene, shared beginning, ordinary tracks stay ordinary, and what is used in a pattern is protected from deletion', async () => {
    const ctx = await start();
    try {
        const section = (await ctx.api('/api/admin/sections', 'POST', { name: 'Moods', mode: 'groups' })).body;
        const made = {};
        for (const [name, length] of [['Tension', 10], ['Fight', 20], ['Aftermath', 30], ['Escape', 40], ['Calm', 50], ['Party', 60]]) {
            made[name] = (await ctx.api('/api/admin/groups', 'POST', { section: section.id, name, description: text(length) })).body;
            made[`${name}Track`] = await ctx.addTrack(section.id, made[name].id, name);
        }
        // Tension → (Fight → Aftermath | Escape)
        const root = (await ctx.api('/api/admin/patterns', 'POST', { section: section.id, kind: 'group', ref: made.Tension.id, name: 'Arena', description: text(15) })).body;
        const fight = (await ctx.api('/api/admin/patterns', 'POST', { section: section.id, parent: root.id, kind: 'group', ref: made.Fight.id, description: text(25) })).body;
        const after = (await ctx.api('/api/admin/patterns', 'POST', { section: section.id, parent: fight.id, kind: 'track', ref: made.AftermathTrack.id })).body;
        const escape = (await ctx.api('/api/admin/patterns', 'POST', { section: section.id, parent: root.id, kind: 'group', ref: made.Escape.id, description: text(35) })).body;

        const scene = length => fakeEmbed(text(length));
        // Вход: сцена «арены» вызывает корень паттерна, а не обычную группу.
        const entered = await ctx.pick({ section: section.id, vector: await scene(15) });
        assert.deepEqual([entered.action, entered.id, entered.pattern], ['play', made.TensionTrack.id, root.id]);
        // Играет, сцена та же — держим.
        assert.deepEqual(await ctx.pick({ section: section.id, vector: await scene(15), current: entered.id, pattern: root.id }), { action: 'keep', pattern: root.id });
        // Доиграл, сцена про бой — ветка Fight; про бегство — ветка Escape (общее начало, разные продолжения).
        const toFight = await ctx.pick({ section: section.id, vector: await scene(25), current: entered.id, pattern: root.id, ended: true });
        assert.deepEqual([toFight.id, toFight.pattern], [made.FightTrack.id, fight.id]);
        const toEscape = await ctx.pick({ section: section.id, vector: await scene(35), current: entered.id, pattern: root.id, ended: true });
        assert.deepEqual([toEscape.id, toEscape.pattern], [made.EscapeTrack.id, escape.id]);
        // Дальше по ветке боя — Aftermath (шаг-трек), а после него паттерн кончается: обычный выбор.
        const toAfter = await ctx.pick({ section: section.id, vector: await scene(25), current: toFight.id, pattern: fight.id, ended: true });
        assert.deepEqual([toAfter.id, toAfter.pattern], [made.AftermathTrack.id, after.id]);
        const out = await ctx.pick({ section: section.id, vector: await scene(50), current: toAfter.id, pattern: after.id, ended: true });
        assert.deepEqual([out.id, out.pattern], [made.CalmTrack.id, undefined], 'out of the pattern: the ordinary pick finds Calm');
        // Треки паттерна остаются обычными: сцена «боя» БЕЗ паттерна играет тот же трек Fight.
        const plain = await ctx.pick({ section: section.id, vector: await scene(20) });
        assert.deepEqual([plain.id, plain.pattern], [made.FightTrack.id, undefined]);

        // Защита: то, что стоит в паттерне, не удаляется; чужие и несуществующие ссылки не принимаются; нельзя перенести шаг в собственную ветку.
        assert.equal((await ctx.api(`/api/admin/tracks/${made.AftermathTrack.id}`, 'DELETE')).status, 409);
        assert.equal((await ctx.api(`/api/admin/groups/${made.Fight.id}`, 'DELETE')).status, 409);
        assert.equal((await ctx.api('/api/admin/patterns', 'POST', { section: section.id, parent: root.id, kind: 'track', ref: 'nope' })).status, 400);
        assert.equal((await ctx.api('/api/admin/patterns', 'POST', { section: section.id, parent: 'nope', kind: 'track', ref: made.CalmTrack.id })).status, 400);
        assert.equal((await ctx.api(`/api/admin/patterns/${root.id}`, 'PATCH', { parent: after.id })).status, 400);
        // Консоль видит дерево с текстом тегов, но без векторов; читатели — ничего.
        const catalog = (await ctx.api('/api/admin/catalog', 'GET')).body;
        assert.equal(catalog.patterns.length, 4);
        assert.ok(catalog.patterns.every(item => !('vector' in item)));
        assert.equal((await (await fetch(`${ctx.base}/api/sections?k=readers`)).text()).includes('Arena'), false);
        // Удаление шага уносит всю ветку под ним.
        const removed = await ctx.api(`/api/admin/patterns/${fight.id}`, 'DELETE');
        assert.equal(removed.body.removed, 2);
        assert.equal((await ctx.api('/api/admin/catalog', 'GET')).body.patterns.length, 2);
        assert.equal((await ctx.api(`/api/admin/tracks/${made.AftermathTrack.id}`, 'DELETE')).status, 200, 'with the step gone the track is free to delete');
    } finally { await ctx.stop(); }
});
