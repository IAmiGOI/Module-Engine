/**
 * Формат запроса/ответа провайдеров генерации изображений — чистые функции, без сети (как `provider-request.js` у текстовых моделей):
 * настоящий HTTP делает Сервис HTTP через Гейт сети, байты кладёт Сервис хранилища картинок.
 *
 * Форматы:
 * - **pollinations** — `GET {endpoint}/prompt/{prompt}?width&height&seed&model&nologo` → сама картинка. Без ключа: годится попробовать
 *   модуль сразу, ничего не настраивая.
 * - **openai** — `POST {endpoint}/images/generations` (DALL·E, gpt-image и совместимые). Размеры у OpenAI — из фиксированного набора, берётся
 *   ближайший по пропорции. `response_format: b64_json` только у `dall-e-*`: gpt-image всегда отдаёт base64 и на этот параметр отвечает
 *   ошибкой. Совместимые серверы иногда отдают `url` вместо base64 — тогда картинку забирает вторым запросом Ядро.
 * - **a1111** — `POST {endpoint}/sdapi/v1/txt2img` (Automatic1111, Forge, SD.Next): base64 PNG в `images[0]`. Ключ вида `user:pass` —
 *   Basic-авторизация (`--api-auth`).
 */

const FORMATS = Object.freeze(['pollinations', 'openai', 'a1111']);
const DEFAULT_ENDPOINTS = Object.freeze({ pollinations: 'https://image.pollinations.ai', openai: 'https://api.openai.com/v1', a1111: 'http://127.0.0.1:7860' });
const MIN_SIDE = 64;
const MAX_SIDE = 2048;
const OPENAI_SIZES = Object.freeze({
    'dall-e-3': ['1024x1024', '1792x1024', '1024x1792'],
    'dall-e-2': ['256x256', '512x512', '1024x1024'],
    default: ['1024x1024', '1536x1024', '1024x1536'],
});

export function resolveImageFormat(format) {
    return FORMATS.includes(format) ? format : 'pollinations';
}

function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

/** Защитное чтение параметров генерации: стороны кратны 8 в пределах 64…2048, шаги 1…150, CFG 1…30, зерно −1 = случайное. */
export function resolveImageRequest(params = {}) {
    const side = (value, fallback) => Math.round(clampNumber(value, MIN_SIDE, MAX_SIDE, fallback) / 8) * 8;
    return {
        prompt: String(params.prompt ?? '').trim(),
        negativePrompt: String(params.negativePrompt ?? '').trim(),
        width: side(params.width, 1024),
        height: side(params.height, 1024),
        steps: Math.round(clampNumber(params.steps, 1, 150, 25)),
        cfgScale: clampNumber(params.cfgScale, 1, 30, 7),
        seed: Number.isInteger(params.seed) && params.seed >= 0 ? params.seed : -1,
    };
}

/** Ближайший по пропорции из размеров, которые принимает модель OpenAI. */
export function resolveOpenAiSize(width, height, model = '') {
    const sizes = OPENAI_SIZES[Object.keys(OPENAI_SIZES).find(key => String(model).startsWith(key))] ?? OPENAI_SIZES.default;
    const wanted = Math.log(width / height);
    let best = sizes[0];
    for (const size of sizes) {
        const [w, h] = size.split('x').map(Number);
        if (Math.abs(Math.log(w / h) - wanted) < Math.abs(Math.log(Number(best.split('x')[0]) / Number(best.split('x')[1])) - wanted)) best = size;
    }
    return best;
}

function trimSlash(url) {
    return String(url ?? '').replace(/\/+$/, '');
}

function toBase64(text) {
    return typeof btoa === 'function' ? btoa(text) : Buffer.from(text, 'utf8').toString('base64');
}

/**
 * `worker` = `{ format, endpoint, apiKey, model }`, `request` — из `resolveImageRequest`. Возвращает `{ url, method, headers, body,
 * responseType }` для `http.request`: `responseType: 'blob'`, когда ответ — сама картинка.
 */
export function buildImageRequest(worker, request) {
    const format = resolveImageFormat(worker?.format);
    const endpoint = trimSlash(worker?.endpoint) || DEFAULT_ENDPOINTS[format];
    const apiKey = String(worker?.apiKey ?? '').trim();
    if (format === 'pollinations') {
        const query = new URLSearchParams({ width: String(request.width), height: String(request.height), nologo: 'true' });
        if (request.seed >= 0) query.set('seed', String(request.seed));
        if (worker?.model) query.set('model', worker.model);
        if (request.negativePrompt) query.set('negative_prompt', request.negativePrompt);
        return {
            url: `${endpoint}/prompt/${encodeURIComponent(request.prompt)}?${query}`,
            method: 'GET',
            headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
            responseType: 'blob',
        };
    }
    if (format === 'openai') {
        const model = worker?.model || 'gpt-image-1';
        const body = { model, prompt: request.prompt, n: 1, size: resolveOpenAiSize(request.width, request.height, model) };
        if (model.startsWith('dall-e')) body.response_format = 'b64_json';
        return {
            url: `${endpoint}/images/generations`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
            body: JSON.stringify(body),
        };
    }
    const body = {
        prompt: request.prompt, negative_prompt: request.negativePrompt, width: request.width, height: request.height,
        steps: request.steps, cfg_scale: request.cfgScale, seed: request.seed, batch_size: 1, n_iter: 1,
    };
    if (worker?.model) body.override_settings = { sd_model_checkpoint: worker.model };
    return {
        url: `${endpoint}/sdapi/v1/txt2img`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: apiKey.includes(':') ? `Basic ${toBase64(apiKey)}` : `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify(body),
    };
}

/**
 * Ответ провайдера → `{ kind: 'blob' }` (картинка уже в `blob` ответа), `{ kind: 'base64', data }` или `{ kind: 'url', url }`.
 * Бросает с понятным текстом, если картинки в ответе нет.
 */
export function resolveImageResponse(format, response) {
    const resolved = resolveImageFormat(format);
    if (resolved === 'pollinations') {
        if (response?.blob) return { kind: 'blob' };
        throw new Error('The image service answered without an image.');
    }
    let json;
    try { json = JSON.parse(response?.text ?? ''); } catch { throw new Error('The image service answered with something that is not JSON.'); }
    if (resolved === 'openai') {
        const first = json?.data?.[0];
        if (first?.b64_json) return { kind: 'base64', data: first.b64_json };
        if (first?.url) return { kind: 'url', url: first.url };
        throw new Error(json?.error?.message ?? 'The image service returned no image.');
    }
    const image = json?.images?.[0];
    if (typeof image === 'string' && image) return { kind: 'base64', data: image.replace(/^data:image\/\w+;base64,/, '') };
    throw new Error(json?.error ?? json?.detail ?? 'The image service returned no image.');
}

export function decodeBase64(data) {
    const binary = typeof atob === 'function' ? atob(String(data)) : Buffer.from(String(data), 'base64').toString('binary');
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

/** Тип и размер картинки по её собственным байтам (PNG, JPEG, WebP): провайдер может отдать не тот размер, что просили. */
export function readImageInfo(bytes) {
    const b = bytes;
    const u32 = offset => ((b[offset] << 24) | (b[offset + 1] << 16) | (b[offset + 2] << 8) | b[offset + 3]) >>> 0;
    const u16 = offset => (b[offset] << 8) | b[offset + 1];
    const le16 = offset => b[offset] | (b[offset + 1] << 8);
    if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return { mime: 'image/png', width: u32(16), height: u32(20) };
    if (b.length > 4 && b[0] === 0xFF && b[1] === 0xD8) {
        for (let offset = 2; offset + 9 < b.length;) {
            if (b[offset] !== 0xFF) { offset += 1; continue; }
            const marker = b[offset + 1];
            const length = u16(offset + 2);
            if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) return { mime: 'image/jpeg', width: u16(offset + 7), height: u16(offset + 5) };
            offset += 2 + length;
        }
        return { mime: 'image/jpeg', width: 0, height: 0 };
    }
    if (b.length > 30 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') {
        const chunk = String.fromCharCode(...b.slice(12, 16));
        if (chunk === 'VP8X') return { mime: 'image/webp', width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
        if (chunk === 'VP8L') { const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return { mime: 'image/webp', width: (bits & 0x3FFF) + 1, height: ((bits >> 14) & 0x3FFF) + 1 }; }
        if (chunk === 'VP8 ') return { mime: 'image/webp', width: le16(26) & 0x3FFF, height: le16(28) & 0x3FFF };
        return { mime: 'image/webp', width: 0, height: 0 };
    }
    return { mime: 'application/octet-stream', width: 0, height: 0 };
}
