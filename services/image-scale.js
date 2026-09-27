/**
 * Сервис масштабирования картинок — готовит аватарки нужного размера один раз, вместо того чтобы отдавать браузеру оригинал в
 * сотни пикселей и надеяться на его уменьшение. Причина: слои с `will-change: transform` (наша область чата) браузер растрирует
 * с самым дешёвым фильтром, и 900-пиксельная картинка, сжатая до ~130 физических пикселей, получалась рваной (лесенка на краях,
 * «до тех пор, пока не приблизишь» — при зуме слой перерастрируется). Плюс миниатюры ST (`/thumbnail?...`, 96×144) при DPR > 1
 * растягивались и мылились.
 *
 * `imageScale.toBlobUrl({ url, width, height })` — размеры в ФИЗИЧЕСКИХ пикселях; вернёт `blob:`-URL картинки, вписанной «cover»
 * (как `object-fit: cover`) и уменьшенной в высоком качестве, либо `null`, если что-то не вышло (тогда остаётся оригинал).
 * Результат кэшируется по `url|width|height`.
 */

/** Миниатюры ST → оригиналы: превью 96×144 для нашего размера слишком мелкое. */
export function avatarSourceUrl(url) {
    const text = String(url ?? '');
    const match = /^\/?thumbnail\?(.+)$/.exec(text);
    if (!match) return text;
    const params = new URLSearchParams(match[1]);
    const file = params.get('file');
    if (!file) return text;
    const type = params.get('type');
    if (type === 'persona') return `/User Avatars/${encodeURIComponent(file)}`;
    if (type === 'avatar') return `/characters/${encodeURIComponent(file)}`;
    return text;
}

/**
 * Лёгкая резкость после уменьшения (нерезкая маска 3×3): уменьшенная картинка всегда чуть мягче оригинала, и глаза/линии кажутся
 * чётче без роста разрешения. `amount` 0..1 — доля резкого ядра, подмешиваемая к исходным пикселям (0 — без изменений). Прозрачность
 * не трогается, края картинки копируются как есть. Меняет `data` (Uint8ClampedArray RGBA) на месте.
 */
export function sharpenImageData(data, width, height, amount = 0.35) {
    if (!(amount > 0) || width < 3 || height < 3) return data;
    const source = new Uint8ClampedArray(data);   // читаем из копии, пишем в data
    const at = (x, y, channel) => source[(y * width + x) * 4 + channel];
    for (let y = 1; y < height - 1; y += 1) {
        for (let x = 1; x < width - 1; x += 1) {
            const offset = (y * width + x) * 4;
            for (let channel = 0; channel < 3; channel += 1) {
                const center = source[offset + channel];
                const sharp = 5 * center - at(x - 1, y, channel) - at(x + 1, y, channel) - at(x, y - 1, channel) - at(x, y + 1, channel);
                data[offset + channel] = center + (sharp - center) * amount;
            }
        }
    }
    return data;
}

export function registerImageScaleService(servicesBus, {
    fetch: fetchImpl = globalThis.fetch?.bind(globalThis),
    createBitmap = (...args) => globalThis.createImageBitmap(...args),
    createCanvas = (width, height) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(globalThis.document.createElement('canvas'), { width, height })),
    createObjectUrl = blob => globalThis.URL.createObjectURL(blob),
    sharpen = 0.35,
} = {}) {
    const cache = new Map(); // key -> Promise<string|null>

    async function scale({ url, width, height }) {
        const source = avatarSourceUrl(url);
        let response = await fetchImpl(source);
        if (!response.ok && source !== url) response = await fetchImpl(url);   // оригинала нет — берём то, что дали
        if (!response.ok) return null;
        const blob = await response.blob();
        const bitmap = await createBitmap(blob);
        // cover: вырезаем из оригинала область нужных пропорций по центру-верху (лицо обычно выше центра), масштабируем сразу до цели.
        const targetRatio = width / height;
        const sourceRatio = bitmap.width / bitmap.height;
        let sw = bitmap.width;
        let sh = bitmap.height;
        if (sourceRatio > targetRatio) sw = Math.round(bitmap.height * targetRatio); else sh = Math.round(bitmap.width / targetRatio);
        const sx = Math.round((bitmap.width - sw) / 2);
        const sy = sourceRatio > targetRatio ? 0 : Math.round((bitmap.height - sh) * 0.25);
        const scaled = await createBitmap(bitmap, sx, sy, sw, sh, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
        const canvas = createCanvas(width, height);
        const context = canvas.getContext('2d');
        context.drawImage(scaled, 0, 0);
        if (sharpen > 0 && typeof context.getImageData === 'function') {
            const image = context.getImageData(0, 0, width, height);
            sharpenImageData(image.data, width, height, sharpen);
            context.putImageData(image, 0, 0);
        }
        const out = canvas.convertToBlob ? await canvas.convertToBlob({ type: 'image/png' }) : await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        bitmap.close?.();
        scaled.close?.();
        return out ? createObjectUrl(out) : null;
    }

    function toBlobUrl({ url, width, height } = {}) {
        if (!url || !(width > 0) || !(height > 0)) return null;
        const key = `${url}|${Math.round(width)}|${Math.round(height)}`;
        if (!cache.has(key)) cache.set(key, scale({ url, width: Math.round(width), height: Math.round(height) }).catch(() => null));
        return cache.get(key);
    }

    /**
     * Картинка-референс для генерации изображений: вписана целиком (без обрезки) в `maxSide`×`maxSide`, JPEG → `data:` URL. Облачные
     * бэкенды принимают референс только base64 и с лимитом размера (NanoGPT — 4 МБ после кодирования); 1024px JPEG — сотни килобайт.
     * Источник — `blob` или адрес ТОГО ЖЕ сервера (`/characters/…`, `/User Avatars/…`): чужие адреса не качаем. `null` — не вышло.
     */
    async function toDataUrl({ url, blob, maxSide = 1024, quality = 0.9 } = {}) {
        let source = blob ?? null;
        if (!source) {
            if (!isSameOriginPath(url)) return null;
            const response = await fetchImpl(avatarSourceUrl(url));
            if (!response.ok) return null;
            source = await response.blob();
        }
        const bitmap = await createBitmap(source);
        const { width, height } = fitInside(bitmap.width, bitmap.height, maxSide);
        const scaled = await createBitmap(bitmap, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
        const canvas = createCanvas(width, height);
        const context = canvas.getContext('2d');
        context.fillStyle = '#fff'; // у PNG с прозрачностью JPEG иначе дал бы чёрный фон
        context.fillRect(0, 0, width, height);
        context.drawImage(scaled, 0, 0);
        const out = canvas.convertToBlob ? await canvas.convertToBlob({ type: 'image/jpeg', quality }) : await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
        bitmap.close?.();
        scaled.close?.();
        return out ? blobToDataUrl(out) : null;
    }

    const unregisters = [
        servicesBus.register('imageScale.toBlobUrl', params => toBlobUrl(params), { loadMetric: () => 0 }),
        servicesBus.register('imageScale.toDataUrl', params => toDataUrl(params ?? {}).catch(() => null), { loadMetric: () => 1 }),
    ];
    return () => { for (const unregister of unregisters) unregister(); };
}

/** Только путь того же сервера: `/characters/a.png` — да; `https://…`, `//host/…`, `data:` — нет. */
export function isSameOriginPath(url) {
    const text = String(url ?? '');
    return text.startsWith('/') && !text.startsWith('//') || /^thumbnail\?/.test(text);
}

/** Размер, вписанный в квадрат `maxSide` с сохранением пропорций; меньшие картинки не увеличиваются. */
export function fitInside(width, height, maxSide) {
    const scale = Math.min(1, maxSide / Math.max(width, height));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

async function blobToDataUrl(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    const base64 = typeof btoa === 'function' ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64');
    return `data:${blob.type || 'image/jpeg'};base64,${base64}`;
}
