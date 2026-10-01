import { computeAvatarCrop, isAvatarImageUrl, isDecodableImageType, AVATAR_WIDTH, AVATAR_HEIGHT, MAX_IMAGE_BYTES } from '../libraries/core/character-avatar.js';

/**
 * Сервис аватара персонажа ST — единственное место, которое скачивает картинку и пишет её в ST. Mea выбирает адрес по подписям и источникам и картинку НЕ
 * видит (её модель может не понимать изображений): здесь картинка скачивается напрямую браузером (нужен заголовок CORS у хоста — он есть у AniList, Википедии, Fandom),
 * обрезается до портрета 2:3 по `focus`, превращается в PNG 512×768 на холсте и уходит в `/api/characters/edit-avatar` (данные карточки ST оставляет как есть).
 * Прежняя картинка запоминается в памяти на один шаг назад: `stCharacterAvatar.undo`.
 *
 * Контракты: `stCharacterAvatar.set { avatar, url, focus? }` → `{ avatar, width, height, source: [ширина, высота исходной картинки] }`; `stCharacterAvatar.undo { avatar }`.
 */
const FETCH_TIMEOUT_MS = 20000;

export function registerStCharacterAvatarService(bus, { getContext, fetch: fetchImpl = globalThis.fetch?.bind(globalThis), FormDataCtor = globalThis.FormData,
    decodeImage = async blob => globalThis.createImageBitmap(blob), createCanvas = (width, height) => Object.assign(globalThis.document.createElement('canvas'), { width, height }),
    setTimer = (callback, ms) => setTimeout(callback, ms), clearTimer = id => clearTimeout(id) } = {}) {
    const buildHeaders = (options = {}) => getContext()?.getRequestHeaders?.(options) ?? {};
    const previous = new Map(); // avatar → Blob прежней картинки (на один шаг назад)

    async function downloadImage(url) {
        if (!isAvatarImageUrl(url)) throw new Error('Only an ordinary http(s) image address can be used.');
        const controller = typeof AbortController === 'undefined' ? null : new AbortController();
        const timer = controller ? setTimer(() => controller.abort(), FETCH_TIMEOUT_MS) : null;
        try {
            let response;
            try {
                response = await fetchImpl(url, { cache: 'no-store', ...(controller ? { signal: controller.signal } : {}) });
            } catch (error) {
                if (error?.name === 'AbortError') throw new Error('The image took too long to download.');
                throw new Error('That host does not allow downloading its images from here (or it did not answer). Use an image from AniList, Wikipedia or a Fandom wiki.');
            }
            if (!response.ok) throw new Error(`The image did not download (HTTP ${response.status}).`);
            const blob = await response.blob();
            if (!isDecodableImageType(blob.type)) throw new Error(`That address is not a picture I can use (${blob.type || 'unknown type'}).`);
            if (blob.size > MAX_IMAGE_BYTES) throw new Error('The image is too large (over 12 MB).');
            return blob;
        } finally {
            if (timer !== null) clearTimer(timer);
        }
    }

    async function renderPortrait(blob, focus) {
        const image = await decodeImage(blob);
        const source = [image.width, image.height]; // до `close()`: у закрытой картинки размер 0
        const crop = computeAvatarCrop({ width: source[0], height: source[1], focus });
        const canvas = createCanvas(AVATAR_WIDTH, AVATAR_HEIGHT);
        canvas.getContext('2d').drawImage(image, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, AVATAR_WIDTH, AVATAR_HEIGHT);
        const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        image.close?.();
        if (!png) throw new Error('The picture could not be prepared.');
        return { png, source };
    }

    async function upload(avatar, blob) {
        const body = new FormDataCtor();
        body.append('avatar', blob, 'avatar.png');
        body.append('avatar_url', avatar);
        const response = await fetchImpl('/api/characters/edit-avatar', { method: 'POST', headers: buildHeaders({ omitContentType: true }), body, cache: 'no-store' });
        if (!response.ok) throw new Error(`SillyTavern did not take the picture (HTTP ${response.status}).`);
        // Миниатюра и сама картинка в кэше браузера: без этого старый аватар висит до перезагрузки.
        try { await fetchImpl(`/thumbnail?type=avatar&file=${encodeURIComponent(avatar)}`, { cache: 'reload' }); await fetchImpl(`/characters/${encodeURIComponent(avatar)}`, { cache: 'reload' }); } catch { /* только кэш */ }
        try { await getContext()?.getCharacters?.(); } catch { /* список подтянется сам */ }
    }

    async function remember(avatar) {
        try {
            const response = await fetchImpl(`/characters/${encodeURIComponent(avatar)}`, { cache: 'no-store' });
            if (response.ok) previous.set(avatar, await response.blob());
        } catch { /* без отката: не повод отказывать в самой замене */ }
    }

    async function setAvatar({ avatar, url, focus } = {}) {
        if (!avatar) throw new Error('Which character? The avatar file name is needed.');
        const { png, source } = await renderPortrait(await downloadImage(url), focus);
        await remember(avatar);
        await upload(avatar, png);
        return { avatar, width: AVATAR_WIDTH, height: AVATAR_HEIGHT, source, canUndo: previous.has(avatar) };
    }

    async function undo({ avatar } = {}) {
        const blob = previous.get(avatar);
        if (!blob) throw new Error('There is no earlier picture to go back to (only the last replacement in this session is kept).');
        await upload(avatar, blob);
        previous.delete(avatar);
        return { avatar };
    }

    const unregisters = [
        bus.register('stCharacterAvatar.set', params => setAvatar(params), { loadMetric: () => 1 }),
        bus.register('stCharacterAvatar.undo', params => undo(params), { loadMetric: () => 0 }),
    ];
    return () => { for (const unregister of unregisters) unregister(); };
}
