/**
 * Аватар карточки персонажа: чистые функции. Картинку выбирает Mea по подписям и источникам (базы персонажей, инфобокс вики), НЕ глядя на неё — модель может не
 * понимать изображений, поэтому подбор делает движок: портретная обрезка 2:3 (как у аватаров SillyTavern, 512×768) с выбором, какую часть кадра оставить.
 * Само скачивание, холст и запись в ST — в Сервисе (`services/st-character-avatar.js`).
 */

export const AVATAR_WIDTH = 512;
export const AVATAR_HEIGHT = 768;
export const AVATAR_FOCUS = Object.freeze(['center', 'left', 'right', 'top', 'bottom']);
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

const TARGET_RATIO = AVATAR_WIDTH / AVATAR_HEIGHT;

/**
 * Какую часть исходного кадра взять под портрет 2:3: `{ sx, sy, sw, sh }`. Картинка шире 2:3 (скриншот, широкий арт) — берётся вертикальная полоса нужной ширины,
 * по центру или у левого/правого края (`focus`); уже вертикальнее 2:3 — берётся верхняя часть (лицо обычно сверху; `bottom` — нижняя, `center` — середина). Без `focus`: широкая — центр, высокая — верх.
 * Картинка ровно 2:3 берётся целиком.
 */
export function computeAvatarCrop({ width, height, focus }) {
    const w = Math.max(1, Math.floor(Number(width) || 0));
    const h = Math.max(1, Math.floor(Number(height) || 0));
    const place = AVATAR_FOCUS.includes(focus) ? focus : 'auto'; // без указания: широкая — по центру, высокая — верх
    if (w / h > TARGET_RATIO) {
        const sw = Math.max(1, Math.round(h * TARGET_RATIO));
        const sx = place === 'left' ? 0 : place === 'right' ? w - sw : Math.round((w - sw) / 2);
        return { sx, sy: 0, sw, sh: h };
    }
    const sh = Math.max(1, Math.round(w / TARGET_RATIO));
    const sy = place === 'bottom' ? h - sh : place === 'center' ? Math.round((h - sh) / 2) : 0; // 'top' и 'auto' — верх
    return { sx: 0, sy: Math.max(0, sy), sw: w, sh: Math.min(h, sh) };
}

/** Годный адрес картинки: обычный https/http, без порта и адреса-числа (как для страниц). */
export function isAvatarImageUrl(value) {
    try {
        const url = new URL(String(value));
        return (url.protocol === 'https:' || url.protocol === 'http:') && !url.port && !/^[\d.]+$/.test(url.hostname) && !url.hostname.includes(':') && url.hostname.includes('.');
    } catch {
        return false;
    }
}

/** Тип ответа — картинка, которую умеет разобрать браузер (SVG и прочее не берём). */
export const isDecodableImageType = type => /^image\/(?:png|jpe?g|webp|gif|bmp|avif)\b/i.test(String(type ?? ''));
