import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { createDiffusionCore, sanitizeImageWorker } from '../cores/models/diffusion.js';
import {
    buildImageRequest, resolveImageRequest, resolveImageResponse, resolveOpenAiSize, decodeBase64, readImageInfo,
    supportsReferences, referencePromptNote,
} from '../libraries/core/image-provider-request.js';
import { registerImageStoreService } from '../services/image-store.js';

/** Минимальный настоящий PNG 3×2 (заголовок + IHDR) — достаточно, чтобы `readImageInfo` прочитал тип и размер. */
function pngBytes(width, height) {
    const bytes = new Uint8Array(33);
    bytes.set([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(bytes.buffer).setUint32(16, width);
    new DataView(bytes.buffer).setUint32(20, height);
    return bytes;
}
const toBase64 = bytes => Buffer.from(bytes).toString('base64');

// --- Библиотека формата: чистые функции ---

test('resolveImageRequest clamps sizes to 64…2048 in steps of 8 and treats a missing or negative seed as random (-1)', () => {
    assert.deepEqual(resolveImageRequest({ prompt: ' a cat ', width: 5000, height: 13 }), {
        prompt: 'a cat', negativePrompt: '', width: 2048, height: 64, steps: 25, cfgScale: 7, seed: -1,
    });
    assert.equal(resolveImageRequest({ prompt: 'x', width: 1000 }).width, 1000);
    assert.equal(resolveImageRequest({ prompt: 'x', width: 1001 }).width, 1000);
    assert.equal(resolveImageRequest({ prompt: 'x', seed: 42 }).seed, 42);
});

test('OpenAI\'s own models get the nearest size from their fixed set; other models on an OpenAI-compatible gateway get exactly the requested size', () => {
    assert.equal(resolveOpenAiSize(1920, 1080, 'gpt-image-1'), '1536x1024');
    assert.equal(resolveOpenAiSize(768, 1024, 'dall-e-3'), '1024x1792');
    assert.equal(resolveOpenAiSize(512, 512, 'dall-e-2'), '256x256', 'dall-e-2 sizes are all square: the first one wins the tie');
    assert.equal(resolveOpenAiSize(1024, 768, 'qwen-image-2.1/text-to-image'), '1024x768');
});

test('an OpenAI-compatible gateway (NanoGPT) is asked for base64, so no second download from its CDN is needed', () => {
    const built = buildImageRequest(
        { format: 'openai', endpoint: 'https://nano-gpt.com/api/v1', apiKey: 'k', model: 'qwen-image-2.1/text-to-image' },
        resolveImageRequest({ prompt: 'A serene mountain landscape at sunset.', width: 1024, height: 1024 }),
    );
    assert.equal(built.url, 'https://nano-gpt.com/api/v1/images/generations');
    assert.equal(built.headers.Authorization, 'Bearer k');
    assert.deepEqual(JSON.parse(built.body), { model: 'qwen-image-2.1/text-to-image', prompt: 'A serene mountain landscape at sunset.', n: 1, size: '1024x1024', response_format: 'b64_json' });
});

test('pollinations is a keyless GET returning the image itself; the prompt is URL-encoded into the path', () => {
    const built = buildImageRequest({ format: 'pollinations' }, resolveImageRequest({ prompt: 'red fox / snow', width: 512, height: 768, seed: 7 }));
    assert.equal(built.method, 'GET');
    assert.equal(built.responseType, 'blob');
    assert.match(built.url, /^https:\/\/image\.pollinations\.ai\/prompt\/red%20fox%20%2F%20snow\?/);
    assert.match(built.url, /width=512&height=768&nologo=true&seed=7/);
});

test('openai asks for base64 from everything but gpt-image (which rejects response_format), a1111 sends Basic auth for user:pass keys', () => {
    const request = resolveImageRequest({ prompt: 'p', width: 1024, height: 1024 });
    assert.equal(JSON.parse(buildImageRequest({ format: 'openai', model: 'dall-e-3', apiKey: 'k' }, request).body).response_format, 'b64_json');
    assert.equal(JSON.parse(buildImageRequest({ format: 'openai', apiKey: 'k' }, request).body).response_format, undefined);
    const a1111 = buildImageRequest({ format: 'a1111', endpoint: 'http://host:7860/', apiKey: 'user:pass', model: 'sdxl' }, request);
    assert.equal(a1111.url, 'http://host:7860/sdapi/v1/txt2img');
    assert.equal(a1111.headers.Authorization, `Basic ${Buffer.from('user:pass').toString('base64')}`);
    assert.deepEqual(JSON.parse(a1111.body).override_settings, { sd_model_checkpoint: 'sdxl' });
});

test('responses: base64 from openai/a1111 (data: prefix stripped), a url from openai-compatible servers, a clear error when there is no image', () => {
    assert.deepEqual(resolveImageResponse('openai', { text: '{"data":[{"b64_json":"QUJD"}]}' }), { kind: 'base64', data: 'QUJD' });
    assert.deepEqual(resolveImageResponse('openai', { text: '{"data":[{"url":"https://x/y.png"}]}' }), { kind: 'url', url: 'https://x/y.png' });
    assert.deepEqual(resolveImageResponse('a1111', { text: '{"images":["data:image/png;base64,QUJD"]}' }), { kind: 'base64', data: 'QUJD' });
    assert.throws(() => resolveImageResponse('openai', { text: '{"error":{"message":"Your prompt was rejected"}}' }), /rejected/);
    assert.throws(() => resolveImageResponse('a1111', { text: '<html>' }), /not JSON/);
});

test('readImageInfo reads type and real size from PNG and JPEG bytes', () => {
    assert.deepEqual(readImageInfo(pngBytes(640, 480)), { mime: 'image/png', width: 640, height: 480 });
    const jpeg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0, 0, 0xFF, 0xC0, 0x00, 0x11, 0x08, 0x01, 0xE0, 0x02, 0x80, 0x03]);
    assert.deepEqual(readImageInfo(jpeg), { mime: 'image/jpeg', width: 640, height: 480 });
    assert.deepEqual([...decodeBase64('QUJD')], [65, 66, 67]);
});

test('sanitizeImageWorker drops entries without an id and normalises the format', () => {
    assert.equal(sanitizeImageWorker({ name: 'x' }), null);
    assert.equal(sanitizeImageWorker({ id: 'a', format: 'weird' }).format, 'pollinations');
});

// --- Ядро: настоящий движок, фейковые только HTTP и хранилище ---

function buildCore({ respond, scaled }) {
    const engine = createEngine();
    const stored = new Map();
    const httpCalls = [];
    const scaleCalls = [];
    engine.buses.services.register('imageScale.toDataUrl', params => { scaleCalls.push(params); const custom = scaled?.(params); return custom !== undefined ? custom : `data:image/jpeg;base64,REF${scaleCalls.length}`; });
    engine.buses.services.register('image.get', ({ id }) => stored.get(id) ?? null);
    engine.buses.network.register('http.request', async params => { httpCalls.push(params); return respond(params, httpCalls.length); });
    engine.buses.services.register('image.put', ({ id, blob }) => { stored.set(id, blob); return id; });
    engine.buses.cores.register('storage.settings.get', ({ fallback }) => fallback);
    engine.buses.cores.register('storage.settings.set', () => true);
    const host = engine.registerCaller('core.models.diffusion', 'cores', { tier: 'official', networkAccess: true });
    const events = [];
    const core = createDiffusionCore(host, { publish: (event, payload) => events.push([event, payload]), workerWaitMs: 5, now: () => 1000 });
    const client = engine.registerCaller('module.probe', 'modules', { tier: 'community', allowedContracts: ['image.generate', 'image.workers.get'] });
    const call = (contract, params) => new Promise(resolve => client.cores.subscribe(contract, { params }, resolve));
    return { core, call, stored, httpCalls, events, scaleCalls };
}

test('image.generate stores the image and hands the module only an asset id and the REAL size read from the bytes', async () => {
    const { core, call, stored, events } = buildCore({ respond: () => ({ ok: true, status: 200, text: JSON.stringify({ images: [toBase64(pngBytes(832, 1216))] }) }) });
    await core.configureWorkers([{ id: 'sd', format: 'a1111' }]);
    const result = await call('image.generate', { prompt: 'a lighthouse', width: 1024, height: 1024 });
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(result.value.assetId, `diffusion:1000-${result.value.requestId}`);
    assert.deepEqual([result.value.mime, result.value.width, result.value.height], ['image/png', 832, 1216]);
    assert.equal(stored.get(result.value.assetId).type, 'image/png');
    assert.deepEqual(events.map(([event]) => event).filter(event => event !== 'image.workers.changed'), ['image.generate.started', 'image.generate.finished']);
});

test('a failing backend falls through to the next one in fallbackWorkerIds, with a retrying event naming both', async () => {
    const { core, call, events } = buildCore({
        respond: params => (params.url.includes('bad')
            ? { ok: false, status: 500, text: 'CUDA out of memory' }
            : { ok: true, status: 200, blob: new Blob([pngBytes(8, 8)]) }),
    });
    await core.configureWorkers([{ id: 'bad', format: 'a1111', endpoint: 'http://bad' }, { id: 'free', format: 'pollinations' }]);
    const result = await call('image.generate', { prompt: 'x', workerId: 'bad', fallbackWorkerIds: ['free'] });
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(result.value.workerId, 'free');
    const retry = events.find(([event]) => event === 'image.generate.retrying')[1];
    assert.equal(retry.failedWorkerId, 'bad');
    assert.match(retry.reason, /HTTP 500: CUDA out of memory/);
});

test('an openai-compatible server that answers with a url gets a second request for the image itself', async () => {
    const { core, call, httpCalls } = buildCore({
        respond: (params, index) => (index === 1 ? { ok: true, status: 200, text: '{"data":[{"url":"https://cdn/x.png"}]}' } : { ok: true, status: 200, blob: new Blob([pngBytes(4, 4)]) }),
    });
    await core.configureWorkers([{ id: 'o', format: 'openai', apiKey: 'k' }]);
    const result = await call('image.generate', { prompt: 'x' });
    assert.equal(result.ok, true, result.error?.message);
    assert.deepEqual(httpCalls.map(entry => [entry.url, entry.responseType ?? null]), [['https://api.openai.com/v1/images/generations', null], ['https://cdn/x.png', 'blob']]);
});

test('no configured backend and an empty prompt are reported as errors, not hangs', async () => {
    const { call } = buildCore({ respond: () => ({ ok: true, status: 200, text: '{}' }) });
    assert.match((await call('image.generate', { prompt: 'x' })).error.message, /No image backends/);
    assert.match((await call('image.generate', { prompt: '  ' })).error.message, /prompt/);
});

test('a backend returning something that is not an image fails with a clear message', async () => {
    const { core, call } = buildCore({ respond: () => ({ ok: true, status: 200, blob: new Blob(['<html>rate limited</html>']) }) });
    await core.configureWorkers([{ id: 'p', format: 'pollinations' }]);
    assert.match((await call('image.generate', { prompt: 'x' })).error.message, /not an image/);
});

// --- Сервис хранилища: адрес для показа ---

test('image.url gives one object URL per stored image until it is revoked, and null for a missing image', async () => {
    const engine = createEngine();
    const created = [];
    const revoked = [];
    registerImageStoreService(engine.buses.services, {
        getBlob: async id => (id === 'a' ? new Blob(['x']) : undefined),
        createObjectUrl: () => { created.push(`blob:${created.length}`); return created.at(-1); },
        revokeObjectUrl: url => revoked.push(url),
    });
    const client = engine.registerCaller('core.probe', 'cores', { tier: 'official' });
    const call = (contract, params) => new Promise(resolve => client.services.subscribe(contract, { params }, resolve));
    assert.equal((await call('image.url', { id: 'a' })).value, 'blob:0');
    assert.equal((await call('image.url', { id: 'a' })).value, 'blob:0', 'the same URL again, not a new one per repaint');
    assert.equal((await call('image.url', { id: 'missing' })).value, null);
    await call('image.revokeUrl', { id: 'a' });
    assert.deepEqual(revoked, ['blob:0']);
    assert.equal((await call('image.url', { id: 'a' })).value, 'blob:1');
});

// --- Референсы (фото персонажей как основа) ---

test('references are on automatically for a NanoGPT backend, off for OpenAI itself and for other formats, and can be forced either way', () => {
    assert.equal(supportsReferences({ format: 'openai', endpoint: 'https://nano-gpt.com/api/v1' }), true);
    assert.equal(supportsReferences({ format: 'openai', endpoint: 'https://api.openai.com/v1' }), false);
    assert.equal(supportsReferences({ format: 'openai', endpoint: 'https://api.openai.com/v1', references: 'on' }), true);
    assert.equal(supportsReferences({ format: 'openai', endpoint: 'https://nano-gpt.com/api/v1', references: 'off' }), false);
    assert.equal(supportsReferences({ format: 'a1111', references: 'on' }), false);
});

test('one reference goes as imageDataUrl, several as imageDataUrls, in the same generations request', () => {
    const worker = { format: 'openai', endpoint: 'https://nano-gpt.com/api/v1', model: 'nano-banana' };
    const request = resolveImageRequest({ prompt: 'x' });
    assert.equal(JSON.parse(buildImageRequest(worker, request, { referenceDataUrls: ['data:a'] }).body).imageDataUrl, 'data:a');
    assert.deepEqual(JSON.parse(buildImageRequest(worker, request, { referenceDataUrls: ['data:a', 'data:b'] }).body).imageDataUrls, ['data:a', 'data:b']);
    assert.equal(JSON.parse(buildImageRequest(worker, request).body).imageDataUrl, undefined);
});

test('the prompt note ties each reference picture to a name and takes only identity from it — expression, pose and clothing follow the scene', () => {
    const note = referencePromptNote(['Alice', 'Bob']);
    assert.match(note, /^Reference images: 1 — Alice, 2 — Bob\. Use them only for who each character is/);
    assert.match(note, /Expression, pose and clothing follow the description above, not the photos/);
    assert.equal(referencePromptNote(['', '']), '');
});

test('image.generate shrinks the references and sends them with a naming note to a backend that accepts them', async () => {
    const { core, call, httpCalls, scaleCalls } = buildCore({ respond: () => ({ ok: true, status: 200, text: JSON.stringify({ data: [{ b64_json: toBase64(pngBytes(8, 8)) }] }) }) });
    await core.configureWorkers([{ id: 'nano', format: 'openai', endpoint: 'https://nano-gpt.com/api/v1', model: 'nano-banana' }]);

    const result = await call('image.generate', { prompt: 'two friends at a campfire', references: [{ url: '/characters/alice.png', label: 'Alice' }, { url: '/characters/bob.png', label: 'Bob' }] });

    assert.equal(result.ok, true, result.error?.message);
    assert.equal(result.value.referencesUsed, 2);
    assert.deepEqual(scaleCalls.map(params => params.url), ['/characters/alice.png', '/characters/bob.png']);
    const body = JSON.parse(httpCalls[0].body);
    assert.deepEqual(body.imageDataUrls, ['data:image/jpeg;base64,REF1', 'data:image/jpeg;base64,REF2']);
    assert.match(body.prompt, /^two friends at a campfire\. Reference images: 1 — Alice, 2 — Bob/);
});

test('a backend without reference support gets a plain request, and the avatars are not even read', async () => {
    const { core, call, httpCalls, scaleCalls } = buildCore({ respond: () => ({ ok: true, status: 200, text: JSON.stringify({ images: [toBase64(pngBytes(8, 8))] }) }) });
    await core.configureWorkers([{ id: 'sd', format: 'a1111' }]);

    const result = await call('image.generate', { prompt: 'a campfire', references: [{ url: '/characters/alice.png', label: 'Alice' }] });

    assert.equal(result.value.referencesUsed, 0);
    assert.equal(scaleCalls.length, 0);
    assert.doesNotMatch(JSON.parse(httpCalls[0].body).prompt, /Reference/);
});

test('a reference that cannot be read is dropped instead of failing the picture', async () => {
    const { core, call, httpCalls } = buildCore({
        respond: () => ({ ok: true, status: 200, text: JSON.stringify({ data: [{ b64_json: toBase64(pngBytes(8, 8)) }] }) }),
        scaled: params => (params.url === '/characters/missing.png' ? null : undefined),
    });
    await core.configureWorkers([{ id: 'nano', format: 'openai', endpoint: 'https://nano-gpt.com/api/v1' }]);

    const result = await call('image.generate', { prompt: 'x', references: [{ url: '/characters/missing.png', label: 'Ghost' }, { url: '/characters/a.png', label: 'Alice' }] });

    assert.equal(result.value.referencesUsed, 1);
    assert.equal(JSON.parse(httpCalls[0].body).imageDataUrl, 'data:image/jpeg;base64,REF2');
});
