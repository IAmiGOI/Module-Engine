import test from 'node:test';
import { addAssigned } from './music-kit.js';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createApp } from '../tools/music-server/app.js';
import { MODEL_ID } from '../tools/music-server/embed.js';
import { estimateAlignment, shiftScene, shiftPrototypes } from '../tools/music-server/alignment.js';
import { pickTrack, scoreItems } from '../tools/music-server/pick.js';

const D = 12;
const axis = (n, size = 1) => Array.from({ length: D }, (_, i) => (i === n ? size : 0.05));
const add = (a, b, k = 1) => a.map((x, i) => x + k * b[i]);

test('alignment: the shift is the difference of the scene mean and the tag mean, scaled by strength; scenes are re-normalised; foreign sizes and missing data change nothing', () => {
    const tags = [axis(0), axis(1), axis(2)];
    const scenes = Array.from({ length: 12 }, (_, i) => add(axis(i % 3), axis(11), 2));
    const alignment = estimateAlignment({ sceneVectors: scenes, tagVectors: tags });
    assert.equal(alignment.scenes, 12);
    assert.ok(alignment.gap[11] > 1.5, 'the register offset on axis 11 is found');
    const shifted = shiftScene(scenes[0], alignment);
    assert.ok(Math.abs(Math.hypot(...shifted) - 1) < 1e-9, 'unit length');
    assert.ok(Math.abs(shifted[11]) < Math.abs(scenes[0][11]) / 5, 'the offset is gone');
    assert.deepEqual(shiftScene(scenes[0], null), scenes[0]);
    assert.deepEqual(shiftScene([1, 2], alignment), [1, 2], 'a vector of another size is left alone');
    assert.equal(estimateAlignment({ sceneVectors: scenes.slice(0, 5), tagVectors: tags }), null, 'too few scenes — no alignment');
    assert.equal(estimateAlignment({ sceneVectors: scenes, tagVectors: [axis(0)] }), null, 'too few tags');
    assert.equal(estimateAlignment({ sceneVectors: scenes, tagVectors: tags, strength: 0 }), null, 'strength 0 is "off"');
    const half = estimateAlignment({ sceneVectors: scenes, tagVectors: tags, strength: 0.5 });
    assert.ok(Math.abs(shiftScene(scenes[0], half)[11]) > Math.abs(shifted[11]), 'half strength removes half');
});

test('alignment: prototypes (scenes too) are shifted the same way as the scene; tags and the rest are not touched', () => {
    const alignment = { gap: axis(11, 2), strength: 1, scenes: 12, tags: 3 };
    const protos = new Map([['g', [add(axis(0), axis(11), 2)]]]);
    const out = shiftPrototypes(protos, alignment);
    assert.ok(Math.abs(out.get('g')[0][11]) < 0.2);
    assert.equal(shiftPrototypes(protos, null), protos);
    assert.equal(shiftPrototypes(null, alignment), null);
});

test('the hub: a tag that happens to sit near the "average scene" wins every scene — until the registers are aligned', () => {
    // Тег-«хаб» (g9) лежит рядом со смещением сцен (ось 11); настоящие теги — оси 0..3. Сцены — тема + общее смещение.
    const tags = [0, 1, 2, 3].map(n => ({ id: `T${n}`, ext: 'mp3', group: `g${n}`, vector: axis(n) }));
    const hub = { id: 'HUB', ext: 'mp3', group: 'g9', vector: add(axis(11, 0.9), axis(0, 0.1)) };
    const items = [...tags, hub];
    const scenesOf = n => Array.from({ length: 4 }, (_, k) => add(add(axis(n, 0.6), axis(11, 1.2)), axis((n + 4 + k) % 8 + 4 > 10 ? 4 : (n + 4 + k) % 8 + 4, 0.1)));
    const scenes = [0, 1, 2, 3].flatMap(scenesOf);
    const alignment = estimateAlignment({ sceneVectors: scenes, tagVectors: items.map(item => item.vector) });
    const base = { items, dim: D, minSimilarity: 0, switchMargin: 0, force: true };
    let withoutHits = 0, withHits = 0, hubWins = 0;
    for (const n of [0, 1, 2, 3]) for (const scene of scenesOf(n)) {
        const plain = pickTrack({ ...base, vector: scene });
        if (plain.id === `T${n}`) withoutHits += 1;
        if (plain.id === 'HUB') hubWins += 1;
        if (pickTrack({ ...base, vector: shiftScene(scene, alignment) }).id === `T${n}`) withHits += 1;
    }
    assert.ok(hubWins >= 10, `without alignment the hub grabs most scenes (${hubWins} of 16)`);
    assert.ok(withHits >= 12, `aligned, the right tag wins (${withHits} of 16; unaligned ${withoutHits})`);
});

// --- на настоящем сервере -------------------------------------------------------------------------------------------------

const DIM = 384;
const fakeEmbed = async text => Array.from({ length: DIM }, (_, i) => (i === String(text).length % DIM ? 1 : 0));

async function start({ seed = null, embedWith = fakeEmbed } = {}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'me-align-'));
    if (seed) await fs.writeFile(path.join(dir, 'catalog.json'), JSON.stringify(seed));
    const queried = [];
    const app = await createApp({ dir, embed: embedWith, embedQuery: async text => { queried.push(text); return embedWith(text); }, adminToken: 'owner-secret' });
    await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.address().port}`;
    const admin = { Authorization: 'Bearer owner-secret', 'Content-Type': 'application/json' };
    const api = async (pathname, method, body) => { const response = await fetch(base + pathname, { method, headers: admin, body: body ? JSON.stringify(body) : undefined }); return { status: response.status, body: await response.json().catch(() => null) }; };
    const stop = async () => { app.closeAllConnections?.(); await new Promise(resolve => app.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); };
    return { base, api, stop, queried };
}

test('examples are embedded from the CLEANED text (names and markup out) and marked so; the owner still sees his own text', async () => {
    const ctx = await start();
    try {
        const section = (await ctx.api('/api/admin/sections', 'POST', { name: 'Moods', mode: 'groups' })).body;
        const group = (await ctx.api('/api/admin/groups', 'POST', { section: section.id, name: 'Calm', description: 'quiet calm evening' })).body;
        const raw = '*Hatsu* sat quietly by the window, Hatsu smiled.';
        const added = await ctx.api('/api/admin/examples', 'POST', { section: section.id, group: group.id, texts: [raw], names: ['Hatsu'] });
        assert.equal(added.body.added, 1);
        assert.deepEqual(ctx.queried, ['sat quietly by the window, smiled.'], 'the model saw the cleaned scene');
        const catalog = (await ctx.api('/api/admin/catalog', 'GET')).body;
        assert.equal(catalog.examples[0].text, raw);
        assert.equal(catalog.examples[0].cleaned, true);
    } finally { await ctx.stop(); }
});

test('old examples (made before cleaning existed) are re-cleaned in batches until none remain, using names that recur across the section\'s scenes', async () => {
    const texts = Array.from({ length: 5 }, (_, n) => `Scene ${n}: she told Hatsu quietly that Nyx had gone, and Hatsu said nothing.`);
    const seed = { sections: [{ id: 's', name: 'S', mode: 'groups' }], groups: [{ id: 'g', section: 's', name: 'G', description: 'x', vector: await fakeEmbed('x'), negative: '', negVector: null }], tracks: [],
        examples: await Promise.all(texts.map(async (text, n) => ({ id: `e${n}`, section: 's', group: 'g', text, vector: await fakeEmbed(text), createdAt: n }))) };
    const ctx = await start({ seed });
    try {
        const first = await ctx.api('/api/admin/examples/reclean', 'POST', { section: 's', limit: 2 });
        assert.equal(first.body.remaining, 3);
        assert.ok(first.body.names.includes('Hatsu') && first.body.names.includes('Nyx'), `recurring names are found: ${first.body.names}`);
        assert.equal(ctx.queried.length, 2);
        assert.ok(ctx.queried.every(text => !text.includes('Hatsu') && !text.includes('Nyx')), 'the model saw no names');
        const second = await ctx.api('/api/admin/examples/reclean', 'POST', { section: 's', limit: 10 });
        assert.equal(second.body.remaining, 0);
        const third = await ctx.api('/api/admin/examples/reclean', 'POST', { section: 's' });
        assert.equal(third.body.remaining, 0);
        assert.equal(ctx.queried.length, 5, 'nothing is embedded twice');
        assert.ok((await ctx.api('/api/admin/catalog', 'GET')).body.examples.every(item => item.cleaned === true));
        assert.equal((await ctx.api('/api/admin/examples/reclean', 'POST', { section: 'nope' })).status, 404);
    } finally { await ctx.stop(); }
});

test('alignment strength is a per-section setting (0–2), shown in the admin catalog; bad values are refused; the test pick reports whether alignment was used', async () => {
    const ctx = await start();
    try {
        const section = (await ctx.api('/api/admin/sections', 'POST', { name: 'Moods', mode: 'groups' })).body;
        assert.equal((await ctx.api(`/api/admin/sections/${section.id}`, 'PATCH', { alignStrength: 0.5 })).body.alignStrength, 0.5);
        assert.equal((await ctx.api(`/api/admin/sections/${section.id}`, 'PATCH', { alignStrength: 3 })).status, 400);
        assert.equal((await ctx.api(`/api/admin/sections/${section.id}`, 'PATCH', { alignStrength: 'abc' })).status, 400);
        const catalog = (await ctx.api('/api/admin/catalog', 'GET')).body;
        assert.equal(catalog.sections[0].alignStrength, 0.5);
        const preview = (await ctx.api('/api/admin/preview', 'POST', { section: section.id, messages: ['quiet scene here'] }));
        assert.equal(preview.status, 200);
        assert.equal(preview.body.aligned, false, 'no examples yet — nothing to align by');
    } finally { await ctx.stop(); }
});

test('the real pick shifts the scene vector by the section\'s alignment — strength 0 gives the old numbers, strength 1 different ones; the test pick says so', async () => {
    const ctx = await start();
    try {
        const section = (await ctx.api('/api/admin/sections', 'POST', { name: 'Moods', mode: 'groups' })).body;
        const text = length => 'x'.repeat(length);
        const a = (await ctx.api('/api/admin/groups', 'POST', { section: section.id, name: 'A', description: text(10) })).body;
        const b = (await ctx.api('/api/admin/groups', 'POST', { section: section.id, name: 'B', description: text(20) })).body;
        for (const group of [a, b]) await addAssigned(ctx.base, { Authorization: 'Bearer owner-secret' }, { section: section.id, group: group.id, title: group.name, bytes: Buffer.from('xx') });
        await ctx.api('/api/admin/examples', 'POST', { section: section.id, group: a.id, texts: Array.from({ length: 12 }, (_, n) => `${text(30 + n)} scene`) });
        const pick = async () => (await (await fetch(`${ctx.base}/api/pick`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: MODEL_ID, section: section.id, vector: await fakeEmbed(text(10)), minSimilarity: 0 }) })).json());
        const aligned = await pick();
        await ctx.api(`/api/admin/sections/${section.id}`, 'PATCH', { alignStrength: 0 });
        const plain = await pick();
        assert.equal(plain.action, 'play'); assert.equal(aligned.action, 'play');
        assert.notEqual(aligned.similarity, plain.similarity, 'the scene was shifted before it was compared');
        const preview = await ctx.api('/api/admin/preview', 'POST', { section: section.id, messages: [text(10)] });
        assert.equal(preview.body.aligned, false, 'strength 0 is off');
        await ctx.api(`/api/admin/sections/${section.id}`, 'PATCH', { alignStrength: 1 });
        assert.equal((await ctx.api('/api/admin/preview', 'POST', { section: section.id, messages: [text(10)] })).body.aligned, true);
        assert.equal((await ctx.api('/api/admin/preview', 'POST', { section: section.id, messages: [text(10)], align: false })).body.aligned, false, '"before" view for comparison');
    } finally { await ctx.stop(); }
});

// Псевдослучайный вектор от текста с общей «составляющей регистра» у сцен: непустые оценки, а не нули one-hot.
const randomEmbed = async text => {
    let seed = 7; for (const char of String(text)) seed = (Math.imul(seed, 31) + char.charCodeAt(0)) >>> 0;
    const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
    const raw = Array.from({ length: DIM }, next);
    const norm = Math.hypot(...raw);
    return raw.map(x => x / norm);
};

test('the test pick shifts the dictionary scenes together with the scene: the ranking equals what the library computes with both shifted', async () => {
    const ctx = await start({ embedWith: randomEmbed });
    try {
        const section = (await ctx.api('/api/admin/sections', 'POST', { name: 'Moods', mode: 'groups' })).body;
        const text = length => 'y'.repeat(length);
        const lengths = { a: 10, b: 20, c: 30 };
        const groups = {};
        for (const [key, length] of Object.entries(lengths)) {
            groups[key] = (await ctx.api('/api/admin/groups', 'POST', { section: section.id, name: key, description: text(length) })).body;
            await addAssigned(ctx.base, { Authorization: 'Bearer owner-secret' }, { section: section.id, group: groups[key].id, title: key, bytes: Buffer.from('xx') });
        }
        const exampleLengths = { a: [41, 42, 43, 44], b: [51, 52, 53, 54], c: [61, 62, 63, 64] };
        for (const [key, list] of Object.entries(exampleLengths)) await ctx.api('/api/admin/examples', 'POST', { section: section.id, group: groups[key].id, texts: list.map(length => text(length)) });
        const scene = text(12);
        const preview = (await ctx.api('/api/admin/preview', 'POST', { section: section.id, messages: [scene], minSimilarity: 0 })).body;
        assert.equal(preview.aligned, true);

        const tags = Object.entries(lengths).map(([key, length]) => ({ id: key, group: key, vector: [], length }));
        const vectorOf = async length => randomEmbed(text(length));
        const items = await Promise.all(tags.map(async tag => ({ id: tag.id, group: tag.group, vector: await vectorOf(tag.length), negVector: null })));
        const protoVectors = new Map(await Promise.all(Object.entries(exampleLengths).map(async ([key, list]) => [key, await Promise.all(list.map(vectorOf))])));
        const alignment = estimateAlignment({ sceneVectors: [...protoVectors.values()].flat(), tagVectors: items.map(item => item.vector) });
        const expected = scoreItems({ items, vector: shiftScene(await vectorOf(12), alignment), prototypes: shiftPrototypes(protoVectors, alignment) }).rows;
        const byLabel = Object.fromEntries(preview.ranking.map(row => [row.label, row.score]));
        for (const row of expected) assert.ok(Math.abs(byLabel[row.item.group] - row.value) < 1e-6, `${row.item.group}: server ${byLabel[row.item.group]} vs library ${row.value}`);
    } finally { await ctx.stop(); }
});
