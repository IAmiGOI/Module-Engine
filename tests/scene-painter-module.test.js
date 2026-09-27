import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { request } from '../libraries/shared/request.js';
import { createDiffusionCore } from '../cores/models/diffusion.js';
import {
    createScenePainterModule, sanitizeImagePrompt, buildSceneTranscript, buildFinalPrompt, sanitizeSettings, buildReferences, MODULE_ID,
} from '../modules/scene-painter/index.js';

/** Те же права, что у определения Модуля в harness/engine-wiring.js: Модуль ходит через настоящий Гейт, как чужой. */
const RIGHTS = {
    tier: 'community',
    allowedContracts: [
        'storage.settings.get', 'storage.settings.set', 'ui.notify',
        'chatHistory.messages', 'chatHistory.annotate', 'chatHistory.annotations',
        'model.generate', 'model.workers.get', 'image.generate', 'image.workers.get', 'image.workers.set',
        'ui.picture.show', 'image.delete',
        'stCharacter.avatars',
        'ui.messageFooter.claim', 'ui.messageFooter.release', 'ui.messageFooter.attach',
    ],
};

function png(width, height) {
    const bytes = new Uint8Array(33);
    bytes.set([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(bytes.buffer).setUint32(16, width);
    new DataView(bytes.buffer).setUint32(20, height);
    return bytes;
}

const CHAT = [
    { mesid: '0', name: 'Alice', isUser: true, isSystem: false, text: 'We reach the lighthouse at dusk.' },
    { mesid: '1', name: 'Keeper', isUser: false, isSystem: false, text: '<p>The keeper lifts his <em>lantern</em>.</p>' },
    { mesid: '2', name: 'Alice', isUser: true, isSystem: false, text: 'Later message that must not be in the scene of #1.' },
];

async function build({ generate = async () => 'Prompt: "an old keeper with a lantern on a cliff, dusk"', httpFails = false, takenFooterSlots = [], workers = [{ id: 'free', format: 'pollinations' }], avatars = null } = {}) {
    const engine = createEngine();
    const calls = { generate: [], http: [], annotate: [], notify: [], attach: 0, deleted: [], stored: new Map(), shown: [] };
    const annotations = {};
    const settings = new Map();
    engine.buses.cores.register('storage.settings.get', ({ namespace, key, fallback }) => settings.get(`${namespace}/${key}`) ?? fallback);
    engine.buses.cores.register('storage.settings.set', ({ namespace, key, value }) => { settings.set(`${namespace}/${key}`, value); return true; });
    engine.buses.cores.register('ui.notify', params => { calls.notify.push(params); return true; });
    engine.buses.cores.register('chatHistory.messages', ({ limit }) => CHAT.slice(-limit));
    engine.buses.cores.register('chatHistory.annotate', ({ mesid, value }) => { calls.annotate.push({ mesid, value }); if (value === null) delete annotations[mesid]; else annotations[mesid] = value; return true; });
    engine.buses.cores.register('chatHistory.annotations', () => ({ ...annotations }));
    engine.buses.cores.register('model.generate', params => { calls.generate.push(params); return generate(params); });
    engine.buses.cores.register('model.workers.get', () => [{ id: 'fast', name: 'Fast' }]);
    const takenSlots = new Set(takenFooterSlots);
    engine.buses.cores.register('ui.messageFooter.claim', ({ slot, node }) => {
        if (takenSlots.has(slot)) throw new Error(`slot "${slot}" is already taken`);
        calls.footer = node;
        calls.footerSlot = slot;
        return slot;
    });
    engine.buses.cores.register('ui.messageFooter.release', () => true);
    engine.buses.cores.register('ui.picture.show', params => { calls.shown.push(params); return true; });
    engine.buses.cores.register('ui.messageFooter.attach', () => { calls.attach += 1; return true; });
    engine.buses.services.register('image.put', ({ id, blob }) => { calls.stored.set(id, blob); return id; });
    engine.buses.services.register('image.url', ({ id }) => (calls.stored.has(id) ? `blob:${id}` : null));
    engine.buses.services.register('image.revokeUrl', () => true);
    engine.buses.services.register('image.delete', ({ id }) => { calls.deleted.push(id); calls.stored.delete(id); return true; });
    calls.avatarReads = 0;
    engine.buses.services.register('stCharacter.avatars', () => { calls.avatarReads += 1; return avatars ?? { characters: [], persona: null }; });
    engine.buses.services.register('imageScale.toDataUrl', ({ url }) => `data:image/jpeg;base64,${Buffer.from(url).toString('base64')}`);
    engine.buses.network.register('http.request', params => {
        calls.http.push(params);
        if (httpFails) return { ok: false, status: 503, text: 'busy' };
        return params.method === 'POST'
            ? { ok: true, status: 200, text: JSON.stringify({ data: [{ b64_json: Buffer.from(png(1024, 768)).toString('base64') }] }) }
            : { ok: true, status: 200, blob: new Blob([png(1024, 768)]) };
    });
    let clock = 0;
    const diffusion = createDiffusionCore(engine.registerCaller('core.models.diffusion', 'cores', { tier: 'official', networkAccess: true }), { publish: () => {}, workerWaitMs: 5, now: () => (clock += 1) });
    await diffusion.configureWorkers(workers);
    const host = engine.registerCaller(MODULE_ID, 'modules', RIGHTS);
    const module = createScenePainterModule(host);
    await module.load();
    return { engine, host, module, calls, annotations };
}

test('sanitizeImagePrompt strips "Prompt:", quotes, code fences and line breaks; buildFinalPrompt appends the style', () => {
    assert.equal(sanitizeImagePrompt('```\nPrompt: "a red fox,\n snow"\n```'), 'a red fox, snow');
    assert.equal(buildFinalPrompt('a fox', ' watercolor '), 'a fox, watercolor');
    assert.equal(buildFinalPrompt('a fox', ''), 'a fox');
});

test('the scene transcript takes the last N messages UP TO the painted one, names first, HTML removed', () => {
    assert.equal(buildSceneTranscript(CHAT, '1', 6), 'Alice: We reach the lighthouse at dusk.\n\nKeeper: The keeper lifts his lantern .');
    assert.equal(buildSceneTranscript(CHAT, '1', 1), 'Keeper: The keeper lifts his lantern .');
});

test('sanitizeSettings turns junk from disk into valid values', () => {
    const clean = sanitizeSettings({ contextMessages: 999, width: 'x', autoPaint: 'yes', style: 5 });
    assert.deepEqual([clean.contextMessages, clean.width, clean.autoPaint, typeof clean.style], [20, 1024, false, 'string']);
});

test('Paint: a text model writes the prompt from the scene, the diffusion core draws it, the picture is attached to the message — its text untouched', async () => {
    const { module, calls, annotations } = await build();
    assert.equal(await module.paint('1'), true);
    assert.equal(calls.generate.length, 1);
    assert.match(calls.generate[0].prompt, /Keeper: The keeper lifts/);
    assert.doesNotMatch(calls.generate[0].prompt, /Later message/, 'nothing after the painted message goes into its scene');
    assert.equal(calls.http.length, 1, 'the image request went out through the diffusion core');
    assert.match(decodeURIComponent(calls.http[0].url), /an old keeper with a lantern on a cliff, dusk, detailed digital painting/);
    const entry = annotations['1'];
    assert.deepEqual([entry.width, entry.height], [1024, 768]);
    assert.ok(calls.stored.has(entry.assetId));
    assert.equal(module.images.peek()['1'].assetId, entry.assetId);
    assert.ok(calls.attach >= 3, 'the footer is refreshed while writing, while painting and when done');
    assert.deepEqual(calls.shown, [{ assetId: entry.assetId, caption: entry.prompt }], 'the picture goes to the engine\'s Picture window, with the prompt as its caption');
});

test('with "open the Picture window" off the picture waits under its reply; 🖼 Show puts it into the window on demand', async () => {
    const { module, calls, annotations } = await build();
    await module.saveSettings({ ...module.settings.peek(), openWindow: false });
    await module.paint('1');
    assert.deepEqual(calls.shown, []);
    assert.equal(await module.showInWindow('1'), true);
    assert.deepEqual(calls.shown, [{ assetId: annotations['1'].assetId, caption: annotations['1'].prompt }]);
    assert.equal(await module.showInWindow('0'), false, 'no picture under this message: nothing to show');
});

test('"Paint again with the same prompt" skips the text model and deletes the previous picture', async () => {
    const { module, calls, annotations } = await build();
    await module.paint('1');
    const first = annotations['1'];
    await module.paint('1', { prompt: first.prompt });
    assert.equal(calls.generate.length, 1);
    assert.notEqual(annotations['1'].assetId, first.assetId);
    assert.deepEqual(calls.deleted, [first.assetId]);
});

test('a failing image backend leaves no half-state: error shown, notification sent, nothing annotated', async () => {
    const { module, calls, annotations } = await build({ httpFails: true });
    assert.equal(await module.paint('1'), false);
    assert.equal(annotations['1'], undefined);
    assert.match(calls.notify[0].text, /HTTP 503/);
    assert.equal(calls.generate.length, 1);
});

test('autoPaint paints only after a reply of the model, never after the user\'s own message', async () => {
    const { module, calls } = await build();
    await module.saveSettings({ ...module.settings.peek(), autoPaint: true });
    await module.onGenerationCompleted();
    assert.equal(calls.generate.length, 0, 'the last message (#2) is the user\'s');
    CHAT.push({ mesid: '3', name: 'Keeper', isUser: false, isSystem: false, text: 'The lamp flares.' });
    try {
        await module.onGenerationCompleted();
        assert.equal(calls.generate.length, 1);
        assert.ok(module.images.peek()['3']);
    } finally {
        CHAT.pop();
    }
});

test('the module has no network of its own: a direct http.request through its host is refused by the Gate', async () => {
    const { host } = await build();
    const result = await request(host.network, 'http.request', { params: { url: 'https://example.com' } });
    assert.equal(result.ok, false);
});

test('the settings form and the footer widget build; the footer stays empty under the user\'s own messages', async () => {
    const { module, calls } = await build();
    assert.ok(module.tree(), 'settings form');
    assert.equal(calls.footer({ mesid: '0', isUser: true, isSystem: false }), null);
    assert.ok(calls.footer({ mesid: '1', isUser: false, isSystem: false }), 'the footer factory given to ui.messageFooter.claim draws under replies');
});

test('a footer slot taken by another module is skipped for the next free one; with all three taken the user is told', async () => {
    assert.equal((await build({ takenFooterSlots: ['right'] })).calls.footerSlot, 'center');
    const { calls } = await build({ takenFooterSlots: ['right', 'center', 'left'] });
    assert.equal(calls.footerSlot, undefined);
    assert.match(calls.notify.at(-1).text, /footer slots are taken/);
});

// --- Фото персонажей как основа ---

const AVATARS = { characters: [{ name: 'Keeper', url: '/characters/keeper.png' }], persona: { name: 'Alice', url: '/User Avatars/alice.png' } };
const NANO = [{ id: 'nano', format: 'openai', endpoint: 'https://nano-gpt.com/api/v1', model: 'nano-banana' }];

test('buildReferences takes the characters, and the persona only when asked', () => {
    assert.deepEqual(buildReferences(AVATARS), [{ url: '/characters/keeper.png', label: 'Keeper' }]);
    assert.equal(buildReferences(AVATARS, { includePersona: true }).at(-1).label, 'Alice');
    assert.deepEqual(buildReferences(null), []);
});

test('with a NanoGPT backend the character avatar goes along as a reference and the prompt writer names the character instead of describing its looks', async () => {
    const { module, calls, annotations } = await build({ workers: NANO, avatars: AVATARS });

    assert.equal(await module.paint('1'), true);

    assert.match(calls.generate[0].systemPrompt, /reference photos of: Keeper\. Call these characters by name/);
    const body = JSON.parse(calls.http[0].body);
    assert.equal(body.imageDataUrl, `data:image/jpeg;base64,${Buffer.from('/characters/keeper.png').toString('base64')}`);
    assert.match(body.prompt, /Reference images: 1 — Keeper/);
    assert.equal(annotations['1'].references, 1);
});

test('a backend that cannot take references never makes the module read avatars or change the prompt writer\'s instruction', async () => {
    const { module, calls } = await build({ avatars: AVATARS });

    await module.paint('1');

    assert.equal(calls.avatarReads, 0);
    assert.doesNotMatch(calls.generate[0].systemPrompt, /reference photos/);
});

test('turning references off sends a plain request even to NanoGPT', async () => {
    const { module, calls } = await build({ workers: NANO, avatars: AVATARS });
    await module.saveSettings({ ...module.settings.peek(), useReferences: false });

    await module.paint('1');

    assert.equal(JSON.parse(calls.http[0].body).imageDataUrl, undefined);
});
